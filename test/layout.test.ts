import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeLayout, terminalSize } from '../src/ui/layout.js'

const base = { rows: 24, tabBarHeight: 1, noticeLines: 0, showingForm: false }

test('the app never renders taller than the terminal', () => {
  // This is the whole point: overflow scrolls the terminal and the title and tab bar are
  // lost off the top, with no way to get back to them.
  for (const rows of [4, 6, 8, 10, 12, 16, 24, 40, 60]) {
    for (const tabBarHeight of [1, 2, 3, 5, 8]) {
      for (const noticeLines of [0, 3, 10]) {
        for (const showingForm of [false, true]) {
          const layout = computeLayout({ rows, tabBarHeight, noticeLines, showingForm })
          assert.ok(
            layout.totalHeight <= rows,
            `${rows} rows / tabs ${tabBarHeight} / notice ${noticeLines} overflowed to ${layout.totalHeight}`,
          )
          assert.ok(layout.paneHeight >= 1, 'the transcript pane never collapses to nothing')
        }
      }
    }
  }
})

test('a roomy terminal keeps all the chrome', () => {
  const layout = computeLayout(base)
  assert.equal(layout.showTitle, true)
  assert.equal(layout.showFooter, true)
  // 24 rows - title - tabs - 2 border - input - footer
  assert.equal(layout.paneHeight, 18)
  assert.equal(layout.totalHeight, 24)
})

test('a wrapped tab bar takes its rows from the transcript, not from the top of the screen', () => {
  const one = computeLayout(base)
  const three = computeLayout({ ...base, tabBarHeight: 3 })
  assert.equal(three.paneHeight, one.paneHeight - 2)
  assert.equal(three.totalHeight, 24, 'still exactly fills the terminal')
  assert.equal(three.showTitle, true)
})

test('chrome is shed in priority order: footer first, then title', () => {
  // A squad big enough to wrap the tab bar over five rows on a short terminal.
  const tight = computeLayout({ ...base, rows: 10, tabBarHeight: 5 })
  assert.equal(tight.showFooter, false, 'the footer goes before the composer does')
  assert.ok(tight.totalHeight <= 10)

  const tighter = computeLayout({ ...base, rows: 8, tabBarHeight: 5 })
  assert.equal(tighter.showFooter, false)
  assert.equal(tighter.showTitle, false, 'the title goes next')
  assert.ok(tighter.totalHeight <= 8)
})

test('the form replaces the composer rather than stacking with it', () => {
  const chat = computeLayout(base)
  const form = computeLayout({ ...base, showingForm: true })
  assert.equal(form.paneHeight, chat.paneHeight + 1)
})

test('a long notice cannot push the tab bar off the screen', () => {
  const layout = computeLayout({ ...base, rows: 12, noticeLines: 10 })
  assert.ok(layout.totalHeight <= 12)
  assert.ok(layout.paneHeight >= 1)
})

test('absurd inputs still produce a usable layout', () => {
  for (const input of [
    { ...base, rows: 0 },
    { ...base, rows: 1 },
    { ...base, rows: 3, tabBarHeight: 20 },
    { ...base, tabBarHeight: 0 },
  ]) {
    const layout = computeLayout(input)
    assert.ok(layout.paneHeight >= 1)
    assert.ok(layout.totalHeight >= 1)
  }
})

test('a terminal that reports no usable size falls back instead of rendering nothing', () => {
  // A host that does not propagate the window size reports 0. `?? 24` does not catch 0,
  // and a root box of height 0 renders the whole app as no lines - a blank screen.
  assert.deepEqual(terminalSize(0, 0), { rows: 24, columns: 80 })
  assert.deepEqual(terminalSize(undefined, undefined), { rows: 24, columns: 80 })
  assert.deepEqual(terminalSize(Number.NaN, Number.NaN), { rows: 24, columns: 80 })
  assert.deepEqual(terminalSize(-5, -5), { rows: 24, columns: 80 })
  assert.deepEqual(terminalSize(Number.POSITIVE_INFINITY, 100), { rows: 24, columns: 100 })
})

test('a real terminal size is used as reported', () => {
  assert.deepEqual(terminalSize(40, 120), { rows: 40, columns: 120 })
  assert.deepEqual(terminalSize(24.7, 80.9), { rows: 24, columns: 80 }, 'fractional sizes are floored')
})

test('a size too small to draw into falls back rather than collapsing', () => {
  assert.equal(terminalSize(2, 80).rows, 24)
  assert.equal(terminalSize(24, 4).columns, 80)
})

test('every fallback size still produces a drawable layout', () => {
  for (const [r, c] of [[0, 0], [undefined, undefined], [1, 1], [2, 10]] as const) {
    const { rows } = terminalSize(r, c)
    const layout = computeLayout({ rows, tabBarHeight: 3, noticeLines: 0, showingForm: false })
    assert.ok(layout.totalHeight >= 1 && layout.totalHeight <= rows)
    assert.ok(layout.paneHeight >= 1)
  }
})
