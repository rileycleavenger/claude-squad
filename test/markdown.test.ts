import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseInline, stripInline } from '../src/ui/markdown.js'

test('bold markers are removed and the text marked bold', () => {
  assert.deepEqual(parseInline('**done**'), [{ text: 'done', bold: true }])
  assert.deepEqual(parseInline('a **b** c'), [
    { text: 'a ' },
    { text: 'b', bold: true },
    { text: ' c' },
  ])
})

test('inline code is marked and its backticks removed', () => {
  assert.deepEqual(parseInline('run `npm test` now'), [
    { text: 'run ' },
    { text: 'npm test', code: true },
    { text: ' now' },
  ])
})

test('bold can wrap inline code', () => {
  // The exact shape agents write: "**Phase 1 done - `squad/engineer` `b36b322`.**"
  assert.deepEqual(parseInline('**done - `abc`.**'), [
    { text: 'done - ', bold: true },
    { text: 'abc', bold: true, code: true },
    { text: '.', bold: true },
  ])
})

test('markers inside code are literal', () => {
  assert.deepEqual(parseInline('`a ** b`'), [{ text: 'a ** b', code: true }])
})

test('unmatched markers stay as text rather than vanishing', () => {
  assert.deepEqual(parseInline('a ** b'), [{ text: 'a ** b' }])
  assert.deepEqual(parseInline('2 * 3 * 4'), [{ text: '2 * 3 * 4' }])
  assert.deepEqual(parseInline('a ` b'), [{ text: 'a ` b' }])
  assert.deepEqual(parseInline('****'), [{ text: '****' }])
})

test('plain text is returned as a single segment', () => {
  assert.deepEqual(parseInline('nothing special here'), [{ text: 'nothing special here' }])
  assert.deepEqual(parseInline(''), [])
})

test('stripInline gives the text as it will actually be displayed', () => {
  // Height estimates must measure the rendered width, not the source width.
  assert.equal(stripInline('**Phase 0** built `1a06146`'), 'Phase 0 built 1a06146')
  assert.equal(stripInline('**a**').length, 1)
})
