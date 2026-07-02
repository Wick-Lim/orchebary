import { create } from 'zustand'
import { nanoid } from 'nanoid'
import type { TerminalSessionInfo } from '../../../shared/domain'
import { terminalRegistry } from '../terminal/TerminalRegistry'
import {
  findLeaf,
  firstLeaf,
  leavesOf,
  makeLeaf,
  removeLeaf,
  splitLeaf,
  withRatio,
  withoutSession,
  type PaneNode,
  type SplitDir
} from '../layout/tree'
import type { Workflow } from '../palette/workflows'
import { useUiStore } from './uiStore'

export interface Tab {
  id: string
  /** Fallback label; the tab strip prefers the focused session's live title. */
  title: string
  root: PaneNode
  activePaneId: string
}

export type FocusDirection = 'left' | 'right' | 'up' | 'down'

const DEFAULT_SIZE = { cols: 80, rows: 24 }

function makeTab(info: TerminalSessionInfo): Tab {
  const leaf = makeLeaf(info.sessionId)
  return { id: nanoid(), title: info.title || 'Terminal', root: leaf, activePaneId: leaf.id }
}

function sessionRefCount(tabs: Tab[], sessionId: string): number {
  let n = 0
  for (const tab of tabs) {
    for (const leaf of leavesOf(tab.root)) if (leaf.sessionId === sessionId) n++
  }
  return n
}

/** Pick a sensible neighbor after removing the tab at `index`. */
function nextActiveTabId(tabs: Tab[], index: number): string | null {
  if (tabs.length === 0) return null
  return tabs[Math.min(index, tabs.length - 1)].id
}

interface LayoutState {
  tabs: Tab[]
  activeTabId: string | null
  /** Live PTY sessions, mirrored from terminal.list() + app events. */
  sessions: Record<string, TerminalSessionInfo>

  // Workspace overlays (owned here so keybindings/actions can toggle them).
  paletteOpen: boolean
  historyOpen: boolean
  pendingWorkflow: Workflow | null
  setPaletteOpen: (open: boolean) => void
  setHistoryOpen: (open: boolean) => void
  setPendingWorkflow: (wf: Workflow | null) => void

  registerSession: (info: TerminalSessionInfo) => void
  handleSessionClosed: (sessionId: string) => void

  newTab: () => Promise<void>
  openSessionTab: (info: TerminalSessionInfo) => void
  revealSession: (info: TerminalSessionInfo) => void
  closeTab: (tabId: string) => void
  setActiveTab: (tabId: string) => void
  activateTabAt: (index: number) => void
  cycleTab: (delta: 1 | -1) => void
  reorderTabs: (fromId: string, toId: string) => void

  splitActivePane: (dir: SplitDir) => Promise<void>
  closePane: (tabId: string, paneId: string) => void
  closeActivePane: () => void
  setRatio: (tabId: string, splitId: string, ratio: number) => void
  focusPane: (tabId: string, paneId: string) => void
  moveFocus: (dir: FocusDirection) => void
}

