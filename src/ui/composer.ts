/**
 * The text-editing model behind the input box.
 *
 * Kept free of Ink so it can be tested directly: every function here is a pure
 * `(text, cursor) -> (text, cursor)` or a layout calculation. The box needs to wrap like
 * a real composer rather than scrolling sideways, and a wrapped box needs a cursor you
 * can actually move, which means the wrap and the cursor position have to be computed
 * from the same layout - otherwise the caret drifts off the character it is on as soon as
 * a line wraps.
 */

/** What the composer holds: the text, and where the caret sits inside it. */
export interface Composer {
  text: string
  /** Index in `text`, from 0 to `text.length`. */
  cursor: number
}

/** One rendered row, with the index in `text` that its first column represents. */
export interface InputLine {
  text: string
  start: number
}

export interface InputLayout {
  lines: InputLine[]
  /** Index into `lines`. */
  row: number
  /** Column within that line. */
  col: number
}

export const empty: Composer = { text: '', cursor: 0 }

/** Put the caret at the end of `text` - what loading a history entry should do. */
export function withText(text: string): Composer {
  return { text, cursor: text.length }
}

function clamp(value: number, max: number): number {
  return Math.max(0, Math.min(max, value))
}

/**
 * Split a paragraph into word-plus-trailing-space chunks.
 *
 * Attaching each run of spaces to the word before it is what keeps a wrapped line from
 * starting with a stray space: the break always happens after the spaces, never inside
 * them.
 */
function chunk(para: string): Array<{ text: string; start: number }> {
  const chunks: Array<{ text: string; start: number }> = []
  let i = 0
  while (i < para.length) {
    const start = i
    while (i < para.length && para[i] !== ' ') i++
    while (i < para.length && para[i] === ' ') i++
    chunks.push({ text: para.slice(start, i), start })
  }
  return chunks
}

/** Visible width of a line: trailing spaces sit in the margin rather than forcing a wrap. */
const visibleWidth = (text: string): number => text.replace(/ +$/, '').length

/**
 * Lay the text out into rows of at most `width` columns and locate the caret in them.
 *
 * A word longer than the whole line is split hard - there is nowhere else to break it -
 * and everything else wraps at a space.
 */
export function layoutInput(text: string, cursor: number, width: number): InputLayout {
  const w = Math.max(1, Math.floor(width))
  const lines: InputLine[] = []

  let offset = 0
  for (const para of text.split('\n')) {
    let current = ''
    let currentStart = offset
    const flush = () => {
      lines.push({ text: current, start: currentStart })
      current = ''
    }
    for (const piece of chunk(para)) {
      let rest = piece.text
      let restStart = offset + piece.start
      // A word that cannot fit on a line of its own is split at the margin.
      while (visibleWidth(rest) > w) {
        if (current !== '') {
          flush()
          currentStart = restStart
        }
        lines.push({ text: rest.slice(0, w), start: restStart })
        rest = rest.slice(w)
        restStart += w
        currentStart = restStart
      }
      if (current !== '' && visibleWidth(current + rest) > w) {
        flush()
        currentStart = restStart
      }
      current += rest
    }
    lines.push({ text: current, start: currentStart })
    offset += para.length + 1 // the newline
  }

  const at = clamp(cursor, text.length)
  let row = 0
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.start <= at) row = i
  }
  return { lines, row, col: Math.min(at - lines[row]!.start, w) }
}

/** How many rows `text` needs at this width. */
export function inputHeight(text: string, width: number): number {
  return layoutInput(text, 0, width).lines.length
}

export function insert(state: Composer, text: string): Composer {
  const at = clamp(state.cursor, state.text.length)
  return { text: state.text.slice(0, at) + text + state.text.slice(at), cursor: at + text.length }
}

/** Delete the character before the caret. */
export function backspace(state: Composer): Composer {
  const at = clamp(state.cursor, state.text.length)
  if (at === 0) return state
  return { text: state.text.slice(0, at - 1) + state.text.slice(at), cursor: at - 1 }
}

/** Delete the character after the caret. */
export function deleteForward(state: Composer): Composer {
  const at = clamp(state.cursor, state.text.length)
  if (at >= state.text.length) return state
  return { text: state.text.slice(0, at) + state.text.slice(at + 1), cursor: at }
}

export function moveLeft(state: Composer): Composer {
  return { ...state, cursor: clamp(state.cursor - 1, state.text.length) }
}

export function moveRight(state: Composer): Composer {
  return { ...state, cursor: clamp(state.cursor + 1, state.text.length) }
}

/** Jump to the start of the previous word, the way alt+left does in a shell. */
export function moveWordLeft(state: Composer): Composer {
  let at = clamp(state.cursor, state.text.length)
  while (at > 0 && /\s/.test(state.text[at - 1]!)) at--
  while (at > 0 && !/\s/.test(state.text[at - 1]!)) at--
  return { ...state, cursor: at }
}

export function moveWordRight(state: Composer): Composer {
  let at = clamp(state.cursor, state.text.length)
  while (at < state.text.length && /\s/.test(state.text[at]!)) at++
  while (at < state.text.length && !/\s/.test(state.text[at]!)) at++
  return { ...state, cursor: at }
}

/** Start of the logical line - what ^A does. */
export function lineStart(state: Composer): Composer {
  const at = clamp(state.cursor, state.text.length)
  const before = state.text.lastIndexOf('\n', at - 1)
  return { ...state, cursor: before + 1 }
}

/** End of the logical line. */
export function lineEnd(state: Composer): Composer {
  const at = clamp(state.cursor, state.text.length)
  const next = state.text.indexOf('\n', at)
  return { ...state, cursor: next === -1 ? state.text.length : next }
}

/**
 * Move the caret one rendered row up or down, keeping its column where it can.
 *
 * Rendered rather than logical rows: the caret should follow what is on screen, so a
 * single long line that wrapped onto three rows takes three presses to cross.
 */
export function moveRow(state: Composer, delta: number, width: number): Composer {
  const { lines, row, col } = layoutInput(state.text, state.cursor, width)
  const target = row + delta
  if (target < 0 || target >= lines.length) return state
  const line = lines[target]!
  // A wrapped row's last column belongs to the row below it, so stop one short of the
  // end; a row that ends a paragraph has no such neighbour and can take its full length.
  const wrapped = target + 1 < lines.length && lines[target + 1]!.start === line.start + line.text.length
  const span = wrapped ? Math.max(0, line.text.length - 1) : line.text.length
  return { ...state, cursor: line.start + Math.min(col, span) }
}

/** Whether up/down should move the caret rather than step through history. */
export function isMultiline(text: string, width: number): boolean {
  return inputHeight(text, width) > 1
}
