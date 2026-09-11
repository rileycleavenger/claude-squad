import { EventEmitter } from 'node:events'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { AgentRunner } from './agent.js'
import { MessageBus } from './bus.js'
import { loadConfig, writeProfile } from './config.js'
import { saveToLibrary } from './library.js'
import { loadState, saveState, TranscriptLog, type SquadState } from './state.js'
import { ensureWorktree, provisionWorkspaces, type Workspace } from './worktree.js'
import type { AgentProfile, AgentStatus, Entry, SquadConfig, SquadMessage } from './types.js'
import { HUMAN, TEAM } from './types.js'

/** A tab in the UI: the groupchat, one agent's thread, or the new-agent pane. */
export interface Tab {
  id: string
  label: string
  kind: 'group' | 'agent' | 'new'
  agent?: AgentProfile
}

export const GROUP_TAB = 'group'
export const NEW_TAB = '+'

export interface AddAgentOptions {
  /** Also copy the profile into the shared cross-project library. */
  alsoSaveToLibrary?: boolean
}

/**
 * Headless controller for a running squad: owns the bus, the runners, the per-tab
 * transcripts and everything persisted between launches. The Ink layer renders this and
 * nothing else.
 */
export class Squad extends EventEmitter {
  readonly config: SquadConfig
  readonly workspaces: Map<string, Workspace>
  readonly warnings: string[] = []

  private readonly bus: MessageBus
  private readonly runners = new Map<string, AgentRunner>()
  private readonly transcripts = new Map<string, Entry[]>()
  private readonly unseen = new Map<string, number>()
  private readonly log: TranscriptLog
  private readonly agentTabs: Tab[] = []
  private state: SquadState
  private saveTimer: NodeJS.Timeout | undefined
  private worktreesEnabled: boolean
  private started = false

  private constructor(
    config: SquadConfig,
    bus: MessageBus,
    workspaces: Map<string, Workspace>,
    state: SquadState,
    restored: Map<string, Entry[]>,
    worktreesEnabled: boolean,
  ) {
    super()
    this.setMaxListeners(0)
    this.config = config
    this.bus = bus
    this.workspaces = workspaces
    this.state = state
    this.worktreesEnabled = worktreesEnabled
    this.log = new TranscriptLog(config.squadDir)
    this.log.open()

    this.transcripts.set(GROUP_TAB, restored.get(GROUP_TAB) ?? [])
    this.unseen.set(GROUP_TAB, 0)

    for (const profile of config.agents) {
      this.transcripts.set(profile.name, restored.get(profile.name) ?? [])
      this.unseen.set(profile.name, 0)
      this.agentTabs.push({ id: profile.name, label: profile.displayName, kind: 'agent', agent: profile })
      this.createRunner(profile)
    }

    bus.on('message', (message: SquadMessage) => this.onBusMessage(message))
    bus.on('warning', (text: string) => this.warnings.push(text))
    bus.on('suppressed', ({ agent, reason }: { agent: string; reason: string }) => {
      const text =
        reason === 'rate-limit'
          ? `Held back a mention for @${agent}: too many wake-ups in the last minute. It will pick the message up on its next turn.`
          : `Held back a mention for @${agent}: the relay chain got too deep. It will pick the message up on its next turn.`
      this.append(GROUP_TAB, { id: randomUUID(), ts: Date.now(), kind: 'notice', agent: 'squad', text })
    })
  }

  static async create(repoPath: string): Promise<Squad> {
    const config = await loadConfig(repoPath)
    const { workspaces, warning } = await provisionWorkspaces(
      repoPath,
      config.agents.map(a => a.name),
      config.useWorktrees,
    )
    const bus = new MessageBus({
      maxWakesPerMinute: config.maxWakesPerMinute,
      maxRelayDepth: config.maxRelayDepth,
      historyPath: path.join(config.squadDir, 'history.jsonl'),
    })
    const state = await loadState(config.squadDir)
    const restored = await TranscriptLog.load(config.squadDir)
    // Agents added later must land in a worktree if and only if the others did.
    const worktreesEnabled =
      config.useWorktrees && [...workspaces.values()].every(w => w.branch !== undefined) && !warning

    const squad = new Squad(config, bus, workspaces, state, restored, worktreesEnabled)
    if (warning) squad.warnings.push(warning)
    return squad
  }

  /** Tabs in display order: the groupchat, every agent, then the new-agent pane. */
  get tabs(): Tab[] {
    return [
      { id: GROUP_TAB, label: '#groupchat', kind: 'group' },
      ...this.agentTabs,
      { id: NEW_TAB, label: '+', kind: 'new' },
    ]
  }

  get lastTab(): string | undefined {
    return this.state.lastTab
  }

  start(): void {
    for (const runner of this.runners.values()) runner.start()
    this.started = true
    this.emit('update')
  }

  entries(tabId: string): readonly Entry[] {
    return this.transcripts.get(tabId) ?? []
  }

  profiles(): AgentProfile[] {
    return this.config.agents
  }

  hasAgent(name: string): boolean {
    return this.runners.has(name)
  }

  statusOf(name: string): AgentStatus {
    return this.runners.get(name)?.getStatus() ?? { kind: 'stopped' }
  }

  costOf(name: string): number {
    return this.runners.get(name)?.getCost() ?? 0
  }

  totalCost(): number {
    let total = 0
    for (const runner of this.runners.values()) total += runner.getCost()
    return total
  }

