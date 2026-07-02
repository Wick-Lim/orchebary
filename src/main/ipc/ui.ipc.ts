import { BrowserWindow, Menu } from 'electron'
import { z } from 'zod'
import { handle } from './router'

const itemSchema = z.object({
  id: z.string().optional(),
  label: z.string().optional(),
  type: z.literal('separator').optional(),
  enabled: z.boolean().optional()
})

/** Native context menus (VS Code-style) — no in-page layout to disturb. */
export function registerUiIpc(): void {
  handle('ui:contextMenu', z.object({ items: z.array(itemSchema) }), (req, event) => {
    return new Promise<{ id: string | null }>((resolve) => {
      let settled = false
      const done = (id: string | null): void => {
        if (!settled) {
          settled = true
          resolve({ id })
        }
      }
      const menu = Menu.buildFromTemplate(
        req.items.map((item) =>
          item.type === 'separator'
            ? { type: 'separator' as const }
            : {
                label: item.label ?? '',
                enabled: item.enabled ?? true,
                click: () => done(item.id ?? null)
              }
        )
      )
      menu.on('menu-will-close', () => {
        // click callbacks fire after close — give them a beat.
        setTimeout(() => done(null), 200)
      })
      const win = BrowserWindow.fromWebContents(event.sender) ?? undefined
      menu.popup({ window: win })
    })
  })
}
