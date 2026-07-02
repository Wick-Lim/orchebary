import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent
} from '@dnd-kit/core'
import { SortableContext, horizontalListSortingStrategy, useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { TerminalSessionInfo } from '../../../shared/domain'
import { useLayoutStore, type Tab } from '../state/layoutStore'
import { findLeaf } from './tree'

function tabSession(
  tab: Tab,
  sessions: Record<string, TerminalSessionInfo>
): TerminalSessionInfo | undefined {
  const leaf = findLeaf(tab.root, tab.activePaneId)
  return leaf ? sessions[leaf.sessionId] : undefined
}

function TabItem({ tab, active }: { tab: Tab; active: boolean }): React.JSX.Element {
  const sessions = useLayoutStore((s) => s.sessions)
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: tab.id
  })

  const session = tabSession(tab, sessions)
  const title = session?.title || tab.title

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={['tab', active ? 'is-active' : '', isDragging ? 'is-dragging' : ''].join(' ')}
      onMouseDown={() => useLayoutStore.getState().setActiveTab(tab.id)}
      {...attributes}
      {...listeners}
    >
      {session?.kind === 'agent' && <span className="tab-dot" title="agent session" />}
      <span className="tab-title" title={session?.cwd}>
        {title}
      </span>
      <button
        type="button"
        className="tab-close"
        aria-label="Close tab"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation()
          useLayoutStore.getState().closeTab(tab.id)
        }}
      >
        ×
      </button>
    </div>
  )
}

export function TabBar(): React.JSX.Element {
  const tabs = useLayoutStore((s) => s.tabs)
  const activeTabId = useLayoutStore((s) => s.activeTabId)
  // Distance threshold keeps plain clicks (activate/close) from starting drags.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))

  const onDragEnd = (event: DragEndEvent): void => {
    const { active, over } = event
    if (over && active.id !== over.id) {
      useLayoutStore.getState().reorderTabs(String(active.id), String(over.id))
    }
  }

  return (
    <div className="tab-bar">
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={tabs.map((t) => t.id)} strategy={horizontalListSortingStrategy}>
          <div className="tab-strip">
            {tabs.map((tab) => (
              <TabItem key={tab.id} tab={tab} active={tab.id === activeTabId} />
            ))}
          </div>
        </SortableContext>
      </DndContext>
      <button
        type="button"
        className="tab-add"
        aria-label="New tab"
        title="New tab (⌘T)"
        onClick={() => void useLayoutStore.getState().newTab()}
      >
        +
      </button>
    </div>
  )
}
