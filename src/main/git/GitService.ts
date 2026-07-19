import { execFile } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  countAddedLines,
  mergeStatus,
  parseNumstat,
  parseStatus,
  parseUnifiedDiff,
  totals,
} from './parse'
import type { ChangedFile, FileDiff, RepoStatus } from '../../shared/panel'

const run = promisify(execFile)

/** Diffs can be enormous; refuse rather than pull a gigabyte into memory. */
const MAX_BUFFER = 16 * 1024 * 1024

/** Ceiling for reading an untracked file just to count its lines. */
const MAX_COUNT_BYTES = 8 * 1024 * 1024

/**
 * Read-only git access for the diff panel.
 *
 * Every call goes through `execFile` with an argument array and no shell, so
 * paths and refs are passed as arguments rather than interpolated into a
 * command string. Nothing here writes: no staging, no commits, no checkout.
 * A tool that shows you diffs has no business mutating the repository behind
 * the terminal you are already working in.
 */
export class GitService {
  private async git(cwd: string, args: string[]): Promise<string> {
    const { stdout } = await run('git', args, {
      cwd,
      maxBuffer: MAX_BUFFER,
      // Stable output regardless of the user's config.
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' },
    })
    return stdout
  }

  /** Repo root, or null when the directory is not inside a repository. */
  async root(cwd: string): Promise<string | null> {
    try {
      return (await this.git(cwd, ['rev-parse', '--show-toplevel'])).trim() || null
    } catch {
      return null
    }
  }

  async branch(cwd: string): Promise<string | undefined> {
    try {
      const name = (await this.git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
      return name === 'HEAD' ? 'detached' : name
    } catch {
      return undefined
    }
  }

  /**
   * Working-tree status with per-file line counts.
   *
   * Counts come from `diff HEAD`, so they cover staged and unstaged changes
   * together — which is what "what has this agent done" means in practice.
   * Untracked files have no diff and legitimately report zero.
   */
  async status(cwd: string): Promise<RepoStatus> {
    const root = await this.root(cwd)
    if (!root) return { root: null, files: [], added: 0, removed: 0 }

    const [statusOut, numstatOut, branch] = await Promise.all([
      this.git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=normal']),
      this.git(root, ['diff', '--numstat', '-z', 'HEAD']).catch(() => ''),
      this.branch(root),
    ])

    const files = mergeStatus(parseStatus(statusOut), parseNumstat(numstatOut))
    await this.countUntracked(root, files)
    return { root, branch, files, ...totals(files) }
  }

  /**
   * Fill in line counts for untracked files.
   *
   * `git diff --numstat HEAD` only knows about tracked paths, so an untracked
   * file arrived as `+0 −0` in the list while its diff — produced separately
   * via `--no-index` — correctly showed every line as added. The list and the
   * body disagreed, and the summary undercounted.
   *
   * Counting lines directly is cheaper than a `--no-index` diff per file, and
   * for a file with no previous version "added lines" is just "lines".
   */
  private async countUntracked(root: string, files: ChangedFile[]): Promise<void> {
    const untracked = files.filter((f) => f.status === '??')

    await Promise.all(
      untracked.map(async (file) => {
        try {
          const info = await stat(join(root, file.path))
          if (!info.isFile()) return

          // Reading an arbitrarily large file to draw a number is not worth
          // it, but the cap has to sit well above anything a coding agent
          // plausibly writes. A file past this reports +0, which undercounts
          // rather than lying about direction.
          if (info.size > MAX_COUNT_BYTES) return

          const counted = countAddedLines(await readFile(join(root, file.path)))
          if (counted !== null) file.added = counted
        } catch {
          // Unreadable or vanished between status and here; leave it at zero.
        }
      }),
    )
  }

  /** Unified diff for one file, against HEAD. */
  async diff(cwd: string, path: string): Promise<FileDiff> {
    const root = (await this.root(cwd)) ?? cwd

    try {
      const out = await this.git(root, [
        'diff',
        '--no-color',
        '--unified=3',
        'HEAD',
        '--',
        path,
      ])
      if (out.trim()) return parseUnifiedDiff(path, out)
    } catch {
      // Falls through to the untracked case below.
    }

    // An untracked file has nothing to diff against, so show it as all-added.
    try {
      const out = await this.git(root, [
        'diff',
        '--no-color',
        '--unified=3',
        '--no-index',
        '/dev/null',
        path,
      ])
      return parseUnifiedDiff(path, out)
    } catch (err) {
      // `--no-index` exits 1 when files differ, which is the normal case.
      const stdout = (err as { stdout?: string }).stdout
      if (stdout) return parseUnifiedDiff(path, stdout)
      return { path, hunks: [], binary: false }
    }
  }
}
