import type { IDisposable, ITerminalAddon, Terminal } from '@xterm/xterm'

/**
 * Events decoded from the escape sequences emitted by
 * resources/shell-integration/zsh/orchebary-integration.zsh.
 */
export interface ShellIntegrationEventMap {
  /** OSC 133;A — a new prompt is about to be drawn (cursor on the prompt row). */
  promptStart: void
  /** OSC 133;B — prompt drawn, user input starts (zero-width, end of PS1). */
  commandStart: void
  /** OSC 133;C — command accepted; output begins at the cursor row. */
  commandExecuted: void
  /** OSC 133;D;<exit> — command finished. exitCode is absent on empty enter / ctrl-c. */
  commandFinished: { exitCode?: number }
  /** OSC 633;E — the exact command line (already unescaped). */
  commandLine: { text: string }
  /** OSC 7 — cwd report (file:// URL, percent-decoded). */
  cwd: { path: string }
  /** Fired exactly once, on the first 133;A — integration feature-detected. */
  activated: void
}

type Listener<K extends keyof ShellIntegrationEventMap> = (
  payload: ShellIntegrationEventMap[K]
) => void

/**
 * Unescape an OSC 633;E payload: `\\` -> backslash, `\x3b` -> `;`,
 * `\x0a` -> newline. Scans left-to-right so `\\x3b` decodes to literal `\x3b`.
 */
export function unescapeCommandLine(raw: string): string {
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    if (ch !== '\\') {
      out += ch
      continue
    }
    if (raw[i + 1] === '\\') {
      out += '\\'
      i += 1
    } else if (raw.startsWith('x3b', i + 1)) {
      out += ';'
      i += 3
    } else if (raw.startsWith('x0a', i + 1)) {
      out += '\n'
      i += 3
    } else {
      // Unknown escape — keep the backslash literal.
      out += ch
    }
  }
  return out
}

/**
 * Parses FinalTerm (OSC 133), Orchebary (OSC 633) and cwd (OSC 7) sequences
 * into typed events. Handlers fire synchronously during `term.write` parsing,
 * so the cursor is exactly at the boundary row when listeners run.
 */
export class ShellIntegrationAddon implements ITerminalAddon {
  private disposables: IDisposable[] = []
  // Values are Set<Listener<K>> for the matching key; `on`/`emit` keep K aligned.
  private listeners = new Map<keyof ShellIntegrationEventMap, Set<Listener<never>>>()
  private active = false

  /** True only after the first 133;A was seen (the shim is actually running). */
  get isActive(): boolean {
    return this.active
  }

  activate(terminal: Terminal): void {
    this.disposables.push(
      terminal.parser.registerOscHandler(133, (data) => this.handleFinalTerm(data)),
      terminal.parser.registerOscHandler(633, (data) => this.handleOrchebary(data)),
      terminal.parser.registerOscHandler(7, (data) => this.handleCwdReport(data))
    )
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose()
    this.disposables = []
    this.listeners.clear()
  }

  on<K extends keyof ShellIntegrationEventMap>(event: K, cb: Listener<K>): IDisposable {
    let set = this.listeners.get(event) as Set<Listener<K>> | undefined
    if (!set) {
      set = new Set()
      this.listeners.set(event, set as Set<Listener<never>>)
    }
    set.add(cb)
    const stable = set
    return { dispose: () => stable.delete(cb) }
  }

  private emit<K extends keyof ShellIntegrationEventMap>(
    event: K,
    payload: ShellIntegrationEventMap[K]
  ): void {
    const set = this.listeners.get(event) as Set<Listener<K>> | undefined
    if (!set) return
    for (const cb of set) cb(payload)
  }

  private handleFinalTerm(data: string): boolean {
    const sep = data.indexOf(';')
    const kind = sep === -1 ? data : data.slice(0, sep)
    const arg = sep === -1 ? undefined : data.slice(sep + 1)
    switch (kind) {
      case 'A':
        if (!this.active) {
          this.active = true
          this.emit('activated', undefined)
        }
        this.emit('promptStart', undefined)
        break
      case 'B':
        this.emit('commandStart', undefined)
        break
      case 'C':
        this.emit('commandExecuted', undefined)
        break
      case 'D': {
        const parsed = arg ? Number.parseInt(arg, 10) : Number.NaN
        this.emit('commandFinished', {
          exitCode: Number.isFinite(parsed) ? parsed : undefined
        })
        break
      }
    }
    return true
  }

  private handleOrchebary(data: string): boolean {
    if (data === 'E' || data.startsWith('E;')) {
      this.emit('commandLine', { text: unescapeCommandLine(data.slice(2)) })
    }
    return true
  }

  private handleCwdReport(data: string): boolean {
    try {
      const url = new URL(data)
      if (url.protocol === 'file:') {
        this.emit('cwd', { path: decodeURIComponent(url.pathname) })
      }
    } catch {
      // Malformed OSC 7 payload — ignore.
    }
    return true
  }
}
