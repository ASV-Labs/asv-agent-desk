import type { SessionInfo } from '../../../shared/ipc'
import type { StoredProject, StoredSession } from '../../../shared/store'

export interface SidebarRow extends StoredSession {
  liveSession?: SessionInfo
  /** 0 for a root session, 1+ for forks nested under their parent. */
  depth: number
  /** Position within the fork tree, e.g. `1` or `1.2`. Empty for roots. */
  forkPath: string
  /** Worktree directory name, when this session runs in one. */
  worktreeName?: string
}

export interface SidebarProject {
  cwd: string
  /** Display label, disambiguated when leaf names collide. */
  label: string
  rows: SidebarRow[]
  liveCount: number
  updatedAt: number
}

/**
 * Give each project a label that is actually distinguishing.
 *
 * Two checkouts named `web` under different parents are indistinguishable if
 * you only show the leaf, so collisions fall back to `parent/leaf`.
 */
export function labelProjects(cwds: string[]): Map<string, string> {
  const leafOf = (cwd: string): string => cwd.split('/').filter(Boolean).pop() || cwd

  const counts = new Map<string, number>()
  for (const cwd of cwds) {
    const leaf = leafOf(cwd)
    counts.set(leaf, (counts.get(leaf) ?? 0) + 1)
  }

  const labels = new Map<string, string>()
  for (const cwd of cwds) {
    const parts = cwd.split('/').filter(Boolean)
    const leaf = parts.at(-1) ?? cwd
    labels.set(cwd, (counts.get(leaf) ?? 0) > 1 ? parts.slice(-2).join('/') : leaf)
  }
  return labels
}

/**
 * Walk lineage to the session a fork ultimately descends from.
 *
 * Cycles and missing parents both terminate the walk rather than looping or
 * throwing — a corrupt lineage file must cost a flat row, not the sidebar.
 */
function rootOf(id: string, lineage: Map<string, string>): string {
  const seen = new Set<string>([id])
  let current = id

  for (;;) {
    const parent = lineage.get(current)
    if (!parent || seen.has(parent)) return current
    seen.add(parent)
    current = parent
  }
}

/**
 * Order rows so forks sit directly beneath the session they came from, and
 * number them by position in the tree.
 */
export function nestForks(
  rows: SidebarRow[],
  lineage: Map<string, string> = new Map(),
): SidebarRow[] {
  const byId = new Map(rows.map((row) => [row.id, row]))
  const children = new Map<string, SidebarRow[]>()
  const roots: SidebarRow[] = []

  for (const row of rows) {
    const parentId = row.liveSession?.parentSessionId ?? lineage.get(row.id)
    if (parentId && byId.has(parentId) && parentId !== row.id) {
      const siblings = children.get(parentId) ?? []
      siblings.push(row)
      children.set(parentId, siblings)
    } else {
      roots.push(row)
    }
  }

  const out: SidebarRow[] = []
  const seen = new Set<string>()

  const walk = (row: SidebarRow, depth: number, path: string): void => {
    // A cycle would only arise from a corrupt lineage file, but recursing
    // forever over the sidebar is a bad way to find that out.
    if (seen.has(row.id)) return
    seen.add(row.id)

    out.push({ ...row, depth, forkPath: path })

    // Number siblings by when they were created, not by display order.
    // Numbering off display order meant a new fork could renumber an existing
    // branch — `fork 1` silently became `fork 2` — which makes the badge look
    // like an identifier while behaving like a row position. Oldest is always
    // 1, and a new sibling appends.
    const kids = [...(children.get(row.id) ?? [])].sort((a, b) => a.createdAt - b.createdAt)
    kids.forEach((child, i) => {
      walk(child, depth + 1, path ? `${path}.${i + 1}` : String(i + 1))
    })
  }

  for (const root of roots) walk(root, 0, '')
  // Anything left is part of a cycle; show it flat rather than losing it.
  for (const row of rows) if (!seen.has(row.id)) out.push({ ...row, depth: 0, forkPath: '' })

  return out
}

