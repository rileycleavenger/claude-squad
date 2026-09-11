import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { draftToProfile, profileToDraft } from '../src/draft.js'
import { emptyDraft } from '../src/ui/AgentForm.js'
import { parseProfile, serializeProfile, writeProfile } from '../src/config.js'
import { listTemplates, saveToLibrary } from '../src/library.js'

function filled(overrides: Partial<ReturnType<typeof emptyDraft>> = {}) {
  return { ...emptyDraft(), name: 'qa', role: 'Tests things', instructions: 'You test things.', ...overrides }
}

test('a valid draft becomes a profile with sensible defaults', () => {
  const { profile, error } = draftToProfile(filled())
  assert.equal(error, undefined)
  assert.equal(profile!.name, 'qa')
  assert.equal(profile!.displayName, 'qa', 'display name falls back to the handle')
  assert.equal(profile!.model, undefined, 'a blank model means "use the squad default"')
  assert.equal(profile!.budgetUsd, undefined)
})

test('a draft is rejected with a message a user can act on', () => {
  assert.match(draftToProfile(filled({ name: '' })).error!, /handle is required/)
  assert.match(draftToProfile(filled({ instructions: '' })).error!, /Instructions are required/)
  assert.match(draftToProfile(filled({ name: 'not a handle' })).error!, /@mention/)
  assert.match(draftToProfile(filled({ effort: 'turbo' })).error!, /effort/)
  assert.match(draftToProfile(filled({ budgetUsd: '-3' })).error!, /positive number/)
})

test('a draft round-trips through markdown unchanged', () => {
  const draft = filled({ displayName: 'QA', model: 'claude-sonnet-5', effort: 'high', budgetUsd: '4.5' })
  const { profile } = draftToProfile(draft)
  const reparsed = parseProfile('qa.md', serializeProfile(profile!), 0)
  assert.deepEqual(reparsed, profile)
  // And the form can be reopened from it.
  assert.deepEqual(profileToDraft(reparsed).name, 'qa')
  assert.equal(profileToDraft(reparsed).budgetUsd, '4.5')
})

test('multi-line instructions survive serialization', () => {
  const body = 'Line one.\n\nLine two with a --- divider.\nLine three.'
  const { profile } = draftToProfile(filled({ instructions: body }))
  const reparsed = parseProfile('qa.md', serializeProfile(profile!), 0)
  assert.equal(reparsed.instructions, body)
})

test('the picker offers built-ins, library entries and unloaded project profiles', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'squad-home-'))
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'squad-repo-'))
  const squadDir = path.join(repo, '.squad')
  const realHome = process.env.HOME
  process.env.HOME = home
  try {
    const { profile: saved } = draftToProfile(filled({ name: 'reviewer', role: 'Reviews code' }))
    await saveToLibrary(saved!)

    const { profile: onDisk } = draftToProfile(filled({ name: 'dormant', role: 'Not running' }))
    await writeProfile(squadDir, onDisk!)
    const { profile: running } = draftToProfile(filled({ name: 'active', role: 'Running now' }))
    await writeProfile(squadDir, running!)

    const templates = await listTemplates(squadDir, ['active'])
    const bySource = (source: string) => templates.filter(t => t.source === source).map(t => t.profile.name)

    assert.deepEqual(bySource('builtin').sort(), ['architect', 'engineer', 'marketing', 'product'])
    assert.deepEqual(bySource('library'), ['reviewer'])
    assert.deepEqual(bySource('project'), ['dormant'], 'an already-running agent is not offered again')
  } finally {
    if (realHome === undefined) delete process.env.HOME
    else process.env.HOME = realHome
  }
})
