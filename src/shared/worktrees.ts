/** Worktrees, and the fork lineage ASV Agent Desk records over them. */

export interface Worktree {
  /** Directory name under the repo folder — Grok's name for the worktree. */
  name: string
  /** Absolute path: ~/.grok/worktrees/<repo>/<name> */
  path: string
  /** Repo folder name as Grok stored it. */
  repo: string
  branch?: string
  head?: string
  /** True when the checkout has uncommitted changes. */
  dirty: boolean
  added: number
  removed: number
  /** Session ids ASV Agent Desk currently has running in this worktree. */
  liveSessionIds: string[]
  /**
   * No live session and nothing uncommitted — safe to remove.
   *
   * Grok never reaps these on its own; `worktree gc` runs only when invoked.
   * Run parallel agents for a week and the disk fills with checkouts nobody
   * remembers creating.
   */
  orphaned: boolean
  updatedAt: number
}

/**
 * Which session a fork came from.
 *
 * Grok does not record this — it has no concept of one session being derived
 * from another. ASV Agent Desk creates the forks, so it records the edge itself.
 */
export interface LineageEdge {
  sessionId: string
  parentSessionId: string
  worktreeName?: string
  createdAt: number
}

export interface ForkRequest {
  /** Session being forked from. */
  parentSessionId: string
  cwd: string
  /** Worktree name; Grok generates one when omitted. */
  name?: string
  /** Base ref for a clean checkout. Omit to branch from current HEAD. */
  ref?: string
  cols: number
  rows: number
}
