import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

export class SecretError extends Error {}

/**
 * Resolve one `{{secret:...}}` reference.
 *
 * The provider is carried by the reference itself so no global configuration is needed:
 *
 *   env:GITHUB_TOKEN          process environment
 *   keychain:my-service       macOS Keychain generic password
 *   op://vault/item/field     1Password CLI
 *   BARE_NAME                 shorthand for env:BARE_NAME
 *
 * Values are injected straight into an MCP server's environment. They are never written
 * to a profile, a transcript, the history log or the state file, and the agent never
 * sees the value in its own context - only the server it talks to does.
 */
export async function resolveSecret(reference: string): Promise<string> {
  const ref = reference.trim()

  if (ref.startsWith('op://')) {
    try {
      const { stdout } = await run('op', ['read', ref], { timeout: 20_000 })
      return stdout.trim()
    } catch (err) {
      throw new SecretError(
        `Could not read ${ref} from 1Password: ${describe(err)}. Is the "op" CLI installed and signed in?`,
      )
    }
  }

  if (ref.startsWith('keychain:')) {
    const service = ref.slice('keychain:'.length)
    try {
      const { stdout } = await run('security', ['find-generic-password', '-s', service, '-w'], {
        timeout: 20_000,
      })
      return stdout.trim()
    } catch (err) {
      throw new SecretError(
        `Could not read "${service}" from the macOS Keychain: ${describe(err)}. Add it with: security add-generic-password -s ${service} -a squad -w`,
      )
    }
  }

  const name = ref.startsWith('env:') ? ref.slice('env:'.length) : ref
  const value = process.env[name]
  if (value === undefined || value === '') {
    throw new SecretError(`Environment variable ${name} is not set.`)
  }
  return value
}

function describe(err: unknown): string {
  const e = err as { stderr?: string; message?: string; code?: string }
  if (e.code === 'ENOENT') return 'command not found'
  return (e.stderr ?? e.message ?? String(err)).trim().split('\n')[0] ?? 'unknown error'
}

const SECRET_RE = /\{\{secret:([^}]+)\}\}/g

export function hasSecretRefs(value: string): boolean {
  SECRET_RE.lastIndex = 0
  return SECRET_RE.test(value)
}

/** Replace every `{{secret:...}}` reference in a string. */
export async function resolveSecretsIn(value: string): Promise<string> {
  const refs = [...value.matchAll(SECRET_RE)].map(m => m[1]!)
  let out = value
  for (const ref of refs) {
    const secret = await resolveSecret(ref)
    out = out.split(`{{secret:${ref}}}`).join(secret)
  }
  return out
}

/** Redact any resolved secret values that appear in text destined for a log or the UI. */
export function redact(text: string, secrets: Iterable<string>): string {
  let out = text
  for (const secret of secrets) {
    if (secret.length >= 6) out = out.split(secret).join('███redacted███')
  }
  return out
}
