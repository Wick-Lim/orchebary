import type { AgentAvailability, AgentEvent, AgentKind } from '../../shared/domain'

export interface AgentSpawnSpec {
  command: string
  args: string[]
  cwd: string
}

export interface ExitInterpretation {
  status: 'completed' | 'failed'
  summary: string
}

/** Stateful line-buffered parser turning raw agent stdout into AgentEvents. */
export interface AgentOutputParser {
  readonly sessionId: string | undefined
  readonly lastResult: AgentEvent['result'] | undefined
  push(chunk: string): AgentEvent[]
  /** Drain a buffered partial line once the stream has ended. */
  flush(): AgentEvent[]
}

export interface AgentAdapter {
  readonly kind: AgentKind
  readonly displayName: string
  readonly supportsFollowUp: boolean
  checkAvailability(): Promise<AgentAvailability>
  buildSpawn(opts: { prompt: string; worktreePath: string }): AgentSpawnSpec
  buildFollowUpSpawn(opts: {
    prompt: string
    worktreePath: string
    sessionId: string
  }): AgentSpawnSpec
  /** Interactive TUI run inside a PTY — the plan-first kanban workflow. */
  buildInteractiveSpawn(opts: { prompt: string; worktreePath: string }): AgentSpawnSpec
  /** Interactive continuation of the most recent conversation in the worktree. */
  buildInteractiveFollowUpSpawn(opts: { prompt: string; worktreePath: string }): AgentSpawnSpec
  createParser(): AgentOutputParser
  interpretExit(
    code: number | null,
    lastResult: AgentEvent['result'] | undefined
  ): ExitInterpretation
}
