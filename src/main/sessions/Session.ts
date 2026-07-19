import { RingBuffer } from './RingBuffer'
import type { PtyFactory, PtyHandle } from './pty'
import { acknowledge, initialActivity, reduceActivity, type Activity } from '../hooks/activity'
import type { HookEvent } from '../../shared/hooks'
import type { SessionCreateOptions, SessionInfo, SessionState } from '../../shared/ipc'

/**
 * Backpressure thresholds, in bytes of un-acknowledged output.
 *
 * Grok's plan viewer and subagent panel redraw aggressively. Without this the
 * PTY outruns the renderer, the IPC queue grows unboundedly, and frames tear.
 * Only applied while a view is attached — a detached session writes solely to
 * its (bounded) replay buffer, so there is nothing to fall behind.
 */
export const HIGH_WATER = 512 * 1024
export const LOW_WATER = 128 * 1024

/** Replay buffer size. Roughly a few full screens of a dense TUI repaint. */
export const REPLAY_BYTES = 256 * 1024

export interface SessionCallbacks {
  onData: (id: string, data: string) => void
  onStateChange: (session: Session) => void
}

/**
 * A single Grok session: one PTY, one replay buffer, and at most one attached
 * view. The session owns the process — views come and go.
 *
 * This ownership split is the point of the class. Previously the PTY was
 * created inside a React effect, so a remount could dispose a live process or
 * strand an orphan when creation resolved after unmount.
 */
export class Session {
  readonly id: string
  /** Directory the session was launched from. Never changes. */
  readonly baseCwd: string

  /**
   * Where the agent is actually working.
   *
   * For a normal session this equals `baseCwd`. For a `-w` session it is the
   * worktree Grok created, which ASV Agent Desk cannot know in advance — Grok picks
   * the name and prints it to the terminal, and reading the terminal is not
   * something this app does.
   *
   * The first hook event solves it: hooks fire from inside the session's own
   * working directory, so `event.cwd` reports the real checkout. Until that
   * arrives the session reports its base directory, which is the honest answer.
   *
   * Getting this wrong was the root cause of six separate symptoms in Phase 4:
   * diffs read the parent checkout, forks of forks branched from the wrong
   * base, orphan detection could not match a live session to its worktree, and
   * the sidebar listed the same session twice.
   */
  cwd: string
  readonly command: string
  readonly args: string[]
  readonly createdAt = Date.now()

  title: string
  state: SessionState = 'running'
  exitCode?: number
  cols: number
  rows: number

  /** What the agent is doing, per Grok's hooks. */
  activity: Activity = initialActivity()
  /** Grok's own session id, learned from the first correlated hook event. */
  grokSessionId?: string
  /** Fork lineage — ASV Agent Desk's own record; Grok does not track this. */
  parentSessionId?: string
  worktreeName?: string
  isWorktree = false

  private readonly pty: PtyHandle
  private readonly replay = new RingBuffer(REPLAY_BYTES)
  private readonly cb: SessionCallbacks

  /** Bytes sent to the attached view but not yet confirmed flushed. */
  private pending = 0
  private paused = false
  private attached = false
  private closed = false
  /** Set while closing, so the pty's exit callback can settle the promise. */
  private onClosed: (() => void) | null = null

