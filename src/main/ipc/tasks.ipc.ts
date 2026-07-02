import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { getOrchestrator } from '../agents/orchestratorHandle'
import { getDb } from '../db/database'
import { ProjectStore } from '../db/ProjectStore'
import { TaskStore } from '../db/TaskStore'
import { broadcast, handle } from './router'

const statusSchema = z.enum(['todo', 'inprogress', 'inreview', 'done', 'cancelled'])

/**
 * Cheap base-branch detection without spawning git: look for loose refs,
 * then packed-refs. Worktree-style `.git` files fall through to 'main'.
 */
function detectBaseBranch(repoPath: string): string {
  const heads = path.join(repoPath, '.git', 'refs', 'heads')
  if (existsSync(path.join(heads, 'main'))) return 'main'
  if (existsSync(path.join(heads, 'master'))) return 'master'
  try {
    const packed = readFileSync(path.join(repoPath, '.git', 'packed-refs'), 'utf8')
    if (packed.includes('refs/heads/main')) return 'main'
    if (packed.includes('refs/heads/master')) return 'master'
  } catch {
    // no packed-refs — fall through
  }
  return 'main'
}

export function registerTasksIpc(): void {
  const db = getDb()
  const projects = new ProjectStore(db)
  const tasks = new TaskStore(db)

  handle('projects:list', null, () => projects.list())

  handle(
    'projects:create',
    z.object({ name: z.string().min(1), repoPath: z.string().min(1) }),
    ({ name, repoPath }) => {
      if (!path.isAbsolute(repoPath)) throw new Error(`Project path must be absolute: ${repoPath}`)
      if (!existsSync(repoPath)) throw new Error(`Path does not exist: ${repoPath}`)
      if (!existsSync(path.join(repoPath, '.git'))) {
        throw new Error(`Not a git repository (no .git): ${repoPath}`)
      }
      return projects.create(name.trim(), repoPath, detectBaseBranch(repoPath))
    }
  )

  handle(
    'projects:update',
    z.object({
      id: z.string(),
      patch: z.object({
        name: z.string().min(1).optional(),
        baseBranch: z.string().min(1).optional(),
        settings: z
          .object({
            defaultAgent: z.enum(['claude-code', 'gemini-cli', 'codex']).optional(),
            setupScript: z.string().optional()
          })
          .optional()
      })
    }),
    ({ id, patch }) => projects.update(id, patch)
  )

  handle('projects:archive', z.object({ id: z.string() }), ({ id }) => projects.archive(id))

  handle('tasks:list', z.object({ projectId: z.string() }), ({ projectId }) =>
    tasks.listForProject(projectId)
  )

  handle('tasks:listInProgress', null, () => tasks.listInProgress())

  handle(
    'tasks:create',
    z.object({
      projectId: z.string(),
      title: z.string().min(1),
      description: z.string().optional(),
      status: statusSchema.optional()
    }),
    (req) => {
      const task = tasks.create(req)
      broadcast('app:event', { type: 'task.updated', task })
      return task
    }
  )

  handle(
    'tasks:update',
    z.object({
      id: z.string(),
      patch: z.object({
        title: z.string().min(1).optional(),
        description: z.string().optional()
      })
    }),
    ({ id, patch }) => {
      const task = tasks.updateContent(id, patch)
      broadcast('app:event', { type: 'task.updated', task })
      return task
    }
  )

  handle(
    'tasks:move',
    z.object({
      id: z.string(),
      status: statusSchema,
      position: z.string().min(1),
      expectedRev: z.number().int().min(0)
    }),
    ({ id, status, position, expectedRev }) => {
      const current = tasks.get(id)
      if (!current) return { ok: false as const, reason: 'task not found' }
      // A live agent owns the inprogress column; the board may not pull the
      // card out from under it.
      if (
        current.status === 'inprogress' &&
        current.latestRun?.status === 'running' &&
        status !== 'inprogress'
      ) {
        return { ok: false as const, reason: 'Cancel the running agent first' }
      }
      const res = tasks.move(id, status, position, expectedRev)
      if (!res.ok) return res
      broadcast('app:event', {
        type: 'task.moved',
        taskId: id,
        status: res.task.status,
        position: res.task.position,
        rev: res.task.rev
      })
      broadcast('app:event', { type: 'task.updated', task: res.task })

      // Dragging a card into In Progress starts the agent: interactive
      // plan-mode claude in a fresh terminal bound to the task's worktree.
      const hadActiveRun =
        current.latestRun?.status === 'queued' || current.latestRun?.status === 'running'
      if (status === 'inprogress' && current.status !== 'inprogress' && !hadActiveRun) {
        getOrchestrator()
          ?.start(id)
          .catch((err) => console.error('[tasks] auto-start on move failed:', err))
      }
      return { ok: true as const, rev: res.task.rev }
    }
  )

  handle('tasks:delete', z.object({ id: z.string() }), ({ id }) => {
    tasks.softDelete(id)
    broadcast('app:event', { type: 'task.deleted', taskId: id })
  })
}
