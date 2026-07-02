import { app } from 'electron'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import type { Project, Task, TaskRun } from '../../shared/domain'
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
  const worktrees = new WorktreeManager(path.join(os.homedir(), '.orchebary', 'worktrees'), git)
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
    ({ runId, cols, rows }) => {
      const { run, task } = requireContext(runId)
      if (!existsSync(run.worktreePath)) throw new Error('worktree no longer exists')
      return sessionManager.createShell(
        { cwd: run.worktreePath, cols, rows },
        { runId, taskId: run.taskId, title: task.title }
      )
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
