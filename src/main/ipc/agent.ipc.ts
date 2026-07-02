import { app } from 'electron'
import { existsSync } from 'node:fs'
import { readdir, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import type { Project, Task, TaskRun, WorktreeEntry } from '../../shared/domain'
import { GitService } from '../agents/GitService'
import { getAdapter, listAvailability } from '../agents/registry'
import { setOrchestrator } from '../agents/orchestratorHandle'
import { RunOrchestrator } from '../agents/RunOrchestrator'
import { WorktreeManager } from '../agents/WorktreeManager'
import { getDb } from '../db/database'
import { ProjectStore } from '../db/ProjectStore'
import { RunStore } from '../db/RunStore'
import { TaskStore } from '../db/TaskStore'
import { sessionManager } from '../terminal/SessionManager'
import { broadcast, handle } from './router'

const agentKindSchema = z.enum(['claude-code', 'gemini-cli', 'codex'])
const runIdSchema = z.object({ runId: z.string() })

/** Agent pipeline IPC: runs:*, git:*, worktree:*, agents:* channels. */
export function registerAgentIpc(): void {
  const db = getDb()
  const projects = new ProjectStore(db)
  const tasks = new TaskStore(db)
  const runs = new RunStore(db)
  const git = new GitService()
  const worktreeRoot = path.join(os.homedir(), '.orchebary', 'worktrees')
  const worktrees = new WorktreeManager(worktreeRoot, git)
  const orchestrator = new RunOrchestrator({
    projects,
    tasks,
    runs,
    git,
    worktrees,
    sessions: sessionManager,
    broadcast: (event) => broadcast('app:event', event)
  })
  setOrchestrator(orchestrator)

  function requireRun(runId: string): TaskRun {
    const run = runs.get(runId)
    if (!run) throw new Error(`run ${runId} not found`)
    return run
  }

  function requireContext(runId: string): { run: TaskRun; task: Task; project: Project } {
    const run = requireRun(runId)
    const task = tasks.get(run.taskId)
    if (!task) throw new Error(`task ${run.taskId} not found`)
    const project = projects.get(task.projectId)
    if (!project) throw new Error(`project ${task.projectId} not found`)
    return { run, task, project }
  }

  // --- runs ---------------------------------------------------------------

  handle(
    'runs:start',
    z.object({
      taskId: z.string(),
      agentKind: agentKindSchema.optional(),
      prompt: z.string().optional()
    }),
    ({ taskId, agentKind, prompt }) => orchestrator.start(taskId, agentKind, prompt)
  )

  handle(
    'runs:followUp',
    z.object({ taskId: z.string(), prompt: z.string().min(1) }),
    ({ taskId, prompt }) => orchestrator.followUp(taskId, prompt)
  )

  handle('runs:cancel', runIdSchema, ({ runId }) => orchestrator.cancel(runId))

  handle('runs:listForTask', z.object({ taskId: z.string() }), ({ taskId }) =>
    runs.listForTask(taskId)
  )

  handle(
    'runs:readLog',
    z.object({
      runId: z.string(),
      offset: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).max(10000).optional()
    }),
    async ({ runId, offset = 0, limit }) => {
      const run = requireRun(runId)
      if (!run.logPath || !existsSync(run.logPath)) return { events: [], total: 0 }
      const raw = await readFile(run.logPath, 'utf8')
      const adapter = getAdapter(run.agentKind) ?? getAdapter('claude-code')!
      const parser = adapter.createParser()
      const events = [...parser.push(raw), ...parser.flush()]
      return {
        events: limit === undefined ? events.slice(offset) : events.slice(offset, offset + limit),
        total: events.length
      }
    }
  )

  // --- git ----------------------------------------------------------------

  handle('git:diff', runIdSchema, async ({ runId }) => {
    const run = requireRun(runId)
    if (!existsSync(run.worktreePath)) throw new Error('worktree no longer exists')
    return { files: await git.diffFiles(run.worktreePath, run.baseRef) }
  })

  handle('git:diffStat', runIdSchema, ({ runId }) => {
    const run = requireRun(runId)
    if (!existsSync(run.worktreePath)) throw new Error('worktree no longer exists')
    return git.diffStat(run.worktreePath, run.baseRef)
  })

  handle('git:merge', runIdSchema, async ({ runId }) => {
    const { run, task, project } = requireContext(runId)
    const result = await git.mergeSquash(
      project.repoPath,
      project.baseBranch,
      run.branch,
      `orchebary: ${task.title}`
    )
    if (result.ok) {
      const position = tasks.keyAtColumnEnd(task.projectId, 'done')
      const moved = tasks.move(task.id, 'done', position, null)
      if (moved.ok) broadcast('app:event', { type: 'task.updated', task: moved.task })
    }
    return result
  })

  // --- worktree -----------------------------------------------------------

  handle(
    'worktree:openInTerminal',
    z.object({
      runId: z.string(),
      cols: z.number().int().min(1).max(1000),
      rows: z.number().int().min(1).max(1000)
    }),
    async ({ runId, cols, rows }) => {
      const { run, task, project } = requireContext(runId)
      const isWorkbench = path.basename(run.worktreePath) === 'workbench'
      const live = isWorkbench
        ? sessionManager.list().find((s) => s.projectId === project.id)
        : sessionManager.list().find((s) => s.taskId === run.taskId && !s.projectId)
      if (live) return live
      if (!existsSync(run.worktreePath)) throw new Error('worktree no longer exists')
      if (isWorkbench) {
        const sessionId = await orchestrator.ensureProjectTerminal(
          project,
          task,
          runId,
          run.worktreePath
        )
        const info = sessionManager.get(sessionId)?.info
        if (!info) throw new Error('failed to open the project terminal')
        return info
      }
      // Legacy per-task worktree: plain task-tagged shell for review work.
      return sessionManager.createAgentTerminal({
        cwd: run.worktreePath,
        cols,
        rows,
        runId,
        taskId: run.taskId,
        title: task.title
      })
    }
  )

  handle(
    'worktree:remove',
    z.object({ runId: z.string(), deleteBranch: z.boolean() }),
    async ({ runId, deleteBranch }) => {
      const { run, project } = requireContext(runId)
      const active = runs
        .listForTask(run.taskId)
        .find((r) => r.status === 'queued' || r.status === 'running')
      if (active) throw new Error('task has an active run; cancel it before removing the worktree')
      await worktrees.remove(project, run, { force: true, deleteBranch })
    }
  )

  handle('git:logGraph', z.object({ projectId: z.string() }), async ({ projectId }) => {
    const project = projects.get(projectId)
    if (!project) throw new Error(`project ${projectId} not found`)
    try {
      return { text: await git.logGraph(project.repoPath) }
    } catch {
      return { text: '' }
    }
  })

  handle('git:branches', z.object({ projectId: z.string() }), async ({ projectId }) => {
    const project = projects.get(projectId)
    if (!project) throw new Error(`project ${projectId} not found`)
    try {
      return await git.listBranches(project.repoPath)
    } catch {
      return []
    }
  })

  handle(
    'git:branchAction',
    z.object({
      projectId: z.string(),
      branch: z.string().min(1),
      action: z.enum(['merge', 'rebase', 'delete'])
    }),
    async ({ projectId, branch, action }) => {
      const project = projects.get(projectId)
      if (!project) throw new Error(`project ${projectId} not found`)
      if (branch === project.baseBranch) {
        return { ok: false, detail: `refusing to ${action} the base branch` }
      }
      if (action === 'merge') {
        const res = await git.mergeSquash(
          project.repoPath,
          project.baseBranch,
          branch,
          `merge ${branch}`
        )
        return res.ok ? { ok: true } : { ok: false, detail: res.detail }
      }
      if (action === 'rebase') {
        return git.rebase(project.repoPath, project.baseBranch, branch)
      }
      const current = await git.currentBranch(project.repoPath)
      if (current === branch) {
        return { ok: false, detail: 'branch is checked out in the primary repo' }
      }
      try {
        await git.deleteBranch(project.repoPath, branch, true)
        return { ok: true }
      } catch (err) {
        return { ok: false, detail: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  handle(
    'git:show',
    z.object({ projectId: z.string(), ref: z.string().regex(/^[0-9a-f]{6,40}$/i) }),
    async ({ projectId, ref }) => {
      const project = projects.get(projectId)
      if (!project) throw new Error(`project ${projectId} not found`)
      return { text: await git.show(project.repoPath, ref) }
    }
  )

  handle('worktree:listAll', null, async () => {
    const entries: WorktreeEntry[] = []
    const known = new Set<string>()

    for (const run of runs.listLatestPerWorktree()) {
      known.add(run.worktreePath)
      if (!existsSync(run.worktreePath)) continue
      const task = tasks.get(run.taskId)
      const project = task ? projects.get(task.projectId) : undefined
      let dirty = false
      try {
        dirty = (await git.statusPorcelain(run.worktreePath)) !== ''
      } catch {
        // unreadable worktree — surface it anyway
      }
      entries.push({
        worktreePath: run.worktreePath,
        orphan: false,
        branch: run.branch,
        projectId: project?.id,
        projectName: project?.name,
        taskId: task?.id,
        taskTitle: task?.title,
        taskStatus: task?.status,
        latestRunId: run.id,
        latestRunStatus: run.status,
        dirty
      })
    }

    // Ghost directories on disk that no run knows about.
    try {
      for (const projDir of await readdir(worktreeRoot, { withFileTypes: true })) {
        if (!projDir.isDirectory()) continue
        const projPath = path.join(worktreeRoot, projDir.name)
        for (const wt of await readdir(projPath, { withFileTypes: true })) {
          if (!wt.isDirectory()) continue
          const p = path.join(projPath, wt.name)
          if (!known.has(p)) {
            entries.push({
              worktreePath: p,
              orphan: true,
              projectId: projDir.name,
              projectName: projects.get(projDir.name)?.name
            })
          }
        }
      }
    } catch {
      // no worktree root yet
    }
    return entries
  })

  handle('worktree:pruneGhost', z.object({ path: z.string() }), async ({ path: target }) => {
    const resolved = path.resolve(target)
    if (!resolved.startsWith(worktreeRoot + path.sep)) {
      throw new Error('path is outside the managed worktree root')
    }
    const owner = runs.listLatestPerWorktree().find((r) => r.worktreePath === resolved)
    if (owner && (owner.status === 'running' || owner.status === 'queued')) {
      throw new Error('worktree has an active run')
    }
    await rm(resolved, { recursive: true, force: true })
    const project = projects.get(path.basename(path.dirname(resolved)))
    if (project) await git.worktreePrune(project.repoPath)
  })

  // --- agents ---------------------------------------------------------------

  handle('agents:listAvailable', null, () => listAvailability())

  app.on('before-quit', () => orchestrator.stopAll())

  try {
    void orchestrator
      .reconcileOnStartup()
      .catch((err) => console.error('[agents] startup reconcile failed:', err))
  } catch (err) {
    console.error('[agents] startup reconcile failed:', err)
  }
}
