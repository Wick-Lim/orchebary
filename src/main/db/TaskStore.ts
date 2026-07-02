import type { Database } from 'better-sqlite3'
import { generateKeyBetween } from 'fractional-indexing'
import { v7 as uuidv7 } from 'uuid'
import type { AgentKind, RunStatus, Task, TaskStatus } from '../../shared/domain'
import { nowIso } from './database'

interface TaskRow {
  id: string
  project_id: string
  title: string
  description: string
  status: TaskStatus
  position: string
  rev: number
  created_at: string
  updated_at: string
  deleted_at: string | null
  // joined columns (tasks:list):
  run_id?: string | null
  run_agent?: string | null
  run_status?: string | null
  run_branch?: string | null
  run_started?: string | null
  run_finished?: string | null
  run_summary?: string | null
  link_key?: string | null
  link_status?: string | null
  link_error?: string | null
}

function toTask(r: TaskRow): Task & { rev: number } {
  return {
    id: r.id,
    projectId: r.project_id,
    title: r.title,
    description: r.description,
    status: r.status,
    position: r.position,
    rev: r.rev,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    deletedAt: r.deleted_at ?? undefined,
    latestRun: r.run_id
      ? {
          id: r.run_id,
          agentKind: r.run_agent as AgentKind,
          status: r.run_status as RunStatus,
          branch: r.run_branch ?? '',
          startedAt: r.run_started ?? undefined,
          finishedAt: r.run_finished ?? undefined,
          summary: r.run_summary ?? undefined
        }
      : undefined,
    remoteLink: r.link_key
      ? {
          provider: 'jira',
          remoteKey: r.link_key,
          remoteStatus: r.link_status ?? undefined,
          syncError: r.link_error ?? undefined
        }
      : undefined
  } as Task & { rev: number }
}

const LIST_SQL = `
SELECT t.*,
       r.id AS run_id, r.agent_kind AS run_agent, r.status AS run_status, r.branch AS run_branch,
       r.started_at AS run_started, r.finished_at AS run_finished, r.summary AS run_summary,
       l.remote_key AS link_key, l.remote_status AS link_status, l.sync_error AS link_error
FROM tasks t
LEFT JOIN task_runs r ON r.id = (
  SELECT id FROM task_runs WHERE task_id = t.id ORDER BY created_at DESC LIMIT 1
)
LEFT JOIN remote_links l ON l.task_id = t.id
`

export class TaskStore {
  constructor(private db: Database) {}

  listForProject(projectId: string): (Task & { rev: number })[] {
    const rows = this.db
      .prepare<[string], TaskRow>(
        `${LIST_SQL} WHERE t.project_id = ? AND t.deleted_at IS NULL ORDER BY t.status, t.position`
      )
      .all(projectId)
    return rows.map(toTask)
  }

  /** Every in-progress task across projects, newest activity first. */
  listInProgress(): (Task & { rev: number; projectName: string })[] {
    const sql = LIST_SQL.replace('SELECT t.*,', 'SELECT t.*, p.name AS project_name,').replace(
      'FROM tasks t',
      'FROM tasks t JOIN projects p ON p.id = t.project_id'
    )
    const rows = this.db
      .prepare<[], TaskRow & { project_name: string }>(
        `${sql} WHERE t.status = 'inprogress' AND t.deleted_at IS NULL ORDER BY t.updated_at DESC`
      )
      .all()
    return rows.map((r) => ({ ...toTask(r), projectName: r.project_name }))
  }

  get(id: string): (Task & { rev: number }) | undefined {
    const row = this.db.prepare<[string], TaskRow>(`${LIST_SQL} WHERE t.id = ?`).get(id)
    return row ? toTask(row) : undefined
  }

  create(req: { projectId: string; title: string; description?: string; status?: TaskStatus }): Task & { rev: number } {
    const id = uuidv7()
    const now = nowIso()
    const status = req.status ?? 'todo'
    const position = this.keyAtColumnEnd(req.projectId, status)
    this.db
      .prepare(
        `INSERT INTO tasks (id, project_id, title, description, status, position, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, req.projectId, req.title, req.description ?? '', status, position, now, now)
    return this.get(id)!
  }

  /** Fractional key after the current last card of a column. */
  keyAtColumnEnd(projectId: string, status: TaskStatus): string {
    const last = this.db
      .prepare<[string, string], { position: string }>(
        `SELECT position FROM tasks WHERE project_id = ? AND status = ? AND deleted_at IS NULL
         ORDER BY position DESC LIMIT 1`
      )
      .get(projectId, status)
    return generateKeyBetween(last?.position ?? null, null)
  }

  updateContent(id: string, patch: { title?: string; description?: string }): Task & { rev: number } {
    const t = this.get(id)
    if (!t) throw new Error(`task ${id} not found`)
    this.db
      .prepare('UPDATE tasks SET title = ?, description = ?, updated_at = ?, rev = rev + 1 WHERE id = ?')
      .run(patch.title ?? t.title, patch.description ?? t.description, nowIso(), id)
    return this.get(id)!
  }

  /**
   * Status/position change. `expectedRev` guards optimistic renderer moves
   * against racing a main-initiated transition; pass null to force (used by
   * the run orchestrator, which is itself the source of truth).
   */
  move(
    id: string,
    status: TaskStatus,
    position: string,
    expectedRev: number | null
  ): { ok: true; task: Task & { rev: number } } | { ok: false; reason: string } {
    const t = this.get(id)
    if (!t) return { ok: false, reason: 'task not found' }
    if (expectedRev !== null && t.rev !== expectedRev) {
      return { ok: false, reason: 'stale revision — board out of date' }
    }
    this.db
      .prepare('UPDATE tasks SET status = ?, position = ?, updated_at = ?, rev = rev + 1 WHERE id = ?')
      .run(status, position, nowIso(), id)
    return { ok: true, task: this.get(id)! }
  }

  softDelete(id: string): void {
    this.db.prepare('UPDATE tasks SET deleted_at = ?, updated_at = ?, rev = rev + 1 WHERE id = ?').run(nowIso(), nowIso(), id)
  }
}
