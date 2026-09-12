import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MessageBus, extractMentions } from '../src/bus.js'
import { HUMAN } from '../src/types.js'

interface Captured {
  name: string
  received: string[]
}

function makeBus(
  agents: string[],
  opts?: { maxWakesPerMinute?: number; maxRelayDepth?: number; chainIdleMs?: number },
) {
  const bus = new MessageBus({
    maxWakesPerMinute: opts?.maxWakesPerMinute ?? 6,
    maxRelayDepth: opts?.maxRelayDepth ?? 8,
    chainIdleMs: opts?.chainIdleMs,
  })
  const captured = new Map<string, Captured>()
  for (const name of agents) {
    const entry: Captured = { name, received: [] }
    captured.set(name, entry)
    bus.register({ name, deliver: text => entry.received.push(text) })
  }
  return { bus, captured }
}

test('extractMentions finds handles and ignores emails', () => {
  assert.deepEqual(extractMentions('hey @engineer and @Architect').sort(), ['architect', 'engineer'])
  assert.deepEqual(extractMentions('mail me at bob@example.com'), [])
  assert.deepEqual(extractMentions('no mentions here'), [])
})

test('an unaddressed groupchat post wakes nobody but becomes unread', () => {
  const { bus, captured } = makeBus(['engineer', 'architect'])
  bus.post({ from: HUMAN, channel: 'group', text: 'just thinking out loud' })
  assert.equal(captured.get('engineer')!.received.length, 0)
  assert.equal(captured.get('architect')!.received.length, 0)
  assert.equal(bus.unreadCount('engineer'), 1)
  assert.equal(bus.unreadCount('architect'), 1)
})

test('a mention wakes only the named agent', () => {
  const { bus, captured } = makeBus(['engineer', 'architect'])
  bus.post({ from: HUMAN, channel: 'group', text: '@engineer please start' })
  assert.equal(captured.get('engineer')!.received.length, 1)
  assert.match(captured.get('engineer')!.received[0]!, /please start/)
  assert.equal(captured.get('architect')!.received.length, 0)
  assert.equal(bus.unreadCount('architect'), 1)
})

test('@team wakes everyone, and a sender never wakes itself', () => {
  const { bus, captured } = makeBus(['engineer', 'architect'])
  bus.post({ from: 'engineer', channel: 'group', text: 'status update', mentions: ['team'] })
  assert.equal(captured.get('architect')!.received.length, 1)
  assert.equal(captured.get('engineer')!.received.length, 0)
})

test('a DM reaches only its recipient', () => {
  const { bus, captured } = makeBus(['engineer', 'architect', 'product'])
  bus.post({ from: 'architect', channel: 'dm:engineer', text: 'use fastify' })
  assert.equal(captured.get('engineer')!.received.length, 1)
  assert.equal(captured.get('product')!.received.length, 0)
  assert.equal(bus.unreadCount('product'), 0, 'a DM should not even be unread for third parties')
})

test('agent wakes are rate limited, operator wakes are not', () => {
  const { bus, captured } = makeBus(['engineer', 'architect'], { maxWakesPerMinute: 2 })
  const suppressed: string[] = []
  bus.on('suppressed', ({ reason }: { reason: string }) => suppressed.push(reason))

  for (let i = 0; i < 5; i++) {
    bus.post({ from: 'architect', channel: 'group', text: `ping ${i}`, mentions: ['engineer'] })
  }
  assert.equal(captured.get('engineer')!.received.length, 2, 'only 2 agent wakes should land')
  assert.equal(bus.unreadCount('engineer'), 3, 'the held-back mentions are still delivered as unread')
  // The notice is announced at most once a minute per agent; one line per held-back
  // mention buried the groupchat.
  assert.equal(suppressed.length, 1)
  assert.ok(suppressed.every(r => r === 'rate-limit'))

  bus.post({ from: HUMAN, channel: 'group', text: '@engineer stop what you are doing' })
  assert.equal(captured.get('engineer')!.received.length, 3, 'the operator always gets through')
})

test('a relay chain is cut once it runs too deep', () => {
  const { bus, captured } = makeBus(['a', 'b'], { maxWakesPerMinute: 1000, maxRelayDepth: 3 })
  const suppressed: string[] = []
  bus.on('suppressed', ({ reason }: { reason: string }) => suppressed.push(reason))

  // a and b ping-pong: each post inherits the depth of the message that woke the sender.
  bus.post({ from: 'a', channel: 'group', text: 'hi b', mentions: ['b'] })
  for (let i = 0; i < 10; i++) {
    const from = i % 2 === 0 ? 'b' : 'a'
    const to = i % 2 === 0 ? 'a' : 'b'
    bus.post({ from, channel: 'group', text: `hop ${i}`, mentions: [to] })
  }

  const delivered = captured.get('a')!.received.length + captured.get('b')!.received.length
  assert.ok(delivered <= 4, `expected the chain to stop by depth 3, got ${delivered} deliveries`)
  assert.ok(suppressed.includes('relay-depth'))
})

