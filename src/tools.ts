import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { MessageBus } from './bus.js'
import { renderUnread } from './bus.js'
import type { AgentProfile } from './types.js'
import { TEAM } from './types.js'
import { SQUAD_SERVER } from './prompt.js'

/** Live view of an agent, so `list_squad` can report who is busy. */
export interface SquadDirectory {
  profiles(): AgentProfile[]
  statusOf(name: string): string
}

function text(body: string) {
  return { content: [{ type: 'text' as const, text: body }] }
}

/**
 * Build the in-process MCP server that gives one agent its squad tools.
 *
 * The agent's own identity is captured in this closure rather than taken as a tool
 * argument, so an agent cannot post to the groupchat as one of its teammates.
 */
export function buildSquadServer(me: string, bus: MessageBus, directory: SquadDirectory) {
  const knownHandles = () => new Set(directory.profiles().map(p => p.name.toLowerCase()))

  /** Reject mentions that name nobody, so a typo fails loudly instead of silently. */
  const validateMentions = (mentions: string[]): string | undefined => {
    const known = knownHandles()
    const unknown = mentions
      .map(m => m.replace(/^@/, '').toLowerCase())
      .filter(m => m !== TEAM && m !== me.toLowerCase() && !known.has(m))
    if (unknown.length === 0) return undefined
    return `Unknown teammate${unknown.length === 1 ? '' : 's'}: ${unknown.map(u => '@' + u).join(', ')}. The squad is: ${[...known].map(k => '@' + k).join(', ')}, or "${TEAM}" for everyone.`
  }

  const postToGroupchat = tool(
    'post_to_groupchat',
    'Post to the squad groupchat. Use this ONLY for something that changes what a teammate does: a decision they must build against, a handoff, a blocker, a question only they can answer, or a change to something shared. NOT for progress updates, phase announcements, implementation detail, test results or summaries of your work - those belong in your reply to the operator, which teammates do not pay for. Two or three sentences; if it needs more, write a file and post the path. Set `mentions` to interrupt specific teammates now; leave it empty to inform without interrupting.',
    {
      text: z
        .string()
        .min(1)
        .describe(
          'The message, in two or three plain sentences. No headings or bullet lists - this is a chat message read by several agents, not a status report.',
        ),
      mentions: z
        .array(z.string())
        .optional()
        .describe(`Handles to wake, without the @ - e.g. ["engineer"], or ["${TEAM}"] for everyone.`),
    },
    async ({ text: body, mentions }) => {
      const error = validateMentions(mentions ?? [])
      if (error) return text(error)
      bus.post({ from: me, channel: 'group', text: body, mentions })
      const woke = mentions?.length ? ` Woke ${mentions.map(m => '@' + m).join(', ')}.` : ''
      return text(`Posted to the groupchat.${woke}`)
    },
    { annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
  )

  const dmAgent = tool(
    'dm_agent',
    'Send a private message to one teammate. The operator can read it in that teammate’s tab, but other agents cannot. Use the groupchat instead for anything the whole squad should know.',
    {
      to: z.string().describe('The teammate’s handle, without the @.'),
      text: z.string().min(1).describe('The message.'),
    },
    async ({ to, text: body }) => {
      const target = to.replace(/^@/, '').toLowerCase()
      if (target === me.toLowerCase()) return text('You cannot DM yourself.')
      const error = validateMentions([target])
      if (error) return text(error)
      bus.post({ from: me, channel: `dm:${target}`, text: body })
      return text(`Sent to @${target}.`)
    },
    { annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
  )

  const readGroupchat = tool(
    'read_groupchat',
    'Read the messages that arrived while you were working and have not been shown to you yet. Call this when you finish a unit of work.',
    {},
    async () => {
      const pending = bus.takeUnread(me)
      if (pending.length === 0) return text('No new messages.')
      return text(renderUnread(pending))
    },
    { annotations: { readOnlyHint: true, openWorldHint: false } },
  )

  const listSquad = tool(
    'list_squad',
    'List your teammates, what each of them is responsible for, and whether they are currently busy.',
    {},
    async () => {
      const rows = directory
        .profiles()
        .filter(p => p.name !== me)
        .map(p => `- @${p.name} (${p.displayName}) - ${p.role} [${directory.statusOf(p.name)}]`)
      if (rows.length === 0) return text('You are the only member of the squad.')
      return text(`Squad:\n${rows.join('\n')}`)
    },
    { annotations: { readOnlyHint: true, openWorldHint: false } },
  )

  const waitForMessages = tool(
    'wait_for_messages',
    'Block until a message arrives for you, or until the timeout elapses. Use this when you are waiting on a teammate - it is far cheaper than polling or inventing filler work.',
    {
      timeoutSeconds: z
        .number()
        .int()
        .min(1)
        .max(600)
        .default(120)
        .describe('How long to wait before giving up. Defaults to 120 seconds.'),
    },
    async ({ timeoutSeconds }) => {
      await bus.waitForMessage(me, timeoutSeconds * 1000)
      const pending = bus.takeUnread(me)
      if (pending.length === 0) {
        return text(`No messages arrived within ${timeoutSeconds}s. If you are still blocked, say so in the groupchat and stop rather than waiting again.`)
      }
      return text(renderUnread(pending))
    },
    { annotations: { readOnlyHint: true, openWorldHint: false } },
  )

  return createSdkMcpServer({
    name: SQUAD_SERVER,
    version: '0.1.0',
    instructions: `Squad communication tools for @${me}. Use them to coordinate with your teammates and the human operator.`,
    tools: [postToGroupchat, dmAgent, readGroupchat, listSquad, waitForMessages],
    alwaysLoad: true,
  })
}
