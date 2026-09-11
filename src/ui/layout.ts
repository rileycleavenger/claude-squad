/** How the fixed chrome around the transcript is sized for a given terminal. */

export interface LayoutInput {
  /** Terminal height in rows. */
  rows: number
  /** Measured height of the tab bar; it wraps to several rows when space is tight. */
  tabBarHeight: number
  /** Rows taken by the notice box, borders included. 0 when there is no notice. */
  noticeLines: number
  /** The form replaces the composer, so no input row is needed. */
  showingForm: boolean
}

export interface Layout {
  /** Rows available for transcript content, inside the pane border. */
  paneHeight: number
  showTitle: boolean
  showFooter: boolean
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
export function computeLayout({ rows, tabBarHeight, noticeLines, showingForm }: LayoutInput): Layout {
  const safeRows = Math.max(1, rows)
  const tabs = Math.max(1, tabBarHeight)
  const inputRows = showingForm ? 0 : 1
  const fixed = tabs + 2 /* pane border */ + noticeLines + inputRows

  const showFooter = safeRows - (fixed + 1 /* title */ + 1 /* footer */) >= MIN_PANE
  const showTitle = safeRows - (fixed + 1 /* title */ + (showFooter ? 1 : 0)) >= 1

  const chrome = fixed + (showTitle ? 1 : 0) + (showFooter ? 1 : 0)
  const paneHeight = Math.max(1, safeRows - chrome)

  return {
    paneHeight,
    showTitle,
    showFooter,
    totalHeight: Math.min(safeRows, chrome + paneHeight),
  }
}
