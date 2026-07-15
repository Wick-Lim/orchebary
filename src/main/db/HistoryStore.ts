import type { Database } from 'better-sqlite3'
import { v7 as uuidv7 } from 'uuid'
import type { HistoryEntry } from '../../shared/domain'

interface HistoryRow {
  id: string
  session_id: string
  cwd: string
  command: string
  exit_code: number | null
  started_at: string
  duration_ms: number | null
  project_root: string | null
}

function toEntry(r: HistoryRow): HistoryEntry {
  return {
    id: r.id,
    sessionId: r.session_id,
    cwd: r.cwd,
    command: r.command,
    exitCode: r.exit_code ?? undefined,
    startedAt: r.started_at,
    durationMs: r.duration_ms ?? undefined,
    projectRoot: r.project_root ?? undefined
  }
}

export class HistoryStore {
  constructor(private db: Database) {}

  append(e: Omit<HistoryEntry, 'id'>): void {
    this.db
      .prepare(
        `INSERT INTO command_history (id, session_id, cwd, command, exit_code, started_at, duration_ms, project_root)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        uuidv7(),
        e.sessionId,
        e.cwd,
        e.command,
        e.exitCode ?? null,
        e.startedAt,
        e.durationMs ?? null,
        e.projectRoot ?? null
      )
  }

  search(req: {
    query: string
    sessionId?: string
    projectRoot?: string
    limit?: number
  }): HistoryEntry[] {
    const clauses: string[] = []
    const params: unknown[] = []
    if (req.query) {
      clauses.push('command LIKE ?')
      params.push(`%${req.query}%`)
    }
    if (req.sessionId) {
      clauses.push('session_id = ?')
      params.push(req.sessionId)
    }
    if (req.projectRoot) {
      clauses.push('project_root = ?')
      params.push(req.projectRoot)
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    const limit = req.limit ?? 50
    const rows = this.db
      .prepare<unknown[], HistoryRow>(
        `SELECT * FROM command_history ${where} ORDER BY started_at DESC LIMIT ?`
      )
      .all(...params, limit * 4)
    // Dedupe by command keeping the most recent occurrence.
    const seen = new Set<string>()
    const out: HistoryEntry[] = []
    for (const row of rows) {
      if (seen.has(row.command)) continue
      seen.add(row.command)
      out.push(toEntry(row))
      if (out.length >= limit) break
    }
    return out
  }
}
