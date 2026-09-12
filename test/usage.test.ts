import { test } from 'node:test'
import assert from 'node:assert/strict'
import { usageLimit } from '../src/usage.js'

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
