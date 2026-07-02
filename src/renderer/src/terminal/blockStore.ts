import { createStore, type StoreApi } from 'zustand/vanilla'
import type { IMarker } from '@xterm/xterm'

export type BlockState = 'prompt' | 'running' | 'done' | 'partial'

export interface CommandBlock {
  id: string
  state: BlockState
  command?: string
  cwd?: string
  exitCode?: number
  startedAt?: number
  endedAt?: number
  /** The command entered the alternate screen (vim/htop) while running. */
  hadAltScreen?: boolean
  /**
   * Buffer anchors. NEVER cache `.line` — reflow and scrollback trimming move
   * it; always read live. `line === -1` / `isDisposed` means trimmed away.
   */
  promptMarker?: IMarker
  outputMarker?: IMarker
  endMarker?: IMarker
  /** Decoration DOM node the React header chrome portals into. */
  portalEl?: HTMLElement
}

export interface BlockStoreState {
  /** True after the first OSC 133;A — feature detection for the zsh shim. */
  integrationActive: boolean
  /** Alternate screen (vim/htop) is active — suppress all block chrome. */
  altScreen: boolean
  /** Chronological; marker lines are monotonically non-decreasing. */
  blocks: CommandBlock[]
  /** Block whose output is shown in the inspector panel, if any. */
  inspectedBlockId: string | null
}

export type BlockStore = StoreApi<BlockStoreState>

const stores = new Map<string, BlockStore>()

function initialState(): BlockStoreState {
  return { integrationActive: false, altScreen: false, blocks: [], inspectedBlockId: null }
}

/**
 * Per-session vanilla store: BlockManager (plain TS) writes synchronously
 * from OSC handlers; React subscribes with selectors via `useStore(store, …)`.
 */
export function getBlockStore(sessionId: string): BlockStore {
  let store = stores.get(sessionId)
  if (!store) {
    store = createStore<BlockStoreState>(initialState)
    stores.set(sessionId, store)
  }
  return store
}

export function disposeBlockStore(sessionId: string): void {
  stores.delete(sessionId)
}