export const useLayoutStore = create<LayoutState>((set, get) => {
  function focusActiveTerminal(): void {
    const { tabs, activeTabId } = get()
    const tab = tabs.find((t) => t.id === activeTabId)
    if (!tab) return
    const leaf = findLeaf(tab.root, tab.activePaneId)
    if (leaf) terminalRegistry.focus(leaf.sessionId)
  }

  function killIfUnreferenced(sessionId: string): void {
    if (sessionRefCount(get().tabs, sessionId) > 0) return
    // Only kill sessions we still believe are alive; dead ones already
    // vanished via the 'terminal.closed' event.
    if (get().sessions[sessionId]) void window.orchebary.terminal.kill(sessionId)
  }

  return {
    tabs: [],
    activeTabId: null,
    sessions: {},

    paletteOpen: false,
    historyOpen: false,
    pendingWorkflow: null,
    setPaletteOpen: (open) => {
      set({ paletteOpen: open })
      if (!open) focusActiveTerminal()
    },
    setHistoryOpen: (open) => {
      set({ historyOpen: open })
      // Don't steal focus back when the overlay closed because the palette
      // (or another overlay) took over the keyboard.
      if (!open && !get().paletteOpen && !get().pendingWorkflow) focusActiveTerminal()
    },
    setPendingWorkflow: (wf) => {
      set({ pendingWorkflow: wf })
      if (!wf) focusActiveTerminal()
    },

    registerSession: (info) => {
      set((state) => ({ sessions: { ...state.sessions, [info.sessionId]: info } }))
      // Agent sessions (kanban-started claude runs) surface themselves: open a
      // tab bound to the session and bring the terminal view forward.
      if (info.kind === 'agent') {
        get().revealSession(info)
        useUiStore.getState().setActiveView('terminal')
      }
    },

    handleSessionClosed: (sessionId) =>
      set((state) => {
        if (!(sessionId in state.sessions) && sessionRefCount(state.tabs, sessionId) === 0) {
          return state
        }
        const sessions = { ...state.sessions }
        delete sessions[sessionId]

        const tabs: Tab[] = []
        for (const tab of state.tabs) {
          const root = withoutSession(tab.root, sessionId)
          if (!root) continue // last pane died -> tab closes
          if (root === tab.root) {
            tabs.push(tab)
          } else {
            const activePaneId = findLeaf(root, tab.activePaneId)
              ? tab.activePaneId
              : firstLeaf(root).id
            tabs.push({ ...tab, root, activePaneId })
          }
        }
        const activeTabId = tabs.some((t) => t.id === state.activeTabId)
          ? state.activeTabId
          : (tabs[0]?.id ?? null)
        return { sessions, tabs, activeTabId }
      }),

    newTab: async () => {
      const info = await window.orchebary.terminal.create(DEFAULT_SIZE)
      get().openSessionTab(info)
    },

    openSessionTab: (info) => {
      const tab = makeTab(info)
      set((state) => ({
        sessions: { ...state.sessions, [info.sessionId]: info },
        tabs: [...state.tabs, tab],
        activeTabId: tab.id
      }))
    },

    revealSession: (info) => {
      const { tabs } = get()
      for (const tab of tabs) {
        const leaf = leavesOf(tab.root).find((l) => l.sessionId === info.sessionId)
        if (leaf) {
          get().focusPane(tab.id, leaf.id)
          return
        }
      }
      // Session already exists in main — bind a new tab to it, never create.
      get().openSessionTab(info)
    },

    closeTab: (tabId) => {
      const index = get().tabs.findIndex((t) => t.id === tabId)
      if (index < 0) return
      const closing = get().tabs[index]
      const closingSessions = new Set(leavesOf(closing.root).map((l) => l.sessionId))
      set((state) => {
        const tabs = state.tabs.filter((t) => t.id !== tabId)
        const activeTabId =
          state.activeTabId === tabId ? nextActiveTabId(tabs, index) : state.activeTabId
        return { tabs, activeTabId }
      })
      for (const sessionId of closingSessions) killIfUnreferenced(sessionId)
    },

    setActiveTab: (tabId) => {
      if (get().tabs.some((t) => t.id === tabId)) set({ activeTabId: tabId })
    },

    activateTabAt: (index) => {
      const tab = get().tabs[index]
      if (tab) set({ activeTabId: tab.id })
    },

    cycleTab: (delta) => {
      const { tabs, activeTabId } = get()
      if (tabs.length < 2) return
      const index = tabs.findIndex((t) => t.id === activeTabId)
      const next = (index + delta + tabs.length) % tabs.length
      set({ activeTabId: tabs[next].id })
    },

    reorderTabs: (fromId, toId) =>
      set((state) => {
        const from = state.tabs.findIndex((t) => t.id === fromId)
        const to = state.tabs.findIndex((t) => t.id === toId)
        if (from < 0 || to < 0 || from === to) return state
        const tabs = [...state.tabs]
        const [moved] = tabs.splice(from, 1)
        tabs.splice(to, 0, moved)
        return { tabs }
      }),

    splitActivePane: async (dir) => {
      const info = await window.orchebary.terminal.create(DEFAULT_SIZE)
      // Re-read after the await: the tree may have changed meanwhile.
      const { tabs, activeTabId } = get()
      const tab = tabs.find((t) => t.id === activeTabId)
      const result = tab && splitLeaf(tab.root, tab.activePaneId, dir, info.sessionId)
      if (!tab || !result) {
        get().openSessionTab(info)
        return
      }
      set((state) => ({
        sessions: { ...state.sessions, [info.sessionId]: info },
        tabs: state.tabs.map((t) =>
          t.id === tab.id ? { ...t, root: result.root, activePaneId: result.newLeaf.id } : t
        )
      }))
    },

    closePane: (tabId, paneId) => {
      const index = get().tabs.findIndex((t) => t.id === tabId)
      if (index < 0) return
      const tab = get().tabs[index]
      const result = removeLeaf(tab.root, paneId)
      if (!result) return
      set((state) => {
        if (result.root === null) {
          const tabs = state.tabs.filter((t) => t.id !== tabId)
          const activeTabId =
            state.activeTabId === tabId ? nextActiveTabId(tabs, index) : state.activeTabId
          return { tabs, activeTabId }
        }
        const root = result.root
        const activePaneId =
          tab.activePaneId === paneId || !findLeaf(root, tab.activePaneId)
            ? firstLeaf(root).id
            : tab.activePaneId
        return {
          tabs: state.tabs.map((t) => (t.id === tabId ? { ...t, root, activePaneId } : t))
        }
      })
      killIfUnreferenced(result.removed.sessionId)
      focusActiveTerminal()
    },

    closeActivePane: () => {
      const { tabs, activeTabId } = get()
      const tab = tabs.find((t) => t.id === activeTabId)
      if (tab) get().closePane(tab.id, tab.activePaneId)
    },

    setRatio: (tabId, splitId, ratio) =>
      set((state) => ({
        tabs: state.tabs.map((t) =>
          t.id === tabId ? { ...t, root: withRatio(t.root, splitId, ratio) } : t
        )
      })),

    focusPane: (tabId, paneId) => {
      const tab = get().tabs.find((t) => t.id === tabId)
      if (!tab) return
      const leaf = findLeaf(tab.root, paneId)
      if (!leaf) return
      set({
        activeTabId: tabId,
        tabs: get().tabs.map((t) => (t.id === tabId ? { ...t, activePaneId: paneId } : t))
      })
      terminalRegistry.focus(leaf.sessionId)
    },

    moveFocus: (dir) => {
      const { tabs, activeTabId } = get()
      const tab = tabs.find((t) => t.id === activeTabId)
      if (!tab) return
      const leaves = leavesOf(tab.root)
      if (leaves.length < 2) return

      // Geometric nearest neighbor over measured pane rects.
      const rects = new Map<string, DOMRect>()
      for (const leaf of leaves) {
        const el = document.querySelector(`[data-pane-id="${leaf.id}"]`)
        if (el) rects.set(leaf.id, el.getBoundingClientRect())
      }
      const cur = rects.get(tab.activePaneId)
      if (!cur) return
      const cx = cur.left + cur.width / 2
      const cy = cur.top + cur.height / 2

      let best: { id: string; score: number } | null = null
      for (const leaf of leaves) {
        if (leaf.id === tab.activePaneId) continue
        const r = rects.get(leaf.id)
        if (!r) continue
        const x = r.left + r.width / 2
        const y = r.top + r.height / 2
        let axis: number
        let cross: number
        if (dir === 'left' || dir === 'right') {
          axis = dir === 'right' ? x - cx : cx - x
          cross = Math.abs(y - cy)
        } else {
          axis = dir === 'down' ? y - cy : cy - y
          cross = Math.abs(x - cx)
        }
        if (axis <= 1) continue // must actually lie in that direction
        const score = axis + cross * 4 // prefer aligned panes over diagonal ones
        if (!best || score < best.score) best = { id: leaf.id, score }
      }
      if (best) get().focusPane(tab.id, best.id)
    }
  }
})

// Module-level guard so HMR/double-mounted effects can never boot twice.
let initPromise: Promise<void> | null = null

/**
 * Renderer boot: subscribe to session lifecycle events, then adopt every
 * already-live PTY session into its own tab (renderer reload survival) or
 * spawn the first shell when none exist.
 */
export function initWorkspace(): Promise<void> {
  initPromise ??= (async () => {
    window.orchebary.onAppEvent((event) => {
      if (event.type === 'terminal.registered') {
        useLayoutStore.getState().registerSession(event.session)
      } else if (event.type === 'terminal.closed') {
        useLayoutStore.getState().handleSessionClosed(event.sessionId)
      }
    })
    // Adopt-only: sessions are born from kanban moves (or ⌘T for a scratch
    // shell) — booting the app spawns nothing.
    const existing = await window.orchebary.terminal.list()
    const store = useLayoutStore.getState()
    for (const info of existing) store.openSessionTab(info)
    const first = useLayoutStore.getState().tabs[0]
    if (first) useLayoutStore.setState({ activeTabId: first.id })
  })()
  return initPromise
}
