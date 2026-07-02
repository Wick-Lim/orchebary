import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Task, TerminalSessionInfo } from '../../../shared/domain'
import { TASK_STATUS_LABEL } from '../../../shared/domain'
import { useLayoutStore } from '../state/layoutStore'
import { leavesOf } from './tree'

type RailTask = Task & { projectName: string }

/** Scratch shell row (⌘T terminals bound to no task), sunk to the bottom. */
function ScratchRow({
  session,
  active
}: {
  session: TerminalSessionInfo
  active: boolean
}): React.JSX.Element {
  const reveal = (): void => useLayoutStore.getState().revealSession(session)
  return (
    <div
      className={`task-rail-item rail-shell${active ? ' is-active' : ''}`}
      role="button"
      tabIndex={0}
      onClick={reveal}
      onKeyDown={(e) => {
        if (e.key === 'Enter') reveal()
      }}
    >
      <span className="rail-shell-glyph">❯</span>
      <span className="task-rail-title">{session.title || 'shell'}</span>
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
    </div>
  )
}

/**
 * Primary navigation of the terminal workspace: the issues being worked on.
 * Each issue owns exactly ONE terminal (a shell in its worktree where the
 * agent runs as a command) — clicking the issue focuses it, recreating the
 * shell if it is gone. Scratch shells sink to the rail bottom.
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
  const sessionForTask = (taskId: string): TerminalSessionInfo | undefined =>
    allSessions.find((s) => s.taskId === taskId && s.kind === 'agent') ??
    allSessions.find((s) => s.taskId === taskId)
  const scratchShells = allSessions.filter((s) => s.kind === 'shell' && !s.taskId)

  const openIssueTerminal = (t: RailTask): void => {
    const session = sessionForTask(t.id)
    if (session) {
      useLayoutStore.getState().revealSession(session)
      return
    }
    // Terminal gone (e.g. after an app restart) — recreate it in the worktree.
    if (t.latestRun) {
      void window.orchebary.worktree
        .openInTerminal(t.latestRun.id, 80, 24)
        .then((info) => useLayoutStore.getState().revealSession(info))
        .catch(() => undefined)
    }
  }

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
        const session = sessionForTask(t.id)
        const active = session ? activeSessionIds.has(session.sessionId) : false
        const running = t.latestRun?.status === 'running' || t.latestRun?.status === 'queued'
        return (
          <div
            key={t.id}
            className={`rail-issue${active ? ' is-active' : ''}${session || t.latestRun ? '' : ' no-session'}`}
            role="button"
            tabIndex={0}
            title={t.title}
            onClick={() => openIssueTerminal(t)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') openIssueTerminal(t)
            }}
          >
            <div className="rail-issue-title">
              {running && <span className="task-rail-dot is-running" />}
              {t.title}
            </div>
            <div className="rail-issue-sub">
              <span className={`panel-status-chip status-${t.status}`}>
                {TASK_STATUS_LABEL[t.status]}
              </span>
              <span className="rail-issue-project">{t.projectName}</span>
            </div>
          </div>
        )
      })}

      {scratchShells.length > 0 && (
        <div className="rail-scratch">
          {scratchShells.map((s) => (
            <ScratchRow
              key={s.sessionId}
              session={s}
              active={activeSessionIds.has(s.sessionId)}
            />
          ))}
        </div>
      )}
    </div>
  )
}
