/**
 * A byte-capped FIFO of output chunks.
 *
 * Every session keeps one so a renderer that mounts late — or remounts after a
 * hot reload — can replay recent output instead of facing a blank terminal.
 * Capped by bytes rather than chunk count because PTY chunk sizes vary wildly:
 * a single frame repaint from Grok's plan viewer can be tens of kilobytes
 * while a keystroke echo is one.
 */
export class RingBuffer {
  private chunks: string[] = []
  private bytes = 0

  constructor(private readonly maxBytes: number) {}

  push(chunk: string): void {
    if (!chunk) return
    this.chunks.push(chunk)
    this.bytes += Buffer.byteLength(chunk, 'utf8')

    while (this.bytes > this.maxBytes && this.chunks.length > 1) {
      const dropped = this.chunks.shift()!
      this.bytes -= Buffer.byteLength(dropped, 'utf8')
    }
  }

  /** Everything retained, oldest first. */
  snapshot(): string {
    return this.chunks.join('')
  }

  get byteLength(): number {
    return this.bytes
  }

  clear(): void {
    this.chunks = []
    this.bytes = 0
  }
}
