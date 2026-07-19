/**
 * The historical record: sessions Grok has written to disk.
 *
 * Distinct from `SessionInfo` in ipc.ts, which describes a session ASV Agent Desk is
 * currently running. A stored session may have no process — most do not — and
 * a running session appears in both, joined on id.
 */

export interface StoredSession {
  id: string
  /** Working directory, decoded from the percent-encoded folder name. */
  cwd: string
  /** From summary.json where present, otherwise derived from the directory. */
  title: string
  updatedAt: number
  createdAt: number
  /**
   * Raw `num_chat_messages`. Shown only in the tooltip: a session that was
   * opened and never prompted still reports 2, so it does not mean "turns"
   * and labelling it as such in the row would be misleading.
   */
  messageCount?: number
  /** False when the session was opened but never given a prompt. */
  prompted?: boolean
  model?: string
  /** Branch recorded at session start — the seed of the Phase 4 lineage view. */
  branch?: string
  gitRoot?: string
  /** True when ASV Agent Desk currently has a live process for this id. */
  live?: boolean
}

export interface StoredProject {
  /** Absolute working directory. */
  cwd: string
  /** Last path segment, for display. */
  name: string
  sessions: StoredSession[]
  updatedAt: number
}
