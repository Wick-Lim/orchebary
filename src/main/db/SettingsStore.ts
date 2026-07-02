import type { Database } from 'better-sqlite3'
import { nowIso } from './database'

export class SettingsStore {
  constructor(private db: Database) {}

  get(key: string): unknown {
    const row = this.db
      .prepare<[string], { value: string }>('SELECT value FROM app_settings WHERE key = ?')
      .get(key)
    if (!row) return undefined
    try {
      return JSON.parse(row.value)
    } catch {
      return undefined
    }
  }

  set(key: string, value: unknown): void {
    this.db
      .prepare(
        `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      )
      .run(key, JSON.stringify(value ?? null), nowIso())
  }
}
