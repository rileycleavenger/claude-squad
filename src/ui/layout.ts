/** How the fixed chrome around the transcript is sized for a given terminal. */
import { inputHeight } from './composer.js'


export interface LayoutInput {
  /** Terminal height in rows. */
  rows: number
  /** Measured height of the tab bar; it wraps to several rows when space is tight. */
  tabBarHeight: number
  /** Rows taken by the notice box, borders included. 0 when there is no notice. */
  noticeLines?: number
  /** The form replaces the composer, so no input row is needed. */
  showingForm?: boolean
  /**
   * Rows the composer needs. It grows as the draft wraps, so a long message is visible
   * while it is being written rather than scrolling out to the left. Defaults to 1.
   */
  inputRows?: number
}

export interface Layout {
  /** Rows available for transcript content, inside the pane border. */
  paneHeight: number
  showTitle: boolean
  showFooter: boolean
  /** Rows the composer gets, after clamping. 0 while the form is up. */
  inputRows: number
  /** Total rows the app will render. Never greater than `rows`. */
  totalHeight: number
}

/** Rows of transcript worth keeping before chrome starts being dropped. */
const MIN_PANE = 2

/**
 * Decide what fits.
 *
 * Everything here exists because the app must never render taller than the terminal: if
 * it does, the terminal scrolls and the top of the app - the title and the tab bar - is
 * gone, with no way to scroll back. The tab bar's height is measured rather than assumed,
 * because it wraps onto extra rows in a narrow pane or with a large squad.
 *
 * When there is not enough room, chrome is dropped in priority order - footer, then title
 * - because the tab bar and the composer are what make the app usable.
 */
export function computeLayout({
  rows,
  tabBarHeight,
  noticeLines = 0,
  showingForm = false,
  inputRows: wanted = 1,
}: LayoutInput): Layout {
  const safeRows = Math.max(1, rows)
  const tabs = Math.max(1, tabBarHeight)
  // The composer may want several rows, but never so many that the transcript is gone:
  // at most a third of the screen, and always at least one row.
  const inputRows = showingForm
    ? 0
    : Math.max(1, Math.min(Math.floor(wanted), Math.max(1, Math.floor(safeRows / 3))))
  const fixed = tabs + 2 /* pane border */ + noticeLines + inputRows

  const showFooter = safeRows - (fixed + 1 /* title */ + 1 /* footer */) >= MIN_PANE
  const showTitle = safeRows - (fixed + 1 /* title */ + (showFooter ? 1 : 0)) >= 1

  const chrome = fixed + (showTitle ? 1 : 0) + (showFooter ? 1 : 0)
  const paneHeight = Math.max(1, safeRows - chrome)

  return {
    paneHeight,
    showTitle,
    showFooter,
    inputRows,
    totalHeight: Math.min(safeRows, chrome + paneHeight),
  }
}

/**
 * Rows a notice box needs at this width: its wrapped text, the dismiss hint, and both
 * border rows.
 *
 * Counting `\n`s is not enough: a warning is one long line that the box wraps over
 * several rows, so the layout reserved one row for something that drew four and the
 * notice rode over the composer, where nothing could scroll it away.
 */
export function noticeHeight(text: string | undefined, columns: number, max = MAX_NOTICE_ROWS): number {
  if (!text) return 0
  return Math.min(inputHeight(text, noticeWidth(columns)), max) + 3 // hint row, two borders
}

/** Columns of text a notice box has, once its borders and padding are taken out. */
export function noticeWidth(columns: number): number {
  return Math.max(1, Math.floor(columns) - 4)
}

/** Most rows a notice may take before it is clipped. */
export const MAX_NOTICE_ROWS = 6

/** Smallest viewport worth trying to draw into. */
export const MIN_ROWS = 4
export const MIN_COLUMNS = 20

/**
 * Trust the terminal's reported size only when it is actually usable.
 *
 * A host that does not propagate the window size reports 0 (or nothing at all), and a
 * `?? fallback` does not catch 0 - it flows straight through to the root box as
 * `height={0}`, which renders the entire app as no lines: a blank screen with no error.
 * Anything non-finite or too small falls back to a size that at least draws something.
 */
export function terminalSize(
  reportedRows: number | undefined,
  reportedColumns: number | undefined,
): { rows: number; columns: number } {
  const usable = (value: number | undefined, min: number): boolean =>
    typeof value === 'number' && Number.isFinite(value) && value >= min
  return {
    rows: usable(reportedRows, MIN_ROWS) ? Math.floor(reportedRows!) : 24,
    columns: usable(reportedColumns, MIN_COLUMNS) ? Math.floor(reportedColumns!) : 80,
  }
}
