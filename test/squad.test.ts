import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Squad, GROUP_TAB, NEW_TAB } from '../src/squad.js'
import { draftToProfile } from '../src/draft.js'
import { emptyDraft } from '../src/ui/AgentForm.js'
import { saveState } from '../src/state.js'

const run = promisify(execFile)

/**
 * These exercise the controller without ever calling `start()`, so no agent session is
 * opened and no API call is made.
 */
async function scratchRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'squad-ctrl-'))
  await run('git', ['-C', dir, 'init', '-q'])
  await run('git', ['-C', dir, 'config', 'user.email', 't@e.com'])
  await run('git', ['-C', dir, 'config', 'user.name', 'T'])
  await fs.writeFile(path.join(dir, 'a.txt'), 'x')
  await run('git', ['-C', dir, 'add', '.'])
  await run('git', ['-C', dir, 'commit', '-qm', 'init'])
  return dir
}

function profile(name: string, role = 'Does things') {
  const { profile: p, error } = draftToProfile({
    ...emptyDraft(),
    name,
    role,
    instructions: `You are ${name}.`,
  })
  if (!p) throw new Error(error)
  return p
}

test('a fresh project opens with just the groupchat and the + tab', async () => {
  const squad = await Squad.create(await scratchRepo())
  assert.deepEqual(squad.tabs.map(t => t.id), [GROUP_TAB, NEW_TAB])
  assert.deepEqual(squad.profiles(), [])
  await squad.shutdown()
})

test('adding an agent persists it, opens a tab and gives it a worktree', async () => {
  const repo = await scratchRepo()
  const squad = await Squad.create(repo)
  await squad.addAgent(profile('engineer', 'Writes code'))

  assert.deepEqual(squad.tabs.map(t => t.id), [GROUP_TAB, 'engineer', NEW_TAB])
  assert.ok(squad.hasAgent('engineer'))

  // The profile is on disk, so the next launch picks it up without the TUI.
  const written = await fs.readFile(path.join(repo, '.squad', 'agents', 'engineer.md'), 'utf8')
  assert.match(written, /name: engineer/)

  // It got its own branch.
  assert.equal(squad.workspaces.get('engineer')?.branch, 'squad/engineer')
  const { stdout } = await run('git', ['-C', repo, 'branch', '--format=%(refname:short)'])
  assert.ok(stdout.includes('squad/engineer'))

  // Existing agents baked the old roster into their prompt, so joining is announced.
  const group = squad.entries(GROUP_TAB)
  assert.ok(group.some(e => e.kind === 'chat' && /@engineer .*has joined/.test(e.text)))
  await squad.shutdown()
})

test('an agent added in the TUI is loaded normally on the next launch', async () => {
  const repo = await scratchRepo()
  const first = await Squad.create(repo)
  await first.addAgent(profile('designer', 'Designs things'))
  await first.shutdown()

  const second = await Squad.create(repo)
  assert.deepEqual(second.profiles().map(p => p.name), ['designer'])
  assert.equal(second.workspaces.get('designer')?.branch, 'squad/designer')
  await second.shutdown()
})

test('a duplicate handle is refused', async () => {
  const squad = await Squad.create(await scratchRepo())
  await squad.addAgent(profile('engineer'))
  await assert.rejects(squad.addAgent(profile('engineer')), /already on the squad/)
  await squad.shutdown()
})

test('the transcript and last tab come back on the next launch', async () => {
  const repo = await scratchRepo()
  const first = await Squad.create(repo)
  await first.addAgent(profile('engineer'))
  first.submit(GROUP_TAB, 'Team, build the thing')
  first.markSeen('engineer')
  await first.shutdown()

  const second = await Squad.create(repo)
  assert.equal(second.lastTab, 'engineer')
  const restored = second.entries(GROUP_TAB)
  assert.ok(
    restored.some(e => e.kind === 'chat' && e.text === 'Team, build the thing'),
    'the operator’s message should still be in the groupchat',
  )
  await second.shutdown()
})

test('a persisted session id is handed to the agent for resume', async () => {
  const repo = await scratchRepo()
  const first = await Squad.create(repo)
  await first.addAgent(profile('engineer'))
  await first.shutdown()

  // Simulate a previous launch having recorded a session and some spend.
  await saveState(path.join(repo, '.squad'), {
    version: 1,
    agents: { engineer: { sessionId: 'sess-abc', costUsd: 2.5 } },
  })

  const second = await Squad.create(repo)
  // Lifetime cost carries forward even though a resumed session reports from zero.
  assert.equal(second.costOf('engineer'), 2.5)
  await second.shutdown()
})
