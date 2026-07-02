import { useEffect, useState } from 'react'
import { terminalRegistry } from '../terminal/TerminalRegistry'
import { TerminalView } from '../terminal/TerminalView'
import { useLayoutStore } from '../state/layoutStore'
import { HistorySearchOverlay } from './HistorySearchOverlay'
import type { LeafNode } from './tree'

export function TerminalPane({
  tabId,
  pane,
  active
}: {
  tabId: string
  pane: LeafNode
  active: boolean
}): React.JSX.Element {
  const info = useLayoutStore((s) => s.sessions[pane.sessionId])
  const historyOpen = useLayoutStore((s) => s.historyOpen)

  // ensure() is idempotent; calling during render guarantees the xterm bundle
  // exists before TerminalView's mount effect attaches its DOM container.
  if (info) terminalRegistry.ensure(info)

  // autoFocus is fixed at mount (changing it would detach/reattach the
  // terminal); later activations focus imperatively instead.
  const [autoFocus] = useState(active)
  useEffect(() => {
    if (active) terminalRegistry.focus(pane.sessionId)
  }, [active, pane.sessionId])

  return (
    <div
      className={active ? 'terminal-pane is-active' : 'terminal-pane'}
      data-pane-id={pane.id}
      onMouseDown={() => {
        if (!active) useLayoutStore.getState().focusPane(tabId, pane.id)
      }}
    >
      {info ? (
        <TerminalView sessionId={pane.sessionId} autoFocus={autoFocus} />
      ) : (
        <div className="terminal-pane-dead">session ended</div>
      )}
      {active && historyOpen && info && <HistorySearchOverlay sessionId={pane.sessionId} />}
    </div>
  )
}
