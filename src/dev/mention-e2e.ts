/**
 * End-to-end check that an operator @mention wakes only who it names.
 *
 *   npx tsx src/dev/mention-e2e.ts
 *
 * Three agents park in `wait_for_messages`, then the operator addresses one of them. Only
 * that one may spend anything. This is the shape that used to put the whole squad to work:
 * the groupchat post carried `@team` regardless of who was named, and releasing the parked
 * agents ignored addressing entirely, so either path alone woke everyone.
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Squad, GROUP_TAB } from '../squad.js'
import type { Entry } from '../types.js'

const run = promisify(execFile)
const MODEL = process.env.SQUAD_SMOKE_MODEL ?? 'claude-haiku-4-5'
const NAMES: string[] = ['alpha', 'beta', 'gamma']

const profile = (name: string) => `---
name: ${name}
displayName: ${name[0]!.toUpperCase() + name.slice(1)}
role: Answers questions put to them
color: cyan
effort: low
---
You are ${name}. You are terse.

When the operator asks you to stand by, call \`wait_for_messages\` with a timeout of 120
seconds and nothing else.

If a message names you, reply to it with one short sentence in the groupchat, mentioning
nobody, and then stop.
`

async function scratchRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'squad-mention-e2e-'))
  await run('git', ['-C', dir, 'init', '-q'])
  await run('git', ['-C', dir, 'config', 'user.email', 'e2e@example.com'])
  await run('git', ['-C', dir, 'config', 'user.name', 'E2E'])
  await fs.writeFile(path.join(dir, 'README.md'), '# scratch\n')
  await run('git', ['-C', dir, 'add', '.'])
  await run('git', ['-C', dir, 'commit', '-qm', 'init'])

  const agents = path.join(dir, '.squad', 'agents')
  await fs.mkdir(agents, { recursive: true })
  for (const name of NAMES) await fs.writeFile(path.join(agents, `${name}.md`), profile(name))
  await fs.writeFile(
    path.join(dir, '.squad', 'squad.json'),
    JSON.stringify({ defaultModel: MODEL, defaultEffort: 'low', defaultBudgetUsd: 2 }, null, 2),
  )
  return dir
}

const settle = async (squad: Squad, ms: number) => {
  const until = Date.now() + ms
  while (Date.now() < until) await new Promise(r => setTimeout(r, 500))
}

const repo = await scratchRepo()
console.log(`scratch repo: ${repo}`)
console.log(`model:        ${MODEL}\n`)

const squad = await Squad.create(repo)
for (const w of squad.warnings) console.log(`warning: ${w}`)
await squad.start()

// Get all three parked, so the test covers waking a waiter and not just an idle agent.
squad.submit(GROUP_TAB, 'Everyone stand by.')
const parked = (n: string) => {
  const status = squad.statusOf(n)
  return status.kind === 'tool' && /wait_for_messages/.test(status.tool)
}
const parkedBy = Date.now() + 90_000
while (Date.now() < parkedBy && !NAMES.every(parked)) {
  await new Promise(r => setTimeout(r, 1000))
}
for (const n of NAMES) {
  const status = squad.statusOf(n)
  console.log(`  @${n} is ${status.kind}${status.kind === 'tool' ? ` ${status.tool}` : ''}`)
}

// Baseline: everything spent so far was the parking turn, which was addressed to everyone.
const baseline = new Map(NAMES.map(n => [n, squad.costOf(n)]))
const entriesBefore = new Map(NAMES.map(n => [n, (squad.entries(n) as Entry[]).length]))
console.log(`\nbaseline spend: ${NAMES.map(n => `${n} $${baseline.get(n)!.toFixed(4)}`).join('  ')}\n`)

squad.submit(GROUP_TAB, '@beta in one sentence, what is 2 + 2?')

// Give everyone a fair chance to wake: wait well past the point where beta has answered.
const deadline = Date.now() + 180_000
let answered = false
while (Date.now() < deadline && !answered) {
  await new Promise(r => setTimeout(r, 1500))
  answered = (squad.entries(GROUP_TAB) as Entry[]).some(e => e.kind === 'chat' && e.from === 'beta' && /4|four/i.test(e.text))
}
await settle(squad, 20_000) // a woken teammate would have started by now

console.log('--- #groupchat ---')
for (const e of squad.entries(GROUP_TAB) as Entry[]) {
  if (e.kind === 'chat') console.log(`  ${e.from}: ${e.text.replace(/\s+/g, ' ').slice(0, 110)}`)
  else if (e.kind === 'notice') console.log(`  (squad) ${e.text.slice(0, 110)}`)
}

const spent = (n: string) => squad.costOf(n) - baseline.get(n)!
const acted = (n: string) => (squad.entries(n) as Entry[]).length > entriesBefore.get(n)!
console.log('\n--- spend since the mention ---')
for (const n of NAMES) console.log(`  @${n}: $${spent(n).toFixed(4)}${acted(n) ? '  (acted)' : ''}`)

await squad.shutdown()

const bystanders = NAMES.filter(n => n !== 'beta')
const results: Array<[string, boolean]> = [
  ['@beta woke and answered', answered],
  ...bystanders.map(n => [`@${n} was not woken (no spend)`, spent(n) <= 0] as [string, boolean]),
  ...bystanders.map(n => [`@${n} stayed quiet (no new transcript)`, !acted(n)] as [string, boolean]),
]

console.log('\n' + '='.repeat(60))
for (const [label, ok] of results) console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`)
console.log(`cost: $${squad.totalCost().toFixed(4)}`)
console.log('='.repeat(60))
console.log(`\nscratch repo: ${repo}`)
process.exit(results.every(([, ok]) => ok) ? 0 : 1)
