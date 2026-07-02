import { useCallback, useEffect, useRef, useState } from 'react'
import type { WorktreeEntry } from '../../../shared/domain'
import { TASK_STATUS_LABEL } from '../../../shared/domain'
import '../assets/worktrees.css'
import { showError, showToast } from '../kanban/toastStore'
import { useUiStore } from '../state/uiStore'

function dirName(p: string): string {
  return p.split('/').pop() ?? p
}

/**
 * Always-visible right sidebar: every git worktree the app owns — branch,
 * owning task, dirty state — with open/remove/prune right where you look.
 */
export function WorktreesPanel(): React.JSX.Element {
  const [entries, setEntries] = useState<WorktreeEntry[]>([])
  const [busyPath, setBusyPath] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const refresh = useCallback(() => {
    window.orchebary.worktree
      .listAll()
      .then(setEntries)
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    refresh()
    const unsubscribe = window.orchebary.onAppEvent((e) => {
      if (e.type === 'run.status' || e.type === 'task.updated' || e.type === 'task.deleted') {
        if (timer.current) clearTimeout(timer.current)
        timer.current = setTimeout(refresh, 300)
      }
    })
    return () => {
      unsubscribe()
      if (timer.current) clearTimeout(timer.current)
    }
  }, [refresh])

  async function act(path: string, label: string, fn: () => Promise<void>): Promise<void> {
    setBusyPath(path)
    try {
      await fn()
      refresh()
    } catch (err) {
      showError(err, label)
    } finally {
      setBusyPath(null)
    }
  }

  const groups = new Map<string, WorktreeEntry[]>()
  for (const e of entries) {
    const key = e.projectName ?? e.projectId ?? 'unknown project'
    const list = groups.get(key)
    if (list) list.push(e)
    else groups.set(key, [e])
  }

  return (
    <div className="wt-panel">
      <div className="wt-panel-header">
        Worktrees <span className="task-rail-count">{entries.length}</span>
        <button className="wt-refresh" title="Refresh" onClick={refresh}>
          ↻
        </button>
      </div>

      {entries.length === 0 && (
        <div className="rail-empty">Agents work in isolated worktrees — they appear here.</div>
      )}

      {[...groups.entries()].map(([projectName, list]) => (
        <div key={projectName} className="wt-group">
          <div className="wt-group-title">{projectName}</div>
          {list.map((e) => {
            const running = e.latestRunStatus === 'running' || e.latestRunStatus === 'queued'
            const busy = busyPath === e.worktreePath
            return (
              <div key={e.worktreePath} className={`wt-row${e.orphan ? ' wt-orphan' : ''}`}>
                <div className="wt-row-top">
                  <span className="wt-path mono" title={e.worktreePath}>
                    {dirName(e.worktreePath)}
                  </span>
                  {e.dirty && (
                    <span className="wt-dot" title="Uncommitted changes">
                      ●
                    </span>
                  )}
                </div>
                {e.branch && (
                  <div className="wt-branch mono" title={e.branch}>
                    ⎇ {e.branch}
                  </div>
                )}
                <div className="wt-meta">
                  {e.taskTitle && (
                    <span className="wt-task" title={e.taskTitle}>
                      {e.taskTitle}
                    </span>
                  )}
                  {e.taskStatus && (
                    <span className={`panel-status-chip status-${e.taskStatus}`}>
                      {TASK_STATUS_LABEL[e.taskStatus]}
                    </span>
                  )}
                  {running && <span className="wt-chip wt-running">running</span>}
                  {e.orphan && <span className="wt-chip wt-dirty">ghost</span>}
                </div>
                <div className="wt-row-actions">
                  {!e.orphan && e.latestRunId && (
                    <button
                      className="wt-action"
                      disabled={busy}
                      onClick={() =>
                        void act(e.worktreePath, 'Open terminal failed', async () => {
                          const info = await window.orchebary.worktree.openInTerminal(
                            e.latestRunId!,
                            80,
                            24
                          )
                          useUiStore.getState().requestOpenSession(info)
                        })
                      }
                    >
                      ↗ terminal
                    </button>
                  )}
                  {!e.orphan && e.latestRunId && !running && (
                    <button
                      className="wt-action wt-action-danger"
                      disabled={busy}
                      onClick={() => {
                        if (
                          !window.confirm(
                            `Remove this worktree and its branch?\n${e.worktreePath}${e.dirty ? '\n\n⚠ It has uncommitted changes.' : ''}`
                          )
                        )
                          return
                        void act(e.worktreePath, 'Remove failed', async () => {
                          await window.orchebary.worktree.remove(e.latestRunId!, true)
                          showToast('Worktree removed', 'info')
                        })
                      }}
                    >
                      remove
                    </button>
                  )}
                  {e.orphan && (
                    <button
                      className="wt-action wt-action-danger"
                      disabled={busy}
                      onClick={() => {
                        if (!window.confirm(`Delete this ghost directory?\n${e.worktreePath}`))
                          return
                        void act(e.worktreePath, 'Prune failed', async () => {
                          await window.orchebary.worktree.pruneGhost(e.worktreePath)
                          showToast('Ghost worktree pruned', 'info')
                        })
                      }}
                    >
                      prune
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      ))}
    </div>
  )
}
