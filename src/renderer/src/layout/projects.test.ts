import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildSidebar, labelProjects, nestForks, type SidebarRow } from './projects'
import type { SessionInfo } from '../../../shared/ipc'
import type { StoredProject } from '../../../shared/store'

const liveSession = (over: Partial<SessionInfo> = {}): SessionInfo => ({
  id: 'live-1',
  cwd: '/tmp/alpha',
  baseCwd: '/tmp/alpha',
  command: 'grok',
  args: [],
  title: 'grok',
  state: 'running',
  pid: 1,
  cols: 80,
  rows: 24,
  createdAt: 5000,
  activity: 'working',
  activitySince: 5000,
  subagents: 0,
  ...over,
})

const project = (cwd: string, ids: string[], updatedAt = 1000): StoredProject => ({
  cwd,
  name: cwd.split('/').filter(Boolean).pop() ?? cwd,
  updatedAt,
  sessions: ids.map((id) => ({
    id,
    cwd,
    title: `Title ${id}`,
    createdAt: updatedAt,
    updatedAt,
  })),
})

describe('labelProjects', () => {
  it('uses the leaf name when it is unique', () => {
    const labels = labelProjects(['/a/web', '/b/api'])
    assert.equal(labels.get('/a/web'), 'web')
    assert.equal(labels.get('/b/api'), 'api')
  })

  // Two checkouts both called `web` are otherwise indistinguishable.
  it('falls back to parent/leaf when leaves collide', () => {
    const labels = labelProjects(['/clients/acme/web', '/clients/globex/web'])
    assert.equal(labels.get('/clients/acme/web'), 'acme/web')
    assert.equal(labels.get('/clients/globex/web'), 'globex/web')
  })
})

describe('nestForks', () => {
  const row = (id: string, parentSessionId?: string): SidebarRow => ({
    id,
    cwd: '/tmp/p',
    title: id,
    createdAt: 0,
    updatedAt: 0,
    depth: 0,
    forkPath: '',
    liveSession: liveSession({ id, parentSessionId }),
  })

  it('places a fork directly beneath its parent', () => {
    const out = nestForks([row('parent'), row('other'), row('fork', 'parent')])
    assert.deepEqual(
      out.map((r) => [r.id, r.depth]),
      [
        ['parent', 0],
        ['fork', 1],
        ['other', 0],
      ],
    )
  })

  it('nests forks of forks', () => {
    const out = nestForks([row('a'), row('b', 'a'), row('c', 'b')])
    assert.deepEqual(
      out.map((r) => r.depth),
      [0, 1, 2],
    )
  })

  it('keeps siblings in order under one parent', () => {
    const out = nestForks([row('p'), row('f1', 'p'), row('f2', 'p')])
    assert.deepEqual(
      out.map((r) => r.id),
      ['p', 'f1', 'f2'],
    )
  })

  // A stored session has no live record, so its edge can only come from the
  // persisted lineage file. Reading the live field alone flattened the tree on
  // every relaunch.
  it('nests a stored fork using persisted lineage', () => {
    const stored = (id: string): SidebarRow => ({
      id,
      cwd: '/tmp/p',
      title: id,
      createdAt: 0,
      updatedAt: 0,
      depth: 0,
      forkPath: '',
    })

    const out = nestForks(
      [stored('parent'), stored('fork')],
      new Map([['fork', 'parent']]),
    )

    assert.deepEqual(
      out.map((r) => [r.id, r.depth]),
      [
        ['parent', 0],
        ['fork', 1],
      ],
    )
  })

  it('prefers the live parent over the persisted edge', () => {
    const out = nestForks(
      [row('a'), row('b'), row('c', 'a')],
      new Map([['c', 'b']]),
    )
    const c = out.find((r) => r.id === 'c')!
    assert.equal(c.depth, 1)
    assert.equal(out[1].id, 'c', 'should sit under a, not b')
  })

  // The parent may be in another project, or closed and gone.
  it('shows an orphaned fork at the top level rather than dropping it', () => {
    const out = nestForks([row('fork', 'missing-parent')])
    assert.equal(out.length, 1)
    assert.equal(out[0].depth, 0)
  })

  // Only reachable via a corrupt lineage file, but recursing forever over the
  // sidebar is a bad way to discover that.
  it('survives a lineage cycle', () => {
    const out = nestForks([row('a', 'b'), row('b', 'a')])
    assert.equal(out.length, 2)
    assert.deepEqual(new Set(out.map((r) => r.id)), new Set(['a', 'b']))
  })

  it('ignores a session claiming to be its own parent', () => {
    const out = nestForks([row('self', 'self')])
    assert.equal(out[0].depth, 0)
  })

  it('leaves a flat list untouched', () => {
    const out = nestForks([row('a'), row('b')])
    assert.deepEqual(
      out.map((r) => r.depth),
      [0, 0],
    )
  })
})

