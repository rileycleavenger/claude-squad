import path from 'node:path'

function str(input: Record<string, unknown> | unknown, key: string): string | undefined {
  if (!input || typeof input !== 'object') return undefined
  const value = (input as Record<string, unknown>)[key]
  return typeof value === 'string' ? value : undefined
}

function short(p: string | undefined): string {
  if (!p) return ''
  // Absolute worktree paths are long and mostly identical between agents; the tail is
  // the only part that tells you what the agent is actually touching.
  const parts = p.split(path.sep).filter(Boolean)
  return parts.length <= 3 ? p : '.../' + parts.slice(-3).join('/')
}

function clip(text: string, max = 72): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : flat.slice(0, max - 1) + '…'
}

/** Render one `tool_use` block as a single scannable transcript line. */
export function summarizeToolUse(name: string, input: unknown): string {
  const file = short(str(input, 'file_path') ?? str(input, 'path') ?? str(input, 'notebook_path'))

  switch (name) {
    case 'Read':
      return `Read ${file}`
    case 'Write':
      return `Write ${file}`
    case 'Edit':
      return `Edit ${file}`
    case 'NotebookEdit':
      return `Edit ${file}`
    case 'Bash':
      return `$ ${clip(str(input, 'command') ?? '')}`
    case 'Glob':
      return `Glob ${clip(str(input, 'pattern') ?? '', 40)}`
    case 'Grep':
      return `Grep ${clip(str(input, 'pattern') ?? '', 40)}${file ? ` in ${file}` : ''}`
    case 'WebSearch':
      return `Search ${clip(str(input, 'query') ?? '', 48)}`
    case 'WebFetch':
      return `Fetch ${clip(str(input, 'url') ?? '', 56)}`
    case 'Task':
      return `Subagent: ${clip(str(input, 'description') ?? '', 48)}`
    case 'TodoWrite':
      return 'Updated todos'
  }

  if (name.startsWith('mcp__squad__')) {
    const bare = name.slice('mcp__squad__'.length)
    switch (bare) {
      case 'post_to_groupchat':
        return `→ groupchat: ${clip(str(input, 'text') ?? '', 56)}`
      case 'dm_agent':
        return `→ @${str(input, 'to') ?? '?'}: ${clip(str(input, 'text') ?? '', 48)}`
      case 'read_groupchat':
        return 'Checked the groupchat'
      case 'list_squad':
        return 'Checked who is on the squad'
      case 'wait_for_messages':
        return 'Waiting for a teammate…'
      default:
        return bare
    }
  }

  return name.startsWith('mcp__') ? name.split('__').slice(1).join('.') : name
}
