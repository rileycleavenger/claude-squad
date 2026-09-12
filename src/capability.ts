import { promises as fs } from 'node:fs'
import path from 'node:path'
import matter from 'gray-matter'
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk'
import { BUILTIN_CAPABILITIES } from './capabilities/builtin.js'
import { resolveSecretsIn } from './secrets.js'
import { findRegisteredHook, type RegisteredHook } from './hooks.js'

export class CapabilityError extends Error {}

/** A stdio MCP server as declared in capability frontmatter. */
export interface CapabilityServer {
  command: string
  args?: string[]
  env?: Record<string, string>
}

/**
 * A PreToolUse hook this capability wants, named by the basename of its command.
 *
 * The absolute path is not written here because it is wherever the user installed the
 * thing; it is looked up in the Claude Code settings the tool already registered itself
 * in. Naming the event and matcher here rather than adopting them from that file means a
 * hook cannot be silently rebound to a different tool by an edit the squad never saw.
 */
export interface CapabilityHook {
  event: string
  matcher?: string
  command: string
}

export interface Capability {
  name: string
  description: string
  /** MCP servers this capability brings, keyed by server name. */
  mcpServers: Record<string, CapabilityServer>
  /** Tool-call hooks this capability wants, resolved against installed hooks. */
  hooks: CapabilityHook[]
  /** Tool patterns to pre-approve, e.g. `mcp__playwright__*` or `WebSearch`. */
  allowedTools: string[]
  /** Human-readable note shown in the picker, e.g. what credentials are needed. */
  requires?: string
  /** The skill body: how to use this capability well. */
  instructions: string
  source: 'builtin' | 'project'
}

export interface TemplateContext {
  agentName: string
  /** Per-agent scratch directory for browser profiles, downloads, traces. */
  agentDir: string
  repoPath: string
  squadDir: string
}

function parseServers(raw: unknown, file: string): Record<string, CapabilityServer> {
  if (raw === undefined || raw === null) return {}
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new CapabilityError(`${file}: "mcpServers" must be a mapping of server name to config`)
  }
  const out: Record<string, CapabilityServer> = {}
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    const entry = value as Record<string, unknown>
    if (!entry || typeof entry.command !== 'string') {
      throw new CapabilityError(`${file}: mcpServers.${name} needs a "command"`)
    }
    if (entry.args !== undefined && !Array.isArray(entry.args)) {
      throw new CapabilityError(`${file}: mcpServers.${name}.args must be a list`)
    }
    out[name] = {
      command: entry.command,
      args: (entry.args as string[] | undefined)?.map(String),
      env: (entry.env as Record<string, string> | undefined) ?? undefined,
    }
  }
  return out
}

function parseHooks(raw: unknown, file: string): CapabilityHook[] {
  if (raw === undefined || raw === null) return []
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new CapabilityError(`${file}: "hooks" must be a mapping of event name to a list of hooks`)
  }
  const out: CapabilityHook[] = []
  for (const [event, entries] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(entries)) {
      throw new CapabilityError(`${file}: hooks.${event} must be a list`)
    }
    for (const entry of entries) {
      const hook = entry as Record<string, unknown>
      if (!hook || typeof hook.command !== 'string' || !hook.command.trim()) {
        throw new CapabilityError(`${file}: every hook under hooks.${event} needs a "command"`)
      }
      out.push({
        event,
        matcher: typeof hook.matcher === 'string' && hook.matcher.trim() ? hook.matcher : undefined,
        command: hook.command,
      })
    }
  }
  return out
}

export function parseCapability(file: string, raw: string, source: Capability['source']): Capability {
  const { data, content } = matter(raw)
  const name = typeof data.name === 'string' ? data.name : path.basename(file, '.md')
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(name)) {
    throw new CapabilityError(`${file}: capability "name" must be a simple slug; got "${name}"`)
  }
  const instructions = content.trim()
  if (!instructions) {
    throw new CapabilityError(`${file}: capability body is empty - it is the skill that teaches the technique`)
  }
  if (data.allowedTools !== undefined && !Array.isArray(data.allowedTools)) {
    throw new CapabilityError(`${file}: "allowedTools" must be a list`)
  }

  return {
    name,
    description: typeof data.description === 'string' ? data.description : 'Capability',
    mcpServers: parseServers(data.mcpServers, file),
    hooks: parseHooks(data.hooks, file),
    allowedTools: ((data.allowedTools as string[] | undefined) ?? []).map(String),
    requires: typeof data.requires === 'string' ? data.requires : undefined,
    instructions,
    source,
  }
}

const ENV_RE = /\{\{env:([A-Za-z_][A-Za-z0-9_]*)\}\}/g

function applyTemplate(value: string, ctx: TemplateContext): string {
  return value
    .split('{{agentName}}').join(ctx.agentName)
    .split('{{agentDir}}').join(ctx.agentDir)
    .split('{{repoPath}}').join(ctx.repoPath)
    .split('{{squadDir}}').join(ctx.squadDir)
    // `{{env:...}}` is for non-secret wiring such as a command path. Anything sensitive
    // belongs in `{{secret:...}}`, which is resolved only into the server environment.
    .replace(ENV_RE, (_match, name: string) => process.env[name] ?? '')
}

