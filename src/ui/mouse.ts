/** Terminal mouse reporting: escape sequences, event parsing, and terminal restore. */
import { writeSync } from 'node:fs'

const ESC = String.fromCharCode(27)

/**
 * Enter the alternate screen and turn on SGR mouse reporting.
 *
 * The alternate screen is what makes click coordinates usable: it starts blank with the
 * cursor at row 1, so the app's own layout coordinates line up with physical screen rows.
 * On the normal screen the app renders wherever the cursor happened to be - below a shell
 * prompt, below npm output - and there is no reliable way to learn that offset.
 *
 * 1000 reports button presses and releases only. Motion tracking (1002/1003) would fire
 * on every cursor move, which is pure noise for clicking a tab.
 */
export const ENABLE_MOUSE = `${ESC}[?1049h${ESC}[?1000h${ESC}[?1006h`

/** Restore the terminal: mouse off, back to the normal screen. */
export const DISABLE_MOUSE = `${ESC}[?1006l${ESC}[?1000l${ESC}[?1049l`

/**
 * Put the terminal back on the normal screen, synchronously.
 *
 * Anything printed while the alternate screen is active is wiped when the terminal
 * restores, so a crash message would vanish and the failure would look like a blank
 * screen. Call this before reporting an error.
 */
export function restoreTerminal(fd = 1): void {
  // Only meaningful if the alternate screen was actually entered; otherwise this would
  // print escape codes into output that was never a terminal takeover, such as a config
  // error before the TUI starts, or piped output.
  if (!entered) return
  entered = false
  try {
    writeSync(fd, DISABLE_MOUSE)
  } catch {
    // The terminal is already gone; there is nothing to restore.
  }
}

/** Whether the app has taken over the terminal and still owes it a restore. */
let entered = false

export interface MouseEvent {
  /** 0-based column. */
  col: number
  /** 0-based row. */
  row: number
  button: number
  kind: 'press' | 'release'
}

// Ink's key parser does not know about mouse sequences, so it hands them to `useInput`
// as raw text with the leading escape already stripped.
const SGR_MOUSE = new RegExp(`^${ESC}?\\[<(\\d+);(\\d+);(\\d+)([Mm])$`)

/**
 * Parse one SGR mouse report. Returns undefined for ordinary keyboard input.
 *
 * Every mouse sequence must be recognised even when it is not acted on, so it can be
 * swallowed - otherwise it lands in the composer as literal text like `[<64;10;5M`.
 */
export function parseMouse(input: string): MouseEvent | undefined {
  const match = SGR_MOUSE.exec(input)
  if (!match) return undefined
  return {
    button: Number(match[1]),
    col: Number(match[2]) - 1,
    row: Number(match[3]) - 1,
    kind: match[4] === 'M' ? 'press' : 'release',
  }
}

/** A left-button press is the only event that should activate something. */
export function isLeftClick(event: MouseEvent): boolean {
  return event.kind === 'press' && event.button === 0
}

/**
 * Turn on mouse reporting and return a function that restores the terminal.
 *
 * Restoring is not optional: a terminal left in this state hides the user's scrollback
 * and prints escape sequences on every click. Stream writes can be dropped when the
 * process exits, so the restore goes out with a synchronous write to the file
 * descriptor, and is also wired to exit and to the signals that would otherwise skip it.
 */
export function installMouse(write: (data: string) => void, fd = 1): () => void {
  let restored = false
  const restore = (): void => {
    if (restored) return
    restored = true
    entered = false
    try {
      // Synchronous, so it cannot be lost to a process exiting behind a buffered write.
      writeSync(fd, DISABLE_MOUSE)
    } catch {
      // Nothing useful to do if the terminal is already gone.
    }
  }

  const onSignal = (signal: NodeJS.Signals) => () => {
    restore()
    process.kill(process.pid, signal)
  }
  const handlers: Array<[NodeJS.Signals, () => void]> = [
    ['SIGTERM', onSignal('SIGTERM')],
    ['SIGHUP', onSignal('SIGHUP')],
  ]

  write(ENABLE_MOUSE)
  entered = true
  process.once('exit', restore)
  for (const [signal, handler] of handlers) {
    process.once(signal, () => {
      process.off(signal, handler)
      handler()
    })
  }

  return () => {
    process.off('exit', restore)
    for (const [signal, handler] of handlers) process.off(signal, handler)
    restore()
  }
}

/** A rectangle in screen coordinates. */
export interface Rect {
  left: number
  top: number
  width: number
  height: number
}

export function hitTest(rect: Rect, col: number, row: number): boolean {
  return (
    row >= rect.top &&
    row < rect.top + Math.max(1, rect.height) &&
    col >= rect.left &&
    col < rect.left + rect.width
  )
}
