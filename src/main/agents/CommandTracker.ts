/**
 * Tracks agent commands inside a project terminal via the shell-integration
 * markers our zsh shim emits (OSC 133;A prompt / C executed / D;exit done).
 *
 * Work is serialized safely: an idle shell gets the agent command typed at
 * its prompt; work arriving while the agent is BOOTING waits (typing into a
 * startup dialog corrupts it); work arriving while the agent is warmly
 * running is typed straight into the conversation; whatever is still waiting
 * when the agent exits starts the next turn (`--continue`, same
 * conversation). Each finished command settles exactly the tasks that rode
 * in it.
 */

const OSC_PROMPT = '\x1b]133;A\x07'
const OSC_EXEC = '\x1b]133;C\x07'
// eslint-disable-next-line no-control-regex -- matching a literal OSC 133;D escape sequence
const OSC_DONE = /\x1b\]133;D(?:;(\d+))?\x07/

/** How long after command start the agent's input is considered ready. */
const INPUT_READY_MS = 20_000

/** Written around the command so zle treats embedded newlines as literal. */
function bracketedPaste(cmd: string): string {
  return `\x1b[200~${cmd}\x1b[201~\r`
}

export interface SubmittedWork {
  runId: string
  /** Message text typed into a live claude session. */
  promptText: string
  /** Shell command used when the session must be (re)started for this work. */
  buildCommand: () => string
}

type State =
  | { phase: 'idle' }
  | { phase: 'wait-prompt'; command: string; attached: string[] }
  | { phase: 'wait-exec'; command: string; attached: string[] }
  | { phase: 'running'; attached: string[]; execAt: number }

export class CommandTracker {
  private state: State = { phase: 'idle' }
  private atPrompt = false
  private tail = ''
  private fallbackTimer: NodeJS.Timeout | null = null
  /** Work waiting for a safe moment to enter the session. */
  private pending: SubmittedWork[] = []

  constructor(
    private readonly write: (data: string) => void,
    private readonly onFinished: (runIds: string[], exitCode: number) => void
  ) {}

  get busy(): boolean {
    return this.state.phase !== 'idle'
  }

  /** Runs riding in the current foreground command. */
  get attachedRunIds(): string[] {
    return this.state.phase === 'idle' ? [] : this.state.attached
  }

  submit(work: SubmittedWork): void {
    if (this.state.phase === 'idle') {
      this.arm(work)
    } else if (this.state.phase === 'running' && Date.now() - this.state.execAt > INPUT_READY_MS) {
      // The agent has been up long enough to be past startup dialogs — type
      // the task into the conversation.
      this.state.attached.push(work.runId)
      this.write(bracketedPaste(work.promptText))
    } else {
      this.pending.push(work)
    }
  }

  /** Drop queued work (its card left In Progress before it started). */
  removePending(runId: string): void {
    this.pending = this.pending.filter((w) => w.runId !== runId)
  }

  private arm(work: SubmittedWork): void {
    const command = work.buildCommand()
    if (this.atPrompt) {
      this.send(command, [work.runId])
    } else {
      this.state = { phase: 'wait-prompt', command, attached: [work.runId] }
      // Degraded shells (no OSC 133) never report a prompt — type anyway
      // after a generous grace period (heavy dotfiles are slow, and typing
      // early spills raw paste markers into the scrollback).
      this.fallbackTimer = setTimeout(() => {
        if (this.state.phase === 'wait-prompt') {
          this.send(this.state.command, this.state.attached)
        }
      }, 25_000)
      this.fallbackTimer.unref()
    }
  }

  private send(command: string, attached: string[]): void {
    this.clearFallback()
    this.state = { phase: 'wait-exec', command, attached }
    this.write(bracketedPaste(command))
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
        if (this.state.phase === 'wait-prompt') {
          this.send(this.state.command, this.state.attached)
        } else if (this.state.phase === 'idle') {
          // Shell is at a prompt again — start queued work.
          const queued = this.pending.shift()
          if (queued) this.arm(queued)
        }
      } else if (next.kind === 'exec') {
        this.atPrompt = false
        if (this.state.phase === 'wait-exec') {
          this.state = { phase: 'running', attached: this.state.attached, execAt: Date.now() }
        }
      } else {
        this.atPrompt = false
        if (this.state.phase === 'running') {
          const { attached } = this.state
          this.state = { phase: 'idle' }
          const code = doneMatch?.[1] !== undefined ? parseInt(doneMatch[1], 10) : 0
          this.onFinished(attached, Number.isFinite(code) ? code : 0)
          // The next queued task opens the next turn of the conversation.
          const queued = this.pending.shift()
          if (queued) this.arm(queued)
        }
      }
    }
  }

  /** Terminal died: everything in flight or waiting is affected. */
  dispose(): string[] {
    this.clearFallback()
    const affected = [...this.attachedRunIds, ...this.pending.map((w) => w.runId)]
    this.state = { phase: 'idle' }
    this.pending = []
    return affected
  }

  private clearFallback(): void {
    if (this.fallbackTimer) {
      clearTimeout(this.fallbackTimer)
      this.fallbackTimer = null
    }
  }
}
