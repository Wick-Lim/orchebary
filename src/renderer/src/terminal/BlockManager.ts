import { nanoid } from 'nanoid'
import type { IBuffer, IDisposable, IMarker, Terminal } from '@xterm/xterm'
import type { ShellIntegrationAddon } from './ShellIntegrationAddon'
import { getBlockStore, type BlockStore, type CommandBlock } from './blockStore'

/**
 * Segments a session's scrollback into Warp-style command blocks. Plain TS —
 * consumes ShellIntegrationAddon events synchronously (the cursor sits on the
 * boundary row during parsing, so `registerMarker(0)` pins that exact row) and
 * publishes immutable records into the per-session vanilla zustand store.
 */
export class BlockManager {
  private readonly store: BlockStore
  private readonly disposables: IDisposable[] = []
  private readonly decorations = new Map<string, IDisposable>()
  private currentCwd?: string
  private pendingCommand?: string
  private disposed = false

  constructor(
    private readonly sessionId: string,
    private readonly term: Terminal,
    addon: ShellIntegrationAddon
  ) {
    this.store = getBlockStore(sessionId)
    this.disposables.push(
      addon.on('activated', () => this.store.setState({ integrationActive: true })),
      addon.on('promptStart', () => this.onPromptStart()),
      addon.on('commandLine', ({ text }) => {
        this.pendingCommand = text
      }),
      addon.on('commandExecuted', () => this.onCommandExecuted()),
      addon.on('commandFinished', ({ exitCode }) => this.onCommandFinished(exitCode)),
      addon.on('cwd', ({ path }) => {
        this.currentCwd = path
      }),
      term.buffer.onBufferChange((buf: IBuffer) => this.onBufferChange(buf.type === 'alternate'))
    )
  }

  dispose(): void {
    this.disposed = true
    for (const d of this.disposables) d.dispose()
    this.disposables.length = 0
    for (const deco of this.decorations.values()) deco.dispose()
    this.decorations.clear()
    // Markers die with the Terminal; the store itself is dropped by the registry.
  }

  // -------------------------------------------------------------------------
  // Event handlers

  private onPromptStart(): void {
    if (this.inAltScreen()) return
    const newest = this.newest()
    if (newest?.state === 'prompt') {
      // Prompt redrawn while one was already open (unexpected) — replace it.
      this.removeBlock(newest.id)
    } else if (newest && newest.state === 'running' && !newest.endMarker) {
      // Missed 133;D — close the block with an unknown exit so state stays sane.
      this.update(newest.id, { state: 'done', endedAt: Date.now() })
    }
    this.createPromptBlock()
  }

  private onCommandExecuted(): void {
    if (this.inAltScreen()) return
    const command = this.pendingCommand
    this.pendingCommand = undefined
    let block = this.newest()
    if (!block || block.state !== 'prompt') {
      // 133;C without an open prompt (integration glitch) — synthesize one.
      block = this.createPromptBlock()
      if (!block) return
    }
    const id = block.id
    const outputMarker = this.registerMarker()
    if (outputMarker) outputMarker.onDispose(() => this.onOutputMarkerDisposed(id))
    this.update(id, {
      state: 'running',
      command,
      startedAt: Date.now(),
      outputMarker
    })
  }

  private onCommandFinished(exitCode?: number): void {
    const block = this.newest()
    if (!block) return
    if (block.state === 'prompt') {
      // 133;D without exit code: empty enter / ctrl-c — drop the empty prompt.
      this.removeBlock(block.id)
      return
    }
    if (block.endMarker || block.endedAt !== undefined) return // already closed

    const id = block.id
    const endedAt = Date.now()
    const endMarker = this.registerMarker()
    if (endMarker) endMarker.onDispose(() => this.onEndMarkerDisposed(id))
    this.update(id, {
      // A block trimmed while still running stays 'partial'.
      state: block.state === 'partial' ? 'partial' : 'done',
      exitCode,
      endedAt,
      endMarker
    })

    if (block.command && block.command.trim().length > 0) {
      const startedAt = block.startedAt ?? endedAt
      window.orchebary.history.append({
        sessionId: this.sessionId,
        cwd: block.cwd ?? '',
        command: block.command,
        exitCode,
        startedAt: new Date(startedAt).toISOString(),
        durationMs: endedAt - startedAt
      })
    }
  }

