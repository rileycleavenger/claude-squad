/**
 * End-to-end check of the full squad: two real agents, isolated worktrees, and the
 * groupchat carrying a message from the operator to both of them and back.
 *
 *   npx tsx src/dev/integration.ts
 *
 * Uses a cheap model by default; override with SQUAD_SMOKE_MODEL.
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

const PROFILES: Record<string, string> = {
  'alpha.md': `---
name: alpha
displayName: Alpha
role: Writes the greeting file
color: green
effort: low
---
You are Alpha. You are terse.

When the operator asks the squad to start, do exactly two things and then stop:
1. Write a file \`alpha.txt\` in your working directory containing the word "alpha".
2. Post one short message to the groupchat mentioning @beta saying your file is written.

Do not do anything else. Do not wait for messages afterwards.
`,
  'beta.md': `---
name: beta
displayName: Beta
role: Writes the response file
color: cyan
effort: low
---
You are Beta. You are terse.

When @alpha tells you their file is written, do exactly two things and then stop:
1. Write a file \`beta.txt\` in your working directory containing the word "beta".
2. Post one short message to the groupchat saying you are done.

Do not do anything else. Do not wait for messages afterwards.
`,
}

async function scratchRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'squad-e2e-'))
  await run('git', ['-C', dir, 'init', '-q'])
  await run('git', ['-C', dir, 'config', 'user.email', 'e2e@example.com'])
  await run('git', ['-C', dir, 'config', 'user.name', 'E2E'])
  await fs.writeFile(path.join(dir, 'README.md'), '# scratch\n')
  await run('git', ['-C', dir, 'add', '.'])
  await run('git', ['-C', dir, 'commit', '-qm', 'init'])

  const agentsDir = path.join(dir, '.squad', 'agents')
  await fs.mkdir(agentsDir, { recursive: true })
  for (const [file, content] of Object.entries(PROFILES)) {
    await fs.writeFile(path.join(agentsDir, file), content)
  }
  await fs.writeFile(
    path.join(dir, '.squad', 'squad.json'),
    JSON.stringify({ defaultModel: MODEL, defaultEffort: 'low', defaultBudgetUsd: 2 }, null, 2),
  )
  return dir
}

async function main() {
  const repoPath = await scratchRepo()
  console.log(`scratch repo: ${repoPath}`)
  console.log(`model:        ${MODEL}\n`)

  const squad = await Squad.create(repoPath)
  for (const warning of squad.warnings) console.log(`warning: ${warning}`)

  for (const [name, ws] of squad.workspaces) {
    console.log(`  @${name} -> ${ws.branch ?? 'shared'}`)
  }
  console.log()

  squad.on('update', () => {})
  await squad.start()

  squad.submit(GROUP_TAB, 'Team, begin. Follow your instructions exactly.')

  // Wait until both agents have posted to the groupchat, or we run out of patience.
  const deadline = Date.now() + 240_000
  const posters = new Set<string>()
  while (Date.now() < deadline) {
    for (const entry of squad.entries(GROUP_TAB) as Entry[]) {
      if (entry.kind === 'chat' && entry.from !== 'you') posters.add(entry.from)
    }
    if (posters.size >= 2) break
    await new Promise(r => setTimeout(r, 1000))
  }

  console.log('--- #groupchat ---')
  for (const entry of squad.entries(GROUP_TAB) as Entry[]) {
    if (entry.kind === 'chat') console.log(`  ${entry.from}: ${entry.text.replace(/\s+/g, ' ').slice(0, 100)}`)
    else if (entry.kind === 'notice') console.log(`  (squad) ${entry.text.slice(0, 100)}`)
  }
  console.log()

  const alphaWs = squad.workspaces.get('alpha')!
  const betaWs = squad.workspaces.get('beta')!
  const wrote = async (p: string) => {
    try {
      await fs.access(p)
      return true
    } catch {
      return false
    }
  }

  const alphaFile = await wrote(path.join(alphaWs.path, 'alpha.txt'))
  const betaFile = await wrote(path.join(betaWs.path, 'beta.txt'))
  // Isolation: alpha's file must NOT be visible in beta's worktree.
  const leaked = await wrote(path.join(betaWs.path, 'alpha.txt'))

  await squad.shutdown()

  const results: Array<[string, boolean]> = [
    ['operator message reached the squad via #groupchat', posters.size >= 1],
    ['both agents posted back to #groupchat', posters.size >= 2],
    ['@alpha wrote a file in its own worktree', alphaFile],
    ['@beta acted on alpha’s @mention and wrote its file', betaFile],
    ['worktrees are isolated (alpha.txt absent from beta)', !leaked],
    ['agents got separate branches', alphaWs.branch !== betaWs.branch],
  ]

  console.log('='.repeat(62))
  for (const [label, ok] of results) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`)
  }
  console.log(`cost: $${squad.totalCost().toFixed(4)}`)
  console.log('='.repeat(62))
  console.log(`\nscratch repo left for inspection: ${repoPath}`)

  process.exit(results.every(([, ok]) => ok) ? 0 : 1)
}

main().catch(err => {
  console.error('integration test failed:', err)
  process.exit(1)
})
