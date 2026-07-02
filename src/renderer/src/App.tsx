import { useEffect } from 'react'
import './assets/workspace.css'
import { BoardPage } from './kanban/BoardPage'
import { Toasts } from './kanban/Toasts'
import { installKeybindings } from './layout/KeybindingService'
import { PaneLayout } from './layout/PaneLayout'
import { WorkspaceRail } from './layout/WorkspaceRail'
import { GitPanel } from './worktrees/GitPanel'
import { registerBuiltinActions } from './palette/actions'
import { PaletteHost } from './palette/PaletteHost'
import { initWorkspace, useLayoutStore } from './state/layoutStore'
import { useUiStore, type AppView } from './state/uiStore'
import { terminalRegistry } from './terminal/TerminalRegistry'

function ViewSwitch({ active }: { active: AppView }): React.JSX.Element {
  const setActiveView = useUiStore((s) => s.setActiveView)
  return (
    <div className="view-switch">
      <button
        type="button"
        className={active === 'board' ? 'is-on' : ''}
        onClick={() => setActiveView('board')}
      >
        Board
      </button>
      <button
        type="button"
        className={active === 'terminal' ? 'is-on' : ''}
        onClick={() => setActiveView('terminal')}
      >
        Terminal
      </button>
    </div>
  )
}

export default function App(): React.JSX.Element {
  const activeView = useUiStore((s) => s.activeView)
  const pendingOpenSession = useUiStore((s) => s.pendingOpenSession)

  useEffect(() => {
    terminalRegistry.bindIpc()
    const disposeActions = registerBuiltinActions()
    const disposeKeys = installKeybindings()
    // Session bootstrapping (adopt-or-create) lives in the layout store; the
    // module-level promise inside makes re-mounts/HMR harmless.
    void initWorkspace()
    return () => {
      disposeActions()
      disposeKeys()
    }
  }, [])

  // Cross-module seam: kanban asked us to show a session that already exists.
  useEffect(() => {
    if (!pendingOpenSession) return
    useLayoutStore.getState().revealSession(pendingOpenSession)
    useUiStore.getState().consumeOpenSession()
  }, [pendingOpenSession])

  return (
    <div className="app-shell">
      <div className="titlebar-drag">
        <ViewSwitch active={activeView} />
      </div>
      <div className="app-content">
        <div className="app-main">
          {/* Terminal view stays mounted (hidden) so xterm DOM/state survives;
              TerminalRegistry's ResizeObserver refits panes when shown again. */}
          <div
            className="workspace terminal-workspace"
            style={activeView === 'terminal' ? undefined : { display: 'none' }}
          >
            <WorkspaceRail />
            <div className="terminal-main">
              <PaneLayout />
            </div>
          </div>
          {activeView === 'board' && (
            <div className="workspace">
              <BoardPage />
            </div>
          )}
        </div>
        <GitPanel />
      </div>
      <PaletteHost />
      <Toasts />
    </div>
  )
}
