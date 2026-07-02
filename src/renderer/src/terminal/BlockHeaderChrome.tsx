import { useEffect, useState } from 'react'
import { useStore } from 'zustand'
import { terminalRegistry } from './TerminalRegistry'
import { getBlockStore, type CommandBlock } from './blockStore'
import { extractBlockOutput } from './blockOutput'

function formatDuration(ms: number): string {
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`
  const s = Math.round(ms / 1000)
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}

function basename(p?: string): string {
  if (!p) return ''
  const parts = p.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? '/'
}

/** Re-render every 250ms while enabled — live-ticking duration. */
function useNow(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!enabled) return undefined
    const t = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(t)
  }, [enabled])
  return now
}

function ExitBadge({ block }: { block: CommandBlock }): React.JSX.Element | null {
  if (block.state === 'running') {
    return (
      <span className="orb-badge orb-badge-running" title="Running">
        ●
      </span>
    )
  }
  if (block.exitCode === undefined) return null
  // Distinct glyph + color: readable for colorblind users.
  return block.exitCode === 0 ? (
    <span className="orb-badge orb-badge-ok" title="Exited 0">
      ✓
    </span>
  ) : (
    <span className="orb-badge orb-badge-err" title={`Exited ${block.exitCode}`}>
      ✕ {block.exitCode}
    </span>
  )
}

/**
 * The chrome strip rendered over a block's prompt row (via decoration portal)
 * and reused inside the sticky header. Renders nothing while the block is
 * still an open prompt so the live shell prompt stays visible.
 */
export function BlockHeaderChrome({
  sessionId,
  blockId,
  sticky = false
}: {
  sessionId: string
  blockId: string
  sticky?: boolean
}): React.JSX.Element | null {
  const store = getBlockStore(sessionId)
  const block = useStore(store, (s) => s.blocks.find((b) => b.id === blockId))
  const shellIdle = useStore(store, (s) => s.blocks[s.blocks.length - 1]?.state === 'prompt')
  const now = useNow(block?.state === 'running')
  if (!block || block.state === 'prompt') return null

  const durationMs =
    block.startedAt !== undefined ? (block.endedAt ?? now) - block.startedAt : undefined
  const canRerun = shellIdle && !!block.command

  const copyCommand = (): void => {
    if (block.command) void navigator.clipboard.writeText(block.command)
  }
  const copyOutput = (): void => {
    const bundle = terminalRegistry.get(sessionId)
    if (bundle) void navigator.clipboard.writeText(extractBlockOutput(bundle.term, block))
  }
  const openOutput = (): void => {
    store.setState({ inspectedBlockId: block.id })
  }
  const rerun = (): void => {
    if (canRerun && block.command) {
      window.orchebary.terminal.input(sessionId, block.command + '\r')
    }
  }

  return (
    <div className={sticky ? 'orb-block-header orb-block-header-sticky' : 'orb-block-header'}>
      {block.cwd && (
        <span className="orb-block-cwd" title={block.cwd}>
          {basename(block.cwd)}
        </span>
      )}
      <span className="orb-block-prompt-glyph">❯</span>
      <span className="orb-block-cmd" title={block.command}>
        {block.command ?? ''}
      </span>
      <span className="orb-block-actions">
        <button
          type="button"
          title="Copy command"
          aria-label="Copy command"
          disabled={!block.command}
          onClick={copyCommand}
        >
          ⧉
        </button>
        <button type="button" title="Copy output" aria-label="Copy output" onClick={copyOutput}>
          ≡
        </button>
        <button type="button" title="Open output" aria-label="Open output" onClick={openOutput}>
          ▤
        </button>
        <button
          type="button"
          title={canRerun ? 'Re-run command' : 'Re-run (shell busy)'}
          aria-label="Re-run command"
          disabled={!canRerun}
          onClick={rerun}
        >
          ↻
        </button>
      </span>
      <span className="orb-block-meta">
        {block.hadAltScreen && (
          <span className="orb-badge orb-badge-alt" title="Used the alternate screen">
            ⛶
          </span>
        )}
        {durationMs !== undefined && (
          <span className="orb-block-duration">{formatDuration(durationMs)}</span>
        )}
        <ExitBadge block={block} />
      </span>
    </div>
  )
}
