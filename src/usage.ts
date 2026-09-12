/**
 * Recognise a usage-limit notice arriving as ordinary assistant text.
 *
 * When the account runs out of quota mid-turn, the notice comes back through the normal
 * assistant channel rather than as a `result` error, so without this it renders as
 * something the agent said - "beta: You've hit your session limit" - and the agent then
 * goes idle looking perfectly healthy. The squad quietly stops coordinating and nothing
 * on screen says why.
 */

/**
 * The wording varies by limit type and has changed between CLI versions, so match the
 * shape rather than any one sentence.
 */
const PATTERNS: RegExp[] = [
  /\b(?:hit|reached)\s+your\s+(?:session|usage|weekly|\d+-hour)\s+limit\b/i,
  /\busage\s+limit\s+reached\b/i,
  /\b\d+-hour\s+limit\s+reached\b/i,
  /\brate\s+limit\s+reached\b/i,
]

/**
 * Longest text still treated as a bare notice.
 *
 * An agent may legitimately discuss rate limits while doing its job - reading an API's
 * docs, writing retry code - and that must stay ordinary chat. A real notice is one short
 * line on its own, so anything longer is the agent talking about limits, not hitting one.
 */
const MAX_NOTICE_LENGTH = 200

/** The notice text if this assistant message is one, otherwise undefined. */
export function usageLimit(text: string): string | undefined {
  const trimmed = text.trim()
  if (!trimmed || trimmed.length > MAX_NOTICE_LENGTH || trimmed.includes('\n')) return undefined
  return PATTERNS.some(pattern => pattern.test(trimmed)) ? trimmed : undefined
}

/**
 * What a stalled agent is told when its quota comes back.
 *
 * Worded like the CLI's own resume prompt: the session still holds everything the agent
 * was doing, so the only thing it needs told is to pick it up and not start over.
 */
export const CONTINUE_PROMPT =
  'Your claude.ai usage limit has reset. Continue the task you were working on when the ' +
  'limit was reached; do not repeat work that is already complete.'

/**
 * Furthest ahead a reset is still worth waiting for.
 *
 * A weekly limit can be days out, and a squad that sat holding timers for two days would
 * resume into a world that has moved on - the operator has closed the laptop, the branch
 * is stale. Past this the operator is told the time and left to restart themselves, which
 * is what the CLI does too.
 */
export const MAX_WAIT_MS = 24 * 60 * 60 * 1000

/**
 * Parse a reset time out of a usage-limit notice.
 *
 * A fallback only: `rate_limit_event` carries `resetsAt` exactly, and this is for the
 * notices that arrive as plain assistant text with no structured event behind them. It is
 * deliberately narrow - a time it cannot read is better than a time it guessed wrong,
 * because a wrong one wakes the whole squad into another rejection.
 */
export function resetAt(text: string, now = Date.now()): number | undefined {
  // An explicit timestamp, when the notice carries one.
  const iso = text.match(/\b(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})?)/)
  if (iso) {
    const at = Date.parse(iso[1]!.replace(' ', 'T'))
    if (Number.isFinite(at) && at > now) return at
  }

  // "resets 3pm", "resets at 10:30 PM", "until 9am".
  const clock = text.match(/\b(?:resets?|until|back)\b[^.\n]{0,20}?\b(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?/i)
  if (!clock) return undefined
  const hour12 = Number(clock[1])
  const minute = Number(clock[2] ?? 0)
  if (hour12 < 1 || hour12 > 12 || minute > 59) return undefined
  const pm = clock[3]!.toLowerCase() === 'p'
  const hour = pm ? (hour12 === 12 ? 12 : hour12 + 12) : hour12 === 12 ? 0 : hour12

  const at = new Date(now)
  at.setHours(hour, minute, 0, 0)
  // A time that has already passed today is tomorrow's - the notice is always forward.
  if (at.getTime() <= now) at.setDate(at.getDate() + 1)
  return at.getTime()
}

/** A reset time as the operator should read it: a clock time, plus how long that is away. */
export function describeReset(at: number, now = Date.now()): string {
  const clock = new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  const minutes = Math.max(0, Math.round((at - now) / 60_000))
  if (minutes < 60) return `${clock} (${minutes} min)`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return `${clock} (${hours}h${rest ? ` ${rest}m` : ''})`
}

/** What the squad should do about a usage limit one of its agents just hit. */
export type ResumePlan =
  /** No reset time was given, so there is nothing to wait on. */
  | { action: 'unknown'; text: string }
  /** The reset is too far out to hold a timer for. */
  | { action: 'too-far'; text: string }
  /** Another agent already reported this same reset; the timer is set. */
  | { action: 'already-scheduled' }
  /** Wait until `at`, then tell the stalled agents to continue. */
  | { action: 'wait'; at: number; text: string }

/**
 * Decide whether a usage limit is worth waiting out.
 *
 * Split out from the squad so the timing rules can be tested without starting an agent:
 * every agent on the squad shares one account, so they all report the same limit within
 * seconds of each other and only the first report should set a timer.
 */
export function planResume(
  resetsAt: number | undefined,
  { now = Date.now(), scheduledAt }: { now?: number; scheduledAt?: number } = {},
): ResumePlan {
  if (resetsAt === undefined) {
    if (scheduledAt !== undefined) return { action: 'already-scheduled' }
    return {
      action: 'unknown',
      text: 'Out of usage. The notice did not say when it resets, so nobody will be resumed automatically - send anything to pick back up once it has.',
    }
  }
  // Reports of the same reset arrive a few seconds apart and round differently; treating
  // them as one keeps the timer from being torn down and rebuilt by every agent in turn.
  if (scheduledAt !== undefined && Math.abs(scheduledAt - resetsAt) < 60_000) {
    return { action: 'already-scheduled' }
  }
  if (resetsAt - now > MAX_WAIT_MS) {
    return {
      action: 'too-far',
      text: `Out of usage until ${describeReset(resetsAt, now)}. That is too far out to wait for - restart the squad once it has reset.`,
    }
  }
  return {
    action: 'wait',
    at: resetsAt,
    text: `Out of usage. Everyone still working will be told to continue at ${describeReset(resetsAt, now)}.`,
  }
}
