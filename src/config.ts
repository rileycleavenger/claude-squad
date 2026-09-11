import { promises as fs } from 'node:fs'
import path from 'node:path'
import matter from 'gray-matter'
import type { AgentProfile, EffortLevel, SquadConfig } from './types.js'
import { DEFAULT_PROFILES, DEFAULT_SQUAD_JSON } from './defaults.js'

const EFFORTS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max']
const FALLBACK_COLORS = ['cyan', 'green', 'magenta', 'yellow', 'blue', 'red']

export class ConfigError extends Error {}

function asString(value: unknown, field: string, file: string): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new ConfigError(`${file}: "${field}" must be a string`)
  return value
}

/** Parse one `.squad/agents/<name>.md` profile. */
export function parseProfile(file: string, raw: string, index: number): AgentProfile {
  const { data, content } = matter(raw)
  const base = path.basename(file, '.md')

  const name = asString(data.name, 'name', file) ?? base
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(name)) {
    throw new ConfigError(
      `${file}: "name" must be a simple handle (letters, digits, - and _) because it is used as an @mention and a git branch name; got "${name}"`,
    )
  }

  const instructions = content.trim()
  if (!instructions) throw new ConfigError(`${file}: profile body is empty - it is the agent's system prompt`)

  const effort = asString(data.effort, 'effort', file) as EffortLevel | undefined
  if (effort && !EFFORTS.includes(effort)) {
    throw new ConfigError(`${file}: "effort" must be one of ${EFFORTS.join(', ')}; got "${effort}"`)
  }

  let tools: string[] | undefined
  if (data.tools !== undefined) {
    if (!Array.isArray(data.tools) || data.tools.some((t: unknown) => typeof t !== 'string')) {
      throw new ConfigError(`${file}: "tools" must be a list of tool names`)
    }
    tools = data.tools as string[]
  }

  let capabilities: string[] = []
  if (data.capabilities !== undefined) {
    if (!Array.isArray(data.capabilities) || data.capabilities.some((c: unknown) => typeof c !== 'string')) {
      throw new ConfigError(`${file}: "capabilities" must be a list of capability names`)
    }
    capabilities = (data.capabilities as string[]).map(c => c.trim()).filter(Boolean)
  }

  let skills: string[] | undefined
  if (data.skills !== undefined) {
    if (!Array.isArray(data.skills) || data.skills.some((c: unknown) => typeof c !== 'string')) {
      throw new ConfigError(`${file}: "skills" must be a list of skill names`)
    }
    skills = (data.skills as string[]).map(c => c.trim()).filter(Boolean)
  }

  let budgetUsd: number | undefined
  if (data.budgetUsd !== undefined) {
    if (typeof data.budgetUsd !== 'number' || !(data.budgetUsd > 0)) {
      throw new ConfigError(`${file}: "budgetUsd" must be a positive number`)
    }
    budgetUsd = data.budgetUsd
  }

  return {
    name,
    displayName: asString(data.displayName, 'displayName', file) ?? name,
    role: asString(data.role, 'role', file) ?? 'Squad member',
    model: asString(data.model, 'model', file),
    effort,
    color: asString(data.color, 'color', file) ?? FALLBACK_COLORS[index % FALLBACK_COLORS.length]!,
    tools,
    capabilities,
    skills,
    budgetUsd,
    instructions,
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

/** Write the default `.squad/` scaffold into `repoPath`. Never overwrites existing files. */
export async function initSquad(repoPath: string): Promise<{ created: string[]; skipped: string[] }> {
  const squadDir = path.join(repoPath, '.squad')
  const agentsDir = path.join(squadDir, 'agents')
  await fs.mkdir(agentsDir, { recursive: true })

  const created: string[] = []
  const skipped: string[] = []

  const jsonPath = path.join(squadDir, 'squad.json')
  if (await exists(jsonPath)) {
    skipped.push(jsonPath)
  } else {
    await fs.writeFile(jsonPath, JSON.stringify(DEFAULT_SQUAD_JSON, null, 2) + '\n', 'utf8')
    created.push(jsonPath)
  }

  for (const profile of DEFAULT_PROFILES) {
    const target = path.join(agentsDir, profile.file)
    if (await exists(target)) {
      skipped.push(target)
      continue
    }
    await fs.writeFile(target, profile.content, 'utf8')
    created.push(target)
  }

  return { created, skipped }
}

/** Load `.squad/squad.json` plus every `.squad/agents/*.md` profile from a target repo. */
export async function loadConfig(repoPath: string): Promise<SquadConfig> {
  const squadDir = path.join(repoPath, '.squad')
  const agentsDir = path.join(squadDir, 'agents')

  // A missing or empty .squad is not an error: `squad` in a fresh project opens the TUI
  // with no agents so you can define the first one with the + tab.
  await fs.mkdir(agentsDir, { recursive: true })

  let settings: Record<string, unknown> = {}
  const jsonPath = path.join(squadDir, 'squad.json')
  if (await exists(jsonPath)) {
    try {
      settings = JSON.parse(await fs.readFile(jsonPath, 'utf8')) as Record<string, unknown>
    } catch (err) {
      throw new ConfigError(`${jsonPath}: not valid JSON (${(err as Error).message})`)
    }
  }

  const files = (await fs.readdir(agentsDir)).filter(f => f.endsWith('.md')).sort()

  const agents: AgentProfile[] = []
  const seen = new Map<string, string>()
  for (const [i, file] of files.entries()) {
    const full = path.join(agentsDir, file)
    const profile = parseProfile(full, await fs.readFile(full, 'utf8'), i)
    const clash = seen.get(profile.name.toLowerCase())
    if (clash) {
      throw new ConfigError(`Duplicate agent name "${profile.name}": defined in both ${clash} and ${full}`)
    }
    seen.set(profile.name.toLowerCase(), full)
    agents.push(profile)
  }

  const num = (key: string, fallback: number): number => {
    const v = settings[key]
    return typeof v === 'number' && Number.isFinite(v) ? v : fallback
  }

  return {
    repoPath,
    squadDir,
    agents,
    defaultModel: typeof settings.defaultModel === 'string' ? settings.defaultModel : 'claude-opus-5',
    defaultEffort: EFFORTS.includes(settings.defaultEffort as EffortLevel)
      ? (settings.defaultEffort as EffortLevel)
      : 'high',
    defaultBudgetUsd: num('defaultBudgetUsd', 10),
    maxWakesPerMinute: num('maxWakesPerMinute', 6),
    maxRelayDepth: num('maxRelayDepth', 8),
    useWorktrees: settings.useWorktrees !== false,
  }
}

/** Render a profile back to the markdown form `.squad/agents/<name>.md` uses. */
export function serializeProfile(profile: AgentProfile): string {
  const front: string[] = [
    `name: ${profile.name}`,
    `displayName: ${profile.displayName}`,
    `role: ${profile.role}`,
    `color: ${profile.color}`,
  ]
  if (profile.model) front.push(`model: ${profile.model}`)
  if (profile.effort) front.push(`effort: ${profile.effort}`)
  if (profile.budgetUsd !== undefined) front.push(`budgetUsd: ${profile.budgetUsd}`)
  if (profile.tools) front.push(`tools: [${profile.tools.join(', ')}]`)
  if (profile.capabilities.length > 0) front.push(`capabilities: [${profile.capabilities.join(', ')}]`)
  if (profile.skills?.length) front.push(`skills: [${profile.skills.join(', ')}]`)
  return `---\n${front.join('\n')}\n---\n\n${profile.instructions.trim()}\n`
}

/** Write a profile into a repo's `.squad/agents/`, returning the path written. */
export async function writeProfile(squadDir: string, profile: AgentProfile): Promise<string> {
  const agentsDir = path.join(squadDir, 'agents')
  await fs.mkdir(agentsDir, { recursive: true })
  const target = path.join(agentsDir, `${profile.name}.md`)
  await fs.writeFile(target, serializeProfile(profile), 'utf8')
  return target
}