  constructor(id: string, opts: SessionCreateOptions, spawn: PtyFactory, cb: SessionCallbacks) {
    this.id = id
    this.baseCwd = opts.cwd
    this.cwd = opts.cwd
    this.command = opts.command ?? 'grok'
    this.args = opts.args ?? []
    // The resolved executable may include a personal absolute path. That is an
    // implementation detail, not a session label and not something the
    // sidebar should expose.
    this.title = opts.title ?? 'Grok Build'
    this.cols = opts.cols
    this.rows = opts.rows
    this.cb = cb

    // Hand Grok our own id rather than letting it mint one.
    //
    // This makes hook correlation exact — every event arrives already keyed to
    // the session it belongs to — and removes the ambiguity that existed when
    // two sessions were started in the same directory at the same moment.
    //
    // It also means the on-disk session at
    // ~/.grok/sessions/<url-encoded-cwd>/<our-id>/ is directly addressable,
    // which is what the sidebar reads. Verified working in interactive TUI
    // mode on Grok Build 0.2.103.
    //
    // Resuming uses `--resume` instead, and the session adopts the resumed id,
    // so correlation and on-disk history stay aligned either way.
    this.grokSessionId = id
    const idFlag = opts.resumeSessionId ? '--resume' : '--session-id'

    // Worktree flags come first so they read the way the docs write them.
    // A bare `-w` branches from current HEAD including uncommitted changes;
    // `--ref` gives a clean checkout of a named ref instead.
    const worktreeArgs: string[] = []
    if (opts.worktree) {
      worktreeArgs.push(opts.worktree.name ? `--worktree=${opts.worktree.name}` : '-w')
      if (opts.worktree.ref) worktreeArgs.push('--ref', opts.worktree.ref)
      this.isWorktree = true
      this.worktreeName = opts.worktree.name
    }

    this.parentSessionId = opts.parentSessionId

    const authArgs = opts.oauth ? ['--oauth'] : []

    this.pty = spawn({
      cwd: this.cwd,
      command: this.command,
      args: [...worktreeArgs, ...authArgs, ...this.args, idFlag, id],
      cols: this.cols,
      rows: this.rows,
    })

    this.pty.onData((data) => {
      // Always buffer, so a view attaching later sees recent history.
      this.replay.push(data)

      if (!this.attached) return

      this.pending += Buffer.byteLength(data, 'utf8')
      if (!this.paused && this.pending > HIGH_WATER) {
        this.paused = true
        this.pty.pause()
      }
      this.cb.onData(this.id, data)
    })

    this.pty.onExit(({ exitCode }) => {
      this.state = 'exited'
      this.exitCode = exitCode
      this.activity = { ...this.activity, state: 'exited', since: Date.now(), subagents: 0 }

      // Reaching here during shutdown is the point: the native queue has
      // drained, so it is now safe to dispose and let the process exit.
      if (this.onClosed) {
        const done = this.onClosed
        this.onClosed = null
        done()
        return
      }

      this.cb.onStateChange(this)
    })
  }

  /** Fold a hook event into activity state and notify listeners if it moved. */
  applyHookEvent(event: HookEvent): void {
    let changed = false

    // Learn the real working directory. Only for `-w` sessions: a normal
    // session's cwd is already known, and a subagent reporting from somewhere
    // else must not be allowed to move it.
    if (this.isWorktree && event.cwd && event.cwd !== this.cwd) {
      this.cwd = event.cwd
      this.worktreeName ??= event.cwd.split('/').filter(Boolean).pop()
      changed = true
    }

    const next = reduceActivity(this.activity, event)
    if (next !== this.activity) {
      this.activity = next
      changed = true
    }

    if (changed) this.cb.onStateChange(this)
  }

  /** Called when the user focuses this session: clears a pending `needs-you`. */
  acknowledge(): void {
    const next = acknowledge(this.activity)
    if (next === this.activity) return
    this.activity = next
    this.cb.onStateChange(this)
  }

  get info(): SessionInfo {
    return {
      id: this.id,
      cwd: this.cwd,
      baseCwd: this.baseCwd,
      command: this.command,
      args: this.args,
      title: this.title,
      state: this.state,
      pid: this.pty.pid,
      cols: this.cols,
      rows: this.rows,
      createdAt: this.createdAt,
      exitCode: this.exitCode,
      activity: this.activity.state,
      activitySince: this.activity.since,
      subagents: this.activity.subagents,
      lastTool: this.activity.lastTool,
      grokSessionId: this.grokSessionId,
      parentSessionId: this.parentSessionId,
      worktreeName: this.worktreeName,
      isWorktree: this.isWorktree,
    }
  }

  get isAttached(): boolean {
    return this.attached
  }

