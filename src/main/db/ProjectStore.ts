import type { Database } from 'better-sqlite3'
import { v7 as uuidv7 } from 'uuid'
import type { Project, ProjectSettings } from '../../shared/domain'
import { nowIso } from './database'

interface ProjectRow {
  id: string
  name: string
  repo_path: string
  base_branch: string
  settings_json: string
  created_at: string
  updated_at: string
  archived_at: string | null
}

const DEFAULT_SETTINGS: ProjectSettings = { defaultAgent: 'claude-code' }

function toProject(r: ProjectRow): Project {
  return {
    id: r.id,
    name: r.name,
    repoPath: r.repo_path,
    baseBranch: r.base_branch,
    settings: { ...DEFAULT_SETTINGS, ...JSON.parse(r.settings_json) },
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    archivedAt: r.archived_at ?? undefined
  }
}

export class ProjectStore {
  constructor(private db: Database) {}

  list(): Project[] {
    const rows = this.db
      .prepare<[], ProjectRow>(
        'SELECT * FROM projects WHERE archived_at IS NULL ORDER BY created_at'
      )
      .all()
    return rows.map(toProject)
  }

  get(id: string): Project | undefined {
    const row = this.db.prepare<[string], ProjectRow>('SELECT * FROM projects WHERE id = ?').get(id)
    return row ? toProject(row) : undefined
  }

  create(name: string, repoPath: string, baseBranch: string): Project {
    const now = nowIso()
    const id = uuidv7()
    this.db
      .prepare(
        `INSERT INTO projects (id, name, repo_path, base_branch, settings_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, name, repoPath, baseBranch, JSON.stringify(DEFAULT_SETTINGS), now, now)
    return this.get(id)!
  }

  update(
    id: string,
    patch: { name?: string; baseBranch?: string; settings?: Partial<ProjectSettings> }
  ): Project {
    const existing = this.get(id)
    if (!existing) throw new Error(`project ${id} not found`)
    const settings = patch.settings
      ? { ...existing.settings, ...patch.settings }
      : existing.settings
    this.db
      .prepare(
        `UPDATE projects SET name = ?, base_branch = ?, settings_json = ?, updated_at = ? WHERE id = ?`
      )
      .run(
        patch.name ?? existing.name,
        patch.baseBranch ?? existing.baseBranch,
        JSON.stringify(settings),
        nowIso(),
        id
      )
    return this.get(id)!
  }

  archive(id: string): void {
    this.db
      .prepare('UPDATE projects SET archived_at = ?, updated_at = ? WHERE id = ?')
      .run(nowIso(), nowIso(), id)
  }
}