  private onBufferChange(alt: boolean): void {
    this.store.setState({ altScreen: alt })
    if (!alt) return
    const newest = this.newest()
    if (newest?.state === 'running') this.update(newest.id, { hadAltScreen: true })
  }

  // -------------------------------------------------------------------------
  // Scrollback trimming (marker disposal)

  private onPromptMarkerDisposed(id: string): void {
    if (this.disposed) return
    const block = this.find(id)
    if (!block) return
    this.dropDecoration(id)
    if (block.state === 'prompt') {
      this.removeBlock(id)
      return
    }
    // Header row trimmed: block survives headless as 'partial'.
    this.update(id, { state: 'partial', portalEl: undefined })
  }

  private onOutputMarkerDisposed(id: string): void {
    if (this.disposed) return
    const block = this.find(id)
    if (!block || block.state === 'partial') return
    this.update(id, { state: 'partial' })
  }

  private onEndMarkerDisposed(id: string): void {
    if (this.disposed) return
    // The whole block scrolled out of the buffer — drop the record entirely.
    this.removeBlock(id)
  }

  // -------------------------------------------------------------------------
  // Internals

  private createPromptBlock(): CommandBlock | undefined {
    const promptMarker = this.registerMarker()
    if (!promptMarker) return undefined
    const block: CommandBlock = {
      id: nanoid(10),
      state: 'prompt',
      cwd: this.currentCwd,
      promptMarker
    }
    promptMarker.onDispose(() => this.onPromptMarkerDisposed(block.id))
    this.store.setState((s) => ({ blocks: [...s.blocks, block] }))
    this.registerHeaderDecoration(block.id, promptMarker)
    return block
  }

  private registerHeaderDecoration(blockId: string, marker: IMarker): void {
    const deco = this.term.registerDecoration({
      marker,
      width: this.term.cols,
      layer: 'top'
    })
    if (!deco) return
    deco.onRender((el) => {
      // onRender fires every frame — mount the portal root exactly once.
      if (el.dataset.orbBlock === blockId) return
      el.dataset.orbBlock = blockId
      el.classList.add('orb-block-anchor')
      this.update(blockId, { portalEl: el })
    })
    this.decorations.set(blockId, deco)
  }

  private registerMarker(): IMarker | undefined {
    if (this.inAltScreen()) return undefined
    // Typed non-optional, but proposed API — be defensive.
    return this.term.registerMarker(0) as IMarker | undefined
  }

  private removeBlock(id: string): void {
    const block = this.find(id)
    if (!block) return
    this.dropDecoration(id)
    this.store.setState((s) => ({
      blocks: s.blocks.filter((b) => b.id !== id),
      inspectedBlockId: s.inspectedBlockId === id ? null : s.inspectedBlockId
    }))
    // Dispose markers after removal so their onDispose finds no record.
    for (const m of [block.promptMarker, block.outputMarker, block.endMarker]) {
      if (m && !m.isDisposed) m.dispose()
    }
  }

  private dropDecoration(id: string): void {
    this.decorations.get(id)?.dispose()
    this.decorations.delete(id)
  }

  private update(id: string, patch: Partial<CommandBlock>): void {
    this.store.setState((s) => ({
      blocks: s.blocks.map((b) => (b.id === id ? { ...b, ...patch } : b))
    }))
  }

  private newest(): CommandBlock | undefined {
    const blocks = this.store.getState().blocks
    return blocks[blocks.length - 1]
  }

  private find(id: string): CommandBlock | undefined {
    return this.store.getState().blocks.find((b) => b.id === id)
  }

  private inAltScreen(): boolean {
    return this.term.buffer.active.type === 'alternate'
  }
}
