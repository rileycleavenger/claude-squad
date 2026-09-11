/**
 * End-to-end check that a capability really equips an agent: the browser capability
 * should give it working Playwright tools, its own isolated browser profile, and the
 * skill that teaches it how to drive one.
 *
 *   npx tsx src/dev/capability-e2e.ts
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

const PROFILE = `---
name: surfer
displayName: Surfer
role: Browses the web
color: cyan
effort: low
capabilities: [browser, research]
---
You are terse. Do exactly what you are asked and then stop.
`

async function scratchRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'squad-cap-e2e-'))
  await run('git', ['-C', dir, 'init', '-q'])
  await run('git', ['-C', dir, 'config', 'user.email', 'e2e@example.com'])
  await run('git', ['-C', dir, 'config', 'user.name', 'E2E'])
  await fs.writeFile(path.join(dir, 'README.md'), '# scratch\n')
  await run('git', ['-C', dir, 'add', '.'])
  await run('git', ['-C', dir, 'commit', '-qm', 'init'])

  const agents = path.join(dir, '.squad', 'agents')
  await fs.mkdir(agents, { recursive: true })
  await fs.writeFile(path.join(agents, 'surfer.md'), PROFILE)
  await fs.writeFile(
    path.join(dir, '.squad', 'squad.json'),
    JSON.stringify({ defaultModel: MODEL, defaultEffort: 'low', defaultBudgetUsd: 3 }, null, 2),
  )
  return dir
}

const repo = await scratchRepo()
console.log(`scratch repo: ${repo}`)
console.log(`model:        ${MODEL}\n`)

const squad = await Squad.create(repo)
for (const w of squad.warnings) console.log(`warning: ${w}`)
await squad.start()

const entries: Entry[] = []
squad.on('update', () => {})

squad.submit(
  'surfer',
  'Open https://example.com in the browser and tell me the exact text of the page’s main heading. Then stop.',
)

const deadline = Date.now() + 300_000
let answered = false
while (Date.now() < deadline && !answered) {
  await new Promise(r => setTimeout(r, 1500))
  const tab = squad.entries('surfer') as Entry[]
  entries.length = 0
  entries.push(...tab)
  answered =
    squad.statusOf('surfer').kind === 'idle' &&
    tab.some(e => e.kind === 'chat' && /example domain/i.test(e.text))
}

console.log('--- @surfer transcript ---')
for (const e of entries) {
  if (e.kind === 'chat') console.log(`  ${e.from}: ${e.text.replace(/\s+/g, ' ').slice(0, 140)}`)
  else if (e.kind === 'tool') console.log(`  ⚙ ${e.summary.slice(0, 120)}`)
  else if (e.kind === 'error') console.log(`  ✕ ${e.text.slice(0, 160)}`)
}

const usedBrowserTool = entries.some(e => e.kind === 'tool' && /playwright|browser|navigate/i.test(e.summary))
const gotHeading = entries.some(e => e.kind === 'chat' && /example domain/i.test(e.text))
const noMcpFailure = !entries.some(e => e.kind === 'error' && /tool server is/.test(e.text))
const noForeignServers = !entries.some(e => e.kind === 'error' && /claude\.ai/.test(e.text))

const agentDir = path.join(repo, '.squad', 'data', 'surfer')
let ownProfile = false
try {
  await fs.access(path.join(agentDir, 'browser'))
  ownProfile = true
} catch {
  ownProfile = false
}

await squad.shutdown()

const results: Array<[string, boolean]> = [
  ['the playwright MCP server started for the agent', noMcpFailure],
  ['no unrelated MCP servers leaked into the agent', noForeignServers],
  ['the agent actually used a browser tool', usedBrowserTool],
  ['it read the real page and reported the heading', gotHeading],
  ['it got its own isolated browser profile dir', ownProfile],
]

console.log('\n' + '='.repeat(60))
for (const [label, ok] of results) console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`)
console.log(`cost: $${squad.totalCost().toFixed(4)}`)
console.log('='.repeat(60))
console.log(`\nscratch repo: ${repo}`)
process.exit(results.every(([, ok]) => ok) ? 0 : 1)
