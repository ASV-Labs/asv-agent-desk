import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { WorktreeManager } from './WorktreeManager'
import type { Worktree } from '../../shared/worktrees'

const worktree = (over: Partial<Worktree> = {}): Worktree => ({
  name: '2026-07-18-abc123',
  path: '/home/u/.grok/worktrees/repo/2026-07-18-abc123',
  repo: 'repo',
  branch: 'main',
  head: 'abc1234',
  dirty: false,
  added: 0,
  removed: 0,
  liveSessionIds: [],
  orphaned: true,
  updatedAt: 0,
  ...over,
})

/**
 * Removal is the only destructive operation in the app, and a worktree exists
 * precisely so parallel work does not get clobbered. The live-session branch
 * has been proven against the real app through a direct IPC call; these cover
 * the decision logic itself, including the uncommitted-changes branch that a
 * live probe cannot safely exercise.
 */
describe('WorktreeManager.remove guards', () => {
  const manager = new WorktreeManager('/nonexistent-home')

  it('refuses while a session is running in the worktree', async () => {
    const result = await manager.remove(worktree({ liveSessionIds: ['session-1'] }))
    assert.equal(result.ok, false)
    assert.match(result.reason ?? '', /still running/i)
  })

  it('refuses a worktree with uncommitted changes', async () => {
    const result = await manager.remove(worktree({ dirty: true, added: 12 }))
    assert.equal(result.ok, false)
    assert.match(result.reason ?? '', /uncommitted/i)
    assert.match(result.reason ?? '', /nothing has been removed/i)
  })

  // Live sessions outrank the force flag: forcing past uncommitted changes is
  // a choice someone can make about their own work, but killing the ground out
  // from under a running agent is not.
  it('refuses a live worktree even when forced', async () => {
    const result = await manager.remove(
      worktree({ liveSessionIds: ['session-1'], dirty: true }),
      true,
    )
    assert.equal(result.ok, false)
    assert.match(result.reason ?? '', /still running/i)
  })

  it('allows a forced removal of a dirty but idle worktree', async () => {
    // Reaches the `grok worktree rm` call and fails there, since no such
    // worktree exists — which is exactly the point: the guard let it past.
    const result = await manager.remove(worktree({ dirty: true }), true)
    assert.equal(result.ok, false)
    assert.doesNotMatch(result.reason ?? '', /uncommitted|still running/i)
  })
})
