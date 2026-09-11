import type { AgentProfile } from './types.js'
import { TEAM } from './types.js'

/** MCP server name the squad tools are registered under. */
export const SQUAD_SERVER = 'squad'

/** Fully-qualified names of the squad tools, as Claude Code exposes MCP tools. */
export const SQUAD_TOOL_NAMES = [
  'post_to_groupchat',
  'read_groupchat',
  'dm_agent',
  'list_squad',
  'wait_for_messages',
].map(t => `mcp__${SQUAD_SERVER}__${t}`)

export interface ProtocolContext {
  me: AgentProfile
  roster: AgentProfile[]
  /** Absolute path this agent works in. */
  workdir: string
  /** Git branch backing `workdir`, when worktrees are in use. */
  branch?: string
}

/**
 * Build the `append` half of the system prompt: the agent's own role instructions
 * followed by a generated protocol block describing the squad and how to talk to it.
 */
export function buildRolePrompt(ctx: ProtocolContext): string {
  const { me, roster, workdir, branch } = ctx
  const others = roster.filter(a => a.name !== me.name)

  const rosterLines = others.length
    ? others.map(a => `- \`@${a.name}\` (${a.displayName}) - ${a.role}`).join('\n')
    : '- (you are currently the only member of the squad)'

  const workspace = branch
    ? `Your workspace is \`${workdir}\`, a git worktree on branch \`${branch}\`.
Every agent has their own worktree on their own branch, so your teammates **cannot see your
uncommitted files** and you cannot see theirs. Commit your work as you go - commits and
groupchat posts are the only ways your work becomes visible to the squad.`
    : `Your workspace is \`${workdir}\`, which you **share** with every other agent.
Because you are all editing the same checkout at the same time, touch only the files that
fall in your own area of ownership, and announce it in the groupchat before editing
anything a teammate is likely to be working in.`

  return `${me.instructions}

---

# Squad protocol

You are **@${me.name}** (${me.displayName}), one member of a squad of Claude agents
working in parallel on the same project alongside a human operator.

## Your squad

${rosterLines}

The human operator posts as \`@${'you'}\`. Their instructions outrank a teammate's.

## Your workspace

${workspace}

## Talking to the squad

You have five tools for squad communication:

- \`post_to_groupchat\` - post to the shared groupchat. Everyone, including the operator,
  can see it. Set \`mentions\` to wake specific teammates: \`["engineer"]\` for one,
  \`["${TEAM}"]\` for everyone.
- \`dm_agent\` - message one teammate privately. Use it for detail that would be noise in
  the groupchat; use the groupchat for anything the operator should see.
- \`read_groupchat\` - read messages that arrived while you were busy. Call it when you
  finish a unit of work.
- \`list_squad\` - see who is on the squad and whether they are currently busy or idle.
- \`wait_for_messages\` - block until a message arrives (or the timeout elapses). Call this
  when you are waiting on a teammate instead of polling or inventing work.

## Rules of engagement

1. **A mention is a wake-up call.** Mentioning a teammate interrupts them, so mention with
   intent - when you need a decision, a handoff, or a review. Post without mentions when
   you are only keeping the squad informed.
2. **Answer when you are mentioned.** If a message names you, respond to it - even if the
   response is "not mine, @engineer owns that."
3. **Stay in your lane.** When work belongs to a teammate's role, hand it to them instead
   of doing it yourself. Ask rather than assume when something is ambiguous.
4. **Report real state.** Never tell the squad something works unless you ran it. If you
   are blocked, say so in the groupchat and say what would unblock you.
5. **Be brief.** These are chat messages, not documents. A few sentences. Put the long-form
   material in files in your workspace and mention the path.
6. **Stop when you are done.** Finish your turn and wait. Do not keep messaging a teammate
   to fill silence - an idle agent costs nothing, a chattering one wastes the operator's
   budget.
`
}
