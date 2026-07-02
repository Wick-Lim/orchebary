import { useEffect, useState } from 'react'
import { terminalRegistry, type PerfSample } from './TerminalRegistry'

// Only the first mounted TerminalView hosts the HUD (it is a fixed overlay).
let hudClaimed = false

/**
 * Dev aid: enable with `localStorage.setItem('orb.hud', '1')`. Shows per
 * attached session writes/sec and KB/s, counted in TerminalRegistry's onData
 * write path and sampled once a second.
 */
export function PerfHud(): React.JSX.Element | null {
  // null = not the HUD owner / disabled — renders nothing.
  const [samples, setSamples] = useState<PerfSample[] | null>(null)

  useEffect(() => {
    if (hudClaimed || localStorage.getItem('orb.hud') !== '1') return undefined
    hudClaimed = true
    const tick = (): void => setSamples(terminalRegistry.samplePerf())
    const raf = requestAnimationFrame(tick)
    const timer = setInterval(tick, 1000)
    return () => {
      cancelAnimationFrame(raf)
      clearInterval(timer)
      hudClaimed = false
    }
  }, [])

  if (samples === null) return null
  return (
    <div className="orb-perf-hud">
      {samples.length === 0 ? (
        <div className="orb-perf-row">no sessions</div>
      ) : (
        samples.map((s) => (
          <div key={s.sessionId} className="orb-perf-row">
            <span className="orb-perf-id">{s.sessionId.slice(0, 6)}</span>
            <span>{s.writes} w/s</span>
            <span>{(s.bytes / 1024).toFixed(1)} KB/s</span>
          </div>
        ))
      )}
    </div>
  )
}
