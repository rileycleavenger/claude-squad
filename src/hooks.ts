/**
 * Bridge shell PreToolUse hooks into the Agent SDK.
 *
 * Claude Code's own hooks are commands configured in settings. The SDK takes callbacks
 * instead, and it loads no settings files unless told to - and squad deliberately tells it
 * `settingSources: ['project']`, because pulling in the user layer also pulls in their
 * personal MCP servers and every agent opens with auth errors.
 *
 * So a hook the user has installed for Claude Code does not reach a squad agent on its
 * own. This module carries one across: same stdin JSON, same stdout contract, run from a
 * callback. That matters more here than in a single session - four agents reading files at
 * full size fill four context windows in parallel.
 */
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type {
  HookCallback,
  HookCallbackMatcher,
  HookEvent,
  HookJSONOutput,
} from '@anthropic-ai/claude-agent-sdk'

/** A hook command as registered in a Claude Code settings file. */
export interface RegisteredHook {
  event: string
  /** Tool name pattern, e.g. `Read`. Absent means every tool. */
  matcher?: string
  command: string
  args: string[]
  /** Seconds, as settings files express it. */
  timeout?: number
}

/**
 * Pull the command hooks out of a parsed settings file.
 *
 * Anything malformed is skipped rather than thrown: a settings file is the user's, may be
 * hand-edited, and a typo in an unrelated entry must not stop the squad from starting.
 */
export function parseUserHooks(settings: unknown): RegisteredHook[] {
  const out: RegisteredHook[] = []
  const hooks = (settings as { hooks?: unknown } | null)?.hooks
  if (!hooks || typeof hooks !== 'object') return out

  for (const [event, matchers] of Object.entries(hooks as Record<string, unknown>)) {
    if (!Array.isArray(matchers)) continue
    for (const entry of matchers) {
      const matcher = (entry as { matcher?: unknown })?.matcher
      const list = (entry as { hooks?: unknown })?.hooks
      if (!Array.isArray(list)) continue
      for (const hook of list) {
        const h = hook as { type?: unknown; command?: unknown; args?: unknown; timeout?: unknown }
        if (h?.type !== 'command' || typeof h.command !== 'string' || !h.command.trim()) continue
        out.push({
          event,
          matcher: typeof matcher === 'string' && matcher.trim() ? matcher : undefined,
          command: h.command,
          args: Array.isArray(h.args) ? h.args.map(String) : [],
          ...(typeof h.timeout === 'number' && h.timeout > 0 ? { timeout: h.timeout } : {}),
        })
      }
    }
  }
  return out
}

/** Where Claude Code keeps the user's settings. */
export function userSettingsPath(home = os.homedir()): string {
  return path.join(home, '.claude', 'settings.json')
}

/** Read and parse the user's registered hooks. Missing or broken file means none. */
export async function loadUserHooks(file = userSettingsPath()): Promise<RegisteredHook[]> {
  try {
    return parseUserHooks(JSON.parse(await fs.readFile(file, 'utf8')))
  } catch {
    return []
  }
}

/**
 * Find a registered hook by the basename of its command.
 *
 * Matching on basename rather than adopting the registry wholesale is the point: a
 * capability names the hooks it wants, and unrelated things the user installs later stay
 * out of the squad. The event and matcher come from the capability too, so a hook cannot
 * be silently rebound to a different tool by an edit to the user's settings.
 */
export function findRegisteredHook(
  command: string,
  registered: RegisteredHook[],
): RegisteredHook | undefined {
  const wanted = path.basename(command)
  return registered.find(hook => path.basename(hook.command) === wanted)
}

/** Default seconds to wait for a hook before giving up on it. */
export const HOOK_TIMEOUT_SECONDS = 10

/**
 * Decide what a finished hook process meant.
 *
 * Silence is "no objection" - the convention these scripts are written to, because an
 * explicit allow would auto-approve the tool call and bypass permissions entirely. A
 * crash, a timeout, or unparseable output is also treated as no objection: a hook that
 * breaks should cost tokens, not stop the agent from working.
 */
export function interpretHookOutput(stdout: string, ok: boolean): HookJSONOutput {
  if (!ok) return {}
  const text = stdout.trim()
  if (!text) return {}
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? (parsed as HookJSONOutput) : {}
  } catch {
    return {}
  }
}

/**
 * Group resolved hooks into the shape `Options.hooks` wants.
 *
 * Hooks sharing an event and matcher are collapsed into one entry, because that is how the
 * SDK expects them and how settings files express them.
 */
export function buildHookMatchers(
  hooks: Array<{ event: string; matcher?: string; command: string; args?: string[]; timeout?: number }>,
  onProblem?: (message: string) => void,
): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  const out: Partial<Record<HookEvent, HookCallbackMatcher[]>> = {}

  for (const hook of hooks) {
    const event = hook.event as HookEvent
    const matchers = (out[event] ??= [])
    const existing = matchers.find(m => m.matcher === hook.matcher)
    const callback = commandHook(hook, onProblem)
    if (existing) existing.hooks.push(callback)
    else matchers.push({ matcher: hook.matcher, hooks: [callback] })
  }

  return out
}

/** Turn a shell hook into an SDK callback. */
export function commandHook(
  spec: { command: string; args?: string[]; timeout?: number },
  onProblem?: (message: string) => void,
): HookCallback {
  const timeoutMs = (spec.timeout ?? HOOK_TIMEOUT_SECONDS) * 1000
  const label = path.basename(spec.command)

  return async (input, _toolUseID, { signal }) =>
    new Promise<HookJSONOutput>(resolve => {
      let child: ReturnType<typeof spawn>
      try {
        child = spawn(spec.command, spec.args ?? [], { stdio: ['pipe', 'pipe', 'pipe'] })
      } catch (err) {
        onProblem?.(`${label} could not run: ${(err as Error).message}`)
        resolve({})
        return
      }

      let stdout = ''
      let stderr = ''
      let done = false

      const kill = () => {
        try {
          child.kill('SIGKILL')
        } catch {
          // Already gone.
        }
      }
      const finish = (output: HookJSONOutput) => {
        if (done) return
        done = true
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        resolve(output)
      }
      const onAbort = () => {
        kill()
        finish({})
      }
      const timer = setTimeout(() => {
        kill()
        onProblem?.(`${label} timed out after ${timeoutMs / 1000}s`)
        finish({})
      }, timeoutMs)
      signal.addEventListener('abort', onAbort, { once: true })

      child.stdout?.on('data', chunk => {
        stdout += String(chunk)
      })
      child.stderr?.on('data', chunk => {
        stderr += String(chunk)
      })
      child.on('error', err => {
        onProblem?.(`${label} could not run: ${err.message}`)
        finish({})
      })
      child.on('close', code => {
        // Exit 2 with stderr is the other host's block signal; these scripts print the
        // JSON either way, so the payload is read regardless of which convention ran.
        if (code !== 0 && code !== 2 && stderr.trim()) {
          onProblem?.(`${label}: ${stderr.trim().split('\n')[0]}`)
        }
        finish(interpretHookOutput(stdout, true))
      })

      // The scripts read the whole event off stdin, exactly as Claude Code sends it.
      child.stdin?.on('error', () => {
        // The hook exited without reading; its own exit is what matters.
      })
      child.stdin?.end(JSON.stringify(input))
    })
}
