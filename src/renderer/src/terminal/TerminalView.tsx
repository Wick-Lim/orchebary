import { useEffect, useRef } from 'react'
import { terminalRegistry } from './TerminalRegistry'
import { StickyBlockHeader } from './StickyBlockHeader'
import { BlockPortals } from './BlockPortals'
import { BlockInspector } from './BlockInspector'
import { PerfHud } from './PerfHud'
import '../assets/blocks.css'

/**
 * Mount point for a registry-owned xterm instance. The terminal DOM is
 * reparented in (never recreated), so scrollback survives pane moves,
 * tab switches, and React remounts. Block chrome (sticky header, header
 * portals, inspector) renders around it; sessions without shell integration
 * (e.g. kind 'agent') get a clean plain terminal — all chrome renders null.
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

  return (
    <div className="terminal-view orb-terminal-wrap">
      <div ref={hostRef} className="orb-terminal-mount" />
      <StickyBlockHeader sessionId={sessionId} />
      <BlockPortals sessionId={sessionId} />
      <BlockInspector sessionId={sessionId} />
      <PerfHud />
    </div>
  )
}