/**
 * The shape a real fork actually produces.
 *
 * These tests exist because the previous lineage tests put parent and fork in
 * the *same* project — a shape that cannot occur once a worktree session knows
 * its own checkout. They passed while the live app rendered three flat
 * top-level groups, which is the same failure mode as testing an invented JSON
 * envelope: the assertion matched the imagined data, not the real data.
 */
describe('buildSidebar with real worktree lineage', () => {
  const PROJECT = '/tmp/myrepo'
  const FORK_WT = '/home/u/.grok/worktrees/myrepo/2026-07-18-df02b9da'
  const GRAND_WT = '/home/u/.grok/worktrees/myrepo/2026-07-18-572de25a'

  const storedProject = (cwd: string, ids: string[]): StoredProject => ({
    cwd,
    name: cwd.split('/').filter(Boolean).pop() ?? cwd,
    updatedAt: 1000,
    sessions: ids.map((id) => ({ id, cwd, title: `Task ${id}`, createdAt: 1000, updatedAt: 1000 })),
  })

  it('keeps a fork under its parent even though they are different checkouts', () => {
    const out = buildSidebar(
      [storedProject(PROJECT, ['parent']), storedProject(FORK_WT, ['fork'])],
      [],
      new Map([['fork', 'parent']]),
    )

    assert.equal(out.length, 1, 'a worktree is a variant of a project, not a project')
    assert.equal(out[0].cwd, PROJECT)
    assert.deepEqual(
      out[0].rows.map((r) => [r.id, r.depth]),
      [
        ['parent', 0],
        ['fork', 1],
      ],
    )
  })

  it('nests a fork of a fork across three checkouts', () => {
    const out = buildSidebar(
      [
        storedProject(PROJECT, ['parent']),
        storedProject(FORK_WT, ['fork']),
        storedProject(GRAND_WT, ['grand']),
      ],
      [],
      new Map([
        ['fork', 'parent'],
        ['grand', 'fork'],
      ]),
    )

    assert.equal(out.length, 1)
    assert.deepEqual(
      out[0].rows.map((r) => r.depth),
      [0, 1, 2],
    )
  })

  // A badge that renumbers when a sibling appears reads as an identifier but
  // behaves like a row position, which is the worst of both.
  it('keeps existing fork numbers stable when a newer sibling appears', () => {
    const withOne = buildSidebar(
      [
        { ...storedProject(PROJECT, ['p']) },
        {
          cwd: FORK_WT,
          name: 'wt',
          updatedAt: 2000,
          sessions: [{ id: 'first', cwd: FORK_WT, title: 'First', createdAt: 2000, updatedAt: 2000 }],
        },
      ],
      [],
      new Map([['first', 'p']]),
    )
    assert.equal(withOne[0].rows.find((r) => r.id === 'first')?.forkPath, '1')

    const withTwo = buildSidebar(
      [
        { ...storedProject(PROJECT, ['p']) },
        {
          cwd: FORK_WT,
          name: 'wt',
          updatedAt: 2000,
          sessions: [{ id: 'first', cwd: FORK_WT, title: 'First', createdAt: 2000, updatedAt: 2000 }],
        },
        {
          cwd: GRAND_WT,
          name: 'wt2',
          updatedAt: 9000,
          sessions: [
            { id: 'second', cwd: GRAND_WT, title: 'Second', createdAt: 9000, updatedAt: 9000 },
          ],
        },
      ],
      [],
      new Map([
        ['first', 'p'],
        ['second', 'p'],
      ]),
    )

    const paths = Object.fromEntries(withTwo[0].rows.map((r) => [r.id, r.forkPath]))
    assert.equal(paths.first, '1', 'the older fork must keep its number')
    assert.equal(paths.second, '2')
  })

  it('numbers forks by position in the tree', () => {
    const out = buildSidebar(
      [
        storedProject(PROJECT, ['p']),
        storedProject(FORK_WT, ['f1']),
        storedProject(GRAND_WT, ['f1a']),
      ],
      [],
      new Map([
        ['f1', 'p'],
        ['f1a', 'f1'],
      ]),
    )

    const paths = Object.fromEntries(out[0].rows.map((r) => [r.id, r.forkPath]))
    assert.equal(paths.p, '')
    assert.equal(paths.f1, '1')
    assert.equal(paths.f1a, '1.1')
  })

  // Placement follows the parent, which is known at spawn — so a fork never
  // appears in the wrong group while waiting for its first hook event.
  it('places a live fork immediately, before its cwd has been corrected', () => {
    const out = buildSidebar(
      [storedProject(PROJECT, ['parent'])],
      [
        liveSession({
          id: 'fresh-fork',
          // Still reporting the launch directory; the hook has not landed yet.
          cwd: PROJECT,
          baseCwd: PROJECT,
          parentSessionId: 'parent',
          isWorktree: true,
        }),
      ],
    )

    assert.equal(out.length, 1)
    assert.deepEqual(
      out[0].rows.map((r) => [r.id, r.depth]),
      [
        ['parent', 0],
        ['fresh-fork', 1],
      ],
    )
  })

  it('does not move the fork once its cwd corrects to the worktree', () => {
    const corrected = buildSidebar(
      [storedProject(PROJECT, ['parent'])],
      [
        liveSession({
          id: 'fresh-fork',
          cwd: FORK_WT,
          baseCwd: PROJECT,
          parentSessionId: 'parent',
          isWorktree: true,
        }),
      ],
    )

    assert.equal(corrected.length, 1, 'correction must not spawn a second group')
    assert.equal(corrected[0].cwd, PROJECT)
  })

  // A `grok -w` started by hand has no parent, so it is genuinely its own root.
  it('gives an unparented worktree session its own group', () => {
    const out = buildSidebar([storedProject(FORK_WT, ['loner'])], [])
    assert.equal(out.length, 1)
    assert.equal(out[0].cwd, FORK_WT)
  })

  it('keeps unrelated projects apart', () => {
    const out = buildSidebar(
      [storedProject('/tmp/a', ['a1']), storedProject('/tmp/b', ['b1'])],
      [],
    )
    assert.equal(out.length, 2)
  })

  it('survives a lineage cycle across projects', () => {
    const out = buildSidebar(
      [storedProject(PROJECT, ['x']), storedProject(FORK_WT, ['y'])],
      [],
      new Map([
        ['x', 'y'],
        ['y', 'x'],
      ]),
    )
    const ids = out.flatMap((p) => p.rows.map((r) => r.id))
    assert.deepEqual(new Set(ids), new Set(['x', 'y']))
  })
})

