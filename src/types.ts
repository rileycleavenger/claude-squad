/** Core shared types for claude-squad. */

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** A squad member, parsed from a `.squad/agents/<name>.md` profile. */
export interface AgentProfile {
  /** Stable id; also the @mention handle and the git branch suffix. */
  name: string
  /** Human label shown in the tab bar. */
  displayName: string
  /** One-line role summary, shown to other agents in the roster. */
  role: string
  model?: string
  effort?: EffortLevel
  /** Ink color name for this agent's transcript label. */
  color: string
  /** Tool allowlist passed to the SDK; undefined means "all built-ins". */
  tools?: string[]
  /** Capability names this agent is equipped with, from `.squad/capabilities` or built-ins. */
  capabilities: string[]
  /**
   * Extra skill names to keep available alongside the capabilities. Equipping an agent
   * with capabilities scopes its skill list, which also hides Claude Code's bundled
   * skills; list any you want back (e.g. `code-review`).
   */
  skills?: string[]
  budgetUsd?: number
  /** The markdown body of the profile: this agent's system instructions. */
  instructions: string
}

export interface SquadConfig {
  /** Absolute path to the target repo the squad works on. */
  repoPath: string
  /** Absolute path to `<repo>/.squad`. */
  squadDir: string
  agents: AgentProfile[]
  defaultModel: string
  defaultEffort: EffortLevel
  defaultBudgetUsd: number
  /** Loop guard: max agent-originated wakes delivered to one agent per minute. */
  maxWakesPerMinute: number
  /** Loop guard: how many agent->agent relay hops a message may travel. */
  maxRelayDepth: number
  /** Whether to isolate each agent in its own git worktree. */
  useWorktrees: boolean
}

/** Where a message is addressed. `group` is the groupchat; `dm:<name>` is a private thread. */
export type Channel = 'group' | `dm:${string}`

/** The sender id used for messages typed by the human operator. */
export const HUMAN = 'you'

/** Mention token that addresses every agent at once. */
export const TEAM = 'team'

export interface SquadMessage {
  id: string
  ts: number
  /** `you` for the operator, otherwise an agent name. */
  from: string
  channel: Channel
  text: string
  /** Normalized mention handles without the leading `@` (may include `team`). */
  mentions: string[]
  /** How many agent-to-agent hops produced this message. Operator messages are 0. */
  relayDepth: number
}

export type AgentStatus =
  | { kind: 'starting' }
  | { kind: 'idle' }
  | { kind: 'thinking' }
  | { kind: 'tool'; tool: string }
  | { kind: 'stopped' }
  | { kind: 'error'; message: string }

/** A renderable line in a tab's transcript. */
export type Entry =
  | { kind: 'chat'; id: string; ts: number; from: string; text: string; mentions: string[] }
  | { kind: 'tool'; id: string; ts: number; agent: string; summary: string }
  | { kind: 'notice'; id: string; ts: number; agent: string; text: string }
  | { kind: 'error'; id: string; ts: number; agent: string; text: string }
