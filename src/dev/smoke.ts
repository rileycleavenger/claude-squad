/**
 * Headless plumbing check for the agent session loop.
 *
 * Proves the one thing the whole design rests on: that a `query()` fed by a
 * never-ending AsyncIterable stays open as ONE conversation across several turns,
 * rather than starting a fresh context each time. Turn 2 asking about turn 1 is the test.
 *
 *   npx tsx src/dev/smoke.ts
 *
 * Uses a cheap model by default since this exercises plumbing, not model quality.
 * Override with SQUAD_SMOKE_MODEL.
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { MessageBus } from '../bus.js'
import { AgentRunner } from '../agent.js'
import { provisionWorkspaces } from '../worktree.js'
import type { AgentProfile, SquadConfig } from '../types.js'

const run = promisify(execFile)
const MODEL = process.env.SQUAD_SMOKE_MODEL ?? 'claude-haiku-4-5'

async function scratchRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'squad-smoke-'))
  await run('git', ['-C', dir, 'init', '-q'])
  await run('git', ['-C', dir, 'config', 'user.email', 'smoke@example.com'])
  await run('git', ['-C', dir, 'config', 'user.name', 'Smoke Test'])
  await fs.writeFile(path.join(dir, 'README.md'), '# scratch\n')
  await run('git', ['-C', dir, 'add', '.'])
  await run('git', ['-C', dir, 'commit', '-qm', 'init'])
  return dir
}

function waitForIdle(runner: AgentRunner, label: string, timeoutMs = 180_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      runner.off('status', onStatus)
      reject(new Error(`timed out waiting for ${label}`))
    }, timeoutMs)
    const onStatus = (status: { kind: string; message?: string }) => {
      if (status.kind === 'idle') {
        clearTimeout(timer)
        runner.off('status', onStatus)
        resolve()
      } else if (status.kind === 'error' || status.kind === 'stopped') {
        clearTimeout(timer)
        runner.off('status', onStatus)
        reject(new Error(`${label}: agent ${status.kind}${status.message ? ` - ${status.message}` : ''}`))
      }
    }
    runner.on('status', onStatus)
  })
}

async function main() {
  const repoPath = await scratchRepo()
  console.log(`scratch repo: ${repoPath}`)
  console.log(`model:        ${MODEL}\n`)

  const profile: AgentProfile = {
    name: 'tester',
    displayName: 'Tester',
    role: 'Smoke test agent',
    color: 'green',
    model: MODEL,
    effort: 'low',
    instructions: 'You are a terse test agent. Answer in one short sentence. Do not use tools.',
    capabilities: [],
    budgetUsd: 1,
  }

  const config: SquadConfig = {
    repoPath,
    squadDir: path.join(repoPath, '.squad'),
    agents: [profile],
    defaultModel: MODEL,
    defaultEffort: 'low',
    defaultBudgetUsd: 1,
    maxWakesPerMinute: 6,
    maxRelayDepth: 8,
    useWorktrees: true,
  }

  const { workspaces, warning } = await provisionWorkspaces(repoPath, ['tester'], true)
  if (warning) console.log(`warning: ${warning}`)
  const workspace = workspaces.get('tester')!
  console.log(`workspace:    ${workspace.path} (${workspace.branch ?? 'shared'})\n`)

  const bus = new MessageBus({ maxWakesPerMinute: 6, maxRelayDepth: 8 })
  const runner = new AgentRunner({
    profile,
    config,
    bus,
    directory: { profiles: () => [profile], statusOf: () => 'idle' },
    workdir: workspace.path,
    branch: workspace.branch,
  })

  const replies: string[] = []
  runner.on('entry', (entry: { kind: string; text?: string; summary?: string }) => {
    if (entry.kind === 'chat') {
      replies.push(entry.text ?? '')
      console.log(`  tester: ${entry.text}`)
    } else if (entry.kind === 'tool') {
      console.log(`  tester: [${entry.summary}]`)
    } else if (entry.kind === 'error') {
      console.log(`  ERROR:  ${entry.text}`)
    }
  })

  bus.register({ name: 'tester', deliver: text => runner.send(text) })
  runner.start()
  console.log('session started\n')

  console.log('turn 1 -> "Remember the number 42..."')
  runner.send('Remember the number 42. Reply with just "ok".')
  await waitForIdle(runner, 'turn 1')

  console.log('\nturn 2 -> "What number did I ask you to remember?"')
  const before = replies.length
  runner.send('What number did I ask you to remember? Reply with just the number.')
  await waitForIdle(runner, 'turn 2')

  console.log('\nturn 3 -> checking the worktree is writable')
  runner.send('Write a file called note.txt in the current directory containing the number you remembered, then confirm.')
  await waitForIdle(runner, 'turn 3')

  const turn2 = replies.slice(before).join(' ')
  const remembered = turn2.includes('42')
  let wroteFile = false
  try {
    const content = await fs.readFile(path.join(workspace.path, 'note.txt'), 'utf8')
    wroteFile = content.includes('42')
  } catch {
    wroteFile = false
  }

  await runner.stop()
  bus.close()

  console.log(`\n${'='.repeat(58)}`)
  console.log(`session continuity (turn 2 recalled turn 1): ${remembered ? 'PASS' : 'FAIL'}`)
  console.log(`worktree is writable (note.txt written):     ${wroteFile ? 'PASS' : 'FAIL'}`)
  console.log(`cost: $${runner.getCost().toFixed(4)}`)
  console.log(`${'='.repeat(58)}`)
  console.log(`\nleaving scratch repo for inspection: ${repoPath}`)

  process.exit(remembered && wroteFile ? 0 : 1)
}

main().catch(err => {
  console.error('smoke test failed:', err)
  process.exit(1)
})
