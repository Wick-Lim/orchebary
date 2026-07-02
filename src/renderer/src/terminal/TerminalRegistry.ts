import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import type { TerminalSessionInfo } from '../../../shared/domain'

/** Browsers cap live WebGL contexts (~8-16 per page); keep a safety margin. */
const MAX_WEBGL_CONTEXTS = 6

export interface TerminalBundle {
  info: TerminalSessionInfo
  term: Terminal
  fit: FitAddon
  search: SearchAddon
  /** Registry-owned DOM node, reparented between panes — never recreated. */
  container: HTMLDivElement
  webgl?: WebglAddon
  attached: boolean
}

export const terminalTheme = {
  background: '#0d1017',
  foreground: '#d9dee7',
  cursor: '#8be9fd',
  cursorAccent: '#0d1017',
  selectionBackground: '#2c3a52',
  black: '#1a1f29',
  red: '#f2645f',
  green: '#7bd88f',
  yellow: '#e5c07b',
  blue: '#6cb2f7',
  magenta: '#c792ea',
  cyan: '#78dce8',
  white: '#d9dee7',
  brightBlack: '#5c6773',
  brightRed: '#ff7a72',
  brightGreen: '#95e6a5',
  brightYellow: '#f0d197',
  brightBlue: '#8ac3ff',
  brightMagenta: '#d9a9f5',
  brightCyan: '#93ecf5',
  brightWhite: '#f4f6fa'
}

/**
 * Owns every xterm.js instance, keyed by sessionId. Instances (and their DOM
 * containers) live for the whole PTY session and are imperatively reparented
 * into whichever React pane displays them — they are never React state.
 */
class TerminalRegistry {
  private bundles = new Map<string, TerminalBundle>()
  private webglOrder: string[] = [] // LRU, most recent last
  private ipcBound = false
  private disposers: Array<() => void> = []

  /** Bind the global IPC listeners exactly once per renderer lifetime. */
  bindIpc(): void {
    if (this.ipcBound) return
    this.ipcBound = true
    this.disposers.push(
      window.orchebary.terminal.onData(({ sessionId, data }) => {
        const b = this.bundles.get(sessionId)
        if (!b) return
        // Ack after xterm has parsed the frame — this is the flow-control
        // credit that lets main resume a paused PTY.
        b.term.write(data, () => window.orchebary.terminal.ack(sessionId, data.byteLength))
      }),
      window.orchebary.terminal.onExit(({ sessionId }) => {
        this.dispose(sessionId)
        for (const l of this.exitListeners) l(sessionId)
      })
    )
  }

  private exitListeners = new Set<(sessionId: string) => void>()
  onSessionExit(l: (sessionId: string) => void): () => void {
    this.exitListeners.add(l)
    return () => this.exitListeners.delete(l)
  }

  ensure(info: TerminalSessionInfo): TerminalBundle {
    const existing = this.bundles.get(info.sessionId)
    if (existing) return existing

    const term = new Terminal({
      allowProposedApi: true,
      fontFamily: '"JetBrainsMono Nerd Font", "MesloLGS NF", Menlo, "SF Mono", monospace',
      fontSize: 13,
      lineHeight: 1.25,
      scrollback: 10_000,
      macOptionIsMeta: true,
      cursorBlink: true,
      cursorStyle: 'bar',
      theme: terminalTheme
    })
    term.loadAddon(new Unicode11Addon())
    term.unicode.activeVersion = '11'
    term.loadAddon(new WebLinksAddon((_e, uri) => window.open(uri)))
    const fit = new FitAddon()
    term.loadAddon(fit)
    const search = new SearchAddon()
    term.loadAddon(search)

    term.onData((data) => window.orchebary.terminal.input(info.sessionId, data))
    term.onResize(({ cols, rows }) => {
      void window.orchebary.terminal.resize(info.sessionId, cols, rows)
    })

    const container = document.createElement('div')
    container.className = 'terminal-host'
    term.open(container)

    const bundle: TerminalBundle = { info, term, fit, search, container, attached: false }
    this.bundles.set(info.sessionId, bundle)
    return bundle
  }

  get(sessionId: string): TerminalBundle | undefined {
    return this.bundles.get(sessionId)
  }

  attach(sessionId: string, parent: HTMLElement): void {
    const b = this.bundles.get(sessionId)
    if (!b) return
    parent.appendChild(b.container)
    b.attached = true
    this.acquireWebgl(b)
    this.fitAndResize(sessionId)
  }

  detach(sessionId: string): void {
    const b = this.bundles.get(sessionId)
    if (!b) return
    b.attached = false
    this.releaseWebgl(b)
    b.container.remove()
  }

  /** WebGL is a pooled privilege of visibility (LRU-capped). */
  private acquireWebgl(b: TerminalBundle): void {
    if (b.webgl) {
      this.touchLru(b.info.sessionId)
      return
    }
    while (this.webglOrder.length >= MAX_WEBGL_CONTEXTS) {
      const evict = this.webglOrder.shift()
      if (!evict) break
      const victim = this.bundles.get(evict)
      if (victim?.webgl) {
        victim.webgl.dispose()
        victim.webgl = undefined
      }
    }
    try {
      const webgl = new WebglAddon()
      webgl.onContextLoss(() => {
        webgl.dispose()
        b.webgl = undefined
        this.webglOrder = this.webglOrder.filter((id) => id !== b.info.sessionId)
      })
      b.term.loadAddon(webgl)
      b.webgl = webgl
      this.webglOrder.push(b.info.sessionId)
    } catch {
      // WebGL unavailable — xterm's DOM renderer keeps working.
    }
  }

  private releaseWebgl(b: TerminalBundle): void {
    if (!b.webgl) return
    b.webgl.dispose()
    b.webgl = undefined
    this.webglOrder = this.webglOrder.filter((id) => id !== b.info.sessionId)
  }

  private touchLru(sessionId: string): void {
    this.webglOrder = this.webglOrder.filter((id) => id !== sessionId)
    this.webglOrder.push(sessionId)
  }

  fitAndResize(sessionId: string): void {
    const b = this.bundles.get(sessionId)
    // Fitting a hidden/zero-size terminal corrupts reflow — only fit attached ones.
    if (!b || !b.attached || b.container.clientWidth === 0) return
    b.fit.fit()
  }

  focus(sessionId: string): void {
    this.bundles.get(sessionId)?.term.focus()
  }

  dispose(sessionId: string): void {
    const b = this.bundles.get(sessionId)
    if (!b) return
    this.releaseWebgl(b)
    b.term.dispose()
    b.container.remove()
    this.bundles.delete(sessionId)
  }

  list(): TerminalBundle[] {
    return [...this.bundles.values()]
  }
}

export const terminalRegistry = new TerminalRegistry()
