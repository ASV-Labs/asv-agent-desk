/**
 * A minimal PTY interface, plus the real node-pty implementation.
 *
 * SessionManager depends on this shape rather than on node-pty directly, so
 * the lifecycle can be unit-tested without spawning real processes. The real
 * factory is the only place node-pty is imported.
 */

export interface PtyHandle {
  readonly pid: number
  write(data: string): void
  resize(cols: number, rows: number): void
  pause(): void
  resume(): void
  kill(signal?: string): void
  onData(cb: (data: string) => void): void
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void
  /**
   * Detach every listener.
   *
   * Called before `kill` during shutdown. Without it, node-pty can invoke a JS
   * callback while the native module is being torn down, which surfaces as
   * `libc++abi: terminating due to uncaught exception of type Napi::Error` on
   * quit rather than a clean exit.
   */
  dispose(): void
}

export interface PtySpawnOptions {
  cwd: string
  command: string
  args: string[]
  cols: number
  rows: number
}

export type PtyFactory = (opts: PtySpawnOptions) => PtyHandle

/**
 * Start a command through a login shell without constructing shell source.
 *
 * `-c` still gives Finder-launched builds the user's login PATH, but the
 * executable and every argument travel as positional values (`$0`, `$@`).
 * Spaces, quotes, dollar signs, substitutions, and semicolons therefore stay
 * data instead of becoming a second command.
 */
export function loginShellSpawnArgs(command: string, args: string[]): string[] {
  return ['-l', '-c', 'exec "$0" "$@"', command, ...args]
}

/** The real thing. Kept out of the test path entirely. */
export const nodePtyFactory: PtyFactory = (opts) => {
  // Required lazily so unit tests never load the native module.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pty = require('node-pty') as typeof import('node-pty')

  // Spawn through a LOGIN shell (-l). The grok installer appends to ~/.zshrc,
  // and Electron does not inherit that PATH when launched from Finder.
  // Without -l, `grok` is simply not found in a packaged build.
  const shell = process.env.SHELL || '/bin/zsh'

  const proc = pty.spawn(shell, loginShellSpawnArgs(opts.command, opts.args), {
    name: 'xterm-256color',
    cwd: opts.cwd,
    cols: opts.cols,
    rows: opts.rows,
    env: {
      ...(process.env as Record<string, string>),
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      LANG: process.env.LANG ?? 'en_US.UTF-8',
    },
  })

  const subscriptions: Array<{ dispose: () => void }> = []

  return {
    pid: proc.pid,
    write: (data) => proc.write(data),
    resize: (cols, rows) => proc.resize(cols, rows),
    pause: () => proc.pause(),
    resume: () => proc.resume(),
    kill: (signal?: string) => proc.kill(signal),
    onData: (cb) => {
      subscriptions.push(proc.onData(cb))
    },
    onExit: (cb) => {
      subscriptions.push(proc.onExit(({ exitCode, signal }) => cb({ exitCode, signal })))
    },
    dispose: () => {
      for (const sub of subscriptions) {
        try {
          sub.dispose()
        } catch {
          // Already torn down.
        }
      }
      subscriptions.length = 0
    },
  }
}
