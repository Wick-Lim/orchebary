import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
 * One live session row: nested under its issue (fixed label) or a scratch
 * shell at the rail bottom. Only shells get the hover ×; killing the PTY
 * prunes panes/tabs through the terminal.closed event.
 */
function SessionRow({
  session,
  label,
  active,
  nested
}: {
  session: TerminalSessionInfo
  label: string
  active: boolean
  nested?: boolean
}): React.JSX.Element {
  const reveal = (): void => useLayoutStore.getState().revealSession(session)
  return (
    <div
      className={`task-rail-item ${nested ? 'rail-session' : 'rail-shell'}${active ? ' is-active' : ''}`}
      role="button"
      tabIndex={0}
      onClick={reveal}
      onKeyDown={(e) => {
        if (e.key === 'Enter') reveal()
      }}
    >
      <span className="rail-shell-glyph">{session.kind === 'agent' ? '⏵' : '❯'}</span>
      <span className="task-rail-title">{label}</span>
      {session.kind === 'shell' && (
        <button
          type="button"
          className="task-rail-close"
          title="Close terminal"
          onClick={(e) => {
            e.stopPropagation()
            void window.orchebary.terminal.kill(session.sessionId)
          }}
        >
          ×
        </button>
      )}
    </div>
  )
}

/**
 * Primary navigation of the terminal workspace (there is no top tab strip):
 * a "Working on" issue tree — every task that is in progress or still owns
 * live sessions, with those sessions nested beneath — then scratch shells
 * (⌘T terminals bound to no task) sunk to the rail bottom.
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

  const allSessions = Object.values(sessions)
  // Agent session first (it is the issue's primary session), then its shells.
  const sessionsForTask = (taskId: string): TerminalSessionInfo[] => {
    const bound = allSessions.filter((s) => s.taskId === taskId)
    return [...bound.filter((s) => s.kind === 'agent'), ...bound.filter((s) => s.kind === 'shell')]
  }
  const scratchShells = allSessions.filter((s) => s.kind === 'shell' && !s.taskId)

  return (
    <div className="task-rail">
      <div className="task-rail-header">
        Working on <span className="task-rail-count">{items.length}</span>
      </div>
      {items.length === 0 && (
        <div className="rail-empty">
          Drag a card into In Progress — the agent&apos;s terminal will appear here.
        </div>
      )}
      {items.map((t) => {
        const bound = sessionsForTask(t.id)
        const primary = bound[0]
        const active = primary ? activeSessionIds.has(primary.sessionId) : false
        return (
          <Fragment key={t.id}>
            <button
              type="button"
              className={`task-rail-item${active ? ' is-active' : ''}${primary ? '' : ' no-session'}`}
              title={primary ? t.title : `${t.title} — no live terminal`}
              onClick={() => {
                if (primary) useLayoutStore.getState().revealSession(primary)
              }}
            >
              <span className={`task-rail-dot ${statusDotClass(t)}`} />
              <span className="task-rail-title">{t.title}</span>
              <span className="task-rail-project">{t.projectName}</span>
            </button>
            {bound.map((s) => (
              <SessionRow
                key={s.sessionId}
                session={s}
                label={s.kind === 'agent' ? 'claude' : 'worktree shell'}
                active={activeSessionIds.has(s.sessionId)}
                nested
              />
            ))}
          </Fragment>
        )
      })}

      {scratchShells.length > 0 && (
        <div className="rail-scratch">
          {scratchShells.map((s) => (
            <SessionRow
              key={s.sessionId}
              session={s}
              label={s.title || 'shell'}
              active={activeSessionIds.has(s.sessionId)}
            />
          ))}
        </div>
      )}
    </div>
  )
}