describe('buildSidebar', () => {
  it('joins a live session onto its stored row', () => {
    const result = buildSidebar([project('/tmp/alpha', ['s1'])], [liveSession({ id: 's1' })])

    assert.equal(result[0].rows.length, 1, 'must not duplicate the row')
    assert.equal(result[0].rows[0].liveSession?.id, 's1')
    assert.equal(result[0].liveCount, 1)
  })

  // The bug this function exists to fix: a new session in a project that
  // already had history vanished until Grok flushed it to disk.
  it('shows a live session whose project already has history but has not hit disk', () => {
    const result = buildSidebar([project('/tmp/alpha', ['old'])], [liveSession({ id: 'brand-new' })])

    assert.equal(result[0].rows.length, 2)
    assert.equal(result[0].rows[0].id, 'brand-new', 'unsaved sessions sort to the top')
    assert.equal(result[0].liveCount, 1)
  })

  it('creates a project for a live session in an unknown directory', () => {
    const result = buildSidebar([], [liveSession({ cwd: '/tmp/brand-new-dir' })])

    assert.equal(result.length, 1)
    assert.equal(result[0].cwd, '/tmp/brand-new-dir')
    assert.equal(result[0].rows.length, 1)
  })

  it('never places the same session twice', () => {
    const result = buildSidebar(
      [project('/tmp/alpha', ['s1']), project('/tmp/beta', ['s2'])],
      [liveSession({ id: 's1' }), liveSession({ id: 's2', cwd: '/tmp/beta' })],
    )

    const ids = result.flatMap((p) => p.rows.map((r) => r.id))
    assert.deepEqual([...new Set(ids)].sort(), ids.sort())
  })

  it('orders projects by most recent activity', () => {
    const result = buildSidebar(
      [project('/tmp/old', ['a'], 1000), project('/tmp/recent', ['b'], 9000)],
      [],
    )
    assert.deepEqual(
      result.map((p) => p.cwd),
      ['/tmp/recent', '/tmp/old'],
    )
  })

  it('handles no sessions at all', () => {
    assert.deepEqual(buildSidebar([], []), [])
  })
})
