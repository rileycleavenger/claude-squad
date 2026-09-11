# claude-squad

A terminal workspace for a **squad** of Claude agents. Each agent has its own tab you can
talk to privately, its own git worktree to work in, and a shared `#groupchat` where they
coordinate with each other — and with you.

```
claude-squad ─ my-project
 #groupchat  Architect ●  Engineer ●  Product ○  Marketing ○ (2)
╭────────────────────────────────────────────────────────────────────╮
│ 14:02 you          Team, build a REST API for the todo service     │
│ 14:02 architect    Fastify + Postgres. Engineer takes the handlers, │
│                    I'll land the schema. Design in docs/design.md.  │
│ 14:03 engineer     ⚙ Write src/routes/todos.ts                      │
│ 14:04 product      Acceptance criteria are in docs/requirements.md. │
╰────────────────────────────────────────────────────────────────────╯
#groupchat > _
architect:working  engineer:working  product:idle     $1.84 · ^K stop · ^C quit
```

## How it works

Every agent is one long-running [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview)
session whose prompt is a queue that never closes — so each tab is a real conversation
that stays in context, not a series of one-shot tasks. Because each session is its own
process, the squad genuinely works in parallel.

- **Profiles are markdown.** An agent is a file in `.squad/agents/<name>.md`: YAML
  frontmatter plus the role instructions. That is the whole configuration.
- **Worktrees keep them out of each other's way.** Each agent works in
  `.squad/worktrees/<name>` on branch `squad/<name>`, so four agents can edit at once
  without clobbering. You review and merge the branches afterwards.
- **@mentions are how agents get each other's attention.** A groupchat post only
  interrupts the agents it names (or `@team`). Everyone else picks it up at their next
  turn boundary, so the squad isn't constantly derailing itself.

## Getting started

```sh
npm install
npm run build
npm link          # puts `squad` on your PATH
```

Then, in any project:

```sh
cd ~/code/my-project
squad
```

That's the whole workflow. `squad` picks up where you left off — the agents defined in
that project and the conversations you were having with them. A project with no agents
opens with just the `+` tab so you can define your first one there; `squad init`
scaffolds four ready-made ones instead.

During development, `npm run dev` runs it straight from TypeScript.

The SDK uses your existing Claude Code credentials. Set `ANTHROPIC_API_KEY` to bill an API
key instead.

## Using it

| Key | |
| --- | --- |
| `←` `→` | switch tabs (`Tab` / `Shift+Tab` also work) |
| `↑` `↓` | input history; moves the selection in the `+` tab |
| `Enter` | send |
| `^K` | interrupt the current tab's agent |
| `^C` | shut the squad down |

Typing in `#groupchat` addresses the whole team. Typing in an agent's tab is a private
message to just that agent. Each tab keeps its own unsent draft.

| Command | |
| --- | --- |
| `/status` | every agent's state and branch |
| `/cost` | spend per agent |
| `/stop [agent]` | interrupt an agent |
| `/new` | jump to the `+` tab |
| `/help`, `/quit` | |

## Adding agents from the TUI

The `+` tab adds an agent to a running squad — no restart, no editing files by hand.

1. Pick a starting point: **Blank agent**, one of the four **built-in** roles, an agent
   you saved to your **library**, or a profile already in **this project** that isn't
   currently running.
2. Fill in the form. `↑` `↓` move between fields, `Enter` advances (and adds a
   newline in the instructions), `^L` toggles saving a copy to your library, `^S` creates
   the agent, `Esc` goes back.

The new agent gets its profile written to `.squad/agents/`, its own worktree and branch,
and its own tab, and is announced in `#groupchat` so the agents already running know it
exists.

Your library lives in `~/.claude-squad/agents/` and is shared across every project, so a
role you tune once can be reused anywhere.

## Picking up where you left off

Relaunching a squad in a project restores:

- the agents defined in `.squad/agents/`
- **the conversations themselves** — each agent's Claude Code session is resumed, so it
  still remembers what you told it last time
- the transcript in every tab, and the tab you were last looking at
- lifetime spend per agent

This lives in `.squad/state.json` (session ids and costs) and `.squad/transcript.jsonl`
(what's on screen). Delete them to start the squad over with a clean slate; the agent
profiles are untouched.

## Writing a profile

```markdown
---
name: engineer          # the @mention handle and branch name
displayName: Engineer
role: Writes and tests the implementation   # shown to teammates in the roster
model: claude-opus-5    # optional; defaults to squad.json's defaultModel
effort: high            # low | medium | high | xhigh | max
color: green
budgetUsd: 10           # hard spend cap for the session
---

You are the squad's software engineer. You own implementation...
```

The body becomes the agent's system prompt. Appended to it automatically: the roster of
teammates, the agent's own workspace and branch, and the squad protocol describing the
groupchat tools and the rules of engagement.

`.squad/squad.json` holds the defaults:

```json
{
  "defaultModel": "claude-opus-5",
  "defaultEffort": "high",
  "defaultBudgetUsd": 10,
  "maxWakesPerMinute": 6,
  "maxRelayDepth": 8,
  "useWorktrees": true
}
```

## The tools agents get

Beyond the usual file, bash and search tools, each agent gets five squad tools. Their own
identity is baked in, so an agent cannot post as a teammate.

| Tool | |
| --- | --- |
| `post_to_groupchat` | post to the shared channel; `mentions` decides who it interrupts |
| `dm_agent` | message one teammate privately |
| `read_groupchat` | drain what arrived while it was busy |
| `list_squad` | who's on the squad and who's busy |
| `wait_for_messages` | block until a teammate replies, instead of burning tokens polling |

## Safety and cost

Agents run **fully autonomously** (`bypassPermissions`) — they execute bash without asking.
That is what makes parallel work possible, and it is a real risk. The guardrails:

- each agent is confined to its own worktree
- `budgetUsd` is a hard per-agent cap enforced by the SDK; an agent that hits it stops
- `^K` interrupts an agent, `^C` aborts every session
- two loop guards stop agents from @mentioning each other forever: a per-agent wake rate
  limit, and a maximum relay depth. Your own messages always get through.

Point it at a scratch repo first. Four concurrent Opus agents spend quickly — the footer
shows the running total, and lighter roles do fine on `claude-sonnet-5`.

## Development

```sh
npm test              # routing, config, drafts, persistence, controller (no API calls)
npm run smoke         # one real agent: proves session continuity and worktree writes
npm run integration   # two real agents: groupchat, @mention handoff, worktree isolation
```

`smoke` and `integration` call the API. They default to `claude-haiku-4-5` since they
exercise plumbing rather than model quality; override with `SQUAD_SMOKE_MODEL`.
