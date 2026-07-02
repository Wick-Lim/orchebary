import { useEffect, useState } from 'react'
import type { TerminalSessionInfo } from '../../shared/domain'
import { terminalRegistry } from './terminal/TerminalRegistry'
import { TerminalView } from './terminal/TerminalView'

// Module-level so double-mounted effects (HMR, StrictMode) can never spawn
// two shells racing each other.
let bootPromise: Promise<TerminalSessionInfo> | null = null

function bootFirstShell(): Promise<TerminalSessionInfo> {
  bootPromise ??= (async () => {
    // Rebind to a live session after a renderer reload; otherwise spawn one.
    const existing = await window.orchebary.terminal.list()
    return (
      existing.find((s) => s.kind === 'shell') ??
      (await window.orchebary.terminal.create({ cols: 80, rows: 24 }))
    )
  })()
  return bootPromise
}

export default function App(): React.JSX.Element {
  const [sessionId, setSessionId] = useState<string | null>(null)

  useEffect(() => {
    terminalRegistry.bindIpc()
    let cancelled = false
    void bootFirstShell().then((shell) => {
      if (cancelled) return
      terminalRegistry.ensure(shell)
      setSessionId(shell.sessionId)
    })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div className="app-shell">
      <div className="titlebar-drag" />
      <div className="workspace">{sessionId && <TerminalView sessionId={sessionId} />}</div>
    </div>
  )
}