  /**
   * Bind a view. Returns buffered output for the view to replay.
   *
   * Attaching does not restart anything: the process has been running the
   * whole time. A second attach replaces the first rather than erroring,
   * because a React remount can attach before the old effect's cleanup runs.
   */
  attach(): string {
    this.attached = true
    this.pending = 0
    if (this.paused) {
      this.paused = false
      this.pty.resume()
    }
    return this.replay.snapshot()
  }

  /** Unbind the view. The process keeps running — that is the whole design. */
  detach(): void {
    this.attached = false
    this.pending = 0
    if (this.paused) {
      this.paused = false
      this.pty.resume()
    }
  }

  /** Raw bytes straight through. No transforms, ever. */
  write(data: string): void {
    if (this.closed || this.state === 'exited') return
    this.pty.write(data)
  }

  resize(cols: number, rows: number): void {
    if (this.closed || this.state === 'exited') return
    // node-pty throws on non-positive dimensions, which happens transiently
    // while panes are dragged or the window is minimised.
    if (cols < 1 || rows < 1) return
    if (cols === this.cols && rows === this.rows) return
    this.cols = cols
    this.rows = rows
    try {
      this.pty.resize(cols, rows)
    } catch {
      // A resize racing process exit is harmless.
    }
  }

  /**
   * Force a full repaint by bouncing the row count.
   *
   * A fullscreen TUI on the alternate screen does not redraw just because a
   * new view attached, so replaying the buffer alone can leave a stale frame.
   * Two resizes emit SIGWINCH, and Grok repaints from scratch.
   */
  nudgeRedraw(): void {
    if (this.closed || this.state === 'exited') return
    if (this.rows < 2) return
    try {
      this.pty.resize(this.cols, this.rows - 1)
      this.pty.resize(this.cols, this.rows)
    } catch {
      // Non-fatal: worst case the view shows the replayed frame.
    }
  }

  ack(bytes: number): void {
    this.pending = Math.max(0, this.pending - bytes)
    if (this.paused && this.pending < LOW_WATER) {
      this.paused = false
      this.pty.resume()
    }
  }

  /**
   * Terminate the process. Idempotent.
   *
   * Returns a promise that settles once the PTY has actually exited, so
   * shutdown can wait for node-pty's thread-safe queue to drain.
   *
   * Ordering matters and is counter-intuitive. An earlier version disposed
   * listeners *before* `kill`, reasoning that a detached listener cannot fire
   * during teardown. It crashed anyway: the callback was already queued inside
   * the native module, below the JS listener layer, and Node's
   * `Environment::CleanupHandles()` drained it after the environment was being
   * freed. The fix is not to detach faster — it is to let the exit callback
   * actually run, and only then dispose.
   */
  close(): Promise<void> {
    if (this.closed) return Promise.resolve()
    this.closed = true
    this.attached = false
    this.replay.clear()

    return new Promise<void>((resolve) => {
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        clearTimeout(escalate)
        clearTimeout(timer)
        try {
          this.pty.dispose()
        } catch {
          // Already torn down.
        }
        resolve()
      }

      // Escalate rather than hope. A closed session was seen lingering in `ps`
      // until the whole app quit — which matters doubly for worktrees, since a
      // process still holding a checkout while the UI believes it is gone is
      // how a live worktree ends up offered for deletion.
      const escalate = setTimeout(() => {
        try {
          this.pty.kill('SIGKILL')
        } catch {
          // Already gone.
        }
      }, 600)

      // The outer cap is the one conditional part of the crash fix: if an exit
      // callback arrives later than this, we dispose anyway and the original
      // queued-callback risk returns. Sessions drain in parallel, so a
      // generous window costs nothing normally and only bounds the
      // pathological case. Observed drains complete well under 100ms.
      const timer = setTimeout(finish, 1500)
      this.onClosed = finish

      try {
        this.pty.kill()
      } catch {
        // Already gone — nothing will call back, so settle now.
        finish()
      }
    })
  }
}
