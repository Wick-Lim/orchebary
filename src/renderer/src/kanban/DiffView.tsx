import { useEffect, useState } from 'react'
import type { FileDiff } from '../../../shared/domain'

const MAX_PATCH_LINES = 2000

function lineClass(line: string): string {
  if (line.startsWith('+++') || line.startsWith('---')) return 'diff-line diff-line-meta'
  if (line.startsWith('@@')) return 'diff-line diff-line-hunk'
  if (line.startsWith('+')) return 'diff-line diff-line-add'
  if (line.startsWith('-')) return 'diff-line diff-line-del'
  return 'diff-line'
}

function Patch({ patch }: { patch: string }): React.JSX.Element {
  const lines = patch.split('\n')
  const shown = lines.slice(0, MAX_PATCH_LINES)
  return (
    <pre className="diff-patch">
      {shown.map((line, i) => (
        <div key={i} className={lineClass(line)}>
          {line || ' '}
        </div>
      ))}
      {lines.length > shown.length && (
        <div className="diff-line diff-line-meta">… {lines.length - shown.length} more lines</div>
      )}
    </pre>
  )
}

export function DiffView({ runId }: { runId: string }): React.JSX.Element {
  const [files, setFiles] = useState<FileDiff[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  // Mounted with key={run.id} by the panel, so state starts fresh per run.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await window.orchebary.git.diff(runId)
        if (cancelled) return
        setFiles(res.files)
        setExpanded(new Set(res.files.slice(0, 1).map((f) => f.path)))
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [runId])

  function toggle(path: string): void {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  if (error) return <div className="panel-note">Diff unavailable: {error}</div>
  if (!files) return <div className="panel-note">Loading diff…</div>
  if (files.length === 0) return <div className="panel-note">No changes</div>

  return (
    <div className="diff-view">
      {files.map((f) => {
        const open = expanded.has(f.path)
        return (
          <div key={f.path} className="diff-file">
            <button className="diff-file-header" onClick={() => toggle(f.path)}>
              <span className="diff-file-caret">{open ? '▾' : '▸'}</span>
              <span className="diff-file-path" title={f.path}>
                {f.oldPath && f.oldPath !== f.path ? `${f.oldPath} → ${f.path}` : f.path}
              </span>
              <span className="diff-file-stat">
                <span className="diff-add">+{f.additions}</span>
                <span className="diff-del">-{f.deletions}</span>
              </span>
            </button>
            {open && <Patch patch={f.patch} />}
          </div>
        )
      })}
    </div>
  )
}
