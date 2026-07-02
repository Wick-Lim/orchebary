/**
 * Coalesces PTY output chunks into batched frames so a firehose like
 * `cat bigfile` becomes ~200 IPC messages/sec instead of thousands.
 * Flushes when FLUSH_INTERVAL_MS elapses after the first unflushed chunk,
 * or immediately once MAX_BATCH_BYTES is buffered.
 */
const FLUSH_INTERVAL_MS = 5
const MAX_BATCH_BYTES = 64 * 1024

export class DataBatcher {
  private chunks: Buffer[] = []
  private size = 0
  private timer: NodeJS.Timeout | null = null
  private disposed = false

  constructor(private readonly onFlush: (data: Uint8Array) => void) {}

  push(data: string | Buffer): void {
    if (this.disposed) return
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data
    this.chunks.push(buf)
    this.size += buf.length
    if (this.size >= MAX_BATCH_BYTES) {
      this.flush()
    } else if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), FLUSH_INTERVAL_MS)
    }
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.size === 0) return
    const frame = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks, this.size)
    this.chunks = []
    this.size = 0
    this.onFlush(frame)
  }

  dispose(): void {
    this.flush()
    this.disposed = true
    if (this.timer) clearTimeout(this.timer)
  }
}
