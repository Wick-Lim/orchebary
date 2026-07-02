import { useEffect, useState } from 'react'
import { useStore } from 'zustand'
import type { Terminal } from '@xterm/xterm'
import { terminalRegistry } from './TerminalRegistry'
import { getBlockStore, type CommandBlock } from './blockStore'
import { BlockHeaderChrome } from './BlockHeaderChrome'

/** Live prompt row; trimmed markers read as -1 which sorts before everything. */
function liveLine(b: CommandBlock): number {
  const m = b.promptMarker
  return m && !m.isDisposed ? m.line : -1
}

/**
 * Binary search (blocks are chronological, marker lines non-decreasing) for
 * the block covering the viewport's top row. Returns null when the covering
 * block's own header row is visible (the inline chrome already shows it).
 */
function findCoveringBlockId(term: Terminal, blocks: CommandBlock[]): string | null {
  if (blocks.length === 0) return null
  const top = term.buffer.active.viewportY
  let lo = 0
  let hi = blocks.length - 1
  let found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (liveLine(blocks[mid]) <= top) {
      found = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  if (found === -1) return null
  const block = blocks[found]
  if (block.state === 'prompt') return null
  if (liveLine(block) === top) return null
  const end = block.endMarker && !block.endMarker.isDisposed ? block.endMarker.line : Infinity
  if (end <= top) return null // block ended above the viewport
  return block.id
}

/**
 * Pinned strip at the top of the terminal showing the block that covers the
 * current viewport top. Recomputed on scroll (rAF-throttled) and on block
 * changes; hidden on the alt screen and when no shell integration is active.
 */
export function StickyBlockHeader({ sessionId }: { sessionId: string }): React.JSX.Element | null {
  const store = getBlockStore(sessionId)
  const integrationActive = useStore(store, (s) => s.integrationActive)
  const altScreen = useStore(store, (s) => s.altScreen)
  const blocks = useStore(store, (s) => s.blocks)
  const [topBlockId, setTopBlockId] = useState<string | null>(null)

  useEffect(() => {
    if (!integrationActive) return undefined
    const bundle = terminalRegistry.get(sessionId)
    if (!bundle) return undefined
    const term = bundle.term
    let raf = 0
    const compute = (): void => {
      raf = 0
      setTopBlockId(findCoveringBlockId(term, store.getState().blocks))
    }
    const schedule = (): void => {
      if (!raf) raf = requestAnimationFrame(compute)
    }
    const scroll = term.onScroll(schedule)
    schedule()
    return () => {
      scroll.dispose()
      if (raf) cancelAnimationFrame(raf)
    }
    // `blocks` is a dep so new/updated blocks trigger a recompute.
  }, [sessionId, integrationActive, blocks, store])

  if (!integrationActive || altScreen || !topBlockId) return null
  return (
    <div className="orb-sticky-header">
      <BlockHeaderChrome sessionId={sessionId} blockId={topBlockId} sticky />
    </div>
  )
}
