import { useCallback, useEffect, useState } from 'react'
import type { WorktreeEntry } from '../../../shared/domain'
import { TASK_STATUS_LABEL } from '../../../shared/domain'
import '../assets/worktrees.css'
import { showError, showToast } from '../kanban/toastStore'
import { Toasts } from '../kanban/Toasts'
import { useUiStore } from '../state/uiStore'

function shortPath(p: string): string {
  const parts = p.split('/')
  return parts.slice(-2).join('/')
}

/**
 * Management view for every git worktree the app owns: what task/branch it
 * belongs to, whether it still has uncommitted changes, plus cleanup for
 * ghost directories left behind by crashes.
 */
export function WorktreesPage(): React.JSX.Element {
  const [entries, setEntries] = useState<WorktreeEntry[] | null>(null)
  const [busyPath, setBusyPath] = useState<string | null>(null)

  const refresh = useCallback(() => {
    window.orchebary.worktree
      .listAll()
      .then(setEntries)
      .catch((err) => {
        setEntries([])
        showError(err, 'Load worktrees failed')
      })
  }, [])

  useEffect(() => {
    refresh()
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
  for (const e of entries ?? []) {
    const key = e.projectName ?? e.projectId ?? 'unknown project'
    const list = groups.get(key)
    if (list) list.push(e)
    else groups.set(key, [e])
  }

  return (
    <div className="wt-root">
      <div className="wt-header">
        <span className="wt-title">Worktrees</span>
        <span className="wt-hint">
          One isolated checkout per task under ~/.orchebary/worktrees — merged or discarded work can
          be cleaned up here.
        </span>
        <button className="btn" onClick={refresh}>
          Refresh
        </button>
      </div>

      {entries !== null && entries.length === 0 && (
        <div className="wt-empty">No worktrees yet — they appear when agents start working.</div>
      )}

      {[...groups.entries()].map(([projectName, list]) => (
        <div key={projectName} className="wt-group">
          <div className="wt-group-title">{projectName}</div>
          {list.map((e) => {
            const running = e.latestRunStatus === 'running' || e.latestRunStatus === 'queued'
            const busy = busyPath === e.worktreePath
            return (
              <div key={e.worktreePath} className={`wt-row${e.orphan ? ' wt-orphan' : ''}`}>
                <div className="wt-row-main">
                  <span className="wt-path mono" title={e.worktreePath}>
                    {shortPath(e.worktreePath)}
                  </span>
                  {e.branch && <span className="wt-chip mono">{e.branch}</span>}
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
                  {e.dirty && <span className="wt-chip wt-dirty">uncommitted changes</span>}
                  {e.orphan && <span className="wt-chip wt-dirty">ghost — no task knows this</span>}
                  {running && <span className="wt-chip wt-running">agent running</span>}
                </div>
                <div className="wt-row-actions">
                  {!e.orphan && e.latestRunId && (
                    <button
                      className="btn"
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
                      Open terminal
                    </button>
                  )}
                  {!e.orphan && e.latestRunId && !running && (
                    <button
                      className="btn btn-danger"
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
                      Remove
                    </button>
                  )}
                  {e.orphan && (
                    <button
                      className="btn btn-danger"
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
                      Prune
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      ))}
      <Toasts />
    </div>
  )
}
