import type { Terminal } from '@xterm/xterm'
import type { CommandBlock } from './blockStore'

/**
 * Lazily extract a block's output from the live buffer — never cached, since
 * reflow/trim move marker lines. Range: [outputMarker.line, endMarker.line)
 * (the end marker sits on the row where the next prompt begins).
 */
export function extractBlockOutput(term: Terminal, block: CommandBlock): string {
  const buf = term.buffer.active
  const start = block.outputMarker && !block.outputMarker.isDisposed ? block.outputMarker.line : -1
  if (start < 0) return ''
  const end =
    block.endMarker && !block.endMarker.isDisposed
      ? block.endMarker.line
      : buf.baseY + buf.cursorY + 1 // still running: read up to the cursor row

  const lines: string[] = []
  for (let y = start; y < end && y < buf.length; y++) {
    const line = buf.getLine(y)
    if (!line) continue
    const text = line.translateToString(true)
    // Rejoin soft-wrapped rows into their logical line.
    if (line.isWrapped && lines.length > 0) lines[lines.length - 1] += text
    else lines.push(text)
  }
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines.join('\n')
}
