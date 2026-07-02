import { Group, Panel, Separator } from 'react-resizable-panels'
import { useLayoutStore } from '../state/layoutStore'
import { TerminalPane } from './TerminalPane'
import type { PaneNode } from './tree'

function PaneTree({
  tabId,
  node,
  activePaneId
}: {
  tabId: string
  node: PaneNode
  activePaneId: string
}): React.JSX.Element {
  if (node.type === 'leaf') {
    return <TerminalPane tabId={tabId} pane={node} active={node.id === activePaneId} />
  }
  const aPct = node.ratio * 100
  return (
    // Key by child ids: structural changes remount the Group so the stored
    // ratio is re-applied as the default layout.
    <Group
      key={`${node.a.id}:${node.b.id}`}
      className="pane-group"
      orientation={node.dir === 'row' ? 'horizontal' : 'vertical'}
      defaultLayout={{ [node.a.id]: aPct, [node.b.id]: 100 - aPct }}
      onLayoutChanged={(layout, meta) => {
        const a = layout[node.a.id]
        if (meta.isUserInteraction && typeof a === 'number') {
          useLayoutStore.getState().setRatio(tabId, node.id, a / 100)
        }
      }}
    >
      <Panel id={node.a.id} className="pane-panel" minSize="10%">
        <PaneTree tabId={tabId} node={node.a} activePaneId={activePaneId} />
      </Panel>
      <Separator className="pane-separator" />
      <Panel id={node.b.id} className="pane-panel" minSize="10%">
        <PaneTree tabId={tabId} node={node.b} activePaneId={activePaneId} />
      </Panel>
    </Group>
  )
}

export function PaneLayout(): React.JSX.Element {
  const tabs = useLayoutStore((s) => s.tabs)
  const activeTabId = useLayoutStore((s) => s.activeTabId)
  const tab = tabs.find((t) => t.id === activeTabId)

  if (!tab) {
    return (
      <div className="pane-empty">
        <p>No open terminals</p>
        <button type="button" onClick={() => void useLayoutStore.getState().newTab()}>
          New Tab <kbd>⌘T</kbd>
        </button>
      </div>
    )
  }

  return (
    <div className="pane-root">
      <PaneTree tabId={tab.id} node={tab.root} activePaneId={tab.activePaneId} />
    </div>
  )
}
