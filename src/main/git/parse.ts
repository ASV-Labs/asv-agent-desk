import type { ChangedFile, DiffHunk, DiffLine, FileDiff } from '../../shared/panel'

/**
 * Pure parsers for git plumbing output.
 *
 * Separated from the process-spawning service so they can be tested against
 * real captured output without a repository.
 */

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/

/**
 * Parse `git status --porcelain=v1 -z`.
 *
 * NUL-separated because filenames may contain newlines, spaces or quotes, and
 * the human-readable format escapes them inconsistently.
 */
export function parseStatus(stdout: string): Array<{ path: string; status: string }> {
  const out: Array<{ path: string; status: string }> = []
  const parts = stdout.split('\0')

  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]
    if (!entry) continue

    const status = entry.slice(0, 2).trim() || entry.slice(0, 2)
    const path = entry.slice(3)
    if (!path) continue

    // Renames and copies emit the destination, then the source as the next
    // record. Consume the source so it is not reported as its own file.
    if (status.startsWith('R') || status.startsWith('C')) {
      i++
    }

    out.push({ path, status })
  }

  return out
}

/**
 * Parse `git diff --numstat -z`.
 *
 * Binary files report `-` for both counts rather than a number.
 */
export function parseNumstat(stdout: string): Map<string, { added: number; removed: number }> {
  const stats = new Map<string, { added: number; removed: number }>()
  const parts = stdout.split('\0').filter(Boolean)

  for (let i = 0; i < parts.length; i++) {
    const match = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(parts[i])
    if (!match) continue

    const [, addedRaw, removedRaw, pathField] = match
    let path = pathField

    // With -z, a rename emits an empty path field followed by two more
    // records: the old path, then the new one.
    if (!path) {
      path = parts[i + 2] ?? parts[i + 1] ?? ''
      i += 2
    }
    if (!path) continue

    stats.set(path, {
      added: addedRaw === '-' ? 0 : Number(addedRaw),
      removed: removedRaw === '-' ? 0 : Number(removedRaw),
    })
  }

  return stats
}

export function mergeStatus(
  entries: Array<{ path: string; status: string }>,
  stats: Map<string, { added: number; removed: number }>,
): ChangedFile[] {
  return entries
    .map(({ path, status }) => ({
      path,
      status,
      added: stats.get(path)?.added ?? 0,
      removed: stats.get(path)?.removed ?? 0,
    }))
    .sort((a, b) => a.path.localeCompare(b.path))
}

/**
 * Parse a unified diff for a single file into hunks with line numbers.
 *
 * Line numbers are tracked per side so the viewer can show old and new
 * gutters, which is what makes a diff readable rather than just coloured.
 */
export function parseUnifiedDiff(path: string, diff: string): FileDiff {
  const hunks: DiffHunk[] = []
  let current: DiffHunk | null = null
  let oldLine = 0
  let newLine = 0
  let binary = false

  for (const raw of diff.split('\n')) {
    if (raw.startsWith('Binary files ') || raw.startsWith('GIT binary patch')) {
      binary = true
      continue
    }

    const header = HUNK_HEADER.exec(raw)
    if (header) {
      oldLine = Number(header[1])
      newLine = Number(header[3])
      current = { header: raw, lines: [] }
      hunks.push(current)
      continue
    }

    // Everything before the first @@ is file metadata.
    if (!current) continue

    // A truncated final line; not part of the content.
    if (raw.startsWith('\\')) continue

    let line: DiffLine
    if (raw.startsWith('+')) {
      line = { kind: 'add', text: raw.slice(1), newLine: newLine++ }
    } else if (raw.startsWith('-')) {
      line = { kind: 'remove', text: raw.slice(1), oldLine: oldLine++ }
    } else if (raw.startsWith(' ')) {
      line = { kind: 'context', text: raw.slice(1), oldLine: oldLine++, newLine: newLine++ }
    } else if (raw === '') {
      continue
    } else {
      line = { kind: 'meta', text: raw }
    }

    current.lines.push(line)
  }

  return { path, hunks, binary }
}

/**
 * Line count for an untracked file's contents.
 *
 * `git diff --numstat HEAD` only covers tracked paths, so untracked files
 * arrived as `+0 −0` in the file list while their diff — produced separately
 * via `--no-index` — correctly showed every line as added. For a file with no
 * previous version, "added lines" is simply "lines".
 *
 * Returns null for binary content, matching git's own NUL-byte heuristic.
 */
export function countAddedLines(buffer: Buffer): number | null {
  if (buffer.includes(0)) return null

  const text = buffer.toString('utf8')
  if (!text) return 0
  // A trailing newline terminates the last line rather than starting another.
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
}

/** Total insertions and deletions across a set of files. */
export function totals(files: ChangedFile[]): { added: number; removed: number } {
  return files.reduce(
    (acc, file) => ({ added: acc.added + file.added, removed: acc.removed + file.removed }),
    { added: 0, removed: 0 },
  )
}
