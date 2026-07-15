import { execFile } from 'node:child_process'
import type { AgentKind, AppEvent, Project, Task, TaskRun, TaskStatus } from '../../shared/domain'
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

function taskPrompt(task: Task): string {
  return `Task: ${task.title}\n\n${task.description}`
}

/**
 * One agent terminal PER PROJECT: a real login shell in the project's
 * workbench worktree running a single claude session. Dragging cards into
 * In Progress queues their prompts into that session (typed while claude is
 * live, or as the command's argument when the shell is idle). When the claude
 * command exits, every queued task settles together: auto-commit -> diff ->
 * In Review — and the terminal stays for review work.
 */
export class RunOrchestrator {
  /** projectId -> live terminal sessionId */
  private projectSessions = new Map<string, string>()
  private sessionProjects = new Map<string, string>()
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
      const projectId = this.sessionProjects.get(sessionId)
      const affected = this.trackers.get(sessionId)?.dispose() ?? []
      this.trackers.delete(sessionId)
      this.sessionProjects.delete(sessionId)
      if (projectId && this.projectSessions.get(projectId) === sessionId) {
        this.projectSessions.delete(projectId)
      }
      if (affected.length > 0 && !this.stopped) {
        void this.settleRuns(affected, null, 'terminal closed').catch((e) =>
          console.error('[agents] settle after terminal close failed:', e)
        )
      }
    })
  }

  /**
   * Queue a task into its project's agent session (creating the workbench
   * worktree and the terminal on first use).
   */
  async start(taskId: string, agentKind?: AgentKind, prompt?: string): Promise<TaskRun> {
    const { tasks, projects, runs, worktrees } = this.deps
    const task = tasks.get(taskId)
    if (!task || task.deletedAt) throw new Error(`task ${taskId} not found`)
    const existing = runs
      .listForTask(taskId)
      .find((r) => r.status === 'queued' || r.status === 'running')
    if (existing) return existing
    const project = projects.get(task.projectId)
    if (!project) throw new Error(`project ${task.projectId} not found`)

    const kind = agentKind ?? project.settings.defaultAgent
    const adapter = await this.requireAdapter(kind)
    const wb = await worktrees.ensureWorkbench(project)

    const promptText = prompt?.trim() || taskPrompt(task)
    const run = runs.insert({
      taskId,
      agentKind: kind,
      prompt: promptText,
      worktreePath: wb.worktreePath,
      branch: wb.branch,
      baseRef: wb.baseRef
    })
    this.moveTask(taskId, 'inprogress')

    try {
      const sessionId = await this.ensureProjectTerminal(project, task, run.id, wb.worktreePath)
      const tracker = this.trackers.get(sessionId)!
      // Idle shell -> fresh claude turn for this task; agent starting ->
      // buffered until live; agent live -> typed into the conversation.
      // (Deliberately no --continue: conversation lookup proved unreliable
      // inside worktrees; each turn is fresh and self-contained.)
      tracker.submit({
        runId: run.id,
        promptText,
        buildCommand: () => adapter.buildInteractiveCommand({ prompt: promptText })
      })
      const pid = this.deps.sessions.get(sessionId)?.info.pid
      runs.markRunning(run.id, pid ?? 0)
    } catch (err) {
      runs.finish(run.id, {
        status: 'failed',
        summary: `failed to launch the project terminal: ${err instanceof Error ? err.message : err}`
      })
      this.moveTask(taskId, 'inreview')
    }

    const current = runs.get(run.id) ?? run
    this.deps.broadcast({ type: 'run.status', run: current })
    return current
  }

  /** Follow-up from the board — same queueing path. */
  async followUp(taskId: string, prompt: string): Promise<TaskRun> {
    return this.start(taskId, undefined, prompt)
  }

  /** The project's one terminal, recreated in the workbench if it is gone. */
  async ensureProjectTerminal(
    project: Project,
    task: Pick<Task, 'id'>,
    runId: string,
    worktreePath: string
  ): Promise<string> {
    const known = this.projectSessions.get(project.id)
    if (known && this.deps.sessions.get(known)) return known

    const adopted = this.deps.sessions.list().find((s) => s.projectId === project.id)
    if (adopted) {
      this.bindProjectSession(project.id, adopted.sessionId)
      return adopted.sessionId
    }

    const info = await this.deps.sessions.createAgentTerminal({
      cwd: worktreePath,
      cols: 120,
      rows: 30,
      runId,
      taskId: task.id,
      projectId: project.id,
      title: project.name
    })
    this.bindProjectSession(project.id, info.sessionId)
    return info.sessionId
  }

  private bindProjectSession(projectId: string, sessionId: string): void {
    this.projectSessions.set(projectId, sessionId)
    this.sessionProjects.set(sessionId, projectId)
    if (!this.trackers.has(sessionId)) {
      this.trackers.set(
        sessionId,
        new CommandTracker(
          (data) => this.deps.sessions.write(sessionId, data),
          (runIds, exitCode) => {
            void this.settleRuns(runIds, exitCode).catch((e) =>
              console.error('[agents] settle failed:', e)
            )
          }
        )
      )
    }
  }

  /**
   * A claude command finished (or its terminal died): commit what changed in
   * the workbench and move exactly the tasks that rode in it to review.
   */
  private async settleRuns(
    runIds: string[],
    exitCode: number | null,
    closedReason?: string
  ): Promise<void> {
    if (this.stopped) return
    const { runs, tasks, git } = this.deps
    const active = runIds
      .map((id) => runs.get(id))
      .filter((r): r is TaskRun => !!r && (r.status === 'queued' || r.status === 'running'))
    if (active.length === 0) return
    const worktreePath = active[0].worktreePath

    let committed = false
    try {
      if ((await git.statusPorcelain(worktreePath)) !== '') {
        const titles = active
          .map((r) => tasks.get(r.taskId)?.title)
          .filter(Boolean)
          .join(', ')
        await git.addAllAndCommit(worktreePath, `orchebary: ${titles || 'agent work'}`)
        committed = true
      }
    } catch (err) {
      console.error(`[agents] auto-commit failed in ${worktreePath}:`, err)
    }

    let hasDiff = committed
    try {
      const stat = await git.diffStat(worktreePath, active[0].baseRef)
      hasDiff = stat.filesChanged > 0
      for (const run of active) {
        this.deps.broadcast({ type: 'run.diffstat', runId: run.id, taskId: run.taskId, stat })
      }
    } catch (err) {
      console.error(`[agents] diffstat failed in ${worktreePath}:`, err)
    }

    for (const run of active) {
      const cancelled = this.cancelling.delete(run.id)
      const killTimer = this.killTimers.get(run.id)
      if (killTimer) {
        clearTimeout(killTimer)
        this.killTimers.delete(run.id)
      }
      runs.finish(run.id, {
        status: cancelled ? 'cancelled' : 'completed',
        exitCode: exitCode ?? undefined,
        summary: cancelled
          ? 'cancelled by user'
          : closedReason
            ? `${closedReason}${hasDiff ? ' — changes ready for review' : ''}`
            : hasDiff
              ? 'agent session ended — changes ready for review'
              : 'agent session ended — no changes'
      })
      this.moveTask(run.taskId, 'inreview')
      const finished = runs.get(run.id)
      if (finished) this.deps.broadcast({ type: 'run.status', run: finished })
    }
  }

  /**
   * Drop one task out of the queue without touching the claude session. Used
   * for per-card cancel and when a card is dragged out of In Progress.
   */
  detachTask(taskId: string): void {
    const { runs } = this.deps
    const active = runs
      .listForTask(taskId)
      .find((r) => r.status === 'queued' || r.status === 'running')
    if (!active) return
    // A prompt already typed into the conversation cannot be untyped — the
    // agent may still act on it; only queued work is truly removed.
    const delivered = [...this.trackers.values()].some((t) => t.attachedRunIds.includes(active.id))
    for (const tracker of this.trackers.values()) tracker.removePending(active.id)
    runs.finish(active.id, {
      status: 'cancelled',
      summary: delivered
        ? 'detached — the prompt was already delivered to the agent'
        : 'removed from the queue'
    })
    const updated = runs.get(active.id)
    if (updated) this.deps.broadcast({ type: 'run.status', run: updated })
  }

  /**
   * Cancel a run. If it is the command the tracker is following, interrupt
   * claude (ctrl-c twice) — the terminal survives; other queued runs settle
   * with the batch. A run that is merely queued detaches silently.
   */
  cancel(runId: string): void {
    const run = this.deps.runs.get(runId)
    if (!run) throw new Error(`run ${runId} not found`)

    for (const [sessionId, tracker] of this.trackers) {
      if (tracker.attachedRunIds.includes(runId)) {
        this.cancelling.add(runId)
        const stillRunning = (): boolean =>
          this.trackers.get(sessionId)?.attachedRunIds.includes(runId) ?? false
        this.deps.sessions.write(sessionId, CANCEL_INTERRUPT)
        setTimeout(() => this.deps.sessions.write(sessionId, CANCEL_INTERRUPT), 300).unref()
        // A modal dialog swallows the first press — a late third one still
        // lands on the exit-confirm REPL state.
        setTimeout(() => {
          if (stillRunning()) this.deps.sessions.write(sessionId, CANCEL_INTERRUPT)
        }, 1500).unref()
        const timer = setTimeout(() => {
          if (!stillRunning()) return
          // Last resorts: SIGTERM the shell's children so the terminal itself
          // survives; nuke the session only if even that changes nothing.
          this.terminateForeground(sessionId)
          const hardTimer = setTimeout(() => {
            if (stillRunning()) this.deps.sessions.kill(sessionId)
          }, CANCEL_KILL_GRACE_MS)
          hardTimer.unref()
          this.killTimers.set(runId, hardTimer)
        }, CANCEL_KILL_GRACE_MS)
        timer.unref()
        this.killTimers.set(runId, timer)
        return
      }
      tracker.removePending(runId)
    }

    if (run.status === 'queued' || run.status === 'running') {
      this.deps.runs.finish(runId, { status: 'cancelled', summary: 'cancelled by user' })
      this.moveTask(run.taskId, 'inreview')
      const updated = this.deps.runs.get(runId)
      if (updated) this.deps.broadcast({ type: 'run.status', run: updated })
    }
  }

  /** SIGTERM the shell's children (the agent) without touching the shell. */
  private terminateForeground(sessionId: string): void {
    const pid = this.deps.sessions.get(sessionId)?.info.pid
    if (!pid) return
    execFile('pkill', ['-TERM', '-P', String(pid)], () => undefined)
  }

  /** before-quit: PTYs die via SessionManager.disposeAll; keep off the DB. */
  stopAll(): void {
    this.stopped = true
    this.trackers.clear()
    this.projectSessions.clear()
    this.sessionProjects.clear()
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
