import { useCallback, useEffect, useState } from 'react'
import Icon from '../ui/Icon'
import type { Worktree } from '../../../shared/worktrees'

/**
 * Worktree housekeeping.
 *
 * Grok creates worktrees but never reaps them: `worktree gc` runs only when
 * invoked, so a week of parallel agents leaves a disk full of checkouts nobody
 * remembers making. This is the lifecycle story the TUI does not have.
 *
 * Only worktrees with no live session and no uncommitted changes are offered
 * for removal, and that check happens in main as well as here — a worktree
 * exists precisely so parallel work does not get clobbered, and removing one
 * is the single destructive thing this app can do.
 */
export default function WorktreePanel(): React.JSX.Element | null {
  const [worktrees, setWorktrees] = useState<Worktree[]>([])
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(() => {
    void window.agentDesk.worktrees.list().then(setWorktrees)
  }, [])

  /**
   * Refresh on session change, not only on a timer.
   *
   * A 30-second poll meant reapability could be half a minute stale — and a
   * destructive control changing underneath a live session is exactly the
   * wrong thing to leave to a timer. Session state changes now drive it, with
   * a slow poll behind that for dirtiness that git alone would notice.
   */
  useEffect(() => {
    refresh()
    const off = window.agentDesk.sessions.onStateChange(refresh)
    const t = window.setInterval(refresh, 10_000)
    return () => {
      off()
      window.clearInterval(t)
    }
  }, [refresh])

  const remove = useCallback(
    async (name: string) => {
      setBusy(name)
      setError(null)
      const result = await window.agentDesk.worktrees.remove(name)
      setBusy(null)
      if (!result.ok) setError(result.reason ?? 'Could not remove worktree')
      refresh()
    },
    [refresh],
  )

  if (worktrees.length === 0) return null

  const reapable = worktrees.filter((w) => w.orphaned)

  return (
    <div className="worktrees">
      <div className="project-head" onClick={() => setOpen((v) => !v)}>
        <span className="project-caret">
          <Icon name={open ? 'chevron-down' : 'chevron-right'} size={12} />
        </span>
        <span className="project-name">Worktrees</span>
        {reapable.length > 0 && (
          <span className="project-count" title={`${reapable.length} can be removed`}>
            {reapable.length}
          </span>
        )}
      </div>

      {open && (
        <div className="worktree-list">
          {error && <div className="worktree-error">{error}</div>}

          {worktrees.map((worktree) => (
            <div key={worktree.path} className="worktree-row" title={worktree.path}>
              <div className="worktree-body">
                <div className="worktree-name">{worktree.name}</div>
                <div className="worktree-sub">
                  {worktree.branch ?? worktree.head}
                  {worktree.added > 0 || worktree.removed > 0
                    ? ` · +${worktree.added} −${worktree.removed}`
                    : ''}
                  {worktree.liveSessionIds.length > 0
                    ? ' · running'
                    : worktree.dirty
                      ? ' · uncommitted'
                      : ''}
                </div>
              </div>

              {worktree.orphaned && (
                <button
                  className="session-close"
                  title="Remove this worktree"
                  disabled={busy === worktree.name}
                  onClick={() => void remove(worktree.name)}
                >
                  <Icon name="close" size={12} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
