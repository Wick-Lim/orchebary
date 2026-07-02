import { execFile } from 'node:child_process'
import type { AgentAvailability, AgentEvent } from '../../shared/domain'
import { captureLoginShellEnv } from '../terminal/shellEnv'
import type {
  AgentAdapter,
  AgentOutputParser,
  AgentSpawnSpec,
  ExitInterpretation
} from './AgentAdapter'

const BASE_ARGS = [
  '--permission-mode',
  'acceptEdits',
  '--output-format',
  'stream-json',
  '--verbose'
]

type Json = Record<string, unknown>

function asRecord(v: unknown): Json | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null
}

/** Parses Claude Code's `--output-format stream-json` NDJSON stdout. */
export class ClaudeStreamParser implements AgentOutputParser {
  private buffer = ''
  private _sessionId: string | undefined
  private _lastResult: AgentEvent['result']

  get sessionId(): string | undefined {
    return this._sessionId
  }

  get lastResult(): AgentEvent['result'] {
    return this._lastResult
  }

  push(chunk: string): AgentEvent[] {
    this.buffer += chunk
    const lines = this.buffer.split('\n')
    this.buffer = lines.pop() ?? ''
    const events: AgentEvent[] = []
    for (const line of lines) this.parseLine(line, events)
    return events
  }

  flush(): AgentEvent[] {
    const rest = this.buffer
    this.buffer = ''
    const events: AgentEvent[] = []
    if (rest.trim()) this.parseLine(rest, events)
    return events
  }

  private parseLine(line: string, out: AgentEvent[]): void {
    const trimmed = line.trim()
    if (!trimmed) return
    const at = new Date().toISOString()
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      out.push({ at, kind: 'raw', text: trimmed })
      return
    }
    const msg = asRecord(parsed)
    if (!msg) {
      out.push({ at, kind: 'raw', text: trimmed })
      return
    }

    switch (msg.type) {
      case 'system': {
        if (msg.subtype === 'init') {
          if (typeof msg.session_id === 'string') this._sessionId = msg.session_id
          out.push({ at, kind: 'system', text: 'session started' })
        } else {
          out.push({
            at,
            kind: 'system',
            text: typeof msg.subtype === 'string' ? msg.subtype : 'system'
          })
        }
        return
      }
      case 'assistant': {
        const message = asRecord(msg.message)
        const content = Array.isArray(message?.content) ? message.content : []
        for (const rawBlock of content) {
          const block = asRecord(rawBlock)
          if (!block) continue
          if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
            out.push({ at, kind: 'assistant-text', text: block.text })
          } else if (block.type === 'tool_use') {
            out.push({
              at,
              kind: 'tool-use',
              toolName: typeof block.name === 'string' ? block.name : 'tool'
            })
          }
        }
        return
      }
      case 'user': {
        const message = asRecord(msg.message)
        const content = Array.isArray(message?.content) ? message.content : []
        for (const rawBlock of content) {
          if (asRecord(rawBlock)?.type === 'tool_result') out.push({ at, kind: 'tool-result' })
        }
        return
      }
      case 'result': {
        const result: NonNullable<AgentEvent['result']> = {
          ok: msg.is_error !== true,
          summary: String(msg.result ?? msg.subtype ?? ''),
          sessionId: typeof msg.session_id === 'string' ? msg.session_id : this._sessionId,
          costUsd: typeof msg.total_cost_usd === 'number' ? msg.total_cost_usd : undefined,
          numTurns: typeof msg.num_turns === 'number' ? msg.num_turns : undefined
        }
        this._lastResult = result
        if (result.sessionId) this._sessionId = result.sessionId
        out.push({ at, kind: 'result', result })
        return
      }
      default:
        out.push({ at, kind: 'raw', text: trimmed })
    }
  }
}

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly kind = 'claude-code' as const
  readonly displayName = 'Claude Code'
  readonly supportsFollowUp = true

  async checkAvailability(): Promise<AgentAvailability> {
    // GUI-launched apps miss the user's PATH; probe with the login-shell env.
    const env = await captureLoginShellEnv()
    return new Promise((resolve) => {
      execFile('claude', ['--version'], { timeout: 5000, env, encoding: 'utf8' }, (err, stdout) => {
        if (err) {
          resolve({
            kind: this.kind,
            displayName: this.displayName,
            available: false,
            problem: `claude CLI not found or not runnable (${err.message})`
          })
        } else {
          resolve({
            kind: this.kind,
            displayName: this.displayName,
            available: true,
            version: stdout.trim()
          })
        }
      })
    })
  }

  buildSpawn(opts: { prompt: string; worktreePath: string }): AgentSpawnSpec {
    return {
      command: 'claude',
      args: ['-p', opts.prompt, ...BASE_ARGS],
      cwd: opts.worktreePath
    }
  }

  buildFollowUpSpawn(opts: {
    prompt: string
    worktreePath: string
    sessionId: string
  }): AgentSpawnSpec {
    // Flags must precede the positional prompt: claude -p --resume <id> '<prompt>' ...
    return {
      command: 'claude',
      args: ['-p', '--resume', opts.sessionId, opts.prompt, ...BASE_ARGS],
      cwd: opts.worktreePath
    }
  }

  createParser(): AgentOutputParser {
    return new ClaudeStreamParser()
  }

  interpretExit(
    code: number | null,
    lastResult: AgentEvent['result'] | undefined
  ): ExitInterpretation {
    if (lastResult) {
      return {
        status: lastResult.ok && code === 0 ? 'completed' : 'failed',
        summary: lastResult.summary
      }
    }
    if (code === 0)
      return { status: 'completed', summary: 'agent exited cleanly (no result event)' }
    return {
      status: 'failed',
      summary: code === null ? 'agent terminated by signal' : `agent exited with code ${code}`
    }
  }
}
