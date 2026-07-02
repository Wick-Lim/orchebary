import { useLayoutStore } from '../state/layoutStore'
import { useUiStore } from '../state/uiStore'
import { findLeaf } from '../layout/tree'
import { actionRegistry, type ActionContext, type AppAction } from './ActionRegistry'
import { cachedWorkflows, sendWorkflowCommand } from './workflows'

export function currentActionContext(): ActionContext {
  const s = useLayoutStore.getState()
  const tab = s.tabs.find((t) => t.id === s.activeTabId) ?? null
  const leaf = tab ? findLeaf(tab.root, tab.activePaneId) : null
  return {
    activeTabId: tab?.id ?? null,
    activePaneId: leaf?.id ?? null,
    activeSessionId: leaf?.sessionId ?? null
  }
}

const layout = (): ReturnType<typeof useLayoutStore.getState> => useLayoutStore.getState()
const inTerminalView = (): boolean => useUiStore.getState().activeView === 'terminal'

export function registerBuiltinActions(): () => void {
  const statics: AppAction[] = [
    {
      id: 'tab.new',
      title: 'New Tab',
      keywords: ['terminal', 'shell', 'create'],
      section: 'Tabs',
      run: () => void layout().newTab()
    },
    {
      id: 'tab.next',
      title: 'Next Tab',
      section: 'Tabs',
      when: () => layout().tabs.length > 1,
      run: () => layout().cycleTab(1)
    },
    {
      id: 'tab.prev',
      title: 'Previous Tab',
      section: 'Tabs',
      when: () => layout().tabs.length > 1,
      run: () => layout().cycleTab(-1)
    },
    {
      id: 'pane.close',
      title: 'Close Pane',
      keywords: ['kill', 'tab'],
      section: 'Panes',
      when: (ctx) => ctx.activePaneId !== null,
      run: () => layout().closeActivePane()
    },
    {
      id: 'pane.split.right',
      title: 'Split Pane Right',
      keywords: ['vertical', 'horizontal'],
      section: 'Panes',
      when: (ctx) => ctx.activePaneId !== null,
      run: () => void layout().splitActivePane('row')
    },
    {
      id: 'pane.split.down',
      title: 'Split Pane Down',
      keywords: ['horizontal', 'vertical'],
      section: 'Panes',
      when: (ctx) => ctx.activePaneId !== null,
      run: () => void layout().splitActivePane('col')
    },
    {
      id: 'view.board',
      title: 'Open Board',
      keywords: ['kanban', 'tasks', 'agents'],
      section: 'View',
      when: () => inTerminalView(),
      run: () => useUiStore.getState().setActiveView('board')
    },
    {
      id: 'view.terminal',
      title: 'Open Terminal',
      keywords: ['shell', 'workspace'],
      section: 'View',
      when: () => !inTerminalView(),
      run: () => useUiStore.getState().setActiveView('terminal')
    },
    {
      id: 'history.toggle',
      title: 'Search Command History',
      keywords: ['ctrl-r', 'reverse'],
      section: 'History',
      when: (ctx) => ctx.activeSessionId !== null && inTerminalView(),
      run: () => layout().setHistoryOpen(!layout().historyOpen)
    },
    {
      id: 'palette.toggle',
      title: 'Command Palette',
      section: 'View',
      run: () => layout().setPaletteOpen(!layout().paletteOpen)
    }
  ]

  const dirs = [
    ['left', 'Left'],
    ['right', 'Right'],
    ['up', 'Up'],
    ['down', 'Down']
  ] as const
  for (const [dir, label] of dirs) {
    statics.push({
      id: `pane.focus.${dir}`,
      title: `Focus Pane ${label}`,
      section: 'Panes',
      when: (ctx) => ctx.activePaneId !== null,
      run: () => layout().moveFocus(dir)
    })
  }

  for (let n = 1; n <= 9; n++) {
    statics.push({
      id: `tab.goto.${n}`,
      title: `Go to Tab ${n}`,
      section: 'Tabs',
      when: () => layout().tabs.length >= n,
      run: () => layout().activateTabAt(n - 1)
    })
  }

  const disposeStatics = actionRegistry.registerMany(statics)

  const disposeSessions = actionRegistry.registerProvider(() =>
    Object.values(layout().sessions).map((info) => ({
      id: `session.switch.${info.sessionId}`,
      title: `Switch to ${info.title}`,
      keywords: [info.cwd, info.kind],
      section: 'Sessions',
      run: () => {
        useUiStore.getState().setActiveView('terminal')
        layout().revealSession(info)
      }
    }))
  )

  const disposeWorkflows = actionRegistry.registerProvider(() =>
    cachedWorkflows().map((wf) => ({
      id: `workflow.${wf.name}`,
      title: wf.name,
      keywords: [wf.command],
      section: 'Workflows',
      when: (ctx: ActionContext) => ctx.activeSessionId !== null,
      run: (ctx: ActionContext) => {
        if (!ctx.activeSessionId) return
        if (wf.params && wf.params.length > 0) {
          layout().setPendingWorkflow(wf)
        } else {
          sendWorkflowCommand(ctx.activeSessionId, wf.command)
        }
      }
    }))
  )

  return () => {
    disposeStatics()
    disposeSessions()
    disposeWorkflows()
  }
}
