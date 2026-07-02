import { generateKeyBetween } from 'fractional-indexing'
import { useEffect, useState } from 'react'
import type { TaskRun } from '../../../shared/domain'
import { TASK_STATUS_LABEL } from '../../../shared/domain'
import { useBoardStore, type BoardTask } from '../state/boardStore'
import { useUiStore } from '../state/uiStore'
import { DiffView } from './DiffView'
import { RunLogView } from './RunLogView'
import { RUN_DOT_CLASS } from './runDot'
import { showError, showToast } from './toastStore'

function fmtTime(iso?: string): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

function fmtDuration(start?: string, end?: string): string {
  if (!start) return ''
  const ms = (end ? Date.parse(end) : Date.now()) - Date.parse(start)
  if (!Number.isFinite(ms) || ms < 0) return ''
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`
}

export function TaskDetailPanel({ task }: { task: BoardTask }): React.JSX.Element {
  const [title, setTitle] = useState(task.title)
  const [description, setDescription] = useState(task.description)
  const [editingDesc, setEditingDesc] = useState(false)
  const [followUp, setFollowUp] = useState('')
  const [runs, setRuns] = useState<TaskRun[]>([])
  const [runsError, setRunsError] = useState<string | null>(null)
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [tab, setTab] = useState<'log' | 'diff'>('log')
  const [busy, setBusy] = useState(false)

  // The panel is mounted with key={task.id}, so switching tasks remounts it
  // and the local editor state above re-initializes from the fresh task.

  const close = (): void => useBoardStore.getState().selectTask(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') useBoardStore.getState().selectTask(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Reload run history when the task or its latest run's lifecycle changes.
  const latestRunKey = `${task.latestRun?.id ?? ''}:${task.latestRun?.status ?? ''}`
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const list = await window.orchebary.runs.listForTask(task.id)
        if (cancelled) return
        setRuns(list)
        setRunsError(null)
        setSelectedRunId((cur) =>
          cur && list.some((r) => r.id === cur) ? cur : (list[0]?.id ?? null)
        )
      } catch (err) {
        if (!cancelled) setRunsError(err instanceof Error ? err.message : String(err))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [task.id, latestRunKey])

  async function act(label: string, fn: () => Promise<void>): Promise<void> {
    setBusy(true)
    try {
      await fn()
    } catch (err) {
      showError(err, label)
    } finally {
      setBusy(false)
    }
  }

  function saveTitle(): void {
    const next = title.trim()
    if (!next || next === task.title) {
      setTitle(task.title)
      return
    }
    void act('Save title failed', async () => {
      const updated = await window.orchebary.tasks.update(task.id, { title: next })
      useBoardStore.getState().applyEvent({ type: 'task.updated', task: updated })
    })
  }

  function saveDescription(): void {
    if (description === task.description) return
    void act('Save description failed', async () => {
      const updated = await window.orchebary.tasks.update(task.id, { description })
      useBoardStore.getState().applyEvent({ type: 'task.updated', task: updated })
    })
  }

  const run = task.latestRun
  const running = run?.status === 'running' || run?.status === 'queued'
  const selectedRun = runs.find((r) => r.id === selectedRunId)

  function jumpToTerminal(): void {
    void act('Open terminal failed', async () => {
      // 1:1 — jump to the task's terminal, recreating it in the worktree if
      // it is gone (e.g. after an app restart).
      const list = await window.orchebary.terminal.list()
      const live =
        list.find((x) => x.kind === 'agent' && x.taskId === task.id) ??
        list.find((x) => x.taskId === task.id)
      if (live) {
        useUiStore.getState().requestOpenSession(live)
        return
      }
      if (!run) {
        showToast('터미널 세션을 찾을 수 없습니다')
        return
      }
      const info = await window.orchebary.worktree.openInTerminal(run.id, 80, 24)
      useUiStore.getState().requestOpenSession(info)
    })
  }

  return (
    <div className="task-panel">
      <div className="task-panel-head">
        <input
          className="panel-title-input"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={saveTitle}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          }}
        />
        <button className="btn btn-icon" title="Close (Esc)" onClick={close}>
          ✕
        </button>
      </div>

      <div className="task-panel-body">
        <div className="panel-meta">
          <div className="panel-meta-row">
            <span className="panel-meta-label">Status</span>
            <span className={`panel-status-chip status-${task.status}`}>
              {TASK_STATUS_LABEL[task.status]}
            </span>
          </div>
          {run && (
            <div className="panel-meta-row">
              <span className="panel-meta-label">Agent</span>
              <span className="panel-meta-value">
                <span className={`dot ${RUN_DOT_CLASS[run.status]}`} /> {run.agentKind}
              </span>
            </div>
          )}
          {run?.branch && (
            <div className="panel-meta-row">
              <span className="panel-meta-label">Branch</span>
              <span className="panel-meta-value mono">{run.branch}</span>
            </div>
          )}
          <div className="panel-meta-row">
            <span className="panel-meta-label">Created</span>
            <span className="panel-meta-value">{fmtTime(task.createdAt)}</span>
          </div>
          <div className="panel-meta-row">
            <span className="panel-meta-label">Updated</span>
            <span className="panel-meta-value">{fmtTime(task.updatedAt)}</span>
          </div>
        </div>

        <div className="panel-section">
          <div className="panel-section-title">Description</div>
          {editingDesc ? (
            <textarea
              className="panel-desc"
              autoFocus
              placeholder="Add a description…"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              onBlur={() => {
                saveDescription()
                setEditingDesc(false)
              }}
            />
          ) : (
            <div
              className={`panel-desc-view${description.trim() ? '' : ' is-empty'}`}
              onClick={() => setEditingDesc(true)}
            >
              {description.trim() || 'Add a description…'}
            </div>
          )}
        </div>

        <div className="panel-actions">
          {!run && (
            <span className="panel-note">Drag this card into In Progress to start the agent.</span>
          )}
          {run && (
            <button className="btn btn-primary" disabled={busy} onClick={jumpToTerminal}>
              Open terminal
            </button>
          )}
          {running && run && (
            <button
              className="btn btn-danger"
              disabled={busy}
              onClick={() =>
                void act('Cancel failed', async () => {
                  await window.orchebary.runs.cancel(run.id)
                })
              }
            >
              Cancel
            </button>
          )}
          {task.status === 'inreview' && run && (
            <button
              className="btn"
              disabled={busy}
              onClick={() =>
                void act('Merge failed', async () => {
                  const res = await window.orchebary.git.merge(run.id)
                  if (res.ok) showToast('Merged to base branch', 'info')
                  else showToast(res.detail)
                })
              }
            >
              Merge to main
            </button>
          )}
          {run && !running && (
            <button
              className="btn btn-danger"
              disabled={busy}
              onClick={() => {
                if (!window.confirm('Discard the worktree (and branch) and cancel this task?'))
                  return
                void act('Discard failed', async () => {
                  await window.orchebary.worktree.remove(run.id, true)
                  const res = await useBoardStore
                    .getState()
                    .moveTask(task.id, 'cancelled', generateKeyBetween(null, null))
                  if (!res.ok) showToast(res.reason)
                })
              }}
            >
              Discard
            </button>
          )}
          {!running && (
            <button
              className="btn btn-danger"
              disabled={busy}
              onClick={() => {
                if (!window.confirm('Delete this task?')) return
                void act('Delete failed', async () => {
                  await window.orchebary.tasks.delete(task.id)
                  useBoardStore.getState().applyEvent({ type: 'task.deleted', taskId: task.id })
                })
              }}
            >
              Delete task
            </button>
          )}
        </div>

        {task.status === 'inreview' && (
          <div className="panel-section">
            <div className="panel-section-title">Follow-up</div>
            <textarea
              className="panel-followup"
              placeholder="Follow-up instructions for the agent…"
              value={followUp}
              onChange={(e) => setFollowUp(e.target.value)}
            />
            <button
              className="btn btn-primary"
              disabled={busy || !followUp.trim()}
              onClick={() =>
                void act('Follow-up failed', async () => {
                  await window.orchebary.runs.followUp(task.id, followUp.trim())
                  setFollowUp('')
                })
              }
            >
              Send follow-up
            </button>
          </div>
        )}

        <div className="panel-section">
          <div className="panel-section-title">Activity</div>
          {runsError && <div className="panel-note">Run history unavailable: {runsError}</div>}
          {!runsError && runs.length === 0 && <div className="panel-note">No runs yet</div>}
          {runs.map((r) => (
            <button
              key={r.id}
              className={`run-row${r.id === selectedRunId ? ' run-row-active' : ''}`}
              onClick={() => setSelectedRunId(r.id)}
            >
              <span className={`dot ${RUN_DOT_CLASS[r.status]}`} />
              <span className="run-row-agent">{r.agentKind}</span>
              <span className={`run-row-status run-${r.status}`}>{r.status}</span>
              <span className="run-row-time">{fmtTime(r.startedAt ?? r.createdAt)}</span>
              <span className="run-row-duration">{fmtDuration(r.startedAt, r.finishedAt)}</span>
              {r.summary && <span className="run-row-summary">{r.summary}</span>}
              {(r.status === 'running' || r.status === 'queued') && (
                <span
                  className="run-row-jump"
                  title="Go to terminal"
                  onClick={(e) => {
                    e.stopPropagation()
                    jumpToTerminal()
                  }}
                >
                  ↗
                </span>
              )}
            </button>
          ))}
        </div>

        {selectedRun && (
          <div className="panel-section panel-run-detail">
            <div className="panel-tabs">
              <button
                className={`tab${tab === 'log' ? ' tab-active' : ''}`}
                onClick={() => setTab('log')}
              >
                Log
              </button>
              <button
                className={`tab${tab === 'diff' ? ' tab-active' : ''}`}
                onClick={() => setTab('diff')}
              >
                Diff
              </button>
            </div>
            {tab === 'log' ? (
              <RunLogView key={selectedRun.id} run={selectedRun} />
            ) : (
              <DiffView key={selectedRun.id} runId={selectedRun.id} />
            )}
          </div>
        )}
      </div>
    </div>
  )
}
