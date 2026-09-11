import { parseProfile, serializeProfile } from './config.js'
import type { AgentProfile } from './types.js'
import type { Draft } from './ui/AgentForm.js'

const FALLBACK_COLORS = ['cyan', 'green', 'magenta', 'yellow', 'blue', 'red']

/** Fill a form draft from an existing profile, so templates open pre-filled. */
export function profileToDraft(profile: AgentProfile): Draft {
  return {
    name: profile.name,
    displayName: profile.displayName,
    role: profile.role,
    model: profile.model ?? '',
    effort: profile.effort ?? '',
    color: profile.color,
    budgetUsd: profile.budgetUsd === undefined ? '' : String(profile.budgetUsd),
    instructions: profile.instructions,
  }
}

export interface DraftResult {
  profile?: AgentProfile
  error?: string
}

/**
 * Turn a form draft into a validated profile.
 *
 * Validation runs by serializing to markdown and parsing it back with the same loader
 * used at startup, so anything accepted here is guaranteed to load next launch.
 */
export function draftToProfile(draft: Draft, index = 0): DraftResult {
  const name = draft.name.trim()
  if (!name) return { error: 'A handle is required - it is how teammates @mention this agent.' }
  if (draft.budgetUsd.trim() && !(Number(draft.budgetUsd) > 0)) {
    return { error: 'Budget must be a positive number, or blank to use the squad default.' }
  }

  const candidate: AgentProfile = {
    name,
    displayName: draft.displayName.trim() || name,
    role: draft.role.trim() || 'Squad member',
    model: draft.model.trim() || undefined,
    effort: (draft.effort.trim() || undefined) as AgentProfile['effort'],
    color: draft.color.trim() || FALLBACK_COLORS[index % FALLBACK_COLORS.length]!,
    budgetUsd: draft.budgetUsd.trim() ? Number(draft.budgetUsd) : undefined,
    instructions: draft.instructions.trim(),
  }

  if (!candidate.instructions) {
    return { error: 'Instructions are required - they become the agent’s system prompt.' }
  }

  try {
    return { profile: parseProfile(`${name}.md`, serializeProfile(candidate), index) }
  } catch (err) {
    return { error: (err as Error).message.replace(`${name}.md: `, '') }
  }
}
