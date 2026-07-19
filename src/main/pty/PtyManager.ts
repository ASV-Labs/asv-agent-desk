/**
 * REMOVED — superseded by `src/main/sessions/`.
 *
 * PtyManager keyed processes by id but had no concept of a session that
 * outlives its view, so the renderer effectively owned the PTY lifecycle.
 * That is what produced the blank-terminal bug in Phase 0: a React remount
 * could dispose a live process, and a create that resolved after unmount
 * stranded an orphan.
 *
 * Ownership now lives in SessionManager: sessions own processes, views attach
 * to sessions. See `src/main/sessions/SessionManager.ts`.
 *
 * This file is intentionally left as a tombstone rather than deleted so the
 * reason for the change stays discoverable in the tree.
 */

export {}
