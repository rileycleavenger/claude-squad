import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ConfigError, initSquad, loadConfig, parseProfile } from '../src/config.js'
import { buildRolePrompt } from '../src/prompt.js'

async function scratch(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'squad-config-'))
}

test('init scaffolds profiles that load back cleanly', async () => {
  const dir = await scratch()
  const { created } = await initSquad(dir)
  assert.ok(created.length >= 5, 'squad.json plus four profiles')

  const config = await loadConfig(dir)
  assert.deepEqual(
    config.agents.map(a => a.name).sort(),
    ['architect', 'engineer', 'marketing', 'product'],
  )
  assert.equal(config.defaultModel, 'claude-opus-5')
  assert.equal(config.useWorktrees, true)
  for (const agent of config.agents) {
    assert.ok(agent.instructions.length > 50, `${agent.name} should have real instructions`)
    assert.ok(agent.role.length > 0)
  }
})

test('init is idempotent and never clobbers edits', async () => {
  const dir = await scratch()
  await initSquad(dir)
  const profile = path.join(dir, '.squad', 'agents', 'engineer.md')
  const edited = (await fs.readFile(profile, 'utf8')) + '\nMy custom rule.\n'
  await fs.writeFile(profile, edited)

  const second = await initSquad(dir)
  assert.equal(second.created.length, 0)
  assert.ok(second.skipped.length >= 5)
  assert.equal(await fs.readFile(profile, 'utf8'), edited)
})

test('a bad profile fails with a message that says what to fix', () => {
  assert.throws(
    () => parseProfile('bad.md', '---\nname: "not a handle!"\n---\nbody', 0),
    (err: Error) => err instanceof ConfigError && /@mention/.test(err.message),
  )
  assert.throws(
    () => parseProfile('bad.md', '---\nname: ok\n---\n   \n', 0),
    (err: Error) => err instanceof ConfigError && /body is empty/.test(err.message),
  )
  assert.throws(
    () => parseProfile('bad.md', '---\nname: ok\neffort: turbo\n---\nbody', 0),
    (err: Error) => err instanceof ConfigError && /effort/.test(err.message),
  )
})

test('loadConfig rejects two profiles claiming the same handle', async () => {
  const dir = await scratch()
  const agents = path.join(dir, '.squad', 'agents')
  await fs.mkdir(agents, { recursive: true })
  await fs.writeFile(path.join(agents, 'a.md'), '---\nname: dup\n---\nfirst agent instructions here\n')
  await fs.writeFile(path.join(agents, 'b.md'), '---\nname: dup\n---\nsecond agent instructions here\n')
  await assert.rejects(loadConfig(dir), (err: Error) => /Duplicate agent name/.test(err.message))
})

test('a project with no squad loads as an empty squad, not an error', async () => {
  // `squad` in a fresh project must open the TUI so the first agent can be added from
  // the + tab, rather than refusing to start.
  const dir = await scratch()
  const config = await loadConfig(dir)
  assert.deepEqual(config.agents, [])
  assert.equal(config.defaultModel, 'claude-opus-5')
  await fs.access(path.join(dir, '.squad', 'agents'))
})

test('the role prompt carries the roster, the workspace and the protocol', async () => {
  const dir = await scratch()
  await initSquad(dir)
  const config = await loadConfig(dir)
  const me = config.agents.find(a => a.name === 'engineer')!

  const prompt = buildRolePrompt({
    me,
    roster: config.agents,
    workdir: '/tmp/wt/engineer',
    branch: 'squad/engineer',
  })

  assert.ok(prompt.includes(me.instructions), 'role instructions come first')
  assert.ok(prompt.includes('@architect'), 'teammates are listed')
  assert.ok(!/^- `@engineer`/m.test(prompt), 'the agent is not listed as its own teammate')
  assert.ok(prompt.includes('squad/engineer'), 'the branch is named')
  assert.ok(prompt.includes('post_to_groupchat'), 'the tools are described')
  assert.ok(prompt.includes('cannot see your'), 'worktree isolation is explained')
})

test('without a branch the prompt warns about the shared checkout', async () => {
  const dir = await scratch()
  await initSquad(dir)
  const config = await loadConfig(dir)
  const prompt = buildRolePrompt({
    me: config.agents[0]!,
    roster: config.agents,
    workdir: '/tmp/shared',
  })
  assert.ok(prompt.includes('share'), 'a shared checkout must be called out')
})
