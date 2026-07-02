import { execFile } from 'node:child_process'
import os from 'node:os'

let cached: Record<string, string> | null = null
let pending: Promise<Record<string, string>> | null = null

/**
 * GUI-launched macOS apps inherit launchd's minimal environment, not the
 * user's shell environment (PATH additions from homebrew, nvm, etc.).
 * Capture the real login-shell env once and merge it into every spawn.
 */
export function captureLoginShellEnv(): Promise<Record<string, string>> {
  if (cached) return Promise.resolve(cached)
  if (pending) return pending

  pending = new Promise((resolve) => {
    const shell = process.env.SHELL || '/bin/zsh'
    execFile(
      shell,
      ['-ilc', '/usr/bin/env -0'],
      { timeout: 5000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout) => {
        const env: Record<string, string> = {}
        if (!err && stdout) {
          for (const pair of stdout.split('\0')) {
            const eq = pair.indexOf('=')
            if (eq > 0) env[pair.slice(0, eq)] = pair.slice(eq + 1)
          }
        }
        // Fall back to (and always keep a floor of) our own process env.
        cached = { ...cleanProcessEnv(), ...env }
        resolve(cached)
      }
    )
  })
  return pending
}

function cleanProcessEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') env[k] = v
  }
  return env
}

export function defaultShell(): string {
  return process.env.SHELL || (os.platform() === 'darwin' ? '/bin/zsh' : '/bin/bash')
}
