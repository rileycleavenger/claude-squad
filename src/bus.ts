import { EventEmitter } from 'node:events'
import { createWriteStream, type WriteStream } from 'node:fs'
import { randomUUID } from 'node:crypto'
import type { Channel, SquadMessage } from './types.js'
import { HUMAN, TEAM } from './types.js'

/** An agent, from the bus's point of view. */
export interface BusSubscriber {
  name: string
  /** Wake the agent with a formatted message. */
  deliver(text: string): void
}

export interface PostInput {
  from: string
  channel: Channel
  text: string
  /** Explicit mention handles. Any `@handle` found in `text` is added automatically. */
  mentions?: string[]
}

export interface BusOptions {
  maxWakesPerMinute: number
  maxRelayDepth: number
  /**
   * How long a relay chain stays "the same conversation". A runaway ping-pong happens in
   * seconds; real collaboration has gaps. After this much quiet an agent starts a fresh
   * chain, so a long-running squad is never permanently gagged. Defaults to 90s; 0
   * treats every post as a new chain, disabling the depth guard.
   */
  chainIdleMs?: number
  /** Path to append the message log to, for post-hoc review. */
  historyPath?: string
}

/** Why a message did not wake an agent it was addressed to. */
export type SuppressionReason = 'rate-limit' | 'relay-depth'

const MENTION_RE = /(?:^|[^\w@])@([a-z0-9][a-z0-9_-]*)/gi

/** Pull `@handle` tokens out of free text. Returns lowercase handles without the `@`. */
export function extractMentions(text: string): string[] {
  const found = new Set<string>()
  for (const match of text.matchAll(MENTION_RE)) {
    const handle = match[1]
    if (handle) found.add(handle.toLowerCase())
  }
  return [...found]
}

/**
 * The squad's message log and router.
 *
 * Every message - from the operator or from an agent - passes through `post()`, which
 * appends it to the log, emits it for the UI, and decides which agents it should
 * interrupt. Only an addressed agent (by `@name` or `@team`) is woken; everyone else
 * accumulates it as unread and picks it up on their next turn boundary.
 */
export class MessageBus extends EventEmitter {
  private readonly subscribers = new Map<string, BusSubscriber>()
  private readonly unread = new Map<string, SquadMessage[]>()
  private readonly wakeTimes = new Map<string, number[]>()
  /** Relay depth of the last message delivered to each agent; their posts inherit depth+1. */
  private readonly depthOf = new Map<string, number>()
  /** When each agent's chain last advanced, so a stale chain can start over. */
  private readonly chainAt = new Map<string, number>()
  /** Last time a suppression was announced for an agent, to keep the groupchat readable. */
  private readonly suppressionNotedAt = new Map<string, number>()
  private readonly waiters = new Map<string, Array<() => void>>()
  private readonly log: SquadMessage[] = []
  private history: WriteStream | undefined

  constructor(private readonly options: BusOptions) {
    super()
    this.setMaxListeners(0)
    if (options.historyPath) {
      this.history = createWriteStream(options.historyPath, { flags: 'a' })
      // A failed history write must never take down the squad.
      this.history.on('error', err => this.emit('warning', `history log: ${err.message}`))
    }
  }

  register(sub: BusSubscriber): void {
    this.subscribers.set(sub.name, sub)
    if (!this.unread.has(sub.name)) this.unread.set(sub.name, [])
  }

  agentNames(): string[] {
    return [...this.subscribers.keys()]
  }

  messages(): readonly SquadMessage[] {
    return this.log
  }

  /** Post a message and route it. Returns the stored message. */
  post(input: PostInput): SquadMessage {
    const fromHuman = input.from === HUMAN
    // A chain that has gone quiet is over. Without this the depth only ever climbs - it
    // counts an agent's posts rather than the length of a back-and-forth - and every
    // mention from a busy agent ends up suppressed forever.
    const idleMs = this.options.chainIdleMs ?? 90_000
    const stale = Date.now() - (this.chainAt.get(input.from) ?? 0) >= idleMs
    const inherited = fromHuman || stale ? -1 : (this.depthOf.get(input.from) ?? 0)

    const mentions = new Set<string>(extractMentions(input.text))
    for (const m of input.mentions ?? []) mentions.add(m.replace(/^@/, '').toLowerCase())
    // A DM is addressed to its recipient by definition.
    if (input.channel.startsWith('dm:')) mentions.add(input.channel.slice(3).toLowerCase())

    const message: SquadMessage = {
      id: randomUUID(),
      ts: Date.now(),
      from: input.from,
      channel: input.channel,
      text: input.text,
      mentions: [...mentions],
      relayDepth: inherited + 1,
    }

    // Advance the sender's own chain depth here rather than on delivery: a hop that gets
    // suppressed must still count, or a blocked ping-pong simply resets and runs forever.
    if (!fromHuman) {
      this.depthOf.set(input.from, message.relayDepth)
      this.chainAt.set(input.from, message.ts)
    }

    this.log.push(message)
    this.history?.write(JSON.stringify(message) + '\n')
    this.emit('message', message)

    this.route(message)
    this.releaseWaiters(message)
    return message
  }

