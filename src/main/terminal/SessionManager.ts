import { spawn as ptySpawn, type IPty } from 'node-pty'
import { nanoid } from 'nanoid'
import os from 'node:os'
import path from 'node:path'
import type { CreateTerminalRequest, TerminalKind, TerminalSessionInfo } from '../../shared/domain'
import { DataBatcher } from './DataBatcher'
import { FlowController } from './FlowController'
import { captureLoginShellEnv, defaultShell } from './shellEnv'
import { shellIntegrationEnv } from './shellIntegration'

export interface PtySession {
  readonly info: TerminalSessionInfo
  readonly pty: IPty
  readonly batcher: DataBatcher
  readonly flow: FlowController
}

interface SpawnAgentOptions {
  cwd: string
  cols: number
  rows: number
  command: string
  args: string[]
  env?: Record<string, string>
  runId: string
  taskId: string
  title: string
}

type DataListener = (sessionId: string, data: Uint8Array) => void
type ExitListener = (sessionId: string, exitCode: number, signal?: number) => void
type LifecycleListener = (session: TerminalSessionInfo, event: 'registered' | 'closed') => void

/**
 * Owns every node-pty instance (user shells and agent-attached terminals).
 * Lives in the main process; the renderer only ever sees sessionIds.
 */
export class SessionManager {
  private sessions = new Map<string, PtySession>()
  private dataListeners = new Set<DataListener>()
  private exitListeners = new Set<ExitListener>()
  private lifecycleListeners = new Set<LifecycleListener>()

  async createShell(
    req: CreateTerminalRequest,
    meta?: { runId?: string; taskId?: string; title?: string }
  ): Promise<TerminalSessionInfo> {
    const sessionId = nanoid()
    const baseEnv = await captureLoginShellEnv()
    const shell = defaultShell()
    const cwd = req.cwd || baseEnv.HOME || os.homedir()

    const env: Record<string, string> = {
      ...baseEnv,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      TERM_PROGRAM: 'orchebary'
    }
    if (path.basename(shell) === 'zsh') {
      Object.assign(env, shellIntegrationEnv(sessionId, baseEnv))
    }
    // Caller overrides win last (e.g. tests point ORB_USER_ZDOTDIR at an
    // empty dir to isolate from the user's dotfiles).
    Object.assign(env, req.env)

    return this.register(
      sessionId,
      'shell',
      {
        file: shell,
        args: ['-il'],
        cwd,
        cols: req.cols,
        rows: req.rows,
        env,
        title: meta?.title ?? path.basename(cwd)
      },
      meta?.runId || meta?.taskId ? { runId: meta.runId, taskId: meta.taskId } : undefined
    )
  }

  /** Spawn an arbitrary command (e.g. `claude --resume`) under a PTY. */
  async createAgentTerminal(opts: SpawnAgentOptions): Promise<TerminalSessionInfo> {
    const sessionId = nanoid()
    const baseEnv = await captureLoginShellEnv()
    const env = { ...baseEnv, ...opts.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' }
    return this.register(
      sessionId,
      'agent',
      {
        file: opts.command,
        args: opts.args,
        cwd: opts.cwd,
        cols: opts.cols,
        rows: opts.rows,
        env,
        title: opts.title
      },
      { runId: opts.runId, taskId: opts.taskId }
    )
  }

  private register(
    sessionId: string,
    kind: TerminalKind,
    spawn: {
      file: string
      args: string[]
      cwd: string
      cols: number
      rows: number
      env: Record<string, string>
      title: string
    },
    extra?: { runId?: string; taskId?: string }
  ): TerminalSessionInfo {
    const pty = ptySpawn(spawn.file, spawn.args, {
      name: 'xterm-256color',
      cols: spawn.cols,
      rows: spawn.rows,
      cwd: spawn.cwd,
      env: spawn.env
    })

    const info: TerminalSessionInfo = {
      sessionId,
      kind,
      title: spawn.title,
      cwd: spawn.cwd,
      pid: pty.pid,
      cols: spawn.cols,
      rows: spawn.rows,
      ...extra
    }

    const flow = new FlowController(
      () => pty.pause(),
      () => pty.resume()
    )
    const batcher = new DataBatcher((frame) => {
      flow.sent(frame.length)
      for (const l of this.dataListeners) l(sessionId, frame)
    })

    pty.onData((data) => batcher.push(data))
    pty.onExit(({ exitCode, signal }) => {
      batcher.dispose()
      this.sessions.delete(sessionId)
      for (const l of this.exitListeners) l(sessionId, exitCode, signal)
      for (const l of this.lifecycleListeners) l(info, 'closed')
    })

    const session: PtySession = { info, pty, batcher, flow }
    this.sessions.set(sessionId, session)
    for (const l of this.lifecycleListeners) l(info, 'registered')
    return info
  }

  write(sessionId: string, data: string): void {
    this.sessions.get(sessionId)?.pty.write(data)
  }

  ack(sessionId: string, bytes: number): void {
    this.sessions.get(sessionId)?.flow.acked(bytes)
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const s = this.sessions.get(sessionId)
    if (!s) return
    if (cols > 0 && rows > 0) {
      s.pty.resize(cols, rows)
      s.info.cols = cols
      s.info.rows = rows
    }
  }

  kill(sessionId: string): void {
    this.sessions.get(sessionId)?.pty.kill()
  }

  get(sessionId: string): PtySession | undefined {
    return this.sessions.get(sessionId)
  }

  list(): TerminalSessionInfo[] {
    return [...this.sessions.values()].map((s) => s.info)
  }

  onData(l: DataListener): void {
    this.dataListeners.add(l)
  }

  onExit(l: ExitListener): void {
    this.exitListeners.add(l)
  }

  onLifecycle(l: LifecycleListener): void {
    this.lifecycleListeners.add(l)
  }

  /** Kill every child before quit; PTY sessions do not survive restarts. */
  disposeAll(): void {
    for (const s of this.sessions.values()) {
      try {
        s.pty.kill()
      } catch {
        // already dead
      }
    }
    this.sessions.clear()
  }
}

export const sessionManager = new SessionManager()
