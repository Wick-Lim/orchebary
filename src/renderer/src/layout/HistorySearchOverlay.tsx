import { useEffect, useRef, useState } from 'react'
import type { HistoryEntry } from '../../../shared/domain'
import { useLayoutStore } from '../state/layoutStore'

/**
 * ctrl-R overlay: fuzzy-ish (substring, main-side) search over persisted
 * command history. Enter pastes the command without a newline so the user
 * reviews it; meta+Enter appends '\r' to execute immediately.
 */
export function HistorySearchOverlay({ sessionId }: { sessionId: string }): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<HistoryEntry[]>([])
  const [selected, setSelected] = useState(0)
  const listRef = useRef<HTMLUListElement>(null)

  useEffect(() => {
    let alive = true
    const timer = setTimeout(
      () => {
        void window.orchebary.history.search({ query, limit: 50 }).then((entries) => {
          if (!alive) return
          setResults(entries)
          setSelected(0)
        })
      },
      query ? 120 : 0
    )
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [query])

  useEffect(() => {
    listRef.current?.querySelector('[data-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [selected, results])

  const close = (): void => useLayoutStore.getState().setHistoryOpen(false)

  const accept = (entry: HistoryEntry | undefined, execute: boolean): void => {
    if (!entry) return
    window.orchebary.terminal.input(sessionId, execute ? `${entry.command}\r` : entry.command)
    close()
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) {
      e.preventDefault()
      setSelected((s) => Math.min(s + 1, Math.max(results.length - 1, 0)))
    } else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) {
      e.preventDefault()
      setSelected((s) => Math.max(s - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      accept(results[selected], e.metaKey)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      close()
    }
  }

  return (
    <div className="history-overlay" onKeyDown={onKeyDown}>
      <div className="history-input-row">
        <span className="history-glyph">⌃R</span>
        <input
          autoFocus
          value={query}
          spellCheck={false}
          placeholder="Search command history…"
          onChange={(e) => setQuery(e.target.value)}
          onBlur={close}
        />
        <span className="history-hint">↵ paste · ⌘↵ run · esc</span>
      </div>
      <ul className="history-results" ref={listRef}>
        {results.map((entry, i) => (
          <li
            key={entry.id}
            data-selected={i === selected}
            className={i === selected ? 'is-selected' : ''}
            // mousedown (not click): the input's blur would close us first
            onMouseDown={(e) => {
              e.preventDefault()
              accept(entry, e.metaKey)
            }}
            onMouseEnter={() => setSelected(i)}
          >
            <span
              className={
                entry.exitCode === undefined
                  ? 'history-exit'
                  : entry.exitCode === 0
                    ? 'history-exit ok'
                    : 'history-exit err'
              }
            >
              {entry.exitCode ?? '·'}
            </span>
            <span className="history-command">{entry.command}</span>
            <span className="history-cwd">{entry.cwd}</span>
          </li>
        ))}
        {results.length === 0 && <li className="history-empty">No matching commands</li>}
      </ul>
    </div>
  )
}
