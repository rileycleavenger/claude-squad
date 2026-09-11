/**
 * Editing an agent must actually change its behaviour.
 *
 * A resumed session keeps the system prompt it started with, so a config change that
 * lives in the prompt requires a fresh session. This checks that the change really takes
 * effect, and that the restarted agent is not left amnesiac.
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Squad } from '../squad.js'
import type { Entry } from '../types.js'

const run = promisify(execFile)
const MODEL = process.env.SQUAD_SMOKE_MODEL ?? 'claude-haiku-4-5'

async function scratchRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'squad-reconf-'))
  await run('git', ['-C', dir, 'init', '-q'])
  await run('git', ['-C', dir, 'config', 'user.email', 'e2e@example.com'])
  await run('git', ['-C', dir, 'config', 'user.name', 'E2E'])
  await fs.writeFile(path.join(dir, 'README.md'), '# scratch\n')
  await run('git', ['-C', dir, 'add', '.'])
  await run('git', ['-C', dir, 'commit', '-qm', 'init'])

  const agents = path.join(dir, '.squad', 'agents')
  await fs.mkdir(agents, { recursive: true })
  await fs.writeFile(
    path.join(agents, 'bob.md'),
    `---
name: bob
displayName: Bob
role: Answers questions
color: green
effort: low
---
You are Bob. Always reply with exactly one word, nothing else.
`,
  )
  await fs.writeFile(
    path.join(dir, '.squad', 'squad.json'),
    JSON.stringify({ defaultModel: MODEL, defaultEffort: 'low', defaultBudgetUsd: 2 }, null, 2),
  )
  return dir
}

async function ask(squad: Squad, text: string): Promise<string> {
  const before = squad.entries('bob').length
  squad.submit('bob', text)
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 1000))
    const list = squad.entries('bob') as Entry[]
    if (squad.statusOf('bob').kind === 'idle' && list.length > before) {
      const reply = [...list].slice(before).reverse().find(e => e.kind === 'chat' && e.from === 'bob')
      if (reply && reply.kind === 'chat') return reply.text.trim()
    }
  }
  return ''
}

const repo = await scratchRepo()
console.log(`scratch repo: ${repo}\nmodel:        ${MODEL}\n`)

const squad = await Squad.create(repo)
await squad.start()

const first = await ask(squad, 'The project codename is FALCON. What colour is the sky?')
console.log(`before edit (one-word rule):  "${first}"  [${first.split(/\s+/).filter(Boolean).length} words]`)

// Reconfigure: new instructions live in the system prompt, so this forces a fresh session.
const bob = squad.profiles().find(p => p.name === 'bob')!
const { restarted } = await squad.updateAgent({
  ...bob,
  instructions: 'You are Bob. Always reply with exactly three words, nothing else.',
})
console.log(`updateAgent restarted the session: ${restarted}`)

const second = await ask(squad, 'What colour is grass?')
console.log(`after edit (three-word rule): "${second}"  [${second.split(/\s+/).filter(Boolean).length} words]`)

const third = await ask(squad, 'What is the project codename I mentioned earlier? Answer in three words.')
console.log(`carried context:              "${third}"`)

const wordsBefore = first.split(/\s+/).filter(Boolean).length
const wordsAfter = second.split(/\s+/).filter(Boolean).length

await squad.shutdown()

const results: Array<[string, boolean]> = [
  ['the edit forced a fresh session', restarted],
  ['old instructions were in force before (1 word)', wordsBefore === 1],
  ['new instructions took effect after (3 words)', wordsAfter === 3],
  ['the restarted agent still knows the earlier context', /falcon/i.test(third)],
]
console.log('\n' + '='.repeat(62))
for (const [label, ok] of results) console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`)
console.log(`cost: $${squad.totalCost().toFixed(4)}`)
console.log('='.repeat(62))
await fs.rm(repo, { recursive: true, force: true })
process.exit(results.every(([, ok]) => ok) ? 0 : 1)
