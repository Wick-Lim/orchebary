import { useEffect, useRef, useState } from 'react'
import type { AgentEvent, TaskRun } from '../../../shared/domain'

const MAX_EVENTS = 500

function firstLine(t: string): string {
  const line = t.split('\n', 1)[0]
  return line.length > 200 ? `${line.slice(0, 200)}…` : line
}

function LogEvent({ ev }: { ev: AgentEvent }): React.JSX.Element | null {
  switch (ev.kind) {
    case 'assistant-text':
      return ev.text ? <div className="log-prose">{ev.text}</div> : null
    case 'tool-use':
      return (
        <div className="log-tool">
          ▸ {ev.toolName ?? 'tool'}
          {ev.text ? ` ${firstLine(ev.text)}` : ''}
        </div>
      )
    case 'tool-result':
      return ev.text ? <div className="log-tool log-tool-result">{firstLine(ev.text)}</div> : null
    case 'result': {
      const r = ev.result
      const ok = r?.ok ?? true
      return (
        <div className={`log-result ${ok ? 'log-result-ok' : 'log-result-err'}`}>
          <div className="log-result-head">{ok ? 'Completed' : 'Failed'}</div>
          {r?.summary && <div className="log-result-summary">{r.summary}</div>}
          {(r?.costUsd !== undefined || r?.numTurns !== undefined) && (
            <div className="log-result-meta">
              {r?.costUsd !== undefined && <span>${r.costUsd.toFixed(2)}</span>}
              {r?.numTurns !== undefined && <span>{r.numTurns} turns</span>}
            </div>
          )}
        </div>
      )
    }
    case 'system':
    case 'raw':
      return ev.text ? <div className="log-system">{firstLine(ev.text)}</div> : null
    default:
      return null
  }
}

export function RunLogView({ run }: { run: TaskRun }): React.JSX.Element {
  const [events, setEvents] = useState<AgentEvent[]>([])
  const [error, setError] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  // Sticky auto-scroll: follow the tail unless the user scrolled up.
  const stickRef = useRef(true)

  // Mounted with key={run.id} by the panel, so state starts fresh per run.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await window.orchebary.runs.readLog(run.id)
        if (!cancelled) setEvents(res.events.slice(-MAX_EVENTS))
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      }
    })()
    const dispose = window.orchebary.onAppEvent((e) => {
      if (e.type === 'run.output' && e.runId === run.id) {
        setEvents((prev) => [...prev, ...e.events].slice(-MAX_EVENTS))
      }
    })
    return () => {
      cancelled = true
      dispose()
    }
  }, [run.id])

  useEffect(() => {
    const el = scrollRef.current
    if (el && stickRef.current) el.scrollTop = el.scrollHeight
  }, [events])

  return (
    <div
      ref={scrollRef}
      className="run-log"
      onScroll={() => {
        const el = scrollRef.current
        if (el) stickRef.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 40
      }}
    >
      {error && <div className="panel-note">Log unavailable: {error}</div>}
      {!error && events.length === 0 && (
        <div className="panel-note">
          Interactive session — the conversation lives in its terminal tab. Check the Diff tab for
          the resulting changes.
        </div>
      )}
      {events.map((ev, i) => (
        <LogEvent key={i} ev={ev} />
      ))}
    </div>
  )
}
