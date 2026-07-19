import { randomUUID } from 'node:crypto'
import { Session } from './Session'
import { nodePtyFactory, type PtyFactory } from './pty'
import type { HookEvent } from '../../shared/hooks'
import type {
  SessionAttachResult,
  SessionCreateOptions,
  SessionInfo,
} from '../../shared/ipc'

type DataListener = (id: string, data: string) => void
type StateListener = (info: SessionInfo, removed: boolean) => void

export interface SessionManagerOptions {
  /** Injectable for tests; defaults to the real node-pty adapter. */
  spawn?: PtyFactory
  /** Injectable for tests so ids are deterministic. */
  makeId?: () => string
}

/**
 * The registry of live sessions, and the only thing that owns PTY processes.
 *
 * Renderers reference sessions by id and attach to them. A renderer reload,
 * a React remount, or a window close-and-reopen leaves the processes running;
 * nothing dies until something calls `close`.
 */
export class SessionManager {
  private readonly sessions = new Map<string, Session>()
  private readonly spawn: PtyFactory
  private readonly makeId: () => string

  private dataListener: DataListener = () => {}
  private stateListener: StateListener = () => {}

  constructor(opts: SessionManagerOptions = {}) {
    this.spawn = opts.spawn ?? nodePtyFactory
    this.makeId = opts.makeId ?? (() => randomUUID())
  }

  onData(cb: DataListener): void {
    this.dataListener = cb
  }

  onStateChange(cb: StateListener): void {
    this.stateListener = cb
  }

  create(opts: SessionCreateOptions): SessionInfo {
    // Resuming a session that is already live is a no-op — clicking its row in
    // the sidebar should focus it, not start a second process against the same
    // on-disk history.
    if (opts.resumeSessionId) {
      const existing = this.sessions.get(opts.resumeSessionId)
      if (existing) return existing.info
    }

    const id = opts.resumeSessionId ?? this.makeId()
    const session = new Session(id, opts, this.spawn, {
      onData: (sid, data) => this.dataListener(sid, data),
      onStateChange: (s) => this.stateListener(s.info, false),
    })
    this.sessions.set(id, session)
    this.stateListener(session.info, false)
    return session.info
  }

  list(): SessionInfo[] {
    return [...this.sessions.values()]
      .map((s) => s.info)
      .sort((a, b) => a.createdAt - b.createdAt)
  }

  get(id: string): SessionInfo | undefined {
    return this.sessions.get(id)?.info
  }

  has(id: string): boolean {
    return this.sessions.has(id)
  }

  /**
   * Bind a view to a session and hand back buffered output.
   *
   * Returns undefined for an unknown id rather than throwing: a renderer can
   * legitimately try to reattach to a session that exited and was reaped while
   * the window was closed.
   */
  attach(id: string): SessionAttachResult | undefined {
    const session = this.sessions.get(id)
    if (!session) return undefined
    const replay = session.attach()
    // Let the caller flush the replay before the TUI repaints over it.
    queueMicrotask(() => session.nudgeRedraw())
    return { info: session.info, replay }
  }

  detach(id: string): void {
    this.sessions.get(id)?.detach()
  }

  write(id: string, data: string): void {
    this.sessions.get(id)?.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    this.sessions.get(id)?.resize(cols, rows)
  }

  ack(id: string, bytes: number): void {
    this.sessions.get(id)?.ack(bytes)
  }

  /** Kill the process and drop the session from the registry. Idempotent. */
  /** Clears a pending `needs-you` when the user focuses the session. */
  acknowledge(id: string): void {
    this.sessions.get(id)?.acknowledge()
  }

  /**
   * Route a hook event to the session it belongs to.
   *
   * Normally exact: we pass our own uuid via `grok --session-id`, so Grok
   * reports back the id we already know.
   *
   * The cwd fallback covers sessions we did not start — a `grok` launched by
   * hand in a terminal, or a subagent reporting under a derived id. Those bind
   * to the oldest unbound session in the same directory, which is a guess, but
   * a guess about a session ASV Agent Desk did not create in the first place.
   */
  handleHookEvent(event: HookEvent): void {
    const bound = this.sessions.get(event.sessionId)
    if (bound) {
      bound.applyHookEvent(event)
      return
    }

    const byGrokId = [...this.sessions.values()].find((s) => s.grokSessionId === event.sessionId)
    if (byGrokId) {
      byGrokId.applyHookEvent(event)
      return
    }

    if (!event.cwd) return

    const candidate = [...this.sessions.values()]
      .filter((s) => s.state === 'running' && s.cwd === event.cwd)
      .sort((a, b) => a.createdAt - b.createdAt)[0]

    candidate?.applyHookEvent(event)
  }

  /**
   * Kill the process and drop the session from the registry. Idempotent.
   *
   * Resolves once the PTY has genuinely exited. Only shutdown needs to await
   * it; ordinary closes can ignore the promise.
   */
  close(id: string): Promise<void> {
    const session = this.sessions.get(id)
    if (!session) return Promise.resolve()
    const info = session.info
    this.sessions.delete(id)
    this.stateListener({ ...info, state: 'exited' }, true)
    return session.close()
  }

  /**
   * Close everything and wait for the PTYs to actually die.
   *
   * The waiting is the fix for the crash on quit. node-pty callbacks sitting
   * in its thread-safe queue must be allowed to run before Node frees the
   * environment, or they surface as an uncaught `Napi::Error` inside
   * `Environment::CleanupHandles()`. Exiting faster does not help — the queue
   * is drained by the teardown either way.
   */
  async closeAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.close(id)))
  }

  get size(): number {
    return this.sessions.size
  }
}