  unseenCount(tabId: string): number {
    return this.unseen.get(tabId) ?? 0
  }

  markSeen(tabId: string): void {
    if (this.state.lastTab !== tabId) {
      this.state.lastTab = tabId
      this.scheduleSave()
    }
    if (this.unseen.get(tabId)) {
      this.unseen.set(tabId, 0)
      this.emit('update')
    }
  }

  /**
   * Add an agent while the squad is running: persist its profile, give it a workspace,
   * open its tab and start its session.
   */
  async addAgent(profile: AgentProfile, options: AddAgentOptions = {}): Promise<void> {
    if (this.runners.has(profile.name)) {
      throw new Error(`@${profile.name} is already on the squad.`)
    }

    await writeProfile(this.config.squadDir, profile)
    if (options.alsoSaveToLibrary) await saveToLibrary(profile)

    const workspace = this.worktreesEnabled
      ? await ensureWorktree(this.config.repoPath, profile.name)
      : { path: this.config.repoPath }
    this.workspaces.set(profile.name, workspace)

    // The roster is read when a runner is built, so appending here means this agent sees
    // everyone, and everyone built after it sees this one.
    this.config.agents.push(profile)
    this.transcripts.set(profile.name, [])
    this.unseen.set(profile.name, 0)
    this.agentTabs.push({ id: profile.name, label: profile.displayName, kind: 'agent', agent: profile })

    const runner = this.createRunner(profile)
    if (this.started) runner.start()

    // Agents already running baked the old roster into their system prompt, so announce
    // the new member; `list_squad` will also report them from now on.
    this.bus.post({
      from: HUMAN,
      channel: 'group',
      text: `@${profile.name} (${profile.displayName}) has joined the squad: ${profile.role}. Bring them up to speed if their work overlaps yours.`,
      mentions: [TEAM],
    })

    this.emit('update')
  }

  /** Handle a line the operator typed in `tabId`. */
  submit(tabId: string, text: string): void {
    const body = text.trim()
    if (!body) return

    if (tabId === GROUP_TAB) {
      // "Team, start on X" should reach everyone; an unaddressed groupchat post that woke
      // nobody would just sit there looking broken.
      this.bus.post({ from: HUMAN, channel: 'group', text: body, mentions: [TEAM] })
      return
    }
    if (!this.runners.has(tabId)) return
    this.bus.post({ from: HUMAN, channel: `dm:${tabId}`, text: body })
  }

  async interrupt(name: string): Promise<void> {
    await this.runners.get(name)?.interrupt()
  }

  async interruptAll(): Promise<void> {
    await Promise.all([...this.runners.values()].map(r => r.interrupt()))
  }

  async shutdown(): Promise<void> {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    await Promise.all([...this.runners.values()].map(r => r.stop()))
    this.captureState()
    await saveState(this.config.squadDir, this.state)
    this.log.close()
    this.bus.close()
  }

  private createRunner(profile: AgentProfile): AgentRunner {
    const workspace = this.workspaces.get(profile.name) ?? { path: this.config.repoPath }
    const runner = new AgentRunner({
      profile,
      config: this.config,
      bus: this.bus,
      directory: {
        profiles: () => this.config.agents,
        statusOf: (name: string) => describeStatus(this.runners.get(name)?.getStatus()),
      },
      workdir: workspace.path,
      branch: workspace.branch,
      resumeSessionId: this.state.agents[profile.name]?.sessionId,
      priorCostUsd: this.state.agents[profile.name]?.costUsd,
    })
    runner.on('entry', (entry: Entry) => this.append(profile.name, entry))
    runner.on('status', () => this.emit('update'))
    runner.on('cost', () => {
      this.scheduleSave()
      this.emit('update')
    })
    runner.on('session', () => this.scheduleSave())
    this.runners.set(profile.name, runner)
    this.bus.register({ name: profile.name, deliver: text => runner.send(text) })
    return runner
  }

  private onBusMessage(message: SquadMessage): void {
    const tabId = message.channel === 'group' ? GROUP_TAB : message.channel.slice(3)
    this.append(tabId, {
      id: message.id,
      ts: message.ts,
      kind: 'chat',
      from: message.from,
      text: message.text,
      mentions: message.mentions,
    })
  }

  private append(tabId: string, entry: Entry): void {
    const list = this.transcripts.get(tabId)
    if (!list) return
    list.push(entry)
    this.log.append(tabId, entry)
    this.unseen.set(tabId, (this.unseen.get(tabId) ?? 0) + 1)
    this.emit('update')
  }

  private captureState(): void {
    for (const [name, runner] of this.runners) {
      this.state.agents[name] = {
        sessionId: runner.getSessionId() ?? this.state.agents[name]?.sessionId,
        costUsd: runner.getCost(),
      }
    }
  }

  /** Coalesce state writes; session ids and costs change on every turn. */
  private scheduleSave(): void {
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined
      this.captureState()
      void saveState(this.config.squadDir, this.state)
    }, 1500)
    this.saveTimer.unref?.()
  }
}

export function describeStatus(status: AgentStatus | undefined): string {
  if (!status) return 'unknown'
  switch (status.kind) {
    case 'starting':
      return 'starting'
    case 'idle':
      return 'idle'
    case 'thinking':
      return 'working'
    case 'tool':
      return `running ${status.tool}`
    case 'stopped':
      return 'stopped'
    case 'error':
      return `error: ${status.message}`
  }
}
