/**
 * Tracks one armed command inside a task terminal via the shell-integration
 * markers our zsh shim emits (OSC 133;A prompt / C executed / D;exit done).
 * The agent command is typed into the shell at the first prompt; when the
 * command finishes the terminal drops back to the prompt and KEEPS RUNNING —
 * only the run record settles.
 */

const OSC_PROMPT = '\x1b]133;A\x07'
const OSC_EXEC = '\x1b]133;C\x07'
const OSC_DONE = /\x1b\]133;D(?:;(\d+))?\x07/

/** Written around the command so zle treats embedded newlines as literal. */
function bracketedPaste(cmd: string): string {
  return `\x1b[200~${cmd}\x1b[201~\r`
}

export interface ArmedCommand {
  runId: string
  command: string
}

type State =
  | { phase: 'idle' }
  | { phase: 'wait-prompt'; armed: ArmedCommand }
  | { phase: 'wait-exec'; armed: ArmedCommand }
  | { phase: 'running'; armed: ArmedCommand }

export class CommandTracker {
  private state: State = { phase: 'idle' }
  private atPrompt = false
  private tail = ''
  private fallbackTimer: NodeJS.Timeout | null = null

  constructor(
    private readonly write: (data: string) => void,
    private readonly onFinished: (runId: string, exitCode: number) => void
  ) {}

  /** True while an armed agent command is pending or in the foreground. */
  get busy(): boolean {
    return this.state.phase !== 'idle'
  }

  get activeRunId(): string | undefined {
    return this.state.phase === 'idle' ? undefined : this.state.armed.runId
  }

  /**
   * Queue a command to be typed at the next shell prompt (immediately if the
   * shell is already sitting at one). Throws if a tracked command is active.
   */
  arm(cmd: ArmedCommand): void {
    if (this.busy) throw new Error('the task terminal is busy with another agent command')
    if (this.atPrompt) {
      this.send(cmd)
    } else {
      this.state = { phase: 'wait-prompt', armed: cmd }
      // Degraded shells (no OSC 133) never report a prompt — type anyway
      // after a grace period; the run then settles only on terminal exit.
      // Generous: heavy dotfiles can take >10s to reach the first prompt,
      // and typing early leaks raw paste markers into the scrollback.
      this.fallbackTimer = setTimeout(() => {
        if (this.state.phase === 'wait-prompt') this.send(this.state.armed)
      }, 25_000)
      this.fallbackTimer.unref()
    }
  }

  private send(cmd: ArmedCommand): void {
    this.clearFallback()
    this.state = { phase: 'wait-exec', armed: cmd }
    this.write(bracketedPaste(cmd.command))
  }

  /** Feed raw PTY output (latin1-decoded); marker bytes are pure ASCII. */
  push(chunk: string): void {
    const data = this.tail + chunk
    // Keep enough tail to survive a marker split across frames.
    this.tail = data.slice(-32)

    let cursor = 0
    while (cursor < data.length) {
      const prompt = data.indexOf(OSC_PROMPT, cursor)
      const exec = data.indexOf(OSC_EXEC, cursor)
      OSC_DONE.lastIndex = 0
      const doneMatch = OSC_DONE.exec(data.slice(cursor))
      const done = doneMatch ? cursor + doneMatch.index : -1

      const candidates = [
        prompt >= 0 ? { at: prompt, kind: 'prompt' as const, len: OSC_PROMPT.length } : null,
        exec >= 0 ? { at: exec, kind: 'exec' as const, len: OSC_EXEC.length } : null,
        done >= 0 ? { at: done, kind: 'done' as const, len: doneMatch![0].length } : null
      ].filter((c): c is NonNullable<typeof c> => c !== null)
      if (candidates.length === 0) break
      const next = candidates.reduce((a, b) => (a.at <= b.at ? a : b))
      cursor = next.at + next.len

      if (next.kind === 'prompt') {
        this.atPrompt = true
        if (this.state.phase === 'wait-prompt') this.send(this.state.armed)
      } else if (next.kind === 'exec') {
        this.atPrompt = false
        if (this.state.phase === 'wait-exec') {
          this.state = { phase: 'running', armed: this.state.armed }
        }
      } else {
        this.atPrompt = false
        if (this.state.phase === 'running') {
          const { runId } = this.state.armed
          this.state = { phase: 'idle' }
          const code = doneMatch?.[1] !== undefined ? parseInt(doneMatch[1], 10) : 0
          this.onFinished(runId, Number.isFinite(code) ? code : 0)
        }
      }
    }
  }

  /** Terminal died: report the active run (if any) and reset. */
  dispose(): string | undefined {
    this.clearFallback()
    const runId = this.activeRunId
    this.state = { phase: 'idle' }
    return runId
  }

  private clearFallback(): void {
    if (this.fallbackTimer) {
      clearTimeout(this.fallbackTimer)
      this.fallbackTimer = null
    }
  }
}
