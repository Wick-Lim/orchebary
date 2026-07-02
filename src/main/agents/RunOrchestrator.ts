import { existsSync } from 'node:fs'
import type { AgentKind, AppEvent, Task, TaskRun, TaskStatus } from '../../shared/domain'
import type { ProjectStore } from '../db/ProjectStore'
import type { RunStore } from '../db/RunStore'
import type { TaskStore } from '../db/TaskStore'
import type { SessionManager } from '../terminal/SessionManager'
import type { AgentAdapter } from './AgentAdapter'
import { CommandTracker } from './CommandTracker'
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

const CANCEL_INTERRUPT = '\x03'
const CANCEL_KILL_GRACE_MS = 6000

function defaultPrompt(task: Task): string {
  return `Task: ${task.title}\n\n${task.description}`
}

/**
 * Plan-first, terminal-persistent run lifecycle. Each task owns ONE terminal:
 * a real login shell in its worktree. The agent command (`claude
 * --permission-mode plan …`) is typed into that shell; OSC 133 markers from
 * the shell integration tell us when the command finishes, which settles the
 * run (auto-commit -> diff -> In Review) while the terminal keeps running for
 * review work and `claude --continue`.
 */
export class RunOrchestrator {
  /** One tracker per live task terminal, keyed by sessionId. */
  private trackers = new Map<string, CommandTracker>()
  private cancelling = new Set<string>()
  private killTimers = new Map<string, NodeJS.Timeout>()
  /** Set during before-quit: exit handlers must not touch the closing DB. */
  private stopped = false

  constructor(private deps: OrchestratorDeps) {
    deps.sessions.onData((sessionId, frame) => {
      const tracker = this.trackers.get(sessionId)
      if (tracker) tracker.push(Buffer.from(frame).toString('latin1'))
    })
    deps.sessions.onExit((sessionId) => {
      const tracker = this.trackers.get(sessionId)
      if (!tracker) return
      this.trackers.delete(sessionId)
      const runId = tracker.dispose()
      if (runId && !this.stopped) {
        void this.settleRun(runId, null, 'terminal closed').catch((e) =>
          console.error('[agents] settle after terminal close failed:', e)
        )
      }
    })
  }

  /**
   * Start (or continue) agent work on a task. Fresh tasks get a new worktree
   * and the full task prompt; tasks with an existing worktree reopen the
   * conversation there (`--continue`), so dragging a card back into
   * In Progress resumes where it left off.
   */
  async start(taskId: string, agentKind?: AgentKind, prompt?: string): Promise<TaskRun> {
    const { tasks, projects, runs, worktrees } = this.deps
    const task = tasks.get(taskId)
    if (!task || task.deletedAt) throw new Error(`task ${taskId} not found`)
    this.assertNoActiveRun(taskId)
    const project = projects.get(task.projectId)
    if (!project) throw new Error(`project ${task.projectId} not found`)

    const latest = runs.latestForTask(taskId)
    const reuse = latest && existsSync(latest.worktreePath)
    const kind = agentKind ?? latest?.agentKind ?? project.settings.defaultAgent
    const adapter = await this.requireAdapter(kind)

    const wt = reuse
      ? { worktreePath: latest.worktreePath, branch: latest.branch, baseRef: latest.baseRef }
      : await worktrees.create(project, task)

    // Reused worktrees reopen the conversation without auto-submitting a
    // message (no tokens burned until the user types); fresh ones get the
    // full task prompt.
    const custom = prompt?.trim() ?? ''
    const command = reuse
      ? adapter.buildInteractiveFollowUpCommand({ prompt: custom })
      : adapter.buildInteractiveCommand({ prompt: custom || defaultPrompt(task) })

    return this.launch(task, {
      agentKind: kind,
      prompt: custom || (reuse ? '(continue session)' : defaultPrompt(task)),
      parentRunId: reuse ? latest.id : undefined,
      ...wt,
      command
    })
  }

  /** Explicit follow-up message from the board (task keeps its terminal). */
  async followUp(taskId: string, prompt: string): Promise<TaskRun> {
    const { tasks, runs } = this.deps
    const task = tasks.get(taskId)
    if (!task || task.deletedAt) throw new Error(`task ${taskId} not found`)
    this.assertNoActiveRun(taskId)

    const latest = runs.latestForTask(taskId)
    if (!latest) throw new Error('no previous run to follow up on')
    if (!existsSync(latest.worktreePath)) {
      throw new Error('worktree no longer exists; drag the card into In Progress to start fresh')
    }
    const adapter = await this.requireAdapter(latest.agentKind)
    if (!adapter.supportsFollowUp) {
      throw new Error(`${adapter.displayName} does not support follow-ups`)
    }

    return this.launch(task, {
      agentKind: latest.agentKind,
      prompt,
      parentRunId: latest.id,
      worktreePath: latest.worktreePath,
      branch: latest.branch,
      baseRef: latest.baseRef,
      command: adapter.buildInteractiveFollowUpCommand({ prompt })
    })
  }

