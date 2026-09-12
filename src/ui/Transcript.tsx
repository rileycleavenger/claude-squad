import React from 'react'
import { Box, Text } from 'ink'
import type { Entry } from '../types.js'
import { HUMAN } from '../types.js'
import { parseInline, stripInline } from './markdown.js'

const CLOCK_WIDTH = 6
const LABEL_WIDTH = 12
const GUTTER = CLOCK_WIDTH + LABEL_WIDTH

function clock(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function truncate(label: string): string {
  return label.length > LABEL_WIDTH - 1 ? label.slice(0, LABEL_WIDTH - 2) + '…' : label
}

/** Roughly how many terminal rows an entry will occupy once wrapped. */
function heightOf(entry: Entry, bodyWidth: number): number {
  const body =
    entry.kind === 'chat' ? entry.text : entry.kind === 'tool' ? entry.summary : entry.text
  const width = Math.max(20, bodyWidth)
  let lines = 0
  // Markers are removed before display, so measure the text as it will actually render.
  for (const line of stripInline(body).split('\n')) lines += Math.max(1, Math.ceil(line.length / width))
  return lines
}

/** Who is speaking in an entry, or undefined for system lines that do not interrupt a run. */
function speakerOf(entry: Entry): string | undefined {
  return entry.kind === 'chat' ? entry.from : undefined
}

/** Render one body with `**bold**` and `` `code` `` applied instead of shown literally. */
function Body({ text, dim }: { text: string; dim?: boolean }) {
  const segments = parseInline(text)
  return (
    <Text dimColor={dim} wrap="wrap">
      {segments.map((segment, index) => (
        <Text key={index} bold={segment.bold} color={segment.code ? 'cyan' : undefined}>
          {segment.text}
        </Text>
      ))}
    </Text>
  )
}

export interface TranscriptProps {
  entries: readonly Entry[]
  colorOf: (agent: string) => string
  /** Rows available for transcript content. */
  height: number
  /** Total pane width, used to estimate wrapping. */
  width: number
  /**
   * Blank rows inserted when the speaker changes. The groupchat mixes several agents, so
   * a visible gap is what makes it readable; a one-to-one agent tab does not need it.
   */
  speakerGap?: number
}

/**
 * One transcript line. The clock and speaker sit in fixed-width boxes rather than being
 * space-padded: Ink trims trailing whitespace inside a Text node when a sibling wraps,
 * which silently destroys the gutter alignment on long messages.
 */
function Line({ time, label, color, body, dim, bold, gap = 0 }: {
  time: number
  label: string
  color: string
  body: string
  dim?: boolean
  bold?: boolean
  gap?: number
}) {
  return (
    <>
      {gap > 0 ? <Box height={gap} flexShrink={0} /> : null}
    <Box flexDirection="row">
      <Box width={CLOCK_WIDTH} flexShrink={0}>
        <Text dimColor>{clock(time)}</Text>
      </Box>
      <Box width={LABEL_WIDTH} flexShrink={0}>
        <Text color={color} bold={bold}>
          {truncate(label)}
        </Text>
      </Box>
      <Box flexGrow={1}>
        <Body text={body} dim={dim} />
      </Box>
    </Box>
    </>
  )
}

export function Transcript({ entries, colorOf, height, width, speakerGap = 0 }: TranscriptProps) {
  // Ink has no scrollback, so render the newest entries that fit. Budgeting by estimated
  // wrapped height (rather than entry count) keeps one long message from pushing the
  // rest of the conversation out of the pane.
  const bodyWidth = Math.max(20, width - GUTTER - 2)

  // Gap rows are part of what a entry costs, or the budget under-counts and the pane
  // overflows.
  const gapBefore = (index: number): number => {
    if (speakerGap <= 0 || index <= 0) return 0
    const speaker = speakerOf(entries[index]!)
    if (!speaker) return 0
    for (let i = index - 1; i >= 0; i--) {
      const previous = speakerOf(entries[i]!)
      if (previous === undefined) continue
      return previous === speaker ? 0 : speakerGap
    }
    return 0
  }

  const visible: Array<{ entry: Entry; gap: number }> = []
  let used = 0
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!
    const gap = gapBefore(i)
    const cost = heightOf(entry, bodyWidth) + gap
    if (used + cost > height && visible.length > 0) break
    visible.unshift({ entry, gap })
    used += cost
  }
  // Never open the pane with dead space at the top.
  if (visible[0]) visible[0].gap = 0

  if (visible.length === 0) {
    return (
      <Box flexGrow={1} paddingX={1}>
        <Text dimColor>No messages yet.</Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1}>
      {visible.map(({ entry, gap }) => {
        switch (entry.kind) {
          case 'chat':
            return (
              <Line
                key={entry.id}
                time={entry.ts}
                label={entry.from === HUMAN ? 'you' : entry.from}
                color={entry.from === HUMAN ? 'white' : colorOf(entry.from)}
                body={entry.text}
                bold={entry.from === HUMAN}
                gap={gap}
              />
            )
          case 'tool':
            return (
              <Line
                key={entry.id}
                time={entry.ts}
                label=""
                color="gray"
                body={`⚙ ${entry.summary}`}
                dim
                gap={gap}
              />
            )
          case 'notice':
            return <Line key={entry.id} time={entry.ts} label="" color="gray" body={entry.text} dim gap={gap} />
          case 'error':
            return <Line key={entry.id} time={entry.ts} label="" color="red" body={`✕ ${entry.text}`} gap={gap} />
        }
      })}
    </Box>
  )
}