/**
 * Turn a capability's declared servers into SDK-ready MCP configs for one agent.
 *
 * Path templates are expanded first so that every agent gets its own browser profile and
 * scratch space - a persistent browser profile can only be driven by one process at a
 * time, so a shared one would make parallel agents fight over it. Secret references are
 * resolved last, and only into the server's environment.
 */
export async function materializeServers(
  capability: Capability,
  ctx: TemplateContext,
): Promise<{ servers: Record<string, McpServerConfig>; secrets: string[]; warnings: string[] }> {
  const servers: Record<string, McpServerConfig> = {}
  const secrets: string[] = []
  const warnings: string[] = []

  for (const [name, spec] of Object.entries(capability.mcpServers)) {
    const command = applyTemplate(spec.command, ctx)
    if (!command.trim()) {
      // An unresolved {{env:...}} command means the capability was never configured.
      // Skip the server rather than starting a broken one: the agent still gets the
      // technique from the skill, and the operator gets told what to set.
      // Named by capability, not by agent: every profile in a squad tends to want the
      // same one, and four copies of the same sentence is what turned the notice box
      // into a wall of text with the real message buried in it.
      warnings.push(
        `the "${capability.name}" capability has no command for its "${name}" server, so its tools are unavailable.${capability.requires ? ` ${capability.requires.trim().split('\n')[0]}` : ''}`,
      )
      continue
    }

    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(spec.env ?? {})) {
      const templated = applyTemplate(value, ctx)
      const resolved = await resolveSecretsIn(templated)
      if (resolved !== templated) secrets.push(resolved)
      env[key] = resolved
    }
    servers[name] = {
      type: 'stdio',
      command,
      args: (spec.args ?? []).map(arg => applyTemplate(arg, ctx)),
      ...(Object.keys(env).length > 0 ? { env } : {}),
    }
  }

  return { servers, secrets, warnings }
}

/**
 * Resolve a capability's declared hooks against what is actually installed.
 *
 * A hook that is not installed is skipped with a warning rather than failing the agent:
 * the capability's skill still teaches the technique, and the operator gets told the hard
 * block is not in force - which matters, because the whole value of a hook like this is
 * that it is a block and not a suggestion.
 *
 * The warning names the capability rather than the agent, and covers every missing hook at
 * once, so that a squad whose four default profiles all want `context` says the thing once
 * instead of eight times.
 */
export function resolveHooks(
  capability: Capability,
  registered: RegisteredHook[],
): { hooks: ResolvedHook[]; warnings: string[] } {
  const hooks: ResolvedHook[] = []
  const missing: string[] = []

  for (const wanted of capability.hooks) {
    const found = findRegisteredHook(wanted.command, registered)
    if (!found) {
      missing.push(path.basename(wanted.command))
      continue
    }
    hooks.push({
      event: wanted.event,
      matcher: wanted.matcher,
      command: found.command,
      args: found.args,
      timeout: found.timeout,
    })
  }

  const warnings = missing.length
    ? [
        `the "${capability.name}" capability wants ${missing.map(m => `"${m}"`).join(' and ')}, which ${missing.length > 1 ? 'are' : 'is'} not installed, so its hooks are not in force.${capability.requires ? ` ${capability.requires.trim().split('\n')[0]}` : ''}`,
      ]
    : []
  return { hooks, warnings }
}

/** A capability hook matched to an installed command. */
export interface ResolvedHook {
  event: string
  matcher?: string
  command: string
  args: string[]
  timeout?: number
}

/** Skill name as the SDK sees it once the capability plugin is loaded. */
export function skillNameFor(capability: string): string {
  return `${PLUGIN_NAME}:${capability}`
}

/** Plugin name the generated capability skills are namespaced under. */
export const PLUGIN_NAME = 'squad'

async function readDir(dir: string, source: Capability['source']): Promise<Capability[]> {
  let files: string[]
  try {
    files = (await fs.readdir(dir)).filter(f => f.endsWith('.md')).sort()
  } catch {
    return []
  }
  const out: Capability[] = []
  for (const file of files) {
    const full = path.join(dir, file)
    out.push(parseCapability(full, await fs.readFile(full, 'utf8'), source))
  }
  return out
}

/**
 * Every capability available to a project: the ones that ship with claude-squad, plus
 * anything in `<repo>/.squad/capabilities/`. A project file with the same name wins, so
 * a user can retune a built-in without forking it.
 */
export async function loadCapabilities(squadDir: string): Promise<Map<string, Capability>> {
  const byName = new Map<string, Capability>()
  for (const entry of BUILTIN_CAPABILITIES) {
    const capability = parseCapability(`${entry.name}.md`, entry.content, 'builtin')
    byName.set(capability.name, capability)
  }
  for (const capability of await readDir(path.join(squadDir, 'capabilities'), 'project')) {
    byName.set(capability.name, capability)
  }
  return byName
}
