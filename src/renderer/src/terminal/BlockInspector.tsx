import { useMemo, useState } from 'react'
import { useStore } from 'zustand'
import { terminalRegistry } from './TerminalRegistry'
import { getBlockStore, type BlockStore, type CommandBlock } from './blockStore'
import { extractBlockOutput } from './blockOutput'

/**
 * Right-side overlay inside the terminal area showing a block's full output —
 * selectable monospace text with a substring line filter. Opened from the
 * header "open output" action; simple conditional render, no library.
 */
export function BlockInspector({ sessionId }: { sessionId: string }): React.JSX.Element | null {
  const store = getBlockStore(sessionId)
  const block = useStore(store, (s) => s.blocks.find((b) => b.id === s.inspectedBlockId))
  if (!block) return null
  // Keyed by block id so the filter input resets when another block opens.
  return <InspectorPanel key={block.id} sessionId={sessionId} store={store} block={block} />
}

function InspectorPanel({
  sessionId,
  store,
  block
}: {
  sessionId: string
  store: BlockStore
  block: CommandBlock
}): React.JSX.Element {
  const [filter, setFilter] = useState('')

  const output = useMemo(() => {
    const bundle = terminalRegistry.get(sessionId)
    return bundle ? extractBlockOutput(bundle.term, block) : ''
    // Block identity changes on every state update, refreshing the snapshot.
  }, [sessionId, block])

  const lines = output === '' ? [] : output.split('\n')
  const needle = filter.trim().toLowerCase()
  const visible = needle ? lines.filter((l) => l.toLowerCase().includes(needle)) : lines

  return (
    <div className="orb-inspector">
      <div className="orb-inspector-head">
        <span className="orb-inspector-title" title={block.command}>
          {block.command ?? '(no command)'}
        </span>
        <button
          type="button"
          className="orb-inspector-close"
          title="Close"
          aria-label="Close inspector"
          onClick={() => store.setState({ inspectedBlockId: null })}
        >
          ✕
        </button>
      </div>
      <input
        className="orb-inspector-filter"
        type="text"
        placeholder="Filter output…"
        spellCheck={false}
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      <pre className="orb-inspector-body">{visible.join('\n')}</pre>
      <div className="orb-inspector-foot">
        <span>
          {visible.length}/{lines.length} lines
        </span>
        {block.exitCode !== undefined && <span>exit {block.exitCode}</span>}
        {block.cwd && (
          <span className="orb-inspector-cwd" title={block.cwd}>
            {block.cwd}
          </span>
        )}
      </div>
    </div>
  )
}
