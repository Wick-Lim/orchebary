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
 * Compact worktree list (embedded under the git tree): every worktree the
 * app owns — branch, owning task, dirty state — with open/remove/prune.
 */
export function WorktreeList(): React.JSX.Element {
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
    <div className="wt-list">
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
              <div
                key={e.worktreePath}
                className={`wt-row${e.orphan ? ' wt-orphan' : ''}`}
                role="button"
                tabIndex={0}
                onClick={() => {
                  if (e.orphan || !e.latestRunId || busy) return
                  void act(e.worktreePath, 'Open terminal failed', async () => {
                    const info = await window.orchebary.worktree.openInTerminal(
                      e.latestRunId!,
                      80,
                      24
                    )
                    useUiStore.getState().requestOpenSession(info)
                  })
                }}
                onContextMenu={(ev) => {
                  ev.preventDefault()
                  if (busy) return
                  const items = e.orphan
                    ? [{ id: 'prune', label: 'Delete ghost directory…' }]
                    : [
                        { id: 'open', label: 'Open terminal' },
                        { type: 'separator' as const },
                        {
                          id: 'remove',
                          label: 'Remove worktree + branch…',
                          enabled: !running
                        }
                      ]
                  void window.orchebary.ui.contextMenu(items).then((res) => {
                    if (res.id === 'open' && e.latestRunId) {
                      void act(e.worktreePath, 'Open terminal failed', async () => {
                        const info = await window.orchebary.worktree.openInTerminal(
                          e.latestRunId!,
                          80,
                          24
                        )
                        useUiStore.getState().requestOpenSession(info)
                      })
                    } else if (res.id === 'remove' && e.latestRunId) {
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
                    } else if (res.id === 'prune') {
                      if (!window.confirm(`Delete this ghost directory?\n${e.worktreePath}`)) return
                      void act(e.worktreePath, 'Prune failed', async () => {
                        await window.orchebary.worktree.pruneGhost(e.worktreePath)
                        showToast('Ghost worktree pruned', 'info')
                      })
                    }
                  })
                }}
              >
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
              </div>
            )
          })}
        </div>
      ))}
    </div>
  )
}
