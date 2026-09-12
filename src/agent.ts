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
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk'
import { redact } from './secrets.js'
import { usageLimit } from './usage.js'

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
  /** MCP servers contributed by this agent's capabilities, already templated per agent. */
  capabilityServers?: Record<string, McpServerConfig>
  /** Tool patterns the capabilities pre-approve. */
  capabilityTools?: string[]
  /** Capability skill names (`squad:browser`), used as this agent's skill allowlist. */
  capabilitySkills?: string[]
  /** Path to the generated capability plugin. */
  pluginPath?: string
  /** Resolved secret values, so they can be scrubbed from anything user-visible. */
  secrets?: string[]
  /** `name - description` for each capability, for the agent's system prompt. */
  capabilityDescriptions?: Array<{ name: string; description: string }>
  /**
   * Context to fold into the first message this agent receives. Used when an agent is
   * reconfigured: its session has to start fresh for new instructions to take effect, so
   * this catches it up without costing a turn of its own.
   */
  primer?: string
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
  private ourServerNames = new Set<string>()
  private primer: string | undefined
  /** Timestamps of recent automatic unread flushes, used to damp agent-to-agent loops. */
  private flushes: number[] = []

  constructor(private readonly deps: RunnerDeps) {
    super()
    this.setMaxListeners(0)
    this.name = deps.profile.name
    this.profile = deps.profile
    this.priorCostUsd = deps.priorCostUsd ?? 0
    this.primer = deps.primer
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

    const capabilityServers = this.deps.capabilityServers ?? {}
    this.ourServerNames = new Set(Object.keys(capabilityServers))
    const capabilityTools = this.deps.capabilityTools ?? []
    const capabilitySkills = this.deps.capabilitySkills ?? []

    const options: Options = {
      cwd: workdir,
      model: profile.model ?? config.defaultModel,
      effort: profile.effort ?? config.defaultEffort,
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: buildRolePrompt({
          me: profile,
          roster: config.agents,
          workdir,
          branch,
          capabilities: this.deps.capabilityDescriptions,
        }),
      },
      mcpServers: { squad: buildSquadServer(this.name, bus, directory), ...capabilityServers },
      // A profile that pins a tool allowlist must still keep its squad tools, or the
      // agent is silently mute. Capability tools are always pre-approved.
      allowedTools: profile.tools
        ? [...profile.tools, ...SQUAD_TOOL_NAMES, ...capabilityTools]
        : undefined,
      // Only scope skills when the agent actually has capabilities; otherwise leave the
      // CLI's own defaults alone rather than silently removing its bundled skills.
      ...(capabilitySkills.length > 0
        ? {
            skills: [...capabilitySkills, ...(profile.skills ?? [])],
            plugins: this.deps.pluginPath ? [{ type: 'local' as const, path: this.deps.pluginPath }] : undefined,
          }
        : {}),
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
    if (this.primer) {
      // Fold the catch-up into the first real message rather than sending it on its own,
      // so reconfiguring an agent does not burn a turn.
      this.queue.push(`${this.primer}\n\n---\n\n${text}`)
      this.primer = undefined
    } else {
      this.queue.push(text)
    }
    if (this.status.kind === 'idle' || this.status.kind === 'starting') {
      this.setStatus({ kind: 'thinking' })
    }
  }

  /** Change the model for subsequent turns without restarting the session. */
  async setModel(model: string | undefined): Promise<void> {
    try {
      await this.session?.setModel(model)
    } catch {
      // Only available in streaming mode and only once the session is up; a failure here
      // just means the change lands on the next restart.
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
            this.reportMcpHealth(message.mcp_servers, this.ourServerNames)
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
            // A quota notice comes back through the assistant channel, so it would
            // otherwise render as something the agent said while its status stayed
            // healthy - the squad stops working and nothing on screen explains it.
            const limit = usageLimit(block.text)
            if (limit) {
              this.emitEntry({ kind: 'error', text: limit })
              this.setStatus({ kind: 'error', message: 'usage limit' })
              continue
            }
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

  /**
   * A capability whose MCP server fails to start is otherwise invisible: the agent simply
   * has no tools and improvises. Surface it in the agent's own tab instead.
   */
  private reportMcpHealth(
    servers: Array<{ name: string; status: string }> | undefined,
    ours: Set<string>,
  ): void {
    for (const server of servers ?? []) {
      // Only servers this agent's capabilities asked for. Anything else in the session
      // came from the environment and is not the squad's to complain about.
      if (!ours.has(server.name)) continue
      if (server.status === 'connected' || server.status === 'pending') continue
      this.emitEntry({
        kind: 'error',
        text: `The "${server.name}" tool server is ${server.status}, so that capability's tools are unavailable.`,
      })
    }
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
