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
 * Primary navigation of the terminal workspace. One agent terminal per
 * PROJECT: the project header is the terminal, and the issues queued into it
 * are listed beneath (Jira-style rows). Scratch shells sink to the bottom.
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
  const sessionForProject = (projectId: string): TerminalSessionInfo | undefined =>
    allSessions.find((s) => s.projectId === projectId)

  const openProjectTerminal = (projectId: string, fallback?: RailTask): void => {
    const session = sessionForProject(projectId)
    if (session) {
      useLayoutStore.getState().revealSession(session)
      return
    }
    const runId = fallback?.latestRun?.id
    if (runId) {
      void window.orchebary.worktree
        .openInTerminal(runId, 80, 24)
        .then((info) => useLayoutStore.getState().revealSession(info))
        .catch(() => undefined)
    }
  }

  // The rail is the active queue: In Progress issues only.
  const inProgress = items.filter((t) => t.status === 'inprogress')
  const groups = new Map<string, { name: string; items: RailTask[] }>()
  for (const t of inProgress) {
    const g = groups.get(t.projectId)
    if (g) g.items.push(t)
    else groups.set(t.projectId, { name: t.projectName, items: [t] })
  }

  const scratchShells = allSessions.filter((s) => s.kind === 'shell' && !s.taskId && !s.projectId)

  return (
    <div className="task-rail">
      <div className="task-rail-header">
        In Progress <span className="task-rail-count">{inProgress.length}</span>
      </div>
      {inProgress.length === 0 && (
        <div className="rail-empty">
          Drag a card into In Progress — the project&apos;s agent terminal appears here.
        </div>
      )}
      {[...groups.entries()].map(([projectId, group]) => {
        const session = sessionForProject(projectId)
        const projectActive = session ? activeSessionIds.has(session.sessionId) : false
        const anyRunning = group.items.some(
          (t) => t.latestRun?.status === 'running' || t.latestRun?.status === 'queued'
        )
        return (
          <div key={projectId} className="rail-group">
            <div
              className={`rail-project${projectActive ? ' is-active' : ''}${session ? '' : ' no-session'}`}
              role="button"
              tabIndex={0}
              title={`${group.name} — project terminal`}
              onClick={() => openProjectTerminal(projectId, group.items[0])}
              onKeyDown={(e) => {
                if (e.key === 'Enter') openProjectTerminal(projectId, group.items[0])
              }}
            >
              {anyRunning && <span className="task-rail-dot is-running" />}
              <span className="rail-project-name">{group.name}</span>
              <span className="rail-project-count">{group.items.length}</span>
            </div>
            {group.items.map((t) => (
              <div
                key={t.id}
                className={`rail-issue${projectActive ? ' is-active' : ''}`}
                role="button"
                tabIndex={0}
                title={t.title}
                onClick={() => openProjectTerminal(projectId, t)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') openProjectTerminal(projectId, t)
                }}
              >
                <div className="rail-issue-title">{t.title}</div>
                <div className="rail-issue-sub">
                  <span className={`panel-status-chip status-${t.status}`}>
                    {TASK_STATUS_LABEL[t.status]}
                  </span>
                </div>
              </div>
            ))}
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
