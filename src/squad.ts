import { EventEmitter } from 'node:events'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk'
import { randomUUID } from 'node:crypto'
import { AgentRunner } from './agent.js'
import { MessageBus } from './bus.js'
import { loadConfig, writeProfile } from './config.js'
import { saveToLibrary } from './library.js'
import { loadState, saveState, TranscriptLog, type SquadState } from './state.js'
import { ensureWorktree, provisionWorkspaces, type Workspace } from './worktree.js'
import {
  loadCapabilities,
  materializeServers,
  resolveHooks,
  skillNameFor,
  type Capability,
  type ResolvedHook,
} from './capability.js'
import { loadUserHooks, type RegisteredHook } from './hooks.js'
import { writeCapabilityPlugin, pluginPath } from './plugin.js'
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
  private capabilities: Map<string, Capability>
  /** Catch-up text queued for an agent whose session had to be restarted. */
  private readonly primers = new Map<string, string>()
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
    capabilities: Map<string, Capability>,
  ) {
    super()
    this.setMaxListeners(0)
    this.config = config
    this.bus = bus
    this.workspaces = workspaces
    this.state = state
    this.worktreesEnabled = worktreesEnabled
    this.capabilities = capabilities
    this.log = new TranscriptLog(config.squadDir)
    this.log.open()

    this.transcripts.set(GROUP_TAB, restored.get(GROUP_TAB) ?? [])
    this.unseen.set(GROUP_TAB, 0)

    for (const profile of config.agents) {
      this.transcripts.set(profile.name, restored.get(profile.name) ?? [])
      this.unseen.set(profile.name, 0)
      this.agentTabs.push({ id: profile.name, label: profile.displayName, kind: 'agent', agent: profile })
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
    const capabilities = await loadCapabilities(config.squadDir)
    // Regenerate the skill plugin on every launch so edits to a capability take effect.
    await writeCapabilityPlugin(config.squadDir, capabilities.values())
    // Agents added later must land in a worktree if and only if the others did.
    const worktreesEnabled =
      config.useWorktrees && [...workspaces.values()].every(w => w.branch !== undefined) && !warning

    const squad = new Squad(config, bus, workspaces, state, restored, worktreesEnabled, capabilities)
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

  /** Build every agent's runner (resolving capability servers), then open their sessions. */
  async start(): Promise<void> {
    for (const profile of this.config.agents) {
      if (!this.runners.has(profile.name)) await this.createRunner(profile)
    }
    for (const runner of this.runners.values()) runner.start()
    this.started = true
    this.emit('update')
  }

  /** Capabilities available to this project, built-in plus anything in .squad/capabilities. */
  availableCapabilities(): Capability[] {
    return [...this.capabilities.values()]
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
    const runner = this.runners.get(name)
    if (runner) return runner.getStatus()
    // Before start(), an agent has no runner yet - that is "starting", not "stopped".
    return this.started ? { kind: 'stopped' } : { kind: 'starting' }
  }

  /** Lifetime spend, falling back to the persisted total before the runner exists. */
  costOf(name: string): number {
    const runner = this.runners.get(name)
    if (runner) return runner.getCost()
    return this.state.agents[name]?.costUsd ?? 0
  }

  totalCost(): number {
    let total = 0
    for (const profile of this.config.agents) total += this.costOf(profile.name)
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

    const runner = await this.createRunner(profile)
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

  /**
   * Which parts of a profile can change without a new session.
   *
   * Instructions, role, capabilities, effort and budget are all fixed when a session is
   * created - and a resumed session keeps the system prompt it started with, so there is
   * no way to change them in place. Everything else is cosmetic or settable live.
   */
  private needsRestart(before: AgentProfile, after: AgentProfile): boolean {
    return (
      before.instructions !== after.instructions ||
      before.role !== after.role ||
      before.effort !== after.effort ||
      before.budgetUsd !== after.budgetUsd ||
      before.capabilities.join(',') !== after.capabilities.join(',') ||
      (before.skills ?? []).join(',') !== (after.skills ?? []).join(',') ||
      (before.tools ?? []).join(',') !== (after.tools ?? []).join(',')
    )
  }

  /**
   * Apply an edited profile to a running agent.
   *
   * Cosmetic edits apply in place. Anything that lives in the system prompt or the tool
   * wiring needs a fresh session, because a resumed one keeps its original system prompt
   * - so the agent is restarted and handed a catch-up primer instead. The transcript in
   * the UI is untouched either way; only the agent's own context restarts.
   */
  async updateAgent(profile: AgentProfile): Promise<{ restarted: boolean }> {
    const index = this.config.agents.findIndex(a => a.name === profile.name)
    if (index < 0) throw new Error(`@${profile.name} is not on the squad.`)
    const before = this.config.agents[index]!

    await writeProfile(this.config.squadDir, profile)
    this.config.agents[index] = profile

    const tab = this.agentTabs.find(t => t.id === profile.name)
    if (tab) {
      tab.label = profile.displayName
      tab.agent = profile
    }

    const restart = this.needsRestart(before, profile)
    if (!restart) {
      const runner = this.runners.get(profile.name)
      if (runner && profile.model !== before.model) await runner.setModel(profile.model)
      this.append(profile.name, {
        id: randomUUID(),
        ts: Date.now(),
        kind: 'notice',
        agent: profile.name,
        text: 'Configuration updated. No restart was needed, so the conversation continues as-is.',
      })
      this.emit('update')
      return { restarted: false }
    }

    const existing = this.runners.get(profile.name)
    if (existing) {
      // Keep the lifetime cost, then detach so the dying runner cannot write to the tab.
      this.captureState()
      existing.removeAllListeners()
      await existing.stop()
      this.runners.delete(profile.name)
    }
    // A fresh session is the point: drop the old one so the new prompt actually applies.
    const carried = this.state.agents[profile.name]
    this.state.agents[profile.name] = { costUsd: carried?.costUsd }
    // Persist immediately rather than on the usual debounce: if this write were lost to a
    // crash, the next launch would resume the old session and silently undo the edit.
    await saveState(this.config.squadDir, this.state)

    this.primers.set(profile.name, this.buildPrimer(profile.name))
    const runner = await this.createRunner(profile)
    this.primers.delete(profile.name)
    if (this.started) runner.start()

    this.append(profile.name, {
      id: randomUUID(),
      ts: Date.now(),
      kind: 'notice',
      agent: profile.name,
      text: 'Configuration updated. This needed a fresh session for the new setup to take effect, so the agent restarted with a summary of what it was doing. The transcript above is unchanged.',
    })
    this.emit('update')
    return { restarted: true }
  }

  /** Assemble a catch-up note for a restarted agent from what it was just doing. */
  private buildPrimer(name: string): string {
    const recent = (this.transcripts.get(name) ?? [])
      .filter(e => e.kind === 'chat')
      .slice(-12)
      .map(e => {
        const entry = e as Extract<Entry, { kind: 'chat' }>
        const who = entry.from === HUMAN ? 'operator' : `@${entry.from}`
        return `- ${who}: ${entry.text.replace(/\s+/g, ' ').slice(0, 280)}`
      })

    const group = this.transcripts
      .get(GROUP_TAB)!
      .filter(e => e.kind === 'chat')
      .slice(-6)
      .map(e => {
        const entry = e as Extract<Entry, { kind: 'chat' }>
        const who = entry.from === HUMAN ? 'operator' : `@${entry.from}`
        return `- ${who}: ${entry.text.replace(/\s+/g, ' ').slice(0, 200)}`
      })

    return [
      'Your configuration was just updated by the operator, which restarted your session.',
      'You do not have your previous context, so here is where things stood.',
      recent.length > 0 ? `\nYour recent thread with the operator:\n${recent.join('\n')}` : '',
      group.length > 0 ? `\nRecent groupchat:\n${group.join('\n')}` : '',
      '\nCheck your workspace for uncommitted work before starting anything new, and read the groupchat if you need more.',
    ]
      .filter(Boolean)
      .join('\n')
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

  /**
   * Resolve one agent's capabilities into SDK wiring: MCP servers with per-agent paths,
   * a pre-approved tool list, and the skill allowlist that scopes which capability
   * skills this agent can invoke.
   */
  private async equip(profile: AgentProfile) {
    const agentDir = path.join(this.config.squadDir, 'data', profile.name)
    await fs.mkdir(agentDir, { recursive: true })

    const servers: Record<string, McpServerConfig> = {}
    const tools: string[] = []
    const skills: string[] = []
    const secrets: string[] = []
    const hooks: ResolvedHook[] = []
    const descriptions: Array<{ name: string; description: string }> = []

    // Read fresh rather than cached, so installing a hook and then adding an agent works
    // without relaunching the squad.
    let registered: RegisteredHook[] = []
    if (profile.capabilities.some(name => this.capabilities.get(name)?.hooks.length)) {
      registered = await loadUserHooks()
    }

    for (const name of profile.capabilities) {
      const capability = this.capabilities.get(name)
      if (!capability) {
        this.warnings.push(
          `@${profile.name} asks for the "${name}" capability, which does not exist. Known: ${[...this.capabilities.keys()].join(', ')}.`,
        )
        continue
      }
      descriptions.push({ name: capability.name, description: capability.description })
      skills.push(skillNameFor(capability.name))
      tools.push(...capability.allowedTools)
      const resolved = resolveHooks(capability, registered)
      hooks.push(...resolved.hooks)
      // Every profile can want the same capability, so say it once for the squad.
      for (const warning of resolved.warnings) {
        if (!this.warnings.includes(warning)) this.warnings.push(warning)
      }
      try {
        const result = await materializeServers(capability, {
          agentName: profile.name,
          agentDir,
          repoPath: this.config.repoPath,
          squadDir: this.config.squadDir,
        })
        Object.assign(servers, result.servers)
        secrets.push(...result.secrets)
        this.warnings.push(...result.warnings)
      } catch (err) {
        // A missing credential disables one capability; it must not stop the squad.
        this.warnings.push(`@${profile.name}: "${name}" could not start - ${(err as Error).message}`)
      }
    }

    return { servers, tools, skills, secrets, hooks, descriptions, agentDir }
  }

  private async createRunner(profile: AgentProfile): Promise<AgentRunner> {
    const workspace = this.workspaces.get(profile.name) ?? { path: this.config.repoPath }
    const equipment = await this.equip(profile)
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
      primer: this.primers.get(profile.name),
      capabilityServers: equipment.servers,
      capabilityTools: equipment.tools,
      capabilitySkills: equipment.skills,
      capabilityHooks: equipment.hooks,
      capabilityDescriptions: equipment.descriptions,
      pluginPath: pluginPath(this.config.squadDir),
      secrets: equipment.secrets,
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
