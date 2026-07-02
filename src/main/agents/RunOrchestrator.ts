import { spawn, type ChildProcess } from 'node:child_process'
import { createWriteStream, existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { v7 as uuidv7 } from 'uuid'
import type {
  AgentEvent,
  AgentKind,
  AppEvent,
  Task,
  TaskRun,
  TaskStatus
} from '../../shared/domain'
import type { ProjectStore } from '../db/ProjectStore'
import type { RunStore } from '../db/RunStore'
import type { TaskStore } from '../db/TaskStore'
import { captureLoginShellEnv } from '../terminal/shellEnv'
import type { AgentAdapter, AgentSpawnSpec } from './AgentAdapter'
import type { GitService } from './GitService'
import { getAdapter } from './registry'
import type { WorktreeManager } from './WorktreeManager'

export interface OrchestratorDeps {
  projects: ProjectStore
  tasks: TaskStore
  runs: RunStore
  git: GitService
  worktrees: WorktreeManager
  broadcast: (event: AppEvent) => void
  logDir: string
}

const OUTPUT_FLUSH_MS = 100
const KILL_GRACE_MS = 5000

function defaultPrompt(task: Task): string {
  return `Task: ${task.title}\n\n${task.description}`
}

/**
 * Drives the run lifecycle: worktree allocation -> headless agent spawn ->
 * NDJSON streaming -> auto-commit -> kanban transitions. One child process
 * per run, tracked so cancel/quit can kill the whole (detached) group.
 */
export class RunOrchestrator {
  private children = new Map<string, ChildProcess>()
  private cancelling = new Set<string>()
  private killTimers = new Map<string, NodeJS.Timeout>()
  private pendingEvents = new Map<string, AgentEvent[]>()
  private flushTimers = new Map<string, NodeJS.Timeout>()
  /** Set during before-quit: exit handlers must not touch the closing DB. */
  private stopped = false

  constructor(private deps: OrchestratorDeps) {}

  async start(taskId: string, agentKind?: AgentKind, prompt?: string): Promise<TaskRun> {
    const { tasks, projects, runs, worktrees } = this.deps
    const task = tasks.get(taskId)
    if (!task || task.deletedAt) throw new Error(`task ${taskId} not found`)
    this.assertNoActiveRun(taskId)
    const project = projects.get(task.projectId)
    if (!project) throw new Error(`project ${task.projectId} not found`)

    const kind = agentKind ?? project.settings.defaultAgent
    const adapter = await this.requireAdapter(kind)
    const effectivePrompt = prompt?.trim() ? prompt : defaultPrompt(task)

    const { worktreePath, branch, baseRef } = await worktrees.create(project, task)
    const run = runs.insert({
      taskId,
      agentKind: kind,
      prompt: effectivePrompt,
      worktreePath,
      branch,
      baseRef,
      logPath: await this.newLogPath()
    })
    this.moveTask(taskId, 'inprogress')
    this.deps.broadcast({ type: 'run.status', run })

    const spec = adapter.buildSpawn({ prompt: effectivePrompt, worktreePath })
    return this.launch(run, task, adapter, spec)
  }

  async followUp(taskId: string, prompt: string): Promise<TaskRun> {
    const { tasks, runs } = this.deps
    const task = tasks.get(taskId)
    if (!task || task.deletedAt) throw new Error(`task ${taskId} not found`)
    this.assertNoActiveRun(taskId)

    const latest = runs.latestForTask(taskId)
    if (!latest || (latest.status !== 'completed' && latest.status !== 'failed')) {
      throw new Error('no finished run to follow up on')
    }
    if (!latest.agentSessionId) throw new Error('previous run left no agent session to resume')
    if (!existsSync(latest.worktreePath)) {
      throw new Error('worktree no longer exists; start a fresh run instead')
    }
    const adapter = await this.requireAdapter(latest.agentKind)
    if (!adapter.supportsFollowUp) {
      throw new Error(`${adapter.displayName} does not support follow-ups`)
    }

    const run = runs.insert({
      taskId,
      agentKind: latest.agentKind,
      prompt,
      parentRunId: latest.id,
      worktreePath: latest.worktreePath,
      branch: latest.branch,
      baseRef: latest.baseRef,
      logPath: await this.newLogPath()
    })
    this.moveTask(taskId, 'inprogress')
    this.deps.broadcast({ type: 'run.status', run })

    const spec = adapter.buildFollowUpSpawn({
      prompt,
      worktreePath: latest.worktreePath,
      sessionId: latest.agentSessionId
    })
    return this.launch(run, task, adapter, spec)
  }

  cancel(runId: string): void {
    const run = this.deps.runs.get(runId)
    if (!run) throw new Error(`run ${runId} not found`)
    const child = this.children.get(runId)
    if (!child) {
      // No live child (e.g. stale row): settle the DB state directly.
      if (run.status === 'queued' || run.status === 'running') {
        this.deps.runs.finish(runId, { status: 'cancelled', summary: 'cancelled by user' })
        this.moveTask(run.taskId, 'inreview')
        const updated = this.deps.runs.get(runId)
        if (updated) this.deps.broadcast({ type: 'run.status', run: updated })
      }
      return
    }
    this.cancelling.add(runId)
    this.signal(child, 'SIGTERM')
    const timer = setTimeout(() => {
      const alive = this.children.get(runId)
      if (alive) this.signal(alive, 'SIGKILL')
    }, KILL_GRACE_MS)
    timer.unref()
    this.killTimers.set(runId, timer)
  }

  /** before-quit: hard-kill every process group; reconcileOnStartup cleans up. */
  stopAll(): void {
    this.stopped = true
    for (const [runId, child] of this.children) {
      this.cancelling.add(runId)
      this.signal(child, 'SIGKILL')
    }
  }

  async reconcileOnStartup(): Promise<void> {
    const { runs, tasks, projects, worktrees } = this.deps
    const orphans = runs.listActive()
    for (const run of orphans) {
      runs.finish(run.id, { status: 'failed', summary: 'orphaned (app restart)' })
      const task = tasks.get(run.taskId)
      if (task && task.status === 'inprogress') this.moveTask(task.id, 'inreview')
    }
    await worktrees.reconcile(projects.list(), orphans)
  }

  // -------------------------------------------------------------------------

  private async launch(
    run: TaskRun,
    task: Task,
    adapter: AgentAdapter,
    spec: AgentSpawnSpec
  ): Promise<TaskRun> {
    const { runs, git } = this.deps
    const env = await captureLoginShellEnv()
    const parser = adapter.createParser()
    const log = createWriteStream(run.logPath!, { flags: 'a' })
    let finalized = false

    // detached => own process group, so cancel can kill the whole tree.
    const child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    this.children.set(run.id, child)

    if (child.stdout) {
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        log.write(chunk)
        this.queueOutput(run.id, task.id, parser.push(chunk))
      })
    }
    if (child.stderr) {
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk: string) => {
        // Prefixed lines fail NDJSON parsing and surface as 'raw' on readLog.
        log.write(
          chunk
            .split('\n')
            .map((l) => (l ? `[stderr] ${l}` : l))
            .join('\n')
        )
      })
    }

    const finalize = async (code: number | null): Promise<void> => {
      if (finalized) return
      finalized = true
      this.children.delete(run.id)
      const killTimer = this.killTimers.get(run.id)
      if (killTimer) {
        clearTimeout(killTimer)
        this.killTimers.delete(run.id)
      }
      this.queueOutput(run.id, task.id, parser.flush())
      this.flushOutput(run.id, task.id)
      log.end()
      const cancelled = this.cancelling.delete(run.id)
      if (this.stopped) return // app is quitting; DB is closing

      try {
        if ((await git.statusPorcelain(run.worktreePath)) !== '') {
          await git.addAllAndCommit(run.worktreePath, `orchebary: ${task.title}`)
        }
      } catch (err) {
        console.error(`[agents] auto-commit failed for run ${run.id}:`, err)
      }

      const outcome = adapter.interpretExit(code, parser.lastResult)
      runs.finish(run.id, {
        status: cancelled ? 'cancelled' : outcome.status,
        exitCode: code ?? undefined,
        summary: cancelled ? 'cancelled by user' : outcome.summary,
        agentSessionId: parser.sessionId,
        costUsd: parser.lastResult?.costUsd,
        numTurns: parser.lastResult?.numTurns
      })

      try {
        const stat = await git.diffStat(run.worktreePath, run.baseRef)
        this.deps.broadcast({ type: 'run.diffstat', runId: run.id, taskId: task.id, stat })
      } catch (err) {
        console.error(`[agents] diffstat failed for run ${run.id}:`, err)
      }

      this.moveTask(task.id, 'inreview')
      const finished = runs.get(run.id)
      if (finished) this.deps.broadcast({ type: 'run.status', run: finished })
    }

    child.once('error', (err) => {
      log.write(`[orchebary] spawn error: ${err.message}\n`)
      void finalize(null).catch((e) => console.error('[agents] finalize failed:', e))
    })
    child.once('close', (code) => {
      void finalize(code).catch((e) => console.error('[agents] finalize failed:', e))
    })

    if (child.pid) {
      runs.markRunning(run.id, child.pid)
      const running = runs.get(run.id)
      if (running) this.deps.broadcast({ type: 'run.status', run: running })
    }
    return runs.get(run.id) ?? run
  }

  private signal(child: ChildProcess, sig: NodeJS.Signals): void {
    try {
      // Negative pid targets the detached process group.
      if (child.pid) process.kill(-child.pid, sig)
      else child.kill(sig)
    } catch {
      try {
        child.kill(sig)
      } catch {
        // already gone
      }
    }
  }

  private queueOutput(runId: string, taskId: string, events: AgentEvent[]): void {
    if (events.length === 0) return
    const pending = this.pendingEvents.get(runId)
    if (pending) pending.push(...events)
    else this.pendingEvents.set(runId, [...events])
    // Trailing-edge throttle: at most one run.output broadcast per 100ms.
    if (!this.flushTimers.has(runId)) {
      this.flushTimers.set(
        runId,
        setTimeout(() => this.flushOutput(runId, taskId), OUTPUT_FLUSH_MS)
      )
    }
  }

  private flushOutput(runId: string, taskId: string): void {
    const timer = this.flushTimers.get(runId)
    if (timer) {
      clearTimeout(timer)
      this.flushTimers.delete(runId)
    }
    const events = this.pendingEvents.get(runId)
    this.pendingEvents.delete(runId)
    if (events && events.length > 0) {
      this.deps.broadcast({ type: 'run.output', runId, taskId, events })
    }
  }

  private moveTask(taskId: string, status: TaskStatus): void {
    const { tasks } = this.deps
    const task = tasks.get(taskId)
    if (!task || task.status === status) return
    const position = tasks.keyAtColumnEnd(task.projectId, status)
    const res = tasks.move(taskId, status, position, null)
    if (res.ok) this.deps.broadcast({ type: 'task.updated', task: res.task })
  }

  private assertNoActiveRun(taskId: string): void {
    const active = this.deps.runs
      .listForTask(taskId)
      .find((r) => r.status === 'queued' || r.status === 'running')
    if (active) throw new Error('a run is already active for this task')
  }

  private async requireAdapter(kind: AgentKind): Promise<AgentAdapter> {
    const adapter = getAdapter(kind)
    if (!adapter) throw new Error(`agent '${kind}' is not supported yet`)
    const availability = await adapter.checkAvailability()
    if (!availability.available) {
      throw new Error(availability.problem ?? `${adapter.displayName} is unavailable`)
    }
    return adapter
  }

  // RunStore generates run ids internally, so log files get their own uuid.
  private async newLogPath(): Promise<string> {
    await mkdir(this.deps.logDir, { recursive: true })
    return path.join(this.deps.logDir, `${uuidv7()}.ndjson`)
  }
}
