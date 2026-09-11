#!/usr/bin/env node
import path from 'node:path'
import process from 'node:process'
import React from 'react'
import { render } from 'ink'
import { App } from './ui/App.js'
import { Squad } from './squad.js'
import { ConfigError, initSquad } from './config.js'

const USAGE = `claude-squad - a terminal workspace for a squad of Claude agents

Usage:
  squad                        start the squad in the current project
  squad --repo <path>          start it somewhere else
  squad init                   scaffold .squad/ with four default agent profiles
  squad --help

Run "squad" in a project and it picks up where you left off: the agents defined in
.squad/agents/*.md, and the conversations you were having with them. A project with no
agents opens with just the + tab, so you can define your first one there.

Each agent gets its own tab and its own git worktree; they coordinate in #groupchat.
`

interface Args {
  command: 'run' | 'init' | 'help'
  repo: string
}

function parseArgs(argv: string[]): Args {
  let command: Args['command'] = 'run'
  let repo = process.cwd()

  const rest = [...argv]
  if (rest[0] && !rest[0].startsWith('-')) {
    const verb = rest.shift()!
    if (verb === 'init') command = 'init'
    else if (verb === 'help') command = 'help'
    else throw new Error(`Unknown command "${verb}".`)
  }

  while (rest.length > 0) {
    const flag = rest.shift()!
    if (flag === '--help' || flag === '-h') {
      command = 'help'
    } else if (flag === '--repo' || flag === '-r') {
      const value = rest.shift()
      if (!value) throw new Error('--repo needs a path.')
      repo = value
    } else {
      throw new Error(`Unknown option "${flag}".`)
    }
  }

  return { command, repo: path.resolve(repo) }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))

  if (args.command === 'help') {
    process.stdout.write(USAGE)
    return
  }

  if (args.command === 'init') {
    const { created, skipped } = await initSquad(args.repo)
    for (const file of created) process.stdout.write(`created  ${path.relative(args.repo, file)}\n`)
    for (const file of skipped) process.stdout.write(`exists   ${path.relative(args.repo, file)}\n`)
    process.stdout.write(`\nEdit the profiles in .squad/agents/, then run "squad --repo ${args.repo}".\n`)
    return
  }

  const squad = await Squad.create(args.repo)
  squad.start()

  const instance = render(React.createElement(App, { squad }))

  // Test hook: render for a fixed time then exit, so the TUI can be smoke-tested in CI.
  const exitAfter = Number(process.env.SQUAD_EXIT_AFTER_MS ?? '')
  if (Number.isFinite(exitAfter) && exitAfter > 0) {
    setTimeout(() => instance.unmount(), exitAfter).unref()
  }

  await instance.waitUntilExit()
  await squad.shutdown()
}

main().catch((err: unknown) => {
  if (err instanceof ConfigError) {
    process.stderr.write(`${err.message}\n`)
  } else {
    process.stderr.write(`squad: ${(err as Error).message}\n`)
  }
  process.exitCode = 1
})
