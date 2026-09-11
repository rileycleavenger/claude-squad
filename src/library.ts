import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseProfile, serializeProfile } from './config.js'
import { DEFAULT_PROFILES } from './defaults.js'
import type { AgentProfile } from './types.js'

/** Shared, cross-project agent library. */
export function libraryDir(): string {
  return path.join(os.homedir(), '.claude-squad', 'agents')
}

export type TemplateSource = 'builtin' | 'library' | 'project'

export interface Template {
  id: string
  /** Name shown in the picker. */
  label: string
  source: TemplateSource
  /** One-line role summary, or why it is listed. */
  detail: string
  /** The profile itself, already parsed. */
  profile: AgentProfile
}

function safeParse(file: string, raw: string, index: number): AgentProfile | undefined {
  try {
    return parseProfile(file, raw, index)
  } catch {
    // A malformed template should drop out of the picker, not break it.
    return undefined
  }
}

async function readDirProfiles(dir: string): Promise<Array<{ file: string; profile: AgentProfile }>> {
  let files: string[]
  try {
    files = (await fs.readdir(dir)).filter(f => f.endsWith('.md')).sort()
  } catch {
    return []
  }
  const out: Array<{ file: string; profile: AgentProfile }> = []
  for (const [i, file] of files.entries()) {
    const full = path.join(dir, file)
    try {
      const profile = safeParse(full, await fs.readFile(full, 'utf8'), i)
      if (profile) out.push({ file: full, profile })
    } catch {
      continue
    }
  }
  return out
}

/**
 * Everything the `+` tab can offer as a starting point: the four built-in roles, anything
 * saved to the shared library, and any profile already on disk in this project that is
 * not currently running.
 */
export async function listTemplates(squadDir: string, activeNames: string[]): Promise<Template[]> {
  const active = new Set(activeNames.map(n => n.toLowerCase()))
  const templates: Template[] = []

  for (const [i, entry] of DEFAULT_PROFILES.entries()) {
    const profile = safeParse(entry.file, entry.content, i)
    if (profile) {
      templates.push({
        id: `builtin:${profile.name}`,
        label: profile.displayName,
        source: 'builtin',
        detail: profile.role,
        profile,
      })
    }
  }

  for (const { file, profile } of await readDirProfiles(libraryDir())) {
    templates.push({
      id: `library:${file}`,
      label: profile.displayName,
      source: 'library',
      detail: profile.role,
      profile,
    })
  }

  for (const { file, profile } of await readDirProfiles(path.join(squadDir, 'agents'))) {
    if (active.has(profile.name.toLowerCase())) continue
    templates.push({
      id: `project:${file}`,
      label: profile.displayName,
      source: 'project',
      detail: `${profile.role} (in this project, not running)`,
      profile,
    })
  }

  return templates
}

/** Save a profile to the shared library so other projects can start from it. */
export async function saveToLibrary(profile: AgentProfile): Promise<string> {
  const dir = libraryDir()
  await fs.mkdir(dir, { recursive: true })
  const target = path.join(dir, `${profile.name}.md`)
  await fs.writeFile(target, serializeProfile(profile), 'utf8')
  return target
}
