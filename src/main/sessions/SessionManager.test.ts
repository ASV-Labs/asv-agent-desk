import assert from 'node:assert/strict'
import { beforeEach, describe, it } from 'node:test'
import { SessionManager } from './SessionManager'
import { fakePtyFactory, type FakePty } from './fake-pty'
import { HIGH_WATER, LOW_WATER } from './Session'
import type { SessionInfo } from '../../shared/ipc'

interface Harness {
  mgr: SessionManager
  spawned: FakePty[]
  data: Array<{ id: string; data: string }>
  states: Array<{ info: SessionInfo; removed: boolean }>
}

function harness(): Harness {
  const { factory, spawned } = fakePtyFactory()
  let n = 0
  const mgr = new SessionManager({ spawn: factory, makeId: () => `s${++n}` })

  const data: Array<{ id: string; data: string }> = []
  const states: Array<{ info: SessionInfo; removed: boolean }> = []
  mgr.onData((id, d) => data.push({ id, data: d }))
  mgr.onStateChange((info, removed) => states.push({ info, removed }))

  return { mgr, spawned, data, states }
}

const opts = { cwd: '/tmp/project', cols: 80, rows: 24 }

describe('SessionManager', () => {
  let h: Harness
  beforeEach(() => {
    h = harness()
  })

  it('creates a session and spawns exactly one process', () => {
    const info = h.mgr.create(opts)
    assert.equal(h.spawned.length, 1)
    assert.equal(info.state, 'running')
    assert.equal(info.cwd, '/tmp/project')
    assert.equal(info.command, 'grok')
    assert.deepEqual(
      h.mgr.list().map((s) => s.id),
      [info.id],
    )
  })

  it('lists sessions oldest first', () => {
    const a = h.mgr.create(opts)
    const b = h.mgr.create(opts)
    assert.deepEqual(
      h.mgr.list().map((s) => s.id),
      [a.id, b.id],
    )
  })

  describe('attach / detach', () => {
    it('replays output produced before the view existed', () => {
      const { id } = h.mgr.create(opts)
      h.spawned[0].emit('before-attach')

      const result = h.mgr.attach(id)
      assert.ok(result)
      assert.equal(result.replay, 'before-attach')
    })

    it('does not forward data to the renderer while detached', () => {
      const { id } = h.mgr.create(opts)
      h.spawned[0].emit('quiet')
      assert.equal(h.data.length, 0, 'nothing should stream to a detached view')

      h.mgr.attach(id)
      h.spawned[0].emit('loud')
      assert.deepEqual(h.data, [{ id, data: 'loud' }])
    })

    it('keeps the process alive across detach', () => {
      const { id } = h.mgr.create(opts)
      h.mgr.attach(id)
      h.mgr.detach(id)

      assert.equal(h.spawned[0].killCount, 0, 'detach must never kill')
      assert.equal(h.mgr.has(id), true)
    })

    // This is the Phase 0 bug, as a regression test: a remount used to dispose
    // a live process or strand an orphan created after unmount.
    it('survives a remount without spawning or killing anything', () => {
      const { id } = h.mgr.create(opts)
      h.mgr.attach(id)
      h.spawned[0].emit('frame-1')
      h.mgr.detach(id)

      const again = h.mgr.attach(id)

      assert.equal(h.spawned.length, 1, 'remount must not spawn a second process')
      assert.equal(h.spawned[0].killCount, 0, 'remount must not kill the process')
      assert.ok(again)
      assert.ok(again.replay.includes('frame-1'), 'remount must not show a blank terminal')
    })

    it('tolerates a double attach, as StrictMode produces', () => {
      const { id } = h.mgr.create(opts)
      h.mgr.attach(id)
      const second = h.mgr.attach(id)
      assert.ok(second, 'second attach should succeed, not throw')
      assert.equal(h.spawned.length, 1)
    })

    it('returns undefined for an unknown session rather than throwing', () => {
      assert.equal(h.mgr.attach('nope'), undefined)
    })

    it('nudges a redraw so an alt-screen TUI repaints for the new view', async () => {
      const { id } = h.mgr.create(opts)
      h.mgr.attach(id)
      await new Promise((r) => setTimeout(r, 0))

      // Bounce down then back: two SIGWINCHes, full repaint.
      assert.deepEqual(h.spawned[0].resizes, [
        [80, 23],
        [80, 24],
      ])
    })
  })

  describe('lifecycle', () => {
    it('marks a session exited and reports the code', () => {
      const { id } = h.mgr.create(opts)
      h.spawned[0].exit(3)

      const info = h.mgr.get(id)
      assert.equal(info?.state, 'exited')
      assert.equal(info?.exitCode, 3)
      assert.equal(h.mgr.has(id), true, 'an exited session stays listed until closed')
    })

    it('ignores writes and resizes after exit', () => {
      const { id } = h.mgr.create(opts)
      h.spawned[0].exit(0)

      h.mgr.write(id, 'ignored')
      h.mgr.resize(id, 100, 40)

      assert.deepEqual(h.spawned[0].written, [])
      assert.deepEqual(h.spawned[0].resizes, [])
    })

    it('close kills the process and removes the session', () => {
      const { id } = h.mgr.create(opts)
      h.mgr.close(id)

      assert.equal(h.spawned[0].killCount, 1)
      assert.equal(h.mgr.has(id), false)
      assert.equal(h.states.at(-1)?.removed, true)
    })

    it('close is idempotent', () => {
      const { id } = h.mgr.create(opts)
      h.mgr.close(id)
      h.mgr.close(id)
      assert.equal(h.spawned[0].killCount, 1, 'must not double-kill')
    })

    /**
     * The ordering here is the fix for the crash on quit, and it is the
     * opposite of what seems intuitive.
     *
     * Disposing listeners first does not prevent the crash — the callback is
     * already queued inside node-pty, below the JS layer, and Node's teardown
     * drains it after the environment is being freed. Killing first and
     * waiting for the exit callback lets that queue empty while the
     * environment is still alive; only then is it safe to dispose.
     */
    it('kills first, then disposes once the pty has exited', async () => {
      const { id } = h.mgr.create(opts)
      await h.mgr.close(id)
      assert.deepEqual(h.spawned[0].teardownOrder, ['kill', 'dispose'])
    })

    it('closeAll waits for every pty to exit', async () => {
      h.mgr.create(opts)
      h.mgr.create(opts)
      await h.mgr.closeAll()

      assert.equal(h.mgr.size, 0)
      for (const pty of h.spawned) {
        assert.equal(pty.disposeCount, 1, 'each pty must be disposed exactly once')
      }
    })

    it('closeAll leaves no session behind', () => {
      h.mgr.create(opts)
      h.mgr.create(opts)
      h.mgr.closeAll()

      assert.equal(h.mgr.size, 0)
      assert.deepEqual(
        h.spawned.map((p) => p.killCount),
        [1, 1],
      )
    })
  })

  describe('resize', () => {
    it('rejects non-positive dimensions', () => {
      const { id } = h.mgr.create(opts)
      h.mgr.resize(id, 0, 24)
      h.mgr.resize(id, 80, 0)
      assert.deepEqual(h.spawned[0].resizes, [])
    })

    it('skips no-op resizes so a drag does not spam SIGWINCH', () => {
      const { id } = h.mgr.create(opts)
      h.mgr.resize(id, 80, 24) // same as spawn geometry
      assert.deepEqual(h.spawned[0].resizes, [])

      h.mgr.resize(id, 100, 30)
      h.mgr.resize(id, 100, 30)
      assert.deepEqual(h.spawned[0].resizes, [[100, 30]])
    })
  })

  describe('flow control', () => {
    const chunk = 'x'.repeat(64 * 1024)

    it('pauses the pty once the attached view falls behind', () => {
      const { id } = h.mgr.create(opts)
      h.mgr.attach(id)

      let sent = 0
      while (sent <= HIGH_WATER) {
        h.spawned[0].emit(chunk)
        sent += chunk.length
      }

      assert.equal(h.spawned[0].paused, true)
    })

    it('resumes once acknowledgements bring it below the low-water mark', () => {
      const { id } = h.mgr.create(opts)
      h.mgr.attach(id)

      let sent = 0
      while (sent <= HIGH_WATER) {
        h.spawned[0].emit(chunk)
        sent += chunk.length
      }
      assert.equal(h.spawned[0].paused, true)

      h.mgr.ack(id, sent - LOW_WATER + 1)
      assert.equal(h.spawned[0].paused, false)
    })

    it('never applies backpressure while detached', () => {
      h.mgr.create(opts)

      let sent = 0
      while (sent <= HIGH_WATER * 2) {
        h.spawned[0].emit(chunk)
        sent += chunk.length
      }

      assert.equal(h.spawned[0].paused, false)
      assert.equal(h.spawned[0].pauseCount, 0)
    })

    it('clears backpressure on detach so a stale view cannot stall the process', () => {
      const { id } = h.mgr.create(opts)
      h.mgr.attach(id)

      let sent = 0
      while (sent <= HIGH_WATER) {
        h.spawned[0].emit(chunk)
        sent += chunk.length
      }
      assert.equal(h.spawned[0].paused, true)

      h.mgr.detach(id)
      assert.equal(h.spawned[0].paused, false, 'detaching must release the pty')
    })
  })

  describe('hook correlation', () => {
    const hook = (name: string, sessionId: string, cwd?: string) =>
      ({ hookEventName: name, sessionId, cwd }) as never

    // We hand Grok our uuid at spawn, so events come back already keyed to us.
    it('passes our session id to grok so correlation is exact', () => {
      const info = h.mgr.create(opts)
      assert.deepEqual(h.spawned[0].opts.args, ['--session-id', info.id])
      assert.equal(info.grokSessionId, info.id)
    })

    it('routes events by our own id', () => {
      const info = h.mgr.create(opts)
      h.mgr.handleHookEvent(hook('UserPromptSubmit', info.id))
      assert.equal(h.mgr.get(info.id)?.activity, 'working')
    })

    // The case that was ambiguous before --session-id: same directory, same
    // instant. Now they cannot collide, because the ids were never guessed.
    it('keeps two sessions in one directory apart', () => {
      const a = h.mgr.create(opts)
      const b = h.mgr.create(opts)

      h.mgr.handleHookEvent(hook('UserPromptSubmit', b.id))

      assert.equal(h.mgr.get(a.id)?.activity, 'idle')
      assert.equal(h.mgr.get(b.id)?.activity, 'working')
    })

    // Covers a `grok` the user started by hand, which mints its own id.
    it('falls back to directory matching for sessions we did not start', () => {
      const a = h.mgr.create({ ...opts, cwd: '/tmp/a' })
      h.mgr.create({ ...opts, cwd: '/tmp/b' })

      h.mgr.handleHookEvent(hook('Stop', 'foreign-id', '/tmp/a'))

      assert.equal(h.mgr.get(a.id)?.activity, 'needs-you')
    })

    it('ignores events that match no session', () => {
      h.mgr.create({ ...opts, cwd: '/tmp/a' })
      assert.doesNotThrow(() => h.mgr.handleHookEvent(hook('Stop', 'x', '/tmp/elsewhere')))
    })

    it('ignores an unknown id with no cwd to fall back on', () => {
      const info = h.mgr.create(opts)
      h.mgr.handleHookEvent(hook('Stop', 'unknown'))
      assert.equal(h.mgr.get(info.id)?.activity, 'idle')
    })

    it('emits a state change so the rail updates live', () => {
      const info = h.mgr.create(opts)
      const before = h.states.length
      h.mgr.handleHookEvent(hook('UserPromptSubmit', info.id))

      assert.ok(h.states.length > before)
      assert.equal(h.states.at(-1)?.info.id, info.id)
      assert.equal(h.states.at(-1)?.info.activity, 'working')
    })

    it('acknowledge clears a waiting session', () => {
      const info = h.mgr.create(opts)
      h.mgr.handleHookEvent(hook('Stop', info.id))
      assert.equal(h.mgr.get(info.id)?.activity, 'needs-you')

      h.mgr.acknowledge(info.id)
      assert.equal(h.mgr.get(info.id)?.activity, 'idle')
    })

    it('marks activity exited when the process dies', () => {
      const info = h.mgr.create(opts)
      h.spawned[0].exit(0)
      assert.equal(h.mgr.get(info.id)?.activity, 'exited')
    })
  })

  describe('io', () => {
    it('passes input through byte for byte', () => {
      const { id } = h.mgr.create(opts)
      // An SGR mouse report — must not be transformed on the way through.
      h.mgr.write(id, '\x1b[<0;10;5M')
      assert.deepEqual(h.spawned[0].written, ['\x1b[<0;10;5M'])
    })

    it('ignores io for unknown ids', () => {
      assert.doesNotThrow(() => {
        h.mgr.write('nope', 'x')
        h.mgr.resize('nope', 80, 24)
        h.mgr.ack('nope', 10)
        h.mgr.detach('nope')
        h.mgr.close('nope')
      })
    })
  })
})