test('takeUnread drains, and wait_for_messages resolves when the agent is addressed', async () => {
  const { bus, captured } = makeBus(['engineer'])
  bus.post({ from: HUMAN, channel: 'group', text: 'fyi' })
  assert.equal(bus.takeUnread('engineer').length, 1)
  assert.equal(bus.unreadCount('engineer'), 0)

  const waiting = bus.waitForMessage('engineer', 5000)
  bus.post({ from: 'architect', channel: 'group', text: '@engineer design is up', mentions: ['engineer'] })
  await waiting // resolves rather than timing out
  // An addressed message goes straight to the agent rather than waiting as unread.
  assert.deepEqual(captured.get('engineer')!.received.length, 1)
  bus.close()
})

test('an unaddressed post leaves a parked agent parked', async () => {
  // Waking an agent out of wait_for_messages is interrupting it, and an unmentioned post
  // is the "inform without interrupting" case. Releasing every waiter meant one @mention
  // put the whole squad back to work at once.
  const { bus } = makeBus(['engineer', 'architect'])
  let released = false
  const waiting = bus.waitForMessage('engineer', 200).then(() => {
    released = true
  })

  bus.post({ from: HUMAN, channel: 'group', text: '@architect what do you think?' })
  await new Promise(r => setTimeout(r, 60))
  assert.equal(released, false, 'a post addressed to a teammate must not wake this one')

  await waiting
  assert.equal(released, true, 'it still comes back on its own timeout')
  // The message is not lost - it is waiting to be read at the next turn boundary.
  assert.equal(bus.unreadCount('engineer'), 1)
  bus.close()
})

test('a DM releases only its recipient', async () => {
  const { bus } = makeBus(['engineer', 'architect'])
  let engineerWoke = false
  const waiting = bus.waitForMessage('engineer', 200).then(() => {
    engineerWoke = true
  })
  bus.post({ from: 'architect', channel: 'dm:engineer', text: 'just you' })
  await new Promise(r => setTimeout(r, 20))
  assert.equal(engineerWoke, true)
  await waiting
  bus.close()
})

test('wait_for_messages gives up after its timeout', async () => {
  const { bus } = makeBus(['engineer'])
  const started = Date.now()
  await bus.waitForMessage('engineer', 60)
  assert.ok(Date.now() - started >= 50)
  bus.close()
})


test('a relay chain restarts after a quiet gap instead of gagging an agent forever', () => {
  // The depth used to climb on every post an agent made and never come back down, so a
  // busy agent's mentions were suppressed permanently after maxRelayDepth posts.
  const { bus, captured } = makeBus(['a', 'b'], { maxWakesPerMinute: 1000, maxRelayDepth: 3, chainIdleMs: 0 })
  for (let i = 0; i < 12; i++) {
    bus.post({ from: 'a', channel: 'group', text: `update ${i}`, mentions: ['b'] })
  }
  assert.equal(
    captured.get('b')!.received.length,
    12,
    'separated posts are new chains, so none of them should be held back',
  )
})

test('a tight back-and-forth is still cut off', () => {
  const { bus, captured } = makeBus(['a', 'b'], { maxWakesPerMinute: 1000, maxRelayDepth: 3 })
  bus.post({ from: 'a', channel: 'group', text: 'hi b', mentions: ['b'] })
  for (let i = 0; i < 10; i++) {
    const from = i % 2 === 0 ? 'b' : 'a'
    const to = i % 2 === 0 ? 'a' : 'b'
    bus.post({ from, channel: 'group', text: `hop ${i}`, mentions: [to] })
  }
  const delivered = captured.get('a')!.received.length + captured.get('b')!.received.length
  assert.ok(delivered <= 4, `the chain should stop by depth 3, got ${delivered}`)
})

test('an operator message always starts a fresh chain', () => {
  const { bus, captured } = makeBus(['a', 'b'], { maxWakesPerMinute: 1000, maxRelayDepth: 2 })
  for (let i = 0; i < 6; i++) {
    const from = i % 2 === 0 ? 'a' : 'b'
    bus.post({ from, channel: 'group', text: `hop ${i}`, mentions: [from === 'a' ? 'b' : 'a'] })
  }
  const before = captured.get('a')!.received.length
  bus.post({ from: HUMAN, channel: 'group', text: '@a carry on' })
  assert.equal(captured.get('a')!.received.length, before + 1)
})
