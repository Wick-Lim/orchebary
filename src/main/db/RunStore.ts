import type { Database } from 'better-sqlite3'
import { v7 as uuidv7 } from 'uuid'
import type { AgentKind, RunStatus, TaskRun } from '../../shared/domain'
import { nowIso } from './database'

interface RunRow {
  id: string
  task_id: string
  agent_kind: AgentKind
  prompt: string
  parent_run_id: string | null
  agent_session_id: string | null
  worktree_path: string
  branch: string
  base_ref: string
  pid: number | null
  status: RunStatus
  exit_code: number | null
  started_at: string | null
  finished_at: string | null
  summary: string | null
  cost_usd: number | null
  num_turns: number | null
  log_path: string | null
  created_at: string
}

function toRun(r: RunRow): TaskRun {
  return {
    id: r.id,
    taskId: r.task_id,
    agentKind: r.agent_kind,
    prompt: r.prompt,
    parentRunId: r.parent_run_id ?? undefined,
    agentSessionId: r.agent_session_id ?? undefined,
    worktreePath: r.worktree_path,
    branch: r.branch,
    baseRef: r.base_ref,
    pid: r.pid ?? undefined,
    status: r.status,
    exitCode: r.exit_code ?? undefined,
    startedAt: r.started_at ?? undefined,
    finishedAt: r.finished_at ?? undefined,
    summary: r.summary ?? undefined,
    costUsd: r.cost_usd ?? undefined,
    numTurns: r.num_turns ?? undefined,
    logPath: r.log_path ?? undefined,
    createdAt: r.created_at
  }
}

export class RunStore {
  constructor(private db: Database) {}

  insert(run: {
    taskId: string
    agentKind: AgentKind
    prompt: string
    parentRunId?: string
    agentSessionId?: string
    worktreePath: string
    branch: string
    baseRef: string
    logPath?: string
  }): TaskRun {
    const id = uuidv7()
    this.db
      .prepare(
        `INSERT INTO task_runs (id, task_id, agent_kind, prompt, parent_run_id, agent_session_id,
                                worktree_path, branch, base_ref, status, log_path, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`
      )
      .run(
        id,
        run.taskId,
        run.agentKind,
        run.prompt,
        run.parentRunId ?? null,
        run.agentSessionId ?? null,
        run.worktreePath,
        run.branch,
        run.baseRef,
        run.logPath ?? null,
        nowIso()
      )
    return this.get(id)!
  }

  get(id: string): TaskRun | undefined {
    const row = this.db.prepare<[string], RunRow>('SELECT * FROM task_runs WHERE id = ?').get(id)
    return row ? toRun(row) : undefined
  }

  listForTask(taskId: string): TaskRun[] {
    return this.db
      .prepare<[string], RunRow>('SELECT * FROM task_runs WHERE task_id = ? ORDER BY created_at DESC')
      .all(taskId)
      .map(toRun)
  }

  markRunning(id: string, pid: number): void {
    this.db
      .prepare(`UPDATE task_runs SET status = 'running', pid = ?, started_at = ? WHERE id = ?`)
      .run(pid, nowIso(), id)
  }

  finish(
    id: string,
    patch: {
      status: Extract<RunStatus, 'completed' | 'failed' | 'cancelled'>
      exitCode?: number
      summary?: string
      agentSessionId?: string
      costUsd?: number
      numTurns?: number
    }
  ): void {
    this.db
      .prepare(
        `UPDATE task_runs
         SET status = ?, exit_code = ?, summary = ?, finished_at = ?,
             agent_session_id = COALESCE(?, agent_session_id),
             cost_usd = COALESCE(?, cost_usd), num_turns = COALESCE(?, num_turns)
         WHERE id = ?`
      )
      .run(
        patch.status,
        patch.exitCode ?? null,
        patch.summary ?? null,
        nowIso(),
        patch.agentSessionId ?? null,
        patch.costUsd ?? null,
        patch.numTurns ?? null,
        id
      )
  }

  /** Startup reconciliation: anything still queued/running was interrupted. */
  listActive(): TaskRun[] {
    return this.db
      .prepare<[], RunRow>(`SELECT * FROM task_runs WHERE status IN ('queued','running')`)
      .all()
      .map(toRun)
  }

  /** Latest run per task, used to find the reviewable worktree. */
  latestForTask(taskId: string): TaskRun | undefined {
    const row = this.db
      .prepare<[string], RunRow>(
        'SELECT * FROM task_runs WHERE task_id = ? ORDER BY created_at DESC LIMIT 1'
      )
      .get(taskId)
    return row ? toRun(row) : undefined
  }
}
