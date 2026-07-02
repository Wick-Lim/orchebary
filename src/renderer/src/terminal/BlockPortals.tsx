import { createPortal } from 'react-dom'
import { useStore } from 'zustand'
import { getBlockStore, type CommandBlock } from './blockStore'
import { BlockHeaderChrome } from './BlockHeaderChrome'

type AnchoredBlock = CommandBlock & { portalEl: HTMLElement }

/**
 * Portals one BlockHeaderChrome into each block's decoration element (created
 * by BlockManager, flagged once via data-orb-block). Renders nothing on the
 * alternate screen or for sessions without shell integration.
 */
export function BlockPortals({ sessionId }: { sessionId: string }): React.JSX.Element | null {
  const store = getBlockStore(sessionId)
  const blocks = useStore(store, (s) => s.blocks)
  const altScreen = useStore(store, (s) => s.altScreen)
  if (altScreen) return null

  const anchored = blocks.filter(
    (b): b is AnchoredBlock => b.portalEl !== undefined && b.state !== 'prompt'
  )
  if (anchored.length === 0) return null

  return (
    <>
      {anchored.map((b) =>
        createPortal(<BlockHeaderChrome sessionId={sessionId} blockId={b.id} />, b.portalEl, b.id)
      )}
    </>
  )
}
