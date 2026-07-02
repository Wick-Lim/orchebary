import { useCallback, useEffect, useRef, useState } from 'react'
import '../assets/worktrees.css'
import { showError, showToast } from '../kanban/toastStore'
import { useBoardStore } from '../state/boardStore'
import { WorktreeList } from './WorktreesPage'

interface BranchInfo {
  name: string
  head: string
  current: boolean
  subject: string
}

function GraphLine({
  line,
  onPick
}: {
  line: string
  onPick: (hash: string) => void
}): React.JSX.Element {
  // `* abc1234 (HEAD -> orc/x, main) message` — highlight hash + refs.
  const hashMatch = line.match(/\b[0-9a-f]{7,10}\b/)
  if (!hashMatch || hashMatch.index === undefined) {
    return <div className="git-line git-line-art">{line || ' '}</div>
  }
  const art = line.slice(0, hashMatch.index)
  let rest = line.slice(hashMatch.index + hashMatch[0].length)
  let refs = ''
  const refMatch = rest.match(/^\s*\(([^)]*)\)/)
  if (refMatch) {
    refs = refMatch[1]
    rest = rest.slice(refMatch[0].length)
  }
  const hash = hashMatch[0]
  const menu = async (e: React.MouseEvent): Promise<void> => {
    e.preventDefault()
    const res = await window.orchebary.ui.contextMenu([
      { id: 'details', label: 'Show details' },
      { id: 'copy', label: 'Copy hash' }
    ])
    if (res.id === 'details') onPick(hash)
    if (res.id === 'copy') void navigator.clipboard.writeText(hash)
  }
  return (
    <div
      className="git-line git-line-commit"
      onClick={() => onPick(hash)}
      onContextMenu={(e) => void menu(e)}
    >
      <span className="git-art">{art}</span>
      <span className="git-hash">{hash}</span>
      {refs && <span className="git-refs"> ({refs})</span>}
      <span className="git-msg">{rest}</span>
    </div>
  )
}

/**
 * Persistent right sidebar: the active project's commit graph and branches
 * (merge / rebase / delete), with worktree cleanup tucked underneath. Commits
 * expand into `git show --stat` details.
 */
export function GitPanel(): React.JSX.Element {
  const projects = useBoardStore((s) => s.projects)
  const activeProjectId = useBoardStore((s) => s.activeProjectId)
  const projectId = activeProjectId ?? projects[0]?.id
  const project = projects.find((p) => p.id === projectId)

  const [graph, setGraph] = useState('')
  const [branches, setBranches] = useState<BranchInfo[]>([])
  const [detail, setDetail] = useState<{ ref: string; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const refresh = useCallback(() => {
    if (!projectId) return
    window.orchebary.git
      .logGraph(projectId)
      .then((r) => setGraph(r.text))
      .catch(() => undefined)
    window.orchebary.git
      .branches(projectId)
      .then(setBranches)
      .catch(() => undefined)
  }, [projectId])

  useEffect(() => {
    setDetail(null)
    refresh()
    const unsubscribe = window.orchebary.onAppEvent((e) => {
      if (e.type === 'run.status' || e.type === 'run.diffstat' || e.type === 'task.updated') {
        if (timer.current) clearTimeout(timer.current)
        timer.current = setTimeout(refresh, 400)
      }
    })
    return () => {
      unsubscribe()
      if (timer.current) clearTimeout(timer.current)
    }
  }, [refresh])

  const pickCommit = (hash: string): void => {
    if (!projectId) return
    if (detail?.ref === hash) {
      setDetail(null)
      return
    }
    window.orchebary.git
      .show(projectId, hash)
      .then((r) => setDetail({ ref: hash, text: r.text }))
      .catch((err) => showError(err, 'Show commit failed'))
  }

  const branchAction = (branch: string, action: 'merge' | 'rebase' | 'delete'): void => {
    if (!projectId || !project) return
    const confirmText =
      action === 'merge'
        ? `Squash-merge ${branch} into ${project.baseBranch}?`
        : action === 'rebase'
          ? `Rebase ${branch} onto ${project.baseBranch}?`
          : `Delete branch ${branch}?`
    if (!window.confirm(confirmText)) return
    setBusy(true)
    window.orchebary.git
      .branchAction(projectId, branch, action)
      .then((res) => {
        if (res.ok) showToast(`${action} done: ${branch}`, 'info')
        else showToast(res.detail ?? `${action} failed`)
        refresh()
      })
      .catch((err) => showError(err, `${action} failed`))
      .finally(() => setBusy(false))
  }

  return (
    <div className="wt-panel">
      <div className="wt-panel-header">
        Git{project ? ` — ${project.name}` : ''}
        <button className="wt-refresh" title="Refresh" onClick={refresh}>
          ↻
        </button>
      </div>

      <div className="git-graph">
        {graph
          ? graph.split('\n').map((line, i) => <GraphLine key={i} line={line} onPick={pickCommit} />)
          : projectId && <div className="rail-empty">No commits yet.</div>}
        {!projectId && <div className="rail-empty">Add a project to see its git tree.</div>}
      </div>

      {detail && (
        <div className="git-detail">
          <div className="git-detail-head">
            <span className="git-hash mono">{detail.ref}</span>
            <button className="wt-refresh" title="Close" onClick={() => setDetail(null)}>
              ×
            </button>
          </div>
          <pre className="git-detail-body">{detail.text}</pre>
        </div>
      )}

      <div className="git-branches">
        <div className="wt-group-title">Branches</div>
        {branches.map((b) => (
          <div
            key={b.name}
            className={`git-branch${b.current ? ' is-current' : ''}`}
            title={`${b.subject}\n(우클릭: merge / rebase / delete)`}
            onContextMenu={(e) => {
              e.preventDefault()
              if (!project || b.name === project.baseBranch || busy) return
              void window.orchebary.ui
                .contextMenu([
                  { id: 'merge', label: `Merge into ${project.baseBranch} (squash)` },
                  { id: 'rebase', label: `Rebase onto ${project.baseBranch}` },
                  { type: 'separator' },
                  { id: 'delete', label: 'Delete branch', enabled: !b.current }
                ])
                .then((res) => {
                  if (res.id === 'merge' || res.id === 'rebase' || res.id === 'delete') {
                    branchAction(b.name, res.id)
                  }
                })
            }}
          >
            <div className="git-branch-top">
              <span className="git-branch-name mono">
                {b.current ? '● ' : ''}
                {b.name}
              </span>
              <span className="git-hash mono">{b.head}</span>
            </div>
          </div>
        ))}
      </div>

      <details className="wt-section">
        <summary>Worktrees</summary>
        <WorktreeList />
      </details>
    </div>
  )
}
