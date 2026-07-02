import { BrowserWindow, dialog } from 'electron'
import { z } from 'zod'
import { getDb } from '../db/database'
import { HistoryStore } from '../db/HistoryStore'
import { SettingsStore } from '../db/SettingsStore'
import { handle, on } from './router'

export function registerMiscIpc(): void {
  const history = new HistoryStore(getDb())
  const settings = new SettingsStore(getDb())

  handle(
    'history:search',
    z.object({
      query: z.string(),
      sessionId: z.string().optional(),
      projectRoot: z.string().optional(),
      limit: z.number().int().min(1).max(500).optional()
    }),
    (req) => history.search(req)
  )

  on(
    'history:append',
    z.object({
      sessionId: z.string(),
      cwd: z.string(),
      command: z.string().min(1),
      exitCode: z.number().int().optional(),
      startedAt: z.string(),
      durationMs: z.number().optional(),
      projectRoot: z.string().optional()
    }),
    (entry) => history.append(entry)
  )

  handle('settings:get', z.object({ key: z.string() }), ({ key }) => settings.get(key))
  handle('settings:set', z.object({ key: z.string(), value: z.unknown() }), ({ key, value }) =>
    settings.set(key, value)
  )

  handle('dialog:pickDirectory', null, async (_req, event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showOpenDialog(win!, {
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return { path: result.filePaths[0] }
  })
}
