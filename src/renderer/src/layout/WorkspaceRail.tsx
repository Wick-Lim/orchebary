import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Task, TerminalSessionInfo } from '../../../shared/domain'
import { useLayoutStore } from '../state/layoutStore'
import { leavesOf } from './tree'

type RailTask = Task & { projectName: string }

function statusDotClass(t: RailTask): string {
  const s = t.latestRun?.status
  if (s === 'running' || s === 'queued') return 'is-running'
  if (s === 'failed') return 'is-failed'
  return 'is-idle'
}

/**
 * Primary navigation of the terminal workspace (there is no top tab strip):
 * the issues I pulled into In Progress, then plain terminal sessions.
 * Selecting an entry reveals its session; killing a shell prunes its panes
 * through the terminal.closed event.
 */
export function WorkspaceRail(): React.JSX.Element {
  const [items, setItems] = useState<RailTask[]>([])
  const sessions = useLayoutStore((s) => s.sessions)
  const tabs = useLayoutStore((s) => s.tabs)
  const activeTabId = useLayoutStore((s) => s.activeTabId)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const refresh = useCallback(() => {
    window.orchebary.tasks
      .listWorkingOn()
      .then(setItems)
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    refresh()
    const unsubscribe = window.orchebary.onAppEvent((e) => {
      if (
        e.type === 'task.updated' ||
        e.type === 'task.moved' ||
        e.type === 'task.deleted' ||
        e.type === 'run.status'
      ) {
        if (timer.current) clearTimeout(timer.current)
        timer.current = setTimeout(refresh, 150)
      }
    })
    return () => {
      unsubscribe()
      if (timer.current) clearTimeout(timer.current)
    }
  }, [refresh])

  const activeSessionIds = useMemo(() => {
    const tab = tabs.find((t) => t.id === activeTabId)
    return new Set(tab ? leavesOf(tab.root).map((l) => l.sessionId) : [])
  }, [tabs, activeTabId])

  const agentSessionForTask = (taskId: string): TerminalSessionInfo | undefined =>
    Object.values(sessions).find((s) => s.kind === 'agent' && s.taskId === taskId)

  const shells = Object.values(sessions).filter((s) => s.kind === 'shell')

  return (
    <div className="task-rail">
      <div className="task-rail-header">
        In Progress <span className="task-rail-count">{items.length}</span>
      </div>
      {items.length === 0 && <div className="rail-empty">Drag a card into In Progress</div>}
      {items.map((t) => {
        const session = agentSessionForTask(t.id)
        const active = session ? activeSessionIds.has(session.sessionId) : false
        return (
          <button
            key={t.id}
            type="button"
            className={`task-rail-item${active ? ' is-active' : ''}${session ? '' : ' no-session'}`}
            title={session ? t.title : `${t.title} — no live terminal`}
            onClick={() => {
              if (session) useLayoutStore.getState().revealSession(session)
            }}
          >
            <span className={`task-rail-dot ${statusDotClass(t)}`} />
            <span className="task-rail-title">{t.title}</span>
            <span className="task-rail-project">{t.projectName}</span>
          </button>
        )
      })}

      <div className="task-rail-header rail-terminals-header">
        Terminals
        <button
          type="button"
          className="rail-add"
          title="New terminal (⌘T)"
          onClick={() => void useLayoutStore.getState().newTab()}
        >
          +
        </button>
      </div>
      {shells.map((s) => (
        <div
          key={s.sessionId}
          className={`task-rail-item rail-shell${activeSessionIds.has(s.sessionId) ? ' is-active' : ''}`}
          role="button"
          tabIndex={0}
          onClick={() => useLayoutStore.getState().revealSession(s)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') useLayoutStore.getState().revealSession(s)
          }}
        >
          <span className="rail-shell-glyph">❯</span>
          <span className="task-rail-title">{s.title || 'shell'}</span>
          <button
            type="button"
            className="task-rail-close"
            title="Close terminal"
            onClick={(e) => {
              e.stopPropagation()
              // PTY exit -> terminal.closed -> panes/tabs prune themselves.
              void window.orchebary.terminal.kill(s.sessionId)
            }}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  )
}