/**
 * Assemble the sidebar.
 *
 * **Grouping is by lineage root, not by working directory.** That distinction
 * is the whole point: a worktree is a *variant of a project*, not a project of
 * its own. Grouping by cwd looked right until worktree sessions started
 * reporting their real checkout — at which point every fork moved into its own
 * top-level group named after a generated directory, and nesting became
 * impossible because parent and child were never in the same group to begin
 * with.
 *
 * Resolving to the lineage root also removes the visible jump that used to
 * happen ~1.8s after forking, when the first hook event corrected `cwd`:
 * placement now depends on who the parent is, which is known at spawn, rather
 * than on where the agent turned out to be working.
 */
export function buildSidebar(
  projects: StoredProject[],
  live: SessionInfo[],
  lineage: Map<string, string> = new Map(),
): SidebarProject[] {
  const liveById = new Map(live.map((s) => [s.id, s]))

  // Lineage from both sources: live sessions know their parent directly,
  // stored ones only through the persisted file.
  const edges = new Map(lineage)
  for (const session of live) {
    if (session.parentSessionId) edges.set(session.id, session.parentSessionId)
  }

  // Every session we know about, live or stored, with the directory it belongs
  // to. A root's directory is its project; a fork inherits its root's.
  const rows = new Map<string, SidebarRow>()
  const cwdOf = new Map<string, string>()

  for (const project of projects) {
    for (const session of project.sessions) {
      cwdOf.set(session.id, project.cwd)
      rows.set(session.id, {
        ...session,
        liveSession: liveById.get(session.id),
        depth: 0,
        forkPath: '',
        worktreeName: liveById.get(session.id)?.worktreeName,
      })
    }
  }

  for (const session of live) {
    if (rows.has(session.id)) continue
    // Live but not yet written to disk. A worktree session belongs to the
    // directory it was launched from — its own checkout is an implementation
    // detail — while an ordinary session simply belongs where it is running.
    cwdOf.set(session.id, session.isWorktree ? session.baseCwd : session.cwd)
    rows.set(session.id, {
      id: session.id,
      cwd: session.cwd,
      title: session.title,
      createdAt: session.createdAt,
      updatedAt: session.createdAt,
      liveSession: session,
      depth: 0,
      forkPath: '',
      worktreeName: session.worktreeName,
    })
  }

  // Group by the directory of each row's lineage root.
  const groups = new Map<string, SidebarRow[]>()
  for (const [id, row] of rows) {
    const root = rootOf(id, edges)
    const groupCwd = cwdOf.get(root) ?? row.cwd
    const bucket = groups.get(groupCwd) ?? []
    bucket.push(row)
    groups.set(groupCwd, bucket)
  }

  const storedUpdatedAt = new Map(projects.map((p) => [p.cwd, p.updatedAt]))

  const out: SidebarProject[] = [...groups.entries()].map(([cwd, groupRows]) => {
    // Sessions with no history yet sort first — they are the ones just
    // started, and burying a new session under older history is the opposite
    // of useful. Everything else falls back to most recently active.
    const ordered = [...groupRows].sort((a, b) => {
      const aNew = a.liveSession && a.updatedAt === a.createdAt ? 0 : 1
      const bNew = b.liveSession && b.updatedAt === b.createdAt ? 0 : 1
      if (aNew !== bNew) return aNew - bNew
      return b.updatedAt - a.updatedAt
    })

    const nested = nestForks(ordered, edges)
    return {
      cwd,
      label: cwd,
      rows: nested,
      liveCount: nested.filter((r) => r.liveSession).length,
      updatedAt: Math.max(
        storedUpdatedAt.get(cwd) ?? 0,
        ...nested.map((r) => r.updatedAt),
        0,
      ),
    }
  })

  const labels = labelProjects(out.map((p) => p.cwd))
  for (const project of out) {
    project.label = labels.get(project.cwd) ?? project.cwd
  }

  return out.sort((a, b) => b.updatedAt - a.updatedAt)
}
