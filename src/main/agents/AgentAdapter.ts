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
  /**
   * Shell command line typed into the task's terminal (a real zsh in the
   * worktree) to start the interactive plan-first run.
   */
  buildInteractiveCommand(opts: { prompt: string }): string
  /** Continuation of the most recent conversation in the worktree's cwd. */
  buildInteractiveFollowUpCommand(opts: { prompt: string }): string
  createParser(): AgentOutputParser
  interpretExit(
    code: number | null,
    lastResult: AgentEvent['result'] | undefined
  ): ExitInterpretation
}
