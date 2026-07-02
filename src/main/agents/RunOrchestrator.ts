import { existsSync } from 'node:fs'
import type { AgentKind, AppEvent, Task, TaskRun, TaskStatus } from '../../shared/domain'
import type { ProjectStore } from '../db/ProjectStore'
import type { RunStore } from '../db/RunStore'
import type { TaskStore } from '../db/TaskStore'
import type { SessionManager } from '../terminal/SessionManager'
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
  sessions: SessionManager
  broadcast: (event: AppEvent) => void
}

function defaultPrompt(task: Task): string {
  return `Task: ${task.title}\n\n${task.description}`
}

/**
 * Drives the plan-first run lifecycle: worktree allocation -> interactive
 * claude session in a real terminal (plan mode, task as the first prompt) ->
 * on session exit: auto-commit -> diff stat -> kanban moves to In Review.
 */
export class RunOrchestrator {
  /** Live interactive PTY runs: terminal sessionId -> runId. */
  private interactiveRuns = new Map<string, string>()
  private cancelling = new Set<string>()
  /** Set during before-quit: exit handlers must not touch the closing DB. */
  private stopped = false

  constructor(private deps: OrchestratorDeps) {
    deps.sessions.onExit((sessionId, exitCode) => {
      void this.finalizeInteractive(sessionId, exitCode).catch((e) =>
        console.error('[agents] interactive finalize failed:', e)
      )
    })
  }

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
      baseRef
    })
    this.moveTask(taskId, 'inprogress')
    this.deps.broadcast({ type: 'run.status', run })

    const spec = adapter.buildInteractiveSpawn({ prompt: effectivePrompt, worktreePath })
    return this.launchInteractive(run, task, spec)
  }

  async followUp(taskId: string, prompt: string): Promise<TaskRun> {
    const { tasks, runs } = this.deps
    const task = tasks.get(taskId)
    if (!task || task.deletedAt) throw new Error(`task ${taskId} not found`)
    this.assertNoActiveRun(taskId)

    const latest = runs.latestForTask(taskId)
    if (!latest || latest.status === 'queued' || latest.status === 'running') {
      throw new Error('no finished run to follow up on')
    }
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
      baseRef: latest.baseRef
    })
    this.moveTask(taskId, 'inprogress')
    this.deps.broadcast({ type: 'run.status', run })

    const spec = adapter.buildInteractiveFollowUpSpawn({
      prompt,
      worktreePath: latest.worktreePath
    })
    return this.launchInteractive(run, task, spec)
  }

  cancel(runId: string): void {
    const run = this.deps.runs.get(runId)
    if (!run) throw new Error(`run ${runId} not found`)

    for (const [sessionId, rid] of this.interactiveRuns) {
      if (rid === runId) {
        // Settles through the PTY exit handler.
        this.cancelling.add(runId)
        this.deps.sessions.kill(sessionId)
        return
      }
    }

    // No live session (e.g. stale row after a crash): settle the DB directly.
    if (run.status === 'queued' || run.status === 'running') {
      this.deps.runs.finish(runId, { status: 'cancelled', summary: 'cancelled by user' })
      this.moveTask(run.taskId, 'inreview')
      const updated = this.deps.runs.get(runId)
      if (updated) this.deps.broadcast({ type: 'run.status', run: updated })
    }
  }

  /** before-quit: PTYs die via SessionManager.disposeAll; keep off the DB. */
  stopAll(): void {
    this.stopped = true
    this.interactiveRuns.clear()
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

  private async launchInteractive(
    run: TaskRun,
    task: Task,
    spec: AgentSpawnSpec
  ): Promise<TaskRun> {
    const { runs, sessions } = this.deps
    try {
      const info = await sessions.createAgentTerminal({
        cwd: spec.cwd,
        cols: 120,
        rows: 30,
        command: spec.command,
        args: spec.args,
        runId: run.id,
        taskId: task.id,
        title: task.title
      })
      this.interactiveRuns.set(info.sessionId, run.id)
      runs.markRunning(run.id, info.pid)
    } catch (err) {
      runs.finish(run.id, {
        status: 'failed',
        summary: `failed to launch agent terminal: ${err instanceof Error ? err.message : err}`
      })
      this.moveTask(task.id, 'inreview')
    }
    const current = runs.get(run.id) ?? run
    this.deps.broadcast({ type: 'run.status', run: current })
    return current
  }

  /** PTY exit of an interactive agent session settles its run. */
  private async finalizeInteractive(sessionId: string, exitCode: number): Promise<void> {
    const runId = this.interactiveRuns.get(sessionId)
    if (!runId) return
    this.interactiveRuns.delete(sessionId)
    const cancelled = this.cancelling.delete(runId)
    if (this.stopped) return // app is quitting; DB is closing

    const { runs, git } = this.deps
    const run = runs.get(runId)
    if (!run || (run.status !== 'queued' && run.status !== 'running')) return

    let committed = false
    try {
      if ((await git.statusPorcelain(run.worktreePath)) !== '') {
        const task = this.deps.tasks.get(run.taskId)
        await git.addAllAndCommit(run.worktreePath, `orchebary: ${task?.title ?? run.taskId}`)
        committed = true
      }
    } catch (err) {
      console.error(`[agents] auto-commit failed for run ${run.id}:`, err)
    }

    let hasDiff = committed
    try {
      const stat = await git.diffStat(run.worktreePath, run.baseRef)
      hasDiff = stat.filesChanged > 0
      this.deps.broadcast({ type: 'run.diffstat', runId: run.id, taskId: run.taskId, stat })
    } catch (err) {
      console.error(`[agents] diffstat failed for run ${run.id}:`, err)
    }

    runs.finish(run.id, {
      status: cancelled ? 'cancelled' : exitCode === 0 ? 'completed' : 'failed',
      exitCode,
      summary: cancelled
        ? 'cancelled by user'
        : `interactive session ended${hasDiff ? ' — changes ready for review' : ' — no changes'}`
    })
    this.moveTask(run.taskId, 'inreview')
    const finished = runs.get(run.id)
    if (finished) this.deps.broadcast({ type: 'run.status', run: finished })
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
}
