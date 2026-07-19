import type { ActivityState, HookEvent } from '../../shared/hooks'

export interface Activity {
  state: ActivityState
  /** When the current state began, for the rail's time-in-state readout. */
  since: number
  subagents: number
  lastTool?: string
  lastEvent?: string
}

export function initialActivity(now = Date.now()): Activity {
  return { state: 'idle', since: now, subagents: 0 }
}

/**
 * Fold a hook event into an activity state.
 *
 * Pure and total: unknown events return the input unchanged, so a future Grok
 * release adding events can never wedge the UI.
 *
 * The core mapping is that a turn ending means the agent is waiting on you —
 * `Stop` is not "done", it is "your move". That is what makes the rail a queue
 * rather than a list of tabs.
 */
export function reduceActivity(prev: Activity, event: HookEvent, now = Date.now()): Activity {
  const enter = (state: ActivityState, extra: Partial<Activity> = {}): Activity => ({
    ...prev,
    ...extra,
    state,
    // Only restart the clock on a real transition, so "waiting 4:12" keeps
    // counting through repeated events in the same state.
    since: state === prev.state ? prev.since : now,
    lastEvent: event.hookEventName,
  })

  switch (event.hookEventName) {
    case 'SessionStart':
      return { state: 'idle', since: now, subagents: 0, lastEvent: event.hookEventName }

    case 'UserPromptSubmit':
      return enter('working')

    case 'PostToolUse':
    case 'PostToolUseFailure':
      // Tool churn keeps a session in `working` but updates what it is doing.
      return enter('working', { lastTool: event.toolName })

    case 'SubagentStart':
      return enter('working', { subagents: prev.subagents + 1 })

    case 'SubagentStop':
      return enter(prev.state === 'failed' ? 'failed' : 'working', {
        subagents: Math.max(0, prev.subagents - 1),
      })

    case 'PreCompact':
    case 'PostCompact':
      return enter('working')

    case 'Stop':
      // Grok emits `stop_failure` and then `stop` about 13ms later, so a naive
      // mapping overwrites the failure before anyone can see it. A turn that
      // failed stays failed until the next prompt clears it.
      if (prev.state === 'failed') return { ...prev, lastEvent: event.hookEventName }
      return enter('needs-you', { subagents: 0 })

    case 'Notification':
    case 'PermissionDenied':
      return enter('needs-you', { subagents: 0 })

    case 'StopFailure':
      return enter('failed', { subagents: 0 })

    case 'SessionEnd':
      return enter('exited', { subagents: 0 })

    default:
      return prev
  }
}

/** Focusing a waiting session clears the flag — the queue drains as you work. */
export function acknowledge(prev: Activity, now = Date.now()): Activity {
  if (prev.state !== 'needs-you') return prev
  return { ...prev, state: 'idle', since: now }
}
