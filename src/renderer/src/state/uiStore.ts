import { create } from 'zustand'
import type { TerminalSessionInfo } from '../../../shared/domain'

export type AppView = 'terminal' | 'board'

interface UiState {
  activeView: AppView
  setActiveView: (v: AppView) => void

  /**
   * Cross-module seam: kanban asks the terminal workspace to show a session
   * (e.g. "Open worktree in terminal"). The layout consumes the request,
   * opens/focuses a tab bound to the session, and switches views.
   */
  pendingOpenSession: TerminalSessionInfo | null
  requestOpenSession: (info: TerminalSessionInfo) => void
  consumeOpenSession: () => void
}

export const useUiStore = create<UiState>((set) => ({
  activeView: 'terminal',
  setActiveView: (v) => set({ activeView: v }),

  pendingOpenSession: null,
  requestOpenSession: (info) => set({ pendingOpenSession: info, activeView: 'terminal' }),
  consumeOpenSession: () => set({ pendingOpenSession: null })
}))
