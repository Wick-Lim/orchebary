import { actionRegistry } from '../palette/ActionRegistry'
import { currentActionContext } from '../palette/actions'
import { useUiStore } from '../state/uiStore'

interface Combo {
  code: string
  meta?: boolean
  ctrl?: boolean
  alt?: boolean
  shift?: boolean
}

interface Binding {
  combo: Combo
  actionId: string
  /** Bindings that only make sense while the terminal workspace is visible. */
  terminalOnly?: boolean
}

function matches(e: KeyboardEvent, c: Combo): boolean {
  return (
    e.code === c.code &&
    e.metaKey === !!c.meta &&
    e.ctrlKey === !!c.ctrl &&
    e.altKey === !!c.alt &&
    e.shiftKey === !!c.shift
  )
}

const BINDINGS: Binding[] = [
  { combo: { code: 'KeyT', meta: true }, actionId: 'tab.new', terminalOnly: true },
  { combo: { code: 'KeyW', meta: true }, actionId: 'pane.close', terminalOnly: true },
  { combo: { code: 'KeyD', meta: true }, actionId: 'pane.split.right', terminalOnly: true },
  {
    combo: { code: 'KeyD', meta: true, shift: true },
    actionId: 'pane.split.down',
    terminalOnly: true
  },
  {
    combo: { code: 'ArrowLeft', meta: true, alt: true },
    actionId: 'pane.focus.left',
    terminalOnly: true
  },
  {
    combo: { code: 'ArrowRight', meta: true, alt: true },
    actionId: 'pane.focus.right',
    terminalOnly: true
  },
  {
    combo: { code: 'ArrowUp', meta: true, alt: true },
    actionId: 'pane.focus.up',
    terminalOnly: true
  },
  {
    combo: { code: 'ArrowDown', meta: true, alt: true },
    actionId: 'pane.focus.down',
    terminalOnly: true
  },
  {
    combo: { code: 'BracketLeft', meta: true, shift: true },
    actionId: 'tab.prev',
    terminalOnly: true
  },
  {
    combo: { code: 'BracketRight', meta: true, shift: true },
    actionId: 'tab.next',
    terminalOnly: true
  },
  { combo: { code: 'KeyK', meta: true }, actionId: 'palette.toggle' },
  { combo: { code: 'KeyR', ctrl: true }, actionId: 'history.toggle', terminalOnly: true },
  ...Array.from({ length: 9 }, (_, i) => ({
    combo: { code: `Digit${i + 1}`, meta: true },
    actionId: `tab.goto.${i + 1}`,
    terminalOnly: true
  }))
]

/**
 * Document-level keydown in the CAPTURE phase: xterm.js swallows keys once
 * they reach its textarea, so app-level chords must intercept first.
 */
export function installKeybindings(): () => void {
  const onKeyDown = (e: KeyboardEvent): void => {
    for (const binding of BINDINGS) {
      if (!matches(e, binding.combo)) continue
      if (binding.terminalOnly && useUiStore.getState().activeView !== 'terminal') return
      const handled = actionRegistry.run(binding.actionId, currentActionContext())
      if (handled) {
        e.preventDefault()
        e.stopPropagation()
      }
      return
    }
  }
  document.addEventListener('keydown', onKeyDown, true)
  return () => document.removeEventListener('keydown', onKeyDown, true)
}
