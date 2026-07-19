import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { LineageEdge } from '../../shared/worktrees'

/**
 * Records which session each fork came from.
 *
 * Grok has no concept of one session being derived from another — `/fork` and
 * `-w` produce independent sessions. ASV Agent Desk creates the forks, so it is the
 * only thing that can know the edge, and it writes them here.
 *
 * This is the one piece of state ASV Agent Desk owns rather than reads. It is kept
 * in the app's own data directory, never inside `~/.grok`, because that
 * directory is Grok's and this app is a reader of it.
 */
export class LineageStore {
  private edges = new Map<string, LineageEdge>()
  private loaded = false

  constructor(private readonly file: string) {}

  async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true

    try {
      const raw = await readFile(this.file, 'utf8')
      const parsed: unknown = JSON.parse(raw)
      if (!Array.isArray(parsed)) return

      for (const entry of parsed) {
        if (!entry || typeof entry !== 'object') continue
        const edge = entry as Partial<LineageEdge>
        if (typeof edge.sessionId !== 'string' || typeof edge.parentSessionId !== 'string') {
          continue
        }
        this.edges.set(edge.sessionId, {
          sessionId: edge.sessionId,
          parentSessionId: edge.parentSessionId,
          worktreeName: typeof edge.worktreeName === 'string' ? edge.worktreeName : undefined,
          createdAt: typeof edge.createdAt === 'number' ? edge.createdAt : Date.now(),
        })
      }
    } catch {
      // Missing or corrupt: lineage is an enhancement, not a requirement. A
      // lost file costs a flat session list, not a broken app.
    }
  }

  async record(edge: LineageEdge): Promise<void> {
    await this.load()
    this.edges.set(edge.sessionId, edge)
    await this.persist()
  }

  async all(): Promise<LineageEdge[]> {
    await this.load()
    return [...this.edges.values()]
  }

  parentOf(sessionId: string): string | undefined {
    return this.edges.get(sessionId)?.parentSessionId
  }

  /** Drop edges whose sessions no longer exist, so the file cannot grow forever. */
  async prune(knownSessionIds: Set<string>): Promise<void> {
    await this.load()
    let changed = false

    for (const [id, edge] of this.edges) {
      if (knownSessionIds.has(id)) continue
      // Keep an edge whose parent survives — the child may simply not be
      // loaded right now, and losing lineage is worse than a stale row.
      if (knownSessionIds.has(edge.parentSessionId)) continue
      this.edges.delete(id)
      changed = true
    }

    if (changed) await this.persist()
  }

  private async persist(): Promise<void> {
    try {
      await mkdir(dirname(this.file), { recursive: true })
      await writeFile(this.file, JSON.stringify([...this.edges.values()], null, 2), 'utf8')
    } catch {
      // Persistence is best-effort; an unwritable data directory must not
      // stop someone from forking a session.
    }
  }
}
