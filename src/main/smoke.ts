import { app } from 'electron'
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { sessionManager } from './terminal/SessionManager'

/**
 * Headless self-test: ORB_SMOKE=1 spawns a real PTY shell, runs a command,
 * and asserts both the command output and the OSC 133 shell-integration
 * markers round-trip. Used in dev and as the packaged-app smoke test
 * (the only reliable way to catch native-module/ABI regressions).
 */
export async function runSmokeTest(): Promise<never> {
  const chunks: Buffer[] = []
  let settled = false

  const finish = (ok: boolean, reason: string): void => {
    if (settled) return
    settled = true
    const out = Buffer.concat(chunks).toString('utf8')
    console.log(`[smoke] ${ok ? 'PASS' : 'FAIL'}: ${reason}`)
    if (!ok) console.log('[smoke] captured output:\n' + JSON.stringify(out.slice(-2000)))
    sessionManager.disposeAll()
    app.exit(ok ? 0 : 1)
    throw new Error('unreachable')
  }

  setTimeout(() => finish(false, 'timeout after 15s'), 15_000)

  sessionManager.onData((_id, data) => {
    chunks.push(Buffer.from(data))
    const text = Buffer.concat(chunks).toString('utf8')
    const hasEcho = text.includes('ORB_SMOKE_MARKER_OK')
    const hasPromptStart = text.includes('\x1b]133;A\x07')
    const hasCommandFinished = /\x1b\]133;D(;\d+)?\x07/.test(text)
    const hasCwdReport = text.includes('\x1b]7;file://')
    if (hasEcho && hasPromptStart && hasCommandFinished && hasCwdReport) {
      finish(true, 'PTY spawn + output + OSC 133/7 shell integration all verified')
    }
  })

  sessionManager.onExit((id, exitCode, signal) => {
    console.log(`[smoke] session ${id} exited code=${exitCode} signal=${signal}`)
  })

  // Isolate from the user's dotfiles (which may block interactively) so the
  // smoke test only exercises OUR pipeline: PTY + shim + OSC emission.
  const emptyZdotdir = mkdtempSync(path.join(os.tmpdir(), 'orb-smoke-'))
  const info = await sessionManager.createShell({
    cols: 100,
    rows: 30,
    env: { ORB_USER_ZDOTDIR: emptyZdotdir }
  })
  console.log(`[smoke] spawned shell pid=${info.pid} session=${info.sessionId}`)
  setTimeout(() => {
    sessionManager.write(info.sessionId, 'echo ORB_SMOKE_MARKER_$((40+2)) | tr 42 OK\r')
  }, 1500)

  return new Promise<never>(() => {})
}
