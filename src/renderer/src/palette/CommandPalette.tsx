import { useEffect, useReducer } from 'react'
import { Command } from 'cmdk'
import { useLayoutStore } from '../state/layoutStore'
import { actionRegistry, type AppAction } from './ActionRegistry'
import { currentActionContext } from './actions'
import { refreshWorkflows } from './workflows'

const SECTION_ORDER = ['Tabs', 'Panes', 'Sessions', 'View', 'History', 'Workflows']

function groupBySection(actions: AppAction[]): Array<[string, AppAction[]]> {
  const groups = new Map<string, AppAction[]>()
  for (const a of actions) {
    const list = groups.get(a.section) ?? []
    list.push(a)
    groups.set(a.section, list)
  }
  return [...groups.entries()].sort(([a], [b]) => {
    const ia = SECTION_ORDER.indexOf(a)
    const ib = SECTION_ORDER.indexOf(b)
    return (ia === -1 ? SECTION_ORDER.length : ia) - (ib === -1 ? SECTION_ORDER.length : ib)
  })
}

export function CommandPalette(): React.JSX.Element | null {
  const open = useLayoutStore((s) => s.paletteOpen)
  const [, bump] = useReducer((x: number) => x + 1, 0)

  // Workflows come from settings (async); re-render once they arrive.
  useEffect(() => {
    if (open) void refreshWorkflows().then(bump)
  }, [open])

  if (!open) return null

  const close = (): void => useLayoutStore.getState().setPaletteOpen(false)
  const sections = groupBySection(actionRegistry.all(currentActionContext()))

  return (
    <div
      className="overlay-backdrop"
      onMouseDown={close}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          close()
        }
      }}
    >
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <Command label="Command palette" loop>
          <Command.Input autoFocus placeholder="Type a command…" />
          <Command.List>
            <Command.Empty>No matching commands</Command.Empty>
            {sections.map(([section, actions]) => (
              <Command.Group key={section} heading={section}>
                {actions.map((action) => (
                  <Command.Item
                    key={action.id}
                    value={action.id}
                    keywords={[action.title, ...(action.keywords ?? [])]}
                    onSelect={() => {
                      close()
                      actionRegistry.run(action.id, currentActionContext())
                    }}
                  >
                    {action.title}
                  </Command.Item>
                ))}
              </Command.Group>
            ))}
          </Command.List>
        </Command>
      </div>
    </div>
  )
}
