import { promises as fs } from 'node:fs'
import path from 'node:path'
import matter from 'gray-matter'
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk'
import { BUILTIN_CAPABILITIES } from './capabilities/builtin.js'
import { resolveSecretsIn } from './secrets.js'

export class CapabilityError extends Error {}

/** A stdio MCP server as declared in capability frontmatter. */
export interface CapabilityServer {
  command: string
  args?: string[]
  env?: Record<string, string>
}

export interface Capability {
  name: string
  description: string
  /** MCP servers this capability brings, keyed by server name. */
  mcpServers: Record<string, CapabilityServer>
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
      warnings.push(
        `@${ctx.agentName}: the "${capability.name}" capability has no command for its "${name}" server, so its tools are unavailable.${capability.requires ? ` ${capability.requires.trim().split('\n')[0]}` : ''}`,
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