  /**
   * Whether `message` is addressed to `name` - the one place that decides who a message
   * interrupts. Both waking an idle agent and releasing a parked one go through this, so
   * an unmentioned post cannot interrupt through one path after being held back by the
   * other.
   */
  private addresses(message: SquadMessage, name: string): boolean {
    if (name === message.from) return false
    // A DM is visible only to its recipient.
    if (message.channel.startsWith('dm:') && name !== message.channel.slice(3)) return false
    return message.mentions.includes(TEAM) || message.mentions.includes(name.toLowerCase())
  }

  private route(message: SquadMessage): void {
    const fromHuman = message.from === HUMAN
    const isDm = message.channel.startsWith('dm:')
    const dmTarget = isDm ? message.channel.slice(3) : undefined

    for (const [name, sub] of this.subscribers) {
      if (name === message.from) continue
      if (isDm && name !== dmTarget) continue

      if (!this.addresses(message, name)) {
        this.queueUnread(name, message)
        continue
      }

      const suppression = fromHuman ? undefined : this.suppressionFor(name, message)
      if (suppression) {
        this.queueUnread(name, message)
        // Announce at most once a minute per agent: one notice per held-back mention
        // turned the groupchat into a wall of them.
        const lastNoted = this.suppressionNotedAt.get(name) ?? 0
        if (message.ts - lastNoted > 60_000) {
          this.suppressionNotedAt.set(name, message.ts)
          this.emit('suppressed', { agent: name, message, reason: suppression })
        }
        continue
      }

      if (!fromHuman) this.noteWake(name)
      this.depthOf.set(name, message.relayDepth)
      this.chainAt.set(name, message.ts)
      sub.deliver(renderForAgent(message))
    }
  }

  /**
   * Loop guard. Agents that @mention each other will otherwise ping-pong forever, so an
   * agent-originated wake is dropped to unread once the relay chain runs too deep or the
   * target has been woken too often in the last minute. Operator messages always pass.
   */
  private suppressionFor(name: string, message: SquadMessage): SuppressionReason | undefined {
    if (message.relayDepth > this.options.maxRelayDepth) return 'relay-depth'
    const now = Date.now()
    const recent = (this.wakeTimes.get(name) ?? []).filter(t => now - t < 60_000)
    this.wakeTimes.set(name, recent)
    if (recent.length >= this.options.maxWakesPerMinute) return 'rate-limit'
    return undefined
  }

  private noteWake(name: string): void {
    const times = this.wakeTimes.get(name) ?? []
    times.push(Date.now())
    this.wakeTimes.set(name, times)
  }

  private queueUnread(name: string, message: SquadMessage): void {
    this.unread.get(name)?.push(message)
  }

  /** Drain and return everything `name` has not yet seen. */
  takeUnread(name: string): SquadMessage[] {
    const pending = this.unread.get(name) ?? []
    this.unread.set(name, [])
    return pending
  }

  unreadCount(name: string): number {
    return this.unread.get(name)?.length ?? 0
  }

  /** Reset an agent's relay depth, so work it starts next is treated as a fresh chain. */
  resetDepth(name: string): void {
    this.depthOf.set(name, 0)
    this.chainAt.delete(name)
  }

  /**
   * Resolve once a message visible to `name` arrives, or after `timeoutMs`.
   * Backs the `wait_for_messages` tool so a blocked agent can park cheaply.
   */
  waitForMessage(name: string, timeoutMs: number): Promise<void> {
    if (this.unreadCount(name) > 0) return Promise.resolve()
    return new Promise<void>(resolve => {
      let done = false
      const finish = () => {
        if (done) return
        done = true
        clearTimeout(timer)
        const list = this.waiters.get(name)
        if (list) this.waiters.set(name, list.filter(f => f !== finish))
        resolve()
      }
      const timer = setTimeout(finish, timeoutMs)
      timer.unref?.()
      const list = this.waiters.get(name) ?? []
      list.push(finish)
      this.waiters.set(name, list)
    })
  }

  /**
   * Wake the agents parked in `wait_for_messages` that this message is addressed to.
   *
   * Only addressed agents: waking a parked agent is interrupting it, and an unmentioned
   * post is explicitly the "inform without interrupting" case. Releasing everyone meant
   * one @mention put the whole squad back to work.
   */
  private releaseWaiters(message: SquadMessage): void {
    for (const [name, list] of this.waiters) {
      if (!this.addresses(message, name)) continue
      for (const resolve of [...list]) resolve()
    }
  }

  close(): void {
    for (const list of this.waiters.values()) for (const resolve of [...list]) resolve()
    this.waiters.clear()
    this.history?.end()
  }
}

/** Format a message the way it is shown to an agent being woken by it. */
export function renderForAgent(message: SquadMessage): string {
  const channel = message.channel === 'group' ? 'groupchat' : 'direct message'
  const who = message.from === HUMAN ? 'the operator' : `@${message.from}`
  return `[${channel}] ${who}:\n${message.text}`
}

/** Format a batch of unread messages as a single catch-up turn. */
export function renderUnread(messages: SquadMessage[]): string {
  const lines = messages.map(m => {
    const where = m.channel === 'group' ? 'groupchat' : 'dm'
    const who = m.from === HUMAN ? 'operator' : `@${m.from}`
    return `- [${where}] ${who}: ${m.text}`
  })
  return `While you were working, ${messages.length} message${messages.length === 1 ? '' : 's'} arrived:\n\n${lines.join('\n')}\n\nRespond only if something here needs you; otherwise acknowledge briefly and stop.`
}
