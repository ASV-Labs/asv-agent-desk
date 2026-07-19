/** Types shared by the right-hand panel: browser tabs and diff tabs. */

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface BrowserTabState {
  id: string
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  favicon?: string
  error?: string
}

/**
 * The whole browser, as main sees it.
 *
 * Main owns tab identity and order; the renderer mirrors this. An earlier
 * version let the renderer keep its own tab array, which split-brained the
 * moment anything created a tab that the renderer had not initiated — a popup
 * appeared under the previous tab's label, and collapsing the panel unmounted
 * the array while leaving the native views alive in main.
 */
export interface BrowserState {
  tabs: BrowserTabState[]
  activeId: string | null
}

export interface ChangedFile {
  path: string
  /** Porcelain status letters, e.g. `M`, `A`, `D`, `??`. */
  status: string
  added: number
  removed: number
}

export interface RepoStatus {
  /** Absolute repo root, or null if the directory is not a git repo. */
  root: string | null
  branch?: string
  files: ChangedFile[]
  added: number
  removed: number
}

export type DiffLineKind = 'add' | 'remove' | 'context' | 'meta'

export interface DiffLine {
  kind: DiffLineKind
  text: string
  oldLine?: number
  newLine?: number
}

export interface DiffHunk {
  header: string
  lines: DiffLine[]
}

export interface FileDiff {
  path: string
  hunks: DiffHunk[]
  binary: boolean
}
