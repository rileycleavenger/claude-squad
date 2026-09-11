import { promises as fs } from 'node:fs'
import { createWriteStream, type WriteStream } from 'node:fs'
import path from 'node:path'
import type { Entry } from './types.js'

const STATE_FILE = 'state.json'
const TRANSCRIPT_FILE = 'transcript.jsonl'
/** How many transcript lines to keep in memory, and replay, per tab. */
const REPLAY_PER_TAB = 250

export interface PersistedAgent {
  /** Claude Code session id, so the agent resumes its conversation next launch. */
  sessionId?: string
  costUsd?: number
}

export interface SquadState {
  version: 1
  agents: Record<string, PersistedAgent>
  /** Tab the operator was last looking at. */
  lastTab?: string
  updatedAt?: number
}

const EMPTY: SquadState = { version: 1, agents: {} }

export async function loadState(squadDir: string): Promise<SquadState> {
  try {
    const raw = await fs.readFile(path.join(squadDir, STATE_FILE), 'utf8')
    const parsed = JSON.parse(raw) as SquadState
    if (parsed.version !== 1 || typeof parsed.agents !== 'object' || parsed.agents === null) return { ...EMPTY }
    return { version: 1, agents: parsed.agents, lastTab: parsed.lastTab }
  } catch {
    // A missing or corrupt state file just means "start fresh" - never fatal.
    return { ...EMPTY }
  }
}

export async function saveState(squadDir: string, state: SquadState): Promise<void> {
  const target = path.join(squadDir, STATE_FILE)
  const tmp = `${target}.tmp`
  const body = JSON.stringify({ ...state, updatedAt: Date.now() }, null, 2) + '\n'
  try {
    await fs.mkdir(squadDir, { recursive: true })
    // Write-then-rename so a crash mid-write cannot leave a truncated state file.
    await fs.writeFile(tmp, body, 'utf8')
    await fs.rename(tmp, target)
  } catch {
    // Losing resume state is a degraded experience, not a reason to take the TUI down.
  }
}

interface TranscriptLine {
  tab: string
  entry: Entry
}

/**
 * Append-only transcript of everything shown in the TUI, so relaunching a squad shows
 * the conversation you left rather than an empty pane.
 */
export class TranscriptLog {
  private stream: WriteStream | undefined

  constructor(private readonly squadDir: string) {}

  open(): void {
    try {
      this.stream = createWriteStream(path.join(this.squadDir, TRANSCRIPT_FILE), { flags: 'a' })
      this.stream.on('error', () => {
        this.stream = undefined
      })
    } catch {
      this.stream = undefined
    }
  }

  append(tab: string, entry: Entry): void {
    this.stream?.write(JSON.stringify({ tab, entry } satisfies TranscriptLine) + '\n')
  }

  close(): void {
    this.stream?.end()
    this.stream = undefined
  }

  /** Replay the tail of a previous session's transcript, grouped by tab. */
  static async load(squadDir: string): Promise<Map<string, Entry[]>> {
    const byTab = new Map<string, Entry[]>()
    let raw: string
    try {
      raw = await fs.readFile(path.join(squadDir, TRANSCRIPT_FILE), 'utf8')
    } catch {
      return byTab
    }

    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try {
        const { tab, entry } = JSON.parse(line) as TranscriptLine
        if (!tab || !entry?.kind) continue
        const list = byTab.get(tab) ?? []
        list.push(entry)
        byTab.set(tab, list)
      } catch {
        // Skip a torn or malformed line rather than losing the whole transcript.
      }
    }

    for (const [tab, entries] of byTab) {
      if (entries.length > REPLAY_PER_TAB) byTab.set(tab, entries.slice(-REPLAY_PER_TAB))
    }
    return byTab
  }
}
