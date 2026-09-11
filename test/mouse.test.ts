import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DISABLE_MOUSE,
  ENABLE_MOUSE,
  hitTest,
  isLeftClick,
  parseMouse,
  type Rect,
} from '../src/ui/mouse.js'

const ESC = String.fromCharCode(27)

test('an SGR mouse report parses to zero-based coordinates', () => {
  // Terminals report 1-based columns and rows; layout metrics are 0-based.
  assert.deepEqual(parseMouse(`${ESC}[<0;16;2M`), { button: 0, col: 15, row: 1, kind: 'press' })
  // Ink strips the leading escape before handing input to useInput.
  assert.deepEqual(parseMouse('[<0;16;2M'), { button: 0, col: 15, row: 1, kind: 'press' })
  assert.deepEqual(parseMouse('[<0;16;2m'), { button: 0, col: 15, row: 1, kind: 'release' })
})

test('ordinary keystrokes are not mistaken for mouse reports', () => {
  for (const input of ['a', 'hello', '', '[', '[<', '[<0;16;2', 'x[<0;16;2M', '[<a;b;cM']) {
    assert.equal(parseMouse(input), undefined, `${JSON.stringify(input)} should not parse`)
  }
})

test('wheel and right-click events parse but are not left clicks', () => {
  // They must still parse, so they get swallowed rather than typed into the composer.
  const wheelUp = parseMouse('[<64;30;10M')!
  const rightClick = parseMouse('[<2;30;10M')!
  const release = parseMouse('[<0;30;10m')!
  assert.equal(wheelUp.button, 64)
  assert.equal(isLeftClick(wheelUp), false)
  assert.equal(isLeftClick(rightClick), false)
  assert.equal(isLeftClick(release), false, 'only the press should act, not the release')
  assert.equal(isLeftClick(parseMouse('[<0;30;10M')!), true)
})

test('hit testing covers a tab and stops at its edges', () => {
  const tab: Rect = { left: 13, top: 1, width: 7, height: 1 }
  assert.equal(hitTest(tab, 13, 1), true, 'left edge is inside')
  assert.equal(hitTest(tab, 19, 1), true, 'right edge is inside')
  assert.equal(hitTest(tab, 12, 1), false, 'one column left is outside')
  assert.equal(hitTest(tab, 20, 1), false, 'one column past the width is outside')
  assert.equal(hitTest(tab, 16, 0), false, 'the row above is outside')
  assert.equal(hitTest(tab, 16, 2), false, 'the row below is outside')
})

test('a zero-height box still covers its own row', () => {
  // Ink can report height 0 before a layout pass settles; a tab should stay clickable.
  assert.equal(hitTest({ left: 0, top: 1, width: 12, height: 0 }, 5, 1), true)
})

test('enable and disable sequences are exact inverses', () => {
  assert.equal(ENABLE_MOUSE, `${ESC}[?1049h${ESC}[?1000h${ESC}[?1006h`)
  assert.equal(DISABLE_MOUSE, `${ESC}[?1006l${ESC}[?1000l${ESC}[?1049l`)
  // Every mode turned on must be turned off again, or the user's shell is left broken.
  const modes = (s: string) => [...s.matchAll(/\[\?(\d+)[hl]/g)].map(m => m[1]).sort()
  assert.deepEqual(modes(ENABLE_MOUSE), modes(DISABLE_MOUSE))
})
