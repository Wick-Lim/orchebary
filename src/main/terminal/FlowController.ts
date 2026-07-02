/**
 * Ack-credit backpressure between a PTY and the renderer.
 * The renderer acks bytes as xterm.js finishes parsing them; when unacked
 * bytes exceed the high-water mark we pause the PTY at the kernel buffer,
 * which blocks the producing process instead of buffering unbounded memory.
 */
const HIGH_WATER_BYTES = 1024 * 1024
const LOW_WATER_BYTES = 256 * 1024

export class FlowController {
  private outstanding = 0
  private paused = false

  constructor(
    private readonly pause: () => void,
    private readonly resume: () => void
  ) {}

  sent(bytes: number): void {
    this.outstanding += bytes
    if (!this.paused && this.outstanding > HIGH_WATER_BYTES) {
      this.paused = true
      this.pause()
    }
  }

  acked(bytes: number): void {
    this.outstanding = Math.max(0, this.outstanding - bytes)
    if (this.paused && this.outstanding < LOW_WATER_BYTES) {
      this.paused = false
      this.resume()
    }
  }

  get isPaused(): boolean {
    return this.paused
  }

  get unackedBytes(): number {
    return this.outstanding
  }
}
