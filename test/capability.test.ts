import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  CapabilityError,
  loadCapabilities,
  materializeServers,
  parseCapability,
  skillNameFor,
} from '../src/capability.js'
import { writeCapabilityPlugin, pluginPath } from '../src/plugin.js'
import { resolveSecret, resolveSecretsIn, redact, SecretError } from '../src/secrets.js'

const ctx = (agent: string) => ({
  agentName: agent,
  agentDir: `/repo/.squad/data/${agent}`,
  repoPath: '/repo',
  squadDir: '/repo/.squad',
})

test('built-in capabilities all parse and declare what they need', async () => {
  const caps = await loadCapabilities('/nonexistent')
  assert.deepEqual(
    [...caps.keys()].sort(),
    ['browser', 'chrome-devtools', 'email', 'github', 'notify', 'research'],
  )
  for (const [name, c] of caps) {
    assert.ok(c.description.length > 10, `${name} needs a real description`)
    assert.ok(c.instructions.length > 200, `${name} needs real technique content`)
    assert.ok(c.allowedTools.length > 0, `${name} should pre-approve some tools`)
  }
})

test('a project capability overrides a built-in of the same name', async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'squad-cap-'))
  const dir = path.join(repo, '.squad', 'capabilities')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(
    path.join(dir, 'browser.md'),
    '---\nname: browser\ndescription: My own browser wiring\nallowedTools: [Bash]\n---\n\nDo it my way, with enough text to count as real instructions for the parser.\n',
  )
  const caps = await loadCapabilities(path.join(repo, '.squad'))
  assert.equal(caps.get('browser')!.source, 'project')
  assert.equal(caps.get('browser')!.description, 'My own browser wiring')
  assert.equal(caps.get('research')!.source, 'builtin', 'other built-ins are untouched')
})

test('each agent gets its own browser profile path', async () => {
  const caps = await loadCapabilities('/nonexistent')
  const browser = caps.get('browser')!
  const a = await materializeServers(browser, ctx('alice'))
  const b = await materializeServers(browser, ctx('bob'))

  const argsOf = (r: typeof a) => (r.servers.playwright as { args: string[] }).args.join(' ')
  assert.match(argsOf(a), /--user-data-dir=\/repo\/\.squad\/data\/alice\/browser/)
  assert.match(argsOf(b), /--user-data-dir=\/repo\/\.squad\/data\/bob\/browser/)
  // A shared persistent profile can only be driven by one browser at a time, so parallel
  // agents must never be handed the same one.
  assert.notEqual(argsOf(a), argsOf(b))
})

test('an unconfigured server is skipped with a warning rather than started broken', async () => {
  delete process.env.SQUAD_EMAIL_MCP_COMMAND
  const caps = await loadCapabilities('/nonexistent')
  const result = await materializeServers(caps.get('email')!, ctx('assistant'))
  assert.deepEqual(result.servers, {})
  assert.equal(result.warnings.length, 1)
  assert.match(result.warnings[0]!, /email/)
})

test('env templating fills a configured command', async () => {
  process.env.SQUAD_EMAIL_MCP_COMMAND = '/usr/local/bin/my-email-mcp'
  try {
    const caps = await loadCapabilities('/nonexistent')
    const result = await materializeServers(caps.get('email')!, ctx('assistant'))
    assert.equal((result.servers.email as { command: string }).command, '/usr/local/bin/my-email-mcp')
    assert.deepEqual(result.warnings, [])
  } finally {
    delete process.env.SQUAD_EMAIL_MCP_COMMAND
  }
})

test('secrets resolve into the server environment, never into args', async () => {
  process.env.SQUAD_TEST_TOKEN = 'super-secret-value'
  try {
    const cap = parseCapability(
      'x.md',
      `---
name: x
description: Test capability
mcpServers:
  thing:
    command: /bin/echo
    args: ["--agent={{agentName}}"]
    env:
      API_TOKEN: "{{secret:env:SQUAD_TEST_TOKEN}}"
---

Instructions long enough to satisfy the parser for this capability under test.
`,
      'project',
    )
    const { servers, secrets } = await materializeServers(cap, ctx('alice'))
    const server = servers.thing as { args: string[]; env: Record<string, string> }
    assert.equal(server.env.API_TOKEN, 'super-secret-value')
    assert.deepEqual(server.args, ['--agent=alice'])
    assert.ok(secrets.includes('super-secret-value'))
    // The serialized config must not leak the secret anywhere but env.
    assert.equal(JSON.stringify(server.args).includes('super-secret'), false)
  } finally {
    delete process.env.SQUAD_TEST_TOKEN
  }
})

test('a missing secret fails with an actionable message', async () => {
  delete process.env.DEFINITELY_NOT_SET
  await assert.rejects(resolveSecret('env:DEFINITELY_NOT_SET'), (e: Error) => e instanceof SecretError)
  await assert.rejects(resolveSecret('keychain:squad-does-not-exist'), (e: Error) =>
    /add-generic-password/.test(e.message),
  )
})

test('resolveSecretsIn substitutes every reference', async () => {
  process.env.A_TOKEN = 'aaa'
  process.env.B_TOKEN = 'bbb'
  try {
    assert.equal(await resolveSecretsIn('{{secret:A_TOKEN}}:{{secret:env:B_TOKEN}}'), 'aaa:bbb')
  } finally {
    delete process.env.A_TOKEN
    delete process.env.B_TOKEN
  }
})

test('redact scrubs resolved secrets from user-visible text', () => {
  const out = redact('token is hunter2hunter2 ok', ['hunter2hunter2'])
  assert.equal(out.includes('hunter2hunter2'), false)
  // Short values are left alone: redacting them would mangle unrelated text.
  assert.equal(redact('abc', ['abc']), 'abc')
})

test('a malformed capability is rejected with a useful message', () => {
  assert.throws(
    () => parseCapability('b.md', '---\nname: b\n---\n', 'project'),
    (e: Error) => e instanceof CapabilityError && /body is empty/.test(e.message),
  )
  assert.throws(
    () => parseCapability('b.md', '---\nname: b\nmcpServers:\n  x:\n    args: []\n---\nlots of text here\n', 'project'),
    (e: Error) => /needs a "command"/.test(e.message),
  )
})

test('capabilities are written out as a loadable skill plugin', async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'squad-plug-'))
  const squadDir = path.join(repo, '.squad')
  const caps = await loadCapabilities(squadDir)
  const root = await writeCapabilityPlugin(squadDir, caps.values())

  assert.equal(root, pluginPath(squadDir))
  const manifest = JSON.parse(await fs.readFile(path.join(root, '.claude-plugin', 'plugin.json'), 'utf8'))
  assert.equal(manifest.name, 'squad')
  assert.equal(skillNameFor('browser'), 'squad:browser')

  const skill = await fs.readFile(path.join(root, 'skills', 'browser', 'SKILL.md'), 'utf8')
  assert.match(skill, /^---\nname: browser/)
  assert.match(skill, /accessibility tree/)

  // Rebuilding drops a capability that no longer exists.
  await writeCapabilityPlugin(squadDir, [caps.get('research')!])
  await assert.rejects(fs.access(path.join(root, 'skills', 'browser', 'SKILL.md')))
  await fs.access(path.join(root, 'skills', 'research', 'SKILL.md'))
})
