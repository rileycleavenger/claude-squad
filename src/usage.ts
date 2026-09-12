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
