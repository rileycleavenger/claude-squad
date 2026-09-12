/**
 * Minimal inline-markdown parsing for transcript text.
 *
 * Agents write markdown, so without this the groupchat is full of literal `**` and
 * backticks. Only the two that actually show up in chat are handled - bold and inline
 * code - because a transcript line is not a document and anything more would be noise.
 */

export interface Segment {
  text: string
  bold?: boolean
  code?: boolean
}

interface Range {
  start: number
  end: number
}

/** Find `` `code` `` spans. Their contents are literal, so markers inside them don't count. */
function codeRanges(text: string): Range[] {
  const ranges: Range[] = []
  const pattern = /`([^`\n]+)`/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    ranges.push({ start: match.index, end: match.index + match[0].length })
  }
  return ranges
}

function inRanges(index: number, ranges: Range[]): boolean {
  return ranges.some(r => index >= r.start && index < r.end)
}

/**
 * Find `**bold**` pairs, ignoring markers that sit inside code spans.
 *
 * Bold may wrap a code span, so this works on the original string rather than on
 * already-split pieces.
 */
function boldRanges(text: string, code: Range[]): Range[] {
  const markers: number[] = []
  for (let i = 0; i < text.length - 1; i++) {
    if (text[i] === '*' && text[i + 1] === '*' && !inRanges(i, code)) {
      markers.push(i)
      i += 1
    }
  }

  const ranges: Range[] = []
  for (let i = 0; i + 1 < markers.length; i += 2) {
    const open = markers[i]!
    const close = markers[i + 1]!
    // An empty `****` is not emphasis; leave it as literal text.
    if (close > open + 2) ranges.push({ start: open, end: close + 2 })
  }
  return ranges
}

/**
 * Split a line into styled segments. Markers are removed; unmatched markers are kept as
 * ordinary text so nothing is silently swallowed.
 */
export function parseInline(text: string): Segment[] {
  if (!text) return []
  const code = codeRanges(text)
  const bold = boldRanges(text, code)
  if (code.length === 0 && bold.length === 0) return [{ text }]

  const skip = new Set<number>()
  for (const range of code) {
    skip.add(range.start)
    skip.add(range.end - 1)
  }
  for (const range of bold) {
    skip.add(range.start)
    skip.add(range.start + 1)
    skip.add(range.end - 2)
    skip.add(range.end - 1)
  }

  const segments: Segment[] = []
  let current: Segment | undefined

  for (let i = 0; i < text.length; i++) {
    if (skip.has(i)) continue
    const isCode = inRanges(i, code)
    const isBold = inRanges(i, bold)
    if (!current || Boolean(current.bold) !== isBold || Boolean(current.code) !== isCode) {
      current = { text: '', ...(isBold ? { bold: true } : {}), ...(isCode ? { code: true } : {}) }
      segments.push(current)
    }
    current.text += text[i]
  }

  return segments.filter(segment => segment.text.length > 0)
}

/**
 * Strip inline markers without styling, for places that measure or summarise text rather
 * than render it.
 */
export function stripInline(text: string): string {
  return parseInline(text)
    .map(segment => segment.text)
    .join('')
}
