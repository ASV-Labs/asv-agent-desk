/**
 * Grok Build hook events, received through ASV Agent Desk's local Unix socket
 * command-hook transport.
 *
 * These are the app's only source of live session state. Nothing here is
 * derived from terminal output — see the no-scraping rule in grok-desk-plan.md.
 */

export const HOOK_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionDenied',
  'Stop',
  'StopFailure',
  'Notification',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
] as const

export type HookEventName = (typeof HOOK_EVENTS)[number]

/**
 * PreToolUse is deliberately absent above.
 *
 * It is the only blocking event: Grok waits for the hook to answer before
 * running the tool. A GUI that hangs would stall the agent, so ASV Agent Desk
 * subscribes to passive events only.
 */
export const BLOCKING_EVENTS = ['PreToolUse'] as const

/** The JSON body Grok POSTs. Fields beyond these are ignored. */
export interface HookEvent {
  hookEventName: HookEventName
  sessionId: string
  cwd?: string
  workspaceRoot?: string
  toolName?: string
}

/**
 * What a session is doing right now.
 *
 * `needs-you` is the state the whole session rail exists to surface: with
 * several agents running in parallel, the bottleneck is noticing that one has
 * been blocked on you for four minutes.
 */
export type ActivityState = 'idle' | 'working' | 'needs-you' | 'failed' | 'exited'

export function isHookEventName(value: string): value is HookEventName {
  return (HOOK_EVENTS as readonly string[]).includes(value)
}

function toSnake(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[\s-]+/g, '_')
    .toLowerCase()
}

const BY_SNAKE = new Map<string, HookEventName>(HOOK_EVENTS.map((e) => [toSnake(e), e]))

/**
 * Resolve an incoming event name to its canonical form, or null if unknown.
 *
 * Grok is asymmetric here, and it cost us a phase: hook *subscriptions* are
 * keyed by PascalCase (`UserPromptSubmit`), but the *envelope* Grok POSTs
 * carries snake_case (`user_prompt_submit`). Validating PascalCase only meant
 * every real event was silently dropped while the endpoint still answered
 * 200 — so Grok logged a successful hook and the rail never moved.
 *
 * Accepting both forms makes this robust whichever convention a given build
 * uses, and normalising to PascalCase keeps one vocabulary inside the app.
 */
export function normalizeHookEventName(value: string): HookEventName | null {
  if (isHookEventName(value)) return value
  return BY_SNAKE.get(toSnake(value)) ?? null
}