  /**
   * The task's one terminal: reuse the live session bound to the task or
   * spawn a fresh login shell in the worktree.
   */
  async ensureTaskTerminal(
    task: Pick<Task, 'id' | 'title'>,
    worktreePath: string,
    runId?: string
  ): Promise<{ sessionId: string; created: boolean }> {
    const live = this.deps.sessions
      .list()
      .find((s) => s.taskId === task.id && (s.kind === 'agent' || s.kind === 'shell'))
    if (live) return { sessionId: live.sessionId, created: false }

    const info = await this.deps.sessions.createAgentTerminal({
      cwd: worktreePath,
      cols: 120,
      rows: 30,
      runId: runId ?? '',
      taskId: task.id,
      title: task.title
    })
    return { sessionId: info.sessionId, created: true }
  }

  private async launch(
    task: Task,
    spec: {
      agentKind: AgentKind
      prompt: string
      parentRunId?: string
      worktreePath: string
      branch: string
      baseRef: string
      command: string
    }
  ): Promise<TaskRun> {
    const { runs } = this.deps
    const run = runs.insert({
      taskId: task.id,
      agentKind: spec.agentKind,
      prompt: spec.prompt,
      parentRunId: spec.parentRunId,
      worktreePath: spec.worktreePath,
      branch: spec.branch,
      baseRef: spec.baseRef
    })
    this.moveTask(task.id, 'inprogress')

    try {
      const { sessionId } = await this.ensureTaskTerminal(task, spec.worktreePath, run.id)
      let tracker = this.trackers.get(sessionId)
      if (!tracker) {
        tracker = new CommandTracker(
          (data) => this.deps.sessions.write(sessionId, data),
          (runId, exitCode) => {
            void this.settleRun(runId, exitCode).catch((e) =>
              console.error('[agents] settle failed:', e)
            )
          }
        )
        this.trackers.set(sessionId, tracker)
      }
      tracker.arm({ runId: run.id, command: spec.command })
      const pid = this.deps.sessions.get(sessionId)?.info.pid
      runs.markRunning(run.id, pid ?? 0)
    } catch (err) {
      runs.finish(run.id, {
        status: 'failed',
        summary: `failed to launch the task terminal: ${err instanceof Error ? err.message : err}`
      })
      this.moveTask(task.id, 'inreview')
    }

    const current = runs.get(run.id) ?? run
    this.deps.broadcast({ type: 'run.status', run: current })
    return current
  }

  /**
   * The agent command finished (or its terminal died): commit what changed,
   * record the outcome, move the card to review. Never 'failed' here — an
   * interactive session the user drove to completion is not a failure.
   */
  private async settleRun(
    runId: string,
    exitCode: number | null,
    closedReason?: string
  ): Promise<void> {
    const { runs, git } = this.deps
    const run = runs.get(runId)
    if (!run || (run.status !== 'queued' && run.status !== 'running')) return
    const cancelled = this.cancelling.delete(runId)
    const killTimer = this.killTimers.get(runId)
    if (killTimer) {
      clearTimeout(killTimer)
      this.killTimers.delete(runId)
    }

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
      status: cancelled ? 'cancelled' : 'completed',
      exitCode: exitCode ?? undefined,
      summary: cancelled
        ? 'cancelled by user'
        : closedReason
          ? `${closedReason}${hasDiff ? ' — changes ready for review' : ''}`
          : hasDiff
            ? 'agent finished — changes ready for review'
            : 'agent finished — no changes'
    })
    this.moveTask(run.taskId, 'inreview')
    const finished = runs.get(run.id)
    if (finished) this.deps.broadcast({ type: 'run.status', run: finished })
  }

  /**
   * Interrupt the agent command (ctrl-c twice exits claude) — the terminal
   * itself survives. Hard-kills the session only if the command ignores the
   * interrupt.
   */
  cancel(runId: string): void {
    const run = this.deps.runs.get(runId)
    if (!run) throw new Error(`run ${runId} not found`)

    for (const [sessionId, tracker] of this.trackers) {
      if (tracker.activeRunId === runId) {
        this.cancelling.add(runId)
        this.deps.sessions.write(sessionId, CANCEL_INTERRUPT)
        setTimeout(() => this.deps.sessions.write(sessionId, CANCEL_INTERRUPT), 300).unref()
        const timer = setTimeout(() => {
          const still = this.trackers.get(sessionId)
          if (still?.activeRunId === runId) this.deps.sessions.kill(sessionId)
        }, CANCEL_KILL_GRACE_MS)
        timer.unref()
        this.killTimers.set(runId, timer)
        return
      }
    }

    // No live tracker (stale row after a crash): settle the DB directly.
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
    this.trackers.clear()
  }

  async reconcileOnStartup(): Promise<void> {
    const { runs, tasks, projects, worktrees } = this.deps
    const orphans = runs.listActive()
    for (const run of orphans) {
      // Not a failure — the app went away, taking the terminal with it.
      runs.finish(run.id, { status: 'cancelled', summary: 'app restarted — session ended' })
      const task = tasks.get(run.taskId)
      if (task && task.status === 'inprogress') this.moveTask(task.id, 'inreview')
    }
    await worktrees.reconcile(projects.list(), orphans)
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
