import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { query, type Options, type Query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { MessageBus } from './bus.js'
import { renderUnread } from './bus.js'
import { MessageQueue } from './queue.js'
import { buildRolePrompt, SQUAD_TOOL_NAMES } from './prompt.js'
import { buildSquadServer, type SquadDirectory } from './tools.js'
import type { AgentProfile, AgentStatus, Entry, SquadConfig } from './types.js'
import { summarizeToolUse } from './toolsummary.js'

export interface RunnerDeps {
  profile: AgentProfile
  config: SquadConfig
  bus: MessageBus
  directory: SquadDirectory
  /** Absolute path this agent works in. */
  workdir: string
  /** Branch backing `workdir`, when worktrees are in use. */
  branch?: string
  /** Claude Code session id from a previous launch, to continue that conversation. */
  resumeSessionId?: string
  /** Spend already recorded for this agent in earlier launches. */
  priorCostUsd?: number
}

/**
 * One squad member: a single long-running `query()` whose prompt is a queue that never
 * ends, so the conversation stays open for the life of the session.
 *
 * Emits `entry` (a transcript line), `status`, and `cost` for the UI to render.
 */
export class AgentRunner extends EventEmitter {
  readonly name: string
  readonly profile: AgentProfile

  private readonly queue = new MessageQueue()
  private readonly abort = new AbortController()
  private session: Query | undefined
  private status: AgentStatus = { kind: 'starting' }
  private costUsd = 0
  /** A resumed session reports cost from zero, so lifetime spend adds the prior total. */
  private readonly priorCostUsd: number
  private turns = 0
  private ready = false
  private sessionId: string | undefined
  /** Timestamps of recent automatic unread flushes, used to damp agent-to-agent loops. */
  private flushes: number[] = []

  constructor(private readonly deps: RunnerDeps) {
    super()
    this.setMaxListeners(0)
    this.name = deps.profile.name
    this.profile = deps.profile
    this.priorCostUsd = deps.priorCostUsd ?? 0
  }

  getStatus(): AgentStatus {
    return this.status
  }

  /** Lifetime spend for this agent on this project, across launches. */
  getCost(): number {
    return this.priorCostUsd + this.costUsd
  }

  /** The live session id, once the first turn has started. Persisted for resume. */
  getSessionId(): string | undefined {
    return this.sessionId
  }

  isBusy(): boolean {
    return this.status.kind === 'thinking' || this.status.kind === 'tool'
  }

  /** Open the agent's session and start draining its message stream in the background. */
  start(): void {
    const { profile, config, bus, directory, workdir, branch } = this.deps

    const options: Options = {
      cwd: workdir,
      model: profile.model ?? config.defaultModel,
      effort: profile.effort ?? config.defaultEffort,
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: buildRolePrompt({ me: profile, roster: config.agents, workdir, branch }),
      },
      mcpServers: { squad: buildSquadServer(this.name, bus, directory) },
      // A profile that pins a tool allowlist must still keep its squad tools, or the
      // agent is silently mute.
      allowedTools: profile.tools ? [...profile.tools, ...SQUAD_TOOL_NAMES] : undefined,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      maxBudgetUsd: profile.budgetUsd ?? config.defaultBudgetUsd,
      settingSources: ['project'],
      resume: this.deps.resumeSessionId,
      abortController: this.abort,
      includePartialMessages: false,
      stderr: () => {},
    }

    this.session = query({ prompt: this.queue, options })
    // The session accepts queued turns immediately; `system/init` does not arrive until
    // the first turn actually starts, so waiting for it here would deadlock the caller.
    this.setStatus({ kind: 'idle' })
    void this.drain(this.session)
  }

  /** Queue a user turn for this agent. */
  send(text: string): void {
    this.queue.push(text)
    if (this.status.kind === 'idle' || this.status.kind === 'starting') {
      this.setStatus({ kind: 'thinking' })
    }
  }

  /** Interrupt the current turn without ending the session. */
  async interrupt(): Promise<void> {
    if (!this.session) return
    try {
      await this.session.interrupt()
      this.emitEntry({ kind: 'notice', text: 'Interrupted by the operator.' })
      this.setStatus({ kind: 'idle' })
    } catch (err) {
      this.emitEntry({ kind: 'error', text: `Could not interrupt: ${(err as Error).message}` })
    }
  }

  /** End the session for good. */
  async stop(): Promise<void> {
    this.queue.close()
    this.abort.abort()
    this.setStatus({ kind: 'stopped' })
  }

  private async drain(session: Query): Promise<void> {
    try {
      for await (const message of session) {
        this.handle(message)
      }
      this.setStatus({ kind: 'stopped' })
    } catch (err) {
      if (this.abort.signal.aborted) {
        this.setStatus({ kind: 'stopped' })
        return
      }
      const text = (err as Error).message
      this.emitEntry({ kind: 'error', text })
      this.setStatus({ kind: 'error', message: text })
    }
  }

  private handle(message: SDKMessage): void {
    switch (message.type) {
      case 'system':
        // `init` is re-emitted at the start of every turn, not just once per session, so
        // it must not be read as "the agent went idle".
        if (message.subtype === 'init') {
          this.noteSession(message.session_id)
          if (!this.ready) {
            this.ready = true
            this.emit('ready', message.model)
          }
        }
        return

      case 'assistant': {
        this.noteSession(message.session_id)
        // Subagent output belongs to the agent's own Task tool, not the squad transcript.
        if (message.parent_tool_use_id) return
        for (const block of message.message.content) {
          if (block.type === 'text' && block.text.trim()) {
            this.emitEntry({ kind: 'chat', text: block.text.trim() })
            this.setStatus({ kind: 'thinking' })
          } else if (block.type === 'tool_use') {
            this.emitEntry({ kind: 'tool', summary: summarizeToolUse(block.name, block.input) })
            this.setStatus({ kind: 'tool', tool: block.name })
          }
        }
        return
      }

      case 'result': {
        this.turns += 1
        // total_cost_usd is cumulative across the whole session, so assign rather than add.
        this.costUsd = message.total_cost_usd
        this.emit('cost', this.costUsd)

        if (message.subtype === 'success') {
          this.setStatus({ kind: 'idle' })
          this.flushUnread()
          return
        }

        const detail = message.errors.join('; ')
        if (message.subtype === 'error_max_budget_usd') {
          // The session is spent: the SDK will not run another turn for this agent.
          this.emitEntry({
            kind: 'error',
            text: `Budget of $${(this.profile.budgetUsd ?? this.deps.config.defaultBudgetUsd).toFixed(2)} exhausted - this agent is done for the session. Raise budgetUsd in its profile and restart to continue.`,
          })
          this.setStatus({ kind: 'error', message: 'budget exhausted' })
          return
        }

        this.emitEntry({ kind: 'error', text: detail || `Turn ended: ${message.subtype}` })
        this.setStatus({ kind: 'idle' })
        this.flushUnread()
        return
      }

      default:
        return
    }
  }

  /**
   * Hand the agent anything that arrived while it was busy, at a turn boundary.
   *
   * Rate-limited: without this, two agents posting unmentioned messages could keep each
   * other awake indefinitely, each flush provoking the reply that becomes the next flush.
   */
  private flushUnread(): void {
    const { bus, config } = this.deps
    if (bus.unreadCount(this.name) === 0) {
      bus.resetDepth(this.name)
      return
    }

    const now = Date.now()
    this.flushes = this.flushes.filter(t => now - t < 60_000)
    if (this.flushes.length >= config.maxWakesPerMinute) return

    const pending = bus.takeUnread(this.name)
    if (pending.length === 0) return
    this.flushes.push(now)
    this.send(renderUnread(pending))
  }

  private noteSession(id: string | undefined): void {
    if (!id || id === this.sessionId) return
    this.sessionId = id
    this.emit('session', id)
  }

  private setStatus(status: AgentStatus): void {
    this.status = status
    this.emit('status', status)
  }

  private emitEntry(partial: { kind: 'chat' | 'tool' | 'notice' | 'error'; text?: string; summary?: string }): void {
    const base = { id: randomUUID(), ts: Date.now() }
    let entry: Entry
    switch (partial.kind) {
      case 'chat':
        entry = { ...base, kind: 'chat', from: this.name, text: partial.text ?? '', mentions: [] }
        break
      case 'tool':
        entry = { ...base, kind: 'tool', agent: this.name, summary: partial.summary ?? '' }
        break
      case 'notice':
        entry = { ...base, kind: 'notice', agent: this.name, text: partial.text ?? '' }
        break
      default:
        entry = { ...base, kind: 'error', agent: this.name, text: partial.text ?? '' }
    }
    this.emit('entry', entry)
  }
}
