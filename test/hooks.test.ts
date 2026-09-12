import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  buildHookMatchers,
  commandHook,
  findRegisteredHook,
  interpretHookOutput,
  parseUserHooks,
} from '../src/hooks.js'
import type { HookInput } from '@anthropic-ai/claude-agent-sdk'

const SETTINGS = {
  hooks: {
    PreToolUse: [
      {
        matcher: 'Read',
        hooks: [{ type: 'command', command: '/opt/shunt/hooks/check-file-size', args: [], timeout: 10 }],
      },
      {
        matcher: 'Bash',
        hooks: [{ type: 'command', command: '/opt/shunt/hooks/check-bash-read' }],
      },
    ],
  },
}

test('command hooks are read out of a settings file', () => {
  const hooks = parseUserHooks(SETTINGS)
  assert.equal(hooks.length, 2)
  assert.deepEqual(hooks[0], {
    event: 'PreToolUse',
    matcher: 'Read',
    command: '/opt/shunt/hooks/check-file-size',
    args: [],
    timeout: 10,
  })
  assert.equal(hooks[1]!.matcher, 'Bash')
  assert.equal(hooks[1]!.timeout, undefined, 'no timeout means the default applies')
})

test('a malformed settings file yields no hooks instead of throwing', () => {
  // The file is the user's and may be hand-edited; a typo must not stop the squad booting.
  for (const settings of [
    null,
    undefined,
    {},
    { hooks: null },
    { hooks: { PreToolUse: 'nope' } },
    { hooks: { PreToolUse: [{ matcher: 'Read' }] } },
    { hooks: { PreToolUse: [{ hooks: [{ type: 'command' }] }] } },
    { hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: '   ' }] }] } },
    { hooks: { PreToolUse: [{ hooks: [{ type: 'inline', command: 'x' }] }] } },
  ]) {
    assert.deepEqual(parseUserHooks(settings), [], JSON.stringify(settings))
  }
})

test('a good entry survives a broken one beside it', () => {
  const hooks = parseUserHooks({
    hooks: {
      PreToolUse: [
        { matcher: 'Read', hooks: [{ type: 'command' }] },
        { matcher: 'Bash', hooks: [{ type: 'command', command: '/opt/shunt/hooks/check-bash-read' }] },
      ],
    },
  })
  assert.equal(hooks.length, 1)
  assert.equal(hooks[0]!.matcher, 'Bash')
})

test('a capability finds its hook by command basename, wherever it is installed', () => {
  // The capability cannot know the install path, so it names the command and the absolute
  // path comes from wherever the tool registered itself.
  const registered = parseUserHooks(SETTINGS)
  assert.equal(findRegisteredHook('check-file-size', registered)?.command, '/opt/shunt/hooks/check-file-size')
  assert.equal(findRegisteredHook('check-bash-read', registered)?.command, '/opt/shunt/hooks/check-bash-read')
  assert.equal(findRegisteredHook('not-installed', registered), undefined)
})

test('silence from a hook is no objection, not approval', () => {
  // An explicit allow would auto-approve the tool call and bypass permissions entirely,
  // which on a Bash matcher green-lights every command the agent ever runs.
  assert.deepEqual(interpretHookOutput('', true), {})
  assert.deepEqual(interpretHookOutput('   \n', true), {})
  assert.deepEqual(interpretHookOutput('not json', true), {}, 'garbage is not a decision')
  assert.deepEqual(interpretHookOutput('"a string"', true), {}, 'a bare scalar is not a decision')
})

test('a deny decision is passed through intact', () => {
  const payload = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: 'File is 800 lines (threshold: 350).',
    },
  }
  assert.deepEqual(interpretHookOutput(JSON.stringify(payload), true), payload)
})

test('hooks on the same event and matcher collapse into one entry', () => {
  const matchers = buildHookMatchers([
    { event: 'PreToolUse', matcher: 'Read', command: '/bin/echo' },
    { event: 'PreToolUse', matcher: 'Read', command: '/bin/true' },
    { event: 'PreToolUse', matcher: 'Bash', command: '/bin/echo' },
    { event: 'PostToolUse', command: '/bin/echo' },
  ])
  assert.equal(matchers.PreToolUse?.length, 2)
  assert.equal(matchers.PreToolUse?.[0]?.hooks.length, 2, 'both Read hooks run')
  assert.equal(matchers.PreToolUse?.[1]?.matcher, 'Bash')
  assert.equal(matchers.PostToolUse?.[0]?.matcher, undefined, 'no matcher means every tool')
})

const input = { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/x' } } as unknown as HookInput
const opts = { signal: new AbortController().signal }

test('a real hook script is fed the event on stdin and its decision comes back', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'squad-hook-'))
  const script = path.join(dir, 'blocker')
  // Echoes back the file_path it was given, proving the event actually reached stdin.
  await fs.writeFile(
    script,
    `#!/bin/bash
p=$(cat | sed -n 's/.*"file_path":"\\([^"]*\\)".*/\\1/p')
printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"too big: %s"}}\\n' "$p"
`,
    { mode: 0o755 },
  )

  const out = (await commandHook({ command: script })(input, undefined, opts)) as any
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny')
  assert.equal(out.hookSpecificOutput.permissionDecisionReason, 'too big: /x')
  await fs.rm(dir, { recursive: true, force: true })
})

test('a broken hook costs tokens rather than stopping the agent', async () => {
  const problems: string[] = []
  const out = await commandHook({ command: '/nonexistent/hook' }, m => problems.push(m))(input, undefined, opts)
  assert.deepEqual(out, {}, 'a missing hook must not block the tool call')
  assert.equal(problems.length, 1)
  assert.match(problems[0]!, /could not run/)
})

test('a hanging hook is killed and does not wedge the turn', async () => {
  const problems: string[] = []
  const started = Date.now()
  const out = await commandHook({ command: '/bin/sleep', args: ['30'], timeout: 0.3 }, m => problems.push(m))(
    input,
    undefined,
    opts,
  )
  assert.deepEqual(out, {})
  assert.ok(Date.now() - started < 5000, 'returned promptly rather than waiting out the sleep')
  assert.match(problems[0]!, /timed out/)
})
