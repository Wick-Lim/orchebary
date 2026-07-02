import Database from 'better-sqlite3'
import { app } from 'electron'
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { migrations } from './migrations'

let db: Database.Database | null = null

export function getDb(): Database.Database {
  if (db) return db
  const dir = app.getPath('userData')
  mkdirSync(dir, { recursive: true })
  db = openAt(path.join(dir, 'orchebary.db'))
  return db
}

/** Test seam: open at an explicit path (e.g. ':memory:'). */
export function openAt(file: string): Database.Database {
  const handle = new Database(file)
  handle.pragma('journal_mode = WAL')
  handle.pragma('foreign_keys = ON')
  migrate(handle, file)
  return handle
}

function migrate(handle: Database.Database, file: string): void {
  const current = handle.pragma('user_version', { simple: true }) as number
  const pending = migrations.filter((m) => m.version > current)
  if (pending.length === 0) return

  // Cheap insurance before touching the schema of a real on-disk DB.
  if (file !== ':memory:' && existsSync(file) && current > 0) {
    copyFileSync(file, `${file}.bak-v${current}`)
  }

  for (const m of pending.sort((a, b) => a.version - b.version)) {
    const run = handle.transaction(() => {
      handle.exec(m.sql)
      handle.pragma(`user_version = ${m.version}`)
    })
    run()
  }
}

export function closeDb(): void {
  db?.close()
  db = null
}

export function nowIso(): string {
  return new Date().toISOString()
}
