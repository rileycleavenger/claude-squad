import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadState, saveState, TranscriptLog } from '../src/state.js'
import type { Entry } from '../src/types.js'

async function scratch() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'squad-state-'))
}

const chat = (id: string, text: string): Entry => ({ id, ts: Date.now(), kind: 'chat', from: 'engineer', text, mentions: [] })

test('session ids survive a save/load round trip', async () => {
  const dir = await scratch()
  await saveState(dir, {
    version: 1,
    agents: { engineer: { sessionId: 'abc-123', costUsd: 1.25 } },
    lastTab: 'engineer',
  })
  const loaded = await loadState(dir)
  assert.equal(loaded.agents.engineer?.sessionId, 'abc-123')
  assert.equal(loaded.agents.engineer?.costUsd, 1.25)
  assert.equal(loaded.lastTab, 'engineer')
})

test('a missing or corrupt state file starts fresh instead of throwing', async () => {
  const dir = await scratch()
  assert.deepEqual((await loadState(dir)).agents, {})
  await fs.writeFile(path.join(dir, 'state.json'), '{ this is not json')
  assert.deepEqual((await loadState(dir)).agents, {})
})

test('transcripts replay per tab, and a torn line is skipped', async () => {
  const dir = await scratch()
  const log = new TranscriptLog(dir)
  log.open()
  log.append('group', chat('1', 'hello team'))
  log.append('engineer', chat('2', 'on it'))
  log.append('group', chat('3', 'second group line'))
  log.close()
  await new Promise(r => setTimeout(r, 50))

  await fs.appendFile(path.join(dir, 'transcript.jsonl'), '{"tab":"group","entry":\n')

  const replayed = await TranscriptLog.load(dir)
  assert.equal(replayed.get('group')?.length, 2)
  assert.equal(replayed.get('engineer')?.length, 1)
  assert.equal((replayed.get('group')![0] as { text: string }).text, 'hello team')
})

test('replay is capped so a long-running squad does not load forever', async () => {
  const dir = await scratch()
  const log = new TranscriptLog(dir)
  log.open()
  for (let i = 0; i < 400; i++) log.append('group', chat(String(i), `line ${i}`))
  log.close()
  await new Promise(r => setTimeout(r, 80))

  const replayed = await TranscriptLog.load(dir)
  const entries = replayed.get('group')!
  assert.equal(entries.length, 250)
  assert.equal((entries[entries.length - 1] as { text: string }).text, 'line 399', 'keeps the most recent')
})
