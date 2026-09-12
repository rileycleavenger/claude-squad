/**
 * End-to-end check that the `context` capability really carries the installed PreToolUse
 * hooks into a squad agent: a large file must be blocked, a targeted read must not be,
 * and the agent must reach its answer by delegating rather than by reading everything.
 *
 *   npx tsx src/dev/context-e2e.ts
 *
 * Needs the hooks installed (see the capability's `requires`). Without them the run
 * reports the warning rather than a silent pass.
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Squad } from '../squad.js'
import { loadCapabilities, resolveHooks } from '../capability.js'
import { commandHook, loadUserHooks } from '../hooks.js'
import type { Entry } from '../types.js'
import type { HookInput } from '@anthropic-ai/claude-agent-sdk'

const run = promisify(execFile)
const MODEL = process.env.SQUAD_SMOKE_MODEL ?? 'claude-haiku-4-5'

const PROFILE = `---
name: reader
displayName: Reader
role: Answers questions about the codebase
color: cyan
effort: low
capabilities: [context]
---
You are terse. Do exactly what you are asked and then stop.
`

/** A file comfortably over the 350-line threshold, with one fact buried in it. */
function bigFile(): string {
  const lines: string[] = []
  for (let i = 1; i <= 900; i += 1) {
    if (i === 604) lines.push(`export const RETRY_BUDGET = 17 // line ${i}`)
    else lines.push(`export function handler${i}(input: string): string { return input + '${i}' }`)
  }
  return lines.join('\n') + '\n'
}

async function scratchRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'squad-ctx-e2e-'))
  await run('git', ['-C', dir, 'init', '-q'])
  await run('git', ['-C', dir, 'config', 'user.email', 'e2e@example.com'])
  await run('git', ['-C', dir, 'config', 'user.name', 'E2E'])
  await fs.writeFile(path.join(dir, 'README.md'), '# scratch\n')
  await fs.writeFile(path.join(dir, 'handlers.ts'), bigFile())
  await run('git', ['-C', dir, 'add', '.'])
  await run('git', ['-C', dir, 'commit', '-qm', 'init'])

  const agents = path.join(dir, '.squad', 'agents')
  await fs.mkdir(agents, { recursive: true })
  await fs.writeFile(path.join(agents, 'reader.md'), PROFILE)
  await fs.writeFile(
    path.join(dir, '.squad', 'squad.json'),
    JSON.stringify({ defaultModel: MODEL, defaultEffort: 'low', defaultBudgetUsd: 3 }, null, 2),
  )
  return dir
}

const repo = await scratchRepo()
console.log(`scratch repo: ${repo}`)
console.log(`model:        ${MODEL}\n`)

// Check the mechanism directly before spending anything on a model. Behaviour alone is
// not proof: an agent that greps instead of reading may simply have chosen to, and a hook
// that was never wired looks exactly the same from the transcript.
const capability = (await loadCapabilities(path.join(repo, '.squad'))).get('context')!
const resolved = resolveHooks(capability, await loadUserHooks())
for (const w of resolved.warnings) console.log(`warning: ${w}`)

const preToolUse = (file: string) =>
  ({
    hook_event_name: 'PreToolUse',
    tool_name: 'Read',
    tool_input: { file_path: file },
    session_id: 'e2e',
    transcript_path: '',
    cwd: repo,
  }) as unknown as HookInput

const readHook = resolved.hooks.find(h => h.matcher === 'Read')
const opts = { signal: new AbortController().signal }
let bigDenied = false
let smallAllowed = false
if (readHook) {
  const callback = commandHook(readHook, m => console.log(`hook problem: ${m}`))
  const big = (await callback(preToolUse(path.join(repo, 'handlers.ts')), undefined, opts)) as {
    hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string }
  }
  bigDenied = big.hookSpecificOutput?.permissionDecision === 'deny'
  console.log(`900-line file: ${bigDenied ? 'DENIED' : 'allowed'} - ${big.hookSpecificOutput?.permissionDecisionReason?.split('\n')[0] ?? 'no decision'}`)

  const small = await callback(preToolUse(path.join(repo, 'README.md')), undefined, opts)
  smallAllowed = Object.keys(small).length === 0
  console.log(`1-line file:   ${smallAllowed ? 'allowed' : 'DENIED'}\n`)
}

const squad = await Squad.create(repo)
const hookWarnings = squad.warnings.filter(w => /hook/.test(w))
for (const w of squad.warnings) console.log(`warning: ${w}`)
await squad.start()

squad.submit(
  'reader',
  'What is the value of RETRY_BUDGET in handlers.ts? Answer with just the number, then stop.',
)

const deadline = Date.now() + 300_000
let answered = false
while (Date.now() < deadline && !answered) {
  await new Promise(r => setTimeout(r, 1500))
  const tab = squad.entries('reader') as Entry[]
  answered = squad.statusOf('reader').kind === 'idle' && tab.some(e => e.kind === 'chat' && /17/.test(e.text))
}

const entries = squad.entries('reader') as Entry[]
console.log('--- @reader transcript ---')
for (const e of entries) {
  if (e.kind === 'chat') console.log(`  ${e.from}: ${e.text.replace(/\s+/g, ' ').slice(0, 140)}`)
  else if (e.kind === 'tool') console.log(`  ⚙ ${e.summary.slice(0, 130)}`)
  else if (e.kind === 'notice') console.log(`  (squad) ${e.text.slice(0, 130)}`)
  else if (e.kind === 'error') console.log(`  ✕ ${e.text.slice(0, 160)}`)
}

await squad.shutdown()

const tools = entries.filter((e): e is Extract<Entry, { kind: 'tool' }> => e.kind === 'tool')
const delegated = tools.some(e => /bulk-read|code-write/.test(e.summary))
const targeted = tools.some(e => /handlers\.ts/.test(e.summary))
const gotAnswer = entries.some(e => e.kind === 'chat' && /\b17\b/.test(e.text))
const hooksResolved = hookWarnings.length === 0

const results: Array<[string, boolean]> = [
  ['the capability found its installed hooks', hooksResolved],
  ['a 900-line read is actually denied by the wired hook', bigDenied],
  ['a small file is still allowed through', smallAllowed],
  ['the agent reached the answer without a full read', delegated || targeted],
  ['it answered correctly (17)', gotAnswer],
]

console.log('\n' + '='.repeat(60))
for (const [label, ok] of results) console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`)
console.log(`cost: $${squad.totalCost().toFixed(4)}`)
console.log('='.repeat(60))
console.log(`\nscratch repo: ${repo}`)
process.exit(results.every(([, ok]) => ok) ? 0 : 1)
