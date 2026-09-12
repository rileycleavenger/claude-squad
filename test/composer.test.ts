import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  backspace,
  deleteForward,
  empty,
  inputHeight,
  insert,
  isMultiline,
  layoutInput,
  lineEnd,
  lineStart,
  moveLeft,
  moveRight,
  moveRow,
  moveWordLeft,
  moveWordRight,
  withText,
} from '../src/ui/composer.js'

const type = (text: string) => insert(empty, text)

test('an empty composer is one empty row with the caret at the origin', () => {
  const layout = layoutInput('', 0, 20)
  assert.deepEqual(layout.lines, [{ text: '', start: 0 }])
  assert.equal(layout.row, 0)
  assert.equal(layout.col, 0)
})

test('a long line wraps at a space, and no row starts with one', () => {
  // The whole point of the box: text that runs past the edge of the window has to come
  // back onto the next row instead of scrolling sideways out of sight.
  const text = 'the quick brown fox jumps over the lazy dog'
  const { lines } = layoutInput(text, 0, 12)
  assert.ok(lines.length > 1)
  for (const line of lines) {
    assert.ok(line.text.replace(/ +$/, '').length <= 12, `"${line.text}" is wider than the box`)
    assert.ok(!line.text.startsWith(' '), `"${line.text}" starts with a stray space`)
  }
  // Nothing is dropped or duplicated on the way.
  assert.equal(lines.map(l => l.text).join(''), text)
})

test('a word too long for the box is split rather than overflowing it', () => {
  const { lines } = layoutInput('supercalifragilistic', 0, 6)
  assert.deepEqual(lines.map(l => l.text), ['superc', 'alifra', 'gilist', 'ic'])
  assert.equal(lines.map(l => l.text).join(''), 'supercalifragilistic')
})

test('explicit newlines start a new row even when there is room', () => {
  const { lines } = layoutInput('a\n\nb', 0, 40)
  assert.deepEqual(lines.map(l => l.text), ['a', '', 'b'])
  assert.deepEqual(lines.map(l => l.start), [0, 2, 3])
})

test('the caret lands on the character it is actually on, across a wrap', () => {
  const text = 'hello world again'
  const { lines, row, col } = layoutInput(text, text.indexOf('again'), 12)
  assert.equal(lines[row]!.text.slice(col), 'again')
})

test('typing inserts at the caret rather than at the end', () => {
  let state = withText('helo')
  state = { ...state, cursor: 3 }
  state = insert(state, 'l')
  assert.equal(state.text, 'hello')
  assert.equal(state.cursor, 4)
})

test('backspace and delete act either side of the caret', () => {
  const state = { text: 'abcd', cursor: 2 }
  assert.deepEqual(backspace(state), { text: 'acd', cursor: 1 })
  assert.deepEqual(deleteForward(state), { text: 'abd', cursor: 2 })
  // Neither runs off the end of the text.
  assert.deepEqual(backspace({ text: 'a', cursor: 0 }), { text: 'a', cursor: 0 })
  assert.deepEqual(deleteForward({ text: 'a', cursor: 1 }), { text: 'a', cursor: 1 })
})

test('the caret stops at both ends instead of going negative', () => {
  assert.equal(moveLeft({ text: 'ab', cursor: 0 }).cursor, 0)
  assert.equal(moveRight({ text: 'ab', cursor: 2 }).cursor, 2)
})

test('word motion crosses one word at a time', () => {
  const text = 'ship it when ready'
  assert.equal(moveWordLeft({ text, cursor: text.length }).cursor, text.indexOf('ready'))
  assert.equal(moveWordRight({ text, cursor: 0 }).cursor, 'ship'.length)
})

test('line start and end respect explicit newlines', () => {
  const text = 'first\nsecond'
  assert.equal(lineStart({ text, cursor: 9 }).cursor, 6)
  assert.equal(lineEnd({ text, cursor: 2 }).cursor, 5)
})

test('up and down move by rendered row, so a wrapped line takes several presses', () => {
  const text = 'the quick brown fox jumps over the lazy dog'
  const width = 12
  const rows = inputHeight(text, width)
  assert.ok(rows >= 3, 'the fixture needs to wrap for this to mean anything')

  let state = { text, cursor: text.length }
  for (let i = 0; i < rows - 1; i++) state = moveRow(state, -1, width)
  assert.equal(layoutInput(state.text, state.cursor, width).row, 0, 'reached the top row')
  // And the top row is as far as it goes.
  assert.deepEqual(moveRow(state, -1, width), state)
})

test('up and down keep the column, clamping to a row too short to hold it', () => {
  const text = 'abcdefgh\nijklmnop'
  const down = moveRow({ text, cursor: 5 }, 1, 40)
  assert.equal(layoutInput(text, down.cursor, 40).col, 5, 'a row that long keeps the column')

  // There is no goal column carried between presses, so a short row is where the caret
  // stays - the same as moving there by hand.
  const short = moveRow({ text: 'abcdefgh\nij', cursor: 5 }, 1, 40)
  assert.equal(short.cursor, 'abcdefgh\nij'.length)
})

test('up and down go nowhere when there is only one row', () => {
  const state = type('short')
  assert.deepEqual(moveRow(state, -1, 40), state)
  assert.deepEqual(moveRow(state, 1, 40), state)
  assert.equal(isMultiline(state.text, 40), false)
})

test('isMultiline is true once the text has wrapped, not just when it has newlines', () => {
  // This is what decides whether up/down edits the draft or steps through history: a
  // single long line that wrapped is still several rows on screen.
  assert.equal(isMultiline('a'.repeat(50), 20), true)
  assert.equal(isMultiline('a\nb', 80), true)
  assert.equal(isMultiline('a b c', 80), false)
})

test('layout survives a box too narrow to render into', () => {
  // A host that reports no width must not make this throw or loop forever.
  for (const width of [0, -5, 1]) {
    const { lines } = layoutInput('hi there', 3, width)
    assert.ok(lines.length > 0)
    // Trailing spaces are allowed to sit in the margin; visible text is not.
    assert.ok(lines.every(l => l.text.replace(/ +$/, '').length <= Math.max(1, width)))
    assert.equal(lines.map(l => l.text).join(''), 'hi there', 'nothing is lost')
  }
})
