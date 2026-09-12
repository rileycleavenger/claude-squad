import { test } from 'node:test'
import assert from 'node:assert/strict'
import { usageLimit, resetAt, planResume, MAX_WAIT_MS } from '../src/usage.js'

test('a usage-limit notice is recognised however it is worded', () => {
  // These arrive as assistant text, so without this they read as the agent speaking.
  for (const text of [
    "You've hit your session limit · resets 7:30pm (America/New_York)",
    "You've reached your usage limit",
    'Claude usage limit reached. Your limit will reset at 3pm.',
    '5-hour limit reached ∙ resets 3pm',
    "You've hit your weekly limit · resets Monday",
    'Rate limit reached',
  ]) {
    assert.equal(usageLimit(text), text.trim(), `${JSON.stringify(text)} should be a notice`)
  }
})

test('an agent talking about rate limits is not mistaken for hitting one', () => {
  // A false positive here kills the tab: the agent is marked errored and stops being
  // treated as available, for a message that was ordinary work.
  for (const text of [
    'I added retry handling for when the usage limit is reached by the upstream API, backing off exponentially and surfacing the reset time to the caller so the job can be requeued rather than dropped.',
    'The docs say rate limit reached responses use HTTP 429.\nI will handle that case.',
    'Done.',
    '',
    '   ',
  ]) {
    assert.equal(usageLimit(text), undefined, `${JSON.stringify(text.slice(0, 40))} should be ordinary chat`)
  }
})

test('a reset time is read out of the notice when one is there', () => {
  const now = Date.parse('2026-09-12T14:00:00')
  assert.equal(resetAt("You've hit your 5-hour limit · resets 3pm", now), Date.parse('2026-09-12T15:00:00'))
  assert.equal(resetAt('Usage limit reached. Resets at 10:30 PM.', now), Date.parse('2026-09-12T22:30:00'))
  // A time that has already gone by today is tomorrow's; the notice always points forward.
  assert.equal(resetAt('resets at 9am', now), Date.parse('2026-09-13T09:00:00'))
  // Noon and midnight are the two the 12-hour clock gets wrong if you do the arithmetic
  // the obvious way.
  assert.equal(resetAt('resets at 12am', now), Date.parse('2026-09-13T00:00:00'))
  assert.equal(resetAt('resets at 12:15pm', now), Date.parse('2026-09-13T12:15:00'))
})

test('a reset time that is not there is not invented', () => {
  // Guessing wrong is worse than not guessing: a wrong time wakes the whole squad into
  // another rejection.
  assert.equal(resetAt("You've hit your usage limit."), undefined)
  assert.equal(resetAt('resets at 25pm'), undefined)
  assert.equal(resetAt('the retry budget is 3 per minute'), undefined)
})

test('an explicit timestamp wins over the clock reading', () => {
  const now = Date.parse('2026-09-12T14:00:00Z')
  assert.equal(
    resetAt('Usage limit reached; resets 2026-09-12T18:00:00Z', now),
    Date.parse('2026-09-12T18:00:00Z'),
  )
})

test('a reset inside the day is waited for, and one beyond it is not', () => {
  const now = Date.parse('2026-09-12T14:00:00Z')
  const soon = now + 90 * 60_000
  const plan = planResume(soon, { now })
  assert.equal(plan.action, 'wait')
  assert.equal(plan.action === 'wait' && plan.at, soon)
  assert.match(plan.text!, /1h 30m/)

  // A weekly limit can be days out. Holding a timer that long resumes into a squad the
  // operator walked away from, so it is left to them.
  assert.equal(planResume(now + 3 * MAX_WAIT_MS, { now }).action, 'too-far')
  assert.equal(planResume(undefined, { now }).action, 'unknown')
})

test('every agent reports the same limit, and only the first one schedules it', () => {
  const now = Date.parse('2026-09-12T14:00:00Z')
  const at = now + 30 * 60_000
  // Four agents share one account, so four rejections arrive seconds apart with reset
  // times that round differently. Rebuilding the timer for each is churn at best.
  assert.equal(planResume(at + 5_000, { now, scheduledAt: at }).action, 'already-scheduled')
  assert.equal(planResume(undefined, { now, scheduledAt: at }).action, 'already-scheduled')
  // A genuinely different reset - a second, longer limit - does replace it.
  assert.equal(planResume(at + 4 * 60 * 60_000, { now, scheduledAt: at }).action, 'wait')
})
