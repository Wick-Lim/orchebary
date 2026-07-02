import { useEffect, useRef } from 'react'
import { terminalRegistry } from './TerminalRegistry'

/**
 * Mount point for a registry-owned xterm instance. The terminal DOM is
 * reparented in (never recreated), so scrollback survives pane moves,
 * tab switches, and React remounts.
 */
export function TerminalView({
  sessionId,
  autoFocus = true
}: {
  sessionId: string
  autoFocus?: boolean
}): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    terminalRegistry.attach(sessionId, host)
    if (autoFocus) terminalRegistry.focus(sessionId)

    let raf = 0
    const ro = new ResizeObserver(() => {
      // Coalesce resize storms to one fit per frame.
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => terminalRegistry.fitAndResize(sessionId))
    })
    ro.observe(host)

    return () => {
      ro.disconnect()
      cancelAnimationFrame(raf)
      terminalRegistry.detach(sessionId)
    }
  }, [sessionId, autoFocus])

  return <div ref={hostRef} className="terminal-view" />
}
