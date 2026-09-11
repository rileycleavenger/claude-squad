import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { promises as fs } from 'node:fs'
import path from 'node:path'

const run = promisify(execFile)

async function git(repoPath: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', ['-C', repoPath, ...args], { maxBuffer: 8 * 1024 * 1024 })
  return stdout.trim()
}

async function gitOk(repoPath: string, args: string[]): Promise<boolean> {
  try {
    await git(repoPath, args)
    return true
  } catch {
    return false
  }
}

export interface Workspace {
  /** Absolute directory the agent works in. */
  path: string
  /** Branch backing `path`, or undefined when agents share the repo directly. */
  branch?: string
}

export async function isGitRepo(repoPath: string): Promise<boolean> {
  return gitOk(repoPath, ['rev-parse', '--git-dir'])
}

/** True when the repo has at least one commit; `git worktree add` needs a base commit. */
export async function hasCommits(repoPath: string): Promise<boolean> {
  return gitOk(repoPath, ['rev-parse', '--verify', 'HEAD'])
}

/**
 * Resolve symlinks so paths can be compared. On macOS `/var` is a symlink to
 * `/private/var`, and git always reports the real path - comparing raw strings would
 * miss an existing worktree and then fail to recreate it.
 */
async function canonical(p: string): Promise<string> {
  try {
    return await fs.realpath(p)
  } catch {
    return path.resolve(p)
  }
}

async function worktreePaths(repoPath: string): Promise<Set<string>> {
  const out = await git(repoPath, ['worktree', 'list', '--porcelain'])
  const paths = new Set<string>()
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) paths.add(await canonical(line.slice('worktree '.length)))
  }
  return paths
}

/**
 * Give one agent an isolated checkout: `<repo>/.squad/worktrees/<name>` on branch
 * `squad/<name>`. Reuses an existing worktree or branch so restarting the squad picks up
 * where it left off rather than discarding work.
 */
export async function ensureWorktree(repoPath: string, agent: string): Promise<Workspace> {
  const target = path.join(repoPath, '.squad', 'worktrees', agent)
  const branch = `squad/${agent}`

  if ((await worktreePaths(repoPath)).has(await canonical(target))) {
    return { path: target, branch }
  }

  const branchExists = await gitOk(repoPath, ['rev-parse', '--verify', `refs/heads/${branch}`])
  const args = branchExists
    ? ['worktree', 'add', target, branch]
    : ['worktree', 'add', target, '-b', branch]

  try {
    await git(repoPath, args)
  } catch (err) {
    const detail = (err as { stderr?: string }).stderr?.trim() || (err as Error).message
    const hint = detail.includes('already exists')
      ? ` The directory is there but git does not know about it; run "git -C ${repoPath} worktree prune" or delete ${target}, then start again.`
      : ''
    throw new Error(`Could not create a worktree for @${agent}: ${detail}${hint}`)
  }

  return { path: target, branch }
}

/**
 * Resolve a workspace for every agent. Falls back to the shared repo directory when
 * worktrees are disabled or unavailable, reporting why so the operator is not surprised
 * by agents editing the same files.
 */
export async function provisionWorkspaces(
  repoPath: string,
  agents: string[],
  useWorktrees: boolean,
): Promise<{ workspaces: Map<string, Workspace>; warning?: string }> {
  const workspaces = new Map<string, Workspace>()
  const shared = (warning: string) => {
    for (const agent of agents) workspaces.set(agent, { path: repoPath })
    return { workspaces, warning }
  }

  if (!useWorktrees) {
    return shared('Worktrees are disabled, so all agents share one checkout and may overwrite each other.')
  }
  if (!(await isGitRepo(repoPath))) {
    return shared(`${repoPath} is not a git repository, so all agents share one checkout and may overwrite each other.`)
  }
  if (!(await hasCommits(repoPath))) {
    return shared('This repository has no commits yet, so worktrees cannot be created. All agents share one checkout - make an initial commit and restart for isolation.')
  }

  for (const agent of agents) {
    workspaces.set(agent, await ensureWorktree(repoPath, agent))
  }
  return { workspaces }
}
