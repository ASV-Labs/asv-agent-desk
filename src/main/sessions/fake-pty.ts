import type { PtyFactory, PtyHandle, PtySpawnOptions } from './pty'

/**
 * Test double for a PTY. Records everything and lets tests drive output and
 * exit directly, so the session lifecycle can be exercised without spawning
 * real processes.
 */
export class FakePty implements PtyHandle {
  static nextPid = 1000

  readonly pid = FakePty.nextPid++
  readonly opts: PtySpawnOptions
  readonly written: string[] = []
  readonly resizes: Array<[number, number]> = []

  killCount = 0
  pauseCount = 0
  resumeCount = 0
  disposeCount = 0
  paused = false
  /** Order matters at shutdown: listeners must go before the kill. */
  readonly teardownOrder: string[] = []

  private dataCb?: (data: string) => void
  private exitCb?: (e: { exitCode: number; signal?: number }) => void

  constructor(opts: PtySpawnOptions) {
    this.opts = opts
  }

  write(data: string): void {
    this.written.push(data)
  }

  resize(cols: number, rows: number): void {
    this.resizes.push([cols, rows])
  }

  pause(): void {
    this.paused = true
    this.pauseCount++
  }

  resume(): void {
    this.paused = false
    this.resumeCount++
  }

  /** Mimics a real pty: killing leads to an exit callback, asynchronously. */
  kill(): void {
    this.killCount++
    this.teardownOrder.push('kill')
    queueMicrotask(() => this.exitCb?.({ exitCode: 0 }))
  }

  dispose(): void {
    this.disposeCount++
    this.teardownOrder.push('dispose')
    this.dataCb = undefined
    this.exitCb = undefined
  }

  onData(cb: (data: string) => void): void {
    this.dataCb = cb
  }

  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void {
    this.exitCb = cb
  }

  // --- test drivers ---

  emit(data: string): void {
    this.dataCb?.(data)
  }

  exit(exitCode = 0): void {
    this.exitCb?.({ exitCode })
  }
}

/** Factory plus a record of every PTY it produced, in spawn order. */
export function fakePtyFactory(): { factory: PtyFactory; spawned: FakePty[] } {
  const spawned: FakePty[] = []
  const factory: PtyFactory = (opts) => {
    const p = new FakePty(opts)
    spawned.push(p)
    return p
  }
  return { factory, spawned }
}
