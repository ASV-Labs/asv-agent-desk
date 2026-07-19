import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { decodeCwd, grokHome, sessionsRoot } from './paths'
import type { StoredProject, StoredSession } from '../../shared/store'

/**
 * Reads Grok's own session history from `~/.grok/sessions`.
 *
 * This is a side channel, in the sense that matters for this app: the sidebar
 * is built from files Grok writes, never from parsing terminal output.
 *
 * Everything here is defensive. The directory belongs to Grok, its format is
 * undocumented, and it changes between releases — so a malformed or unexpected
 * file must degrade one row rather than empty the sidebar.
 */
export class SessionStore {
  constructor(private readonly root: string = grokHome()) {}

  /** All projects that have at least one readable session, newest first. */
  async projects(): Promise<StoredProject[]> {
    const root = sessionsRoot(this.root)

    let entries: string[]
    try {
      entries = await readdir(root)
    } catch {
      // No sessions directory yet — a fresh Grok install.
      return []
    }

    const projects = await Promise.all(entries.map((entry) => this.readProject(root, entry)))

    return projects
      .filter((p): p is StoredProject => p !== null && p.sessions.length > 0)
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /** Sessions for one working directory, newest first. */
  async sessionsFor(cwd: string): Promise<StoredSession[]> {
    const all = await this.projects()
    return all.find((p) => p.cwd === cwd)?.sessions ?? []
  }

  private async readProject(root: string, entry: string): Promise<StoredProject | null> {
    const dir = join(root, entry)

    let ids: string[]
    try {
      const info = await stat(dir)
      if (!info.isDirectory()) return null
      ids = await readdir(dir)
    } catch {
      return null
    }

    const cwd = decodeCwd(entry)
    const sessions = (
      await Promise.all(ids.map((id) => this.readSession(dir, id, cwd)))
    ).filter((s): s is StoredSession => s !== null)

    if (sessions.length === 0) return null

    sessions.sort((a, b) => b.updatedAt - a.updatedAt)

    return {
      cwd,
      name: cwd.split('/').filter(Boolean).pop() || cwd,
      sessions,
      updatedAt: sessions[0].updatedAt,
    }
  }

  private async readSession(
    projectDir: string,
    id: string,
    cwd: string,
  ): Promise<StoredSession | null> {
    const dir = join(projectDir, id)

    let mtime: number
    let birthtime: number
    try {
      const info = await stat(dir)
      if (!info.isDirectory()) return null
      mtime = info.mtimeMs
      birthtime = info.birthtimeMs || info.mtimeMs
    } catch {
      return null
    }

    // summary.json is the nice case. Absence is survivable — the directory
    // mtime and a derived title still make a usable row.
    const summary = await this.readSummary(join(dir, 'summary.json'))

    return {
      id,
      // The decoded directory name is authoritative, because it is also what
      // groups sessions into projects. `info.cwd` only rescues the case where
      // the folder name was not valid percent-encoding and decoding no-oped.
      cwd: cwd.includes('%') && summary.cwd ? summary.cwd : cwd,
      // Three distinct cases, deliberately not collapsed:
      //   a title            → show it
      //   no title, prompted → unusual; fall back to the uuid stub
      //   never prompted     → "No prompt yet"
      // `prompted` is undefined when summary.json is missing or corrupt, which
      // is a different thing from knowing the session was never used — so that
      // case keeps the stub rather than claiming something it cannot know.
      title:
        summary.title ??
        (summary.prompted === false ? 'No prompt yet' : `Session ${id.slice(0, 8)}`),
      prompted: summary.prompted,
      updatedAt: summary.updatedAt ?? mtime,
      createdAt: summary.createdAt ?? birthtime,
      messageCount: summary.messageCount,
      model: summary.model,
      branch: summary.branch,
      gitRoot: summary.gitRoot,
    }
  }

  /**
   * Read one `summary.json`.
   *
   * Key names come from a real Grok 0.2.103 file. An earlier version guessed
   * at `title` / `name` / `summary` and matched none of them, so every row in
   * the sidebar rendered as `Session 9fc1b4a3` — the unit tests passed because
   * they asserted against the same invented schema. The canonical names are
   * checked first now; the aliases behind them are tolerance, not guesses.
   *
   * Real shape:
   *   { info: { id, cwd }, session_summary, generated_title, created_at,
   *     updated_at, last_active_at, num_messages, num_chat_messages,
   *     current_model_id, git_root_dir, head_branch, head_commit, ... }
   */
  private async readSummary(path: string): Promise<{
    cwd?: string
    title?: string
    updatedAt?: number
    createdAt?: number
    messageCount?: number
    model?: string
    branch?: string
    gitRoot?: string
    prompted?: boolean
  }> {
    try {
      const raw = await readFile(path, 'utf8')
      const parsed: unknown = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object') return {}
      const record = parsed as Record<string, unknown>

      const info =
        record.info && typeof record.info === 'object'
          ? (record.info as Record<string, unknown>)
          : {}

      return {
        cwd: pickString(info, 'cwd'),
        // The title is the opening prompt, so it can be a paragraph.
        title: truncate(
          pickString(record, 'generated_title', 'session_summary', 'title', 'name'),
          80,
        ),
        updatedAt: pickTime(record, 'last_active_at', 'updated_at', 'updatedAt', 'timestamp'),
        createdAt: pickTime(record, 'created_at', 'createdAt', 'startedAt'),
        // Chat turns, not the raw message count, which includes tool traffic.
        messageCount: pickNumber(record, 'num_chat_messages', 'num_messages', 'messageCount'),
        model: pickString(record, 'current_model_id', 'model', 'model_id'),
        branch: pickString(record, 'head_branch'),
        gitRoot: pickString(record, 'git_root_dir'),
        // `num_messages` counts 1 for a session that was merely opened, so
        // anything above that means a prompt was actually submitted.
        prompted: (pickNumber(record, 'num_messages') ?? 0) > 1,
      }
    } catch {
      return {}
    }
  }
}

function truncate(value: string | undefined, max: number): string | undefined {
  if (!value) return undefined
  const flat = value.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

function pickString(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

function pickNumber(record: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return undefined
}

/**
 * Timestamps appear as epoch seconds, epoch milliseconds, or ISO strings
 * depending on the field. Normalise everything to milliseconds.
 */
function pickTime(record: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key]

    if (typeof value === 'number' && Number.isFinite(value)) {
      // Anything below this threshold is seconds, not milliseconds.
      return value < 1e12 ? value * 1000 : value
    }

    if (typeof value === 'string') {
      const parsed = Date.parse(value)
      if (!Number.isNaN(parsed)) return parsed
    }
  }
  return undefined
}
