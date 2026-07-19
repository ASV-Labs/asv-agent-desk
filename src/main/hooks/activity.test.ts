import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { acknowledge, initialActivity, reduceActivity } from './activity'
import type { HookEvent, HookEventName } from '../../shared/hooks'

const ev = (hookEventName: HookEventName, extra: Partial<HookEvent> = {}): HookEvent => ({
  hookEventName,
  sessionId: 'grok-1',
  ...extra,
})

describe('activity state machine', () => {
  it('starts idle', () => {
    assert.equal(initialActivity().state, 'idle')
  })

  it('goes to working when a prompt is submitted', () => {
    const a = reduceActivity(initialActivity(), ev('UserPromptSubmit'))
    assert.equal(a.state, 'working')
  })

  // The core claim of the rail: a turn ending is not "done", it is "your move".
  it('treats a finished turn as needing you', () => {
    let a = reduceActivity(initialActivity(), ev('UserPromptSubmit'))
    a = reduceActivity(a, ev('Stop'))
    assert.equal(a.state, 'needs-you')
  })

  it('treats notifications and denied permissions as needing you', () => {
    assert.equal(reduceActivity(initialActivity(), ev('Notification')).state, 'needs-you')
    assert.equal(reduceActivity(initialActivity(), ev('PermissionDenied')).state, 'needs-you')
  })

  it('marks a failed turn distinctly from a finished one', () => {
    const a = reduceActivity(initialActivity(), ev('StopFailure'))
    assert.equal(a.state, 'failed')
  })

  // Observed in a real quota-limited turn: Grok emits stop_failure and then
  // stop ~13ms later. Naively mapping both made the failure invisible.
  it('keeps a failure visible when Stop immediately follows StopFailure', () => {
    let a = reduceActivity(initialActivity(), ev('UserPromptSubmit'))
    a = reduceActivity(a, ev('StopFailure'), 1000)
    a = reduceActivity(a, ev('Stop'), 1013)

    assert.equal(a.state, 'failed')
    assert.equal(a.since, 1000, 'the failure timestamp should survive too')
  })

  it('clears a failure on the next prompt', () => {
    let a = reduceActivity(initialActivity(), ev('StopFailure'))
    a = reduceActivity(a, ev('UserPromptSubmit'))
    assert.equal(a.state, 'working')
  })

  it('keeps the clock running across events within one state', () => {
    const start = initialActivity(1000)
    const working = reduceActivity(start, ev('UserPromptSubmit'), 2000)
    const stillWorking = reduceActivity(working, ev('PostToolUse', { toolName: 'Edit' }), 5000)

    assert.equal(stillWorking.state, 'working')
    assert.equal(stillWorking.since, 2000, 'time-in-state must not reset on same-state events')
  })

  it('restarts the clock on a real transition', () => {
    const working = reduceActivity(initialActivity(1000), ev('UserPromptSubmit'), 2000)
    const waiting = reduceActivity(working, ev('Stop'), 9000)
    assert.equal(waiting.since, 9000)
  })

  it('tracks the tool in flight', () => {
    const a = reduceActivity(initialActivity(), ev('PostToolUse', { toolName: 'Bash' }))
    assert.equal(a.lastTool, 'Bash')
  })

  it('counts subagents up and down without going negative', () => {
    let a = initialActivity()
    a = reduceActivity(a, ev('SubagentStart'))
    a = reduceActivity(a, ev('SubagentStart'))
    assert.equal(a.subagents, 2)

    a = reduceActivity(a, ev('SubagentStop'))
    a = reduceActivity(a, ev('SubagentStop'))
    a = reduceActivity(a, ev('SubagentStop'))
    assert.equal(a.subagents, 0)
  })

  it('clears subagents when the turn ends', () => {
    let a = reduceActivity(initialActivity(), ev('SubagentStart'))
    a = reduceActivity(a, ev('Stop'))
    assert.equal(a.subagents, 0)
  })

  it('resets cleanly when a session restarts', () => {
    let a = reduceActivity(initialActivity(), ev('StopFailure'))
    a = reduceActivity(a, ev('SessionStart'))
    assert.deepEqual({ state: a.state, subagents: a.subagents }, { state: 'idle', subagents: 0 })
  })

  // A future Grok release adding events must never wedge the UI.
  it('ignores unknown events', () => {
    const before = initialActivity()
    const after = reduceActivity(before, { hookEventName: 'Nonsense', sessionId: 'x' } as never)
    assert.equal(after, before, 'unknown events return the exact same object')
  })

  describe('acknowledge', () => {
    it('clears a pending needs-you on focus', () => {
      const waiting = reduceActivity(initialActivity(), ev('Stop'), 1000)
      const seen = acknowledge(waiting, 4000)
      assert.equal(seen.state, 'idle')
      assert.equal(seen.since, 4000)
    })

    it('leaves other states alone', () => {
      const working = reduceActivity(initialActivity(), ev('UserPromptSubmit'))
      assert.equal(acknowledge(working), working)
    })
  })
})
