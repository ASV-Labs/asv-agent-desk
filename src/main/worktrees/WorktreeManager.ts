import { execFile } from 'node:child_process'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { grokHome, worktreesRoot } from '../store/paths'
import { countAddedLines } from '../git/parse'
import type { Worktree } from '../../shared/worktrees'

const run = promisify(execFile)

/**
 * Inventory and lifecycle for Grok's worktrees.
 *
 * **Read from the filesystem, not from `grok worktree list`.** The CLI's
 * human-readable output has no documented shape and would have to be
 * screen-scraped; the directory layout — `~/.grok/worktrees/<repo>/<name>` —
 * is stable, and each checkout is a real git repository that answers questions
 * directly. Parsing an undocumented text format has already cost this project
 * two rounds elsewhere.
 *
 * Mutations do go through `grok worktree rm`, because removing a worktree
 * involves git bookkeeping beyond deleting a directory, and that is Grok's to
 * own.
 */
export class WorktreeManager {
  private command = process.env.ASV_AGENT_DESK_GROK_COMMAND?.trim() || 'grok'

  constructor(private readonly root: string = grokHome()) {}

  /** Use the same resolved CLI path as session spawning. */
  setCommand(command: string): void {
    this.command = command
  }

  private async git(cwd: string, args: string[]): Promise<string> {
    const { stdout } = await run('git', args, {
      cwd,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' },
    })
    return stdout.trim()
  }

  /**
   * Every worktree on disk, enriched with git state.
   *
   * `liveSessionIds` is supplied by the caller because only SessionManager
   * knows what is running; keeping that out of here avoids a dependency cycle
   * between the two.
   */
  async list(liveByPath: Map<string, string[]> = new Map()): Promise<Worktree[]> {
    const root = worktreesRoot(this.root)

    let repos: string[]
    try {
      repos = await readdir(root)
    } catch {
      // No worktrees directory: nobody has forked yet.
      return []
    }

    const found: Worktree[] = []

    for (const repo of repos) {
      const repoDir = join(root, repo)
      let names: string[]
      try {
        const info = await stat(repoDir)
        if (!info.isDirectory()) continue
        names = await readdir(repoDir)
      } catch {
        continue
      }

      for (const name of names) {
        const worktree = await this.read(repo, name, join(repoDir, name), liveByPath)
        if (worktree) found.push(worktree)
      }
    }

    return found.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  private async read(
    repo: string,
    name: string,
    path: string,
    liveByPath: Map<string, string[]>,
  ): Promise<Worktree | null> {
    let updatedAt: number
    try {
      const info = await stat(path)
      if (!info.isDirectory()) return null
      updatedAt = info.mtimeMs
    } catch {
      return null
    }

    const [branch, head, statusOut, numstatOut] = await Promise.all([
      this.git(path, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => undefined),
      this.git(path, ['rev-parse', '--short', 'HEAD']).catch(() => undefined),
      this.git(path, ['status', '--porcelain=v1']).catch(() => ''),
      this.git(path, ['diff', '--numstat', 'HEAD']).catch(() => ''),
    ])

    // A directory that git will not answer for is not a usable worktree.
    if (!head) return null

    const dirty = statusOut.trim().length > 0
    let added = 0
    let removed = 0
    for (const line of numstatOut.split('\n')) {
      const match = /^(\d+|-)\t(\d+|-)\t/.exec(line)
      if (!match) continue
      if (match[1] !== '-') added += Number(match[1])
      if (match[2] !== '-') removed += Number(match[2])
    }

    // `git diff --numstat HEAD` ignores untracked paths, so a worktree whose
    // only work is new files reported "uncommitted" with no counts at all —
    // the same gap that was fixed in the diff panel, repeated here.
    added += await this.countUntracked(path, statusOut)

    const liveSessionIds = liveByPath.get(path) ?? []

    return {
      name,
      path,
      repo,
      branch: branch === 'HEAD' ? 'detached' : branch,
      head,
      dirty,
      added,
      removed,
      liveSessionIds,
      // Deliberately conservative: anything running or holding uncommitted
      // work is never offered for reaping, however old it looks.
      orphaned: liveSessionIds.length === 0 && !dirty,
      updatedAt,
    }
  }

  /** Lines in untracked files, which numstat never reports. */
  private async countUntracked(root: string, statusOut: string): Promise<number> {
    const paths = statusOut
      .split('\n')
      .filter((line) => line.startsWith('?? '))
      .map((line) => line.slice(3).trim())
      .filter(Boolean)

    let total = 0
    await Promise.all(
      paths.map(async (rel) => {
        try {
          const full = join(root, rel)
          const info = await stat(full)
          if (!info.isFile() || info.size > 8 * 1024 * 1024) return
          const counted = countAddedLines(await readFile(full))
          if (counted !== null) total += counted
        } catch {
          // Unreadable, a directory, or gone since status ran.
        }
      }),
    )
    return total
  }

  /**
   * Remove a worktree via Grok.
   *
   * Refuses while a session is live in it or it holds uncommitted changes —
   * this is the one destructive operation in the app, and a worktree exists
   * precisely so parallel work does not get clobbered.
   */
  async remove(worktree: Worktree, force = false): Promise<{ ok: boolean; reason?: string }> {
    if (worktree.liveSessionIds.length > 0) {
      return { ok: false, reason: 'A session is still running in this worktree' }
    }
    if (worktree.dirty && !force) {
      return { ok: false, reason: 'Uncommitted changes — nothing has been removed' }
    }

    try {
      await run(this.command, ['worktree', 'rm', worktree.name], {
        cwd: worktree.path,
        env: { ...process.env, LC_ALL: 'C' },
      })
      return { ok: true }
    } catch (err) {
      return { ok: false, reason: (err as Error).message }
    }
  }
}
