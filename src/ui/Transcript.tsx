import React from 'react'
import { Box, Text } from 'ink'
import type { Entry } from '../types.js'
import { HUMAN } from '../types.js'

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
  for (const line of body.split('\n')) lines += Math.max(1, Math.ceil(line.length / width))
  return lines
}

export interface TranscriptProps {
  entries: readonly Entry[]
  colorOf: (agent: string) => string
  /** Rows available for transcript content. */
  height: number
  /** Total pane width, used to estimate wrapping. */
  width: number
}

/**
 * One transcript line. The clock and speaker sit in fixed-width boxes rather than being
 * space-padded: Ink trims trailing whitespace inside a Text node when a sibling wraps,
 * which silently destroys the gutter alignment on long messages.
 */
function Line({ time, label, color, body, dim, bold }: {
  time: number
  label: string
  color: string
  body: string
  dim?: boolean
  bold?: boolean
}) {
  return (
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
        <Text dimColor={dim} wrap="wrap">
          {body}
        </Text>
      </Box>
    </Box>
  )
}

export function Transcript({ entries, colorOf, height, width }: TranscriptProps) {
  // Ink has no scrollback, so render the newest entries that fit. Budgeting by estimated
  // wrapped height (rather than entry count) keeps one long message from pushing the
  // rest of the conversation out of the pane.
  const bodyWidth = Math.max(20, width - GUTTER - 2)
  const visible: Entry[] = []
  let used = 0
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!
    const cost = heightOf(entry, bodyWidth)
    if (used + cost > height && visible.length > 0) break
    visible.unshift(entry)
    used += cost
  }

  if (visible.length === 0) {
    return (
      <Box flexGrow={1} paddingX={1}>
        <Text dimColor>No messages yet.</Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1}>
      {visible.map(entry => {
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
              />
            )
          case 'tool':
            return (
              <Line key={entry.id} time={entry.ts} label="" color="gray" body={`⚙ ${entry.summary}`} dim />
            )
          case 'notice':
            return <Line key={entry.id} time={entry.ts} label="" color="gray" body={entry.text} dim />
          case 'error':
            return <Line key={entry.id} time={entry.ts} label="" color="red" body={`✕ ${entry.text}`} />
        }
      })}
    </Box>
  )
}
