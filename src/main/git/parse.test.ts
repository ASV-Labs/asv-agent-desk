import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  countAddedLines,
  mergeStatus,
  parseNumstat,
  parseStatus,
  parseUnifiedDiff,
  totals,
} from './parse'
import { displayTitle, isAllowedExternalUrl, normalizeUrl } from '../../shared/url'

describe('parseStatus', () => {
  it('reads NUL-separated porcelain output', () => {
    const out = parseStatus('M  src/a.ts\0?? src/new.ts\0 D src/gone.ts\0')
    assert.deepEqual(out, [
      { path: 'src/a.ts', status: 'M' },
      { path: 'src/new.ts', status: '??' },
      { path: 'src/gone.ts', status: 'D' },
    ])
  })

  // The reason for -z: a filename can contain a space or a newline, and the
  // human-readable format quotes them inconsistently.
  it('handles filenames with spaces', () => {
    const out = parseStatus('M  src/my file.ts\0')
    assert.equal(out[0].path, 'src/my file.ts')
  })

  it('consumes the source record of a rename', () => {
    // A rename emits the destination, then the source as a separate record.
    const out = parseStatus('R  new/path.ts\0old/path.ts\0M  other.ts\0')
    assert.deepEqual(
      out.map((f) => f.path),
      ['new/path.ts', 'other.ts'],
    )
  })

  it('returns nothing for a clean tree', () => {
    assert.deepEqual(parseStatus(''), [])
  })
})

describe('parseNumstat', () => {
  it('reads added and removed counts', () => {
    const stats = parseNumstat('12\t3\tsrc/a.ts\0 0\t7\tsrc/b.ts\0')
    assert.deepEqual(stats.get('src/a.ts'), { added: 12, removed: 3 })
  })

  it('treats binary files as zero rather than NaN', () => {
    const stats = parseNumstat('-\t-\tlogo.png\0')
    assert.deepEqual(stats.get('logo.png'), { added: 0, removed: 0 })
  })
})

describe('mergeStatus', () => {
  it('joins counts onto status entries and sorts by path', () => {
    const files = mergeStatus(
      [
        { path: 'z.ts', status: 'M' },
        { path: 'a.ts', status: 'M' },
      ],
      new Map([['a.ts', { added: 5, removed: 2 }]]),
    )

    assert.deepEqual(
      files.map((f) => f.path),
      ['a.ts', 'z.ts'],
    )
    assert.equal(files[0].added, 5)
    // Untracked files have no diff against HEAD; zero is correct, not missing.
    assert.equal(files[1].added, 0)
  })

  it('totals across files', () => {
    assert.deepEqual(
      totals([
        { path: 'a', status: 'M', added: 3, removed: 1 },
        { path: 'b', status: 'M', added: 4, removed: 2 },
      ]),
      { added: 7, removed: 3 },
    )
  })
})

/**
 * Untracked files are invisible to `git diff --numstat HEAD`, so they arrived
 * as `+0 −0` in the file list while their `--no-index` diff correctly showed
 * every line as added. The list and the body disagreed.
 */
describe('countAddedLines', () => {
  it('counts lines with a trailing newline', () => {
    assert.equal(countAddedLines(Buffer.from('a\nb\n')), 2)
  })

  it('counts a final line with no trailing newline', () => {
    assert.equal(countAddedLines(Buffer.from('a\nb')), 2)
  })

  it('counts a single line', () => {
    assert.equal(countAddedLines(Buffer.from('only\n')), 1)
  })

  it('returns zero for an empty file', () => {
    assert.equal(countAddedLines(Buffer.from('')), 0)
  })

  // Git's own heuristic: a NUL byte anywhere means binary.
  it('returns null for binary content', () => {
    assert.equal(countAddedLines(Buffer.from([0x89, 0x50, 0x00, 0x4e])), null)
  })
})

describe('parseUnifiedDiff', () => {
  const DIFF = `diff --git a/src/app.ts b/src/app.ts
index 1234567..89abcde 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -10,7 +10,8 @@ export function main() {
 const a = 1
-const b = 2
+const b = 3
+const c = 4
 const d = 5
`

  it('extracts hunks with per-side line numbers', () => {
    const result = parseUnifiedDiff('src/app.ts', DIFF)

    assert.equal(result.hunks.length, 1)
    const lines = result.hunks[0].lines

    assert.deepEqual(
      lines.map((l) => l.kind),
      ['context', 'remove', 'add', 'add', 'context'],
    )

    // Old and new gutters advance independently — that is what makes the
    // rendered diff readable rather than just coloured.
    assert.equal(lines[0].oldLine, 10)
    assert.equal(lines[0].newLine, 10)
    assert.equal(lines[1].oldLine, 11)
    assert.equal(lines[1].newLine, undefined)
    assert.equal(lines[2].newLine, 11)
    assert.equal(lines[4].oldLine, 12)
    assert.equal(lines[4].newLine, 13)
  })

  it('strips the leading marker from line text', () => {
    const result = parseUnifiedDiff('src/app.ts', DIFF)
    const added = result.hunks[0].lines.filter((l) => l.kind === 'add')
    assert.deepEqual(
      added.map((l) => l.text),
      ['const b = 3', 'const c = 4'],
    )
  })

  it('flags binary files instead of rendering bytes', () => {
    const result = parseUnifiedDiff(
      'logo.png',
      'diff --git a/logo.png b/logo.png\nBinary files a/logo.png and b/logo.png differ\n',
    )
    assert.equal(result.binary, true)
    assert.equal(result.hunks.length, 0)
  })

  it('handles multiple hunks', () => {
    const multi = `--- a/f.ts
+++ b/f.ts
@@ -1,2 +1,2 @@
-a
+b
@@ -20,2 +20,2 @@
-c
+d
`
    const result = parseUnifiedDiff('f.ts', multi)
    assert.equal(result.hunks.length, 2)
    assert.equal(result.hunks[1].lines[0].oldLine, 20)
  })

  it('ignores the no-newline marker', () => {
    const result = parseUnifiedDiff('f.ts', '@@ -1 +1 @@\n-a\n+b\n\\ No newline at end of file\n')
    assert.equal(result.hunks[0].lines.length, 2)
  })

  it('returns no hunks for an empty diff', () => {
    assert.deepEqual(parseUnifiedDiff('f.ts', '').hunks, [])
  })
})

describe('normalizeUrl', () => {
  it('keeps an explicit scheme', () => {
    assert.equal(normalizeUrl('https://x.ai/cli'), 'https://x.ai/cli')
    assert.equal(normalizeUrl('file:///tmp/a.html'), 'file:///tmp/a.html')
    assert.equal(normalizeUrl('about:blank'), 'about:blank')
  })

  // A naive `^word:` scheme test matches this and passes it through as a
  // nonsense scheme — and it is the single most common thing typed here.
  it('does not mistake a host:port for a scheme', () => {
    assert.equal(normalizeUrl('localhost:5173'), 'http://localhost:5173')
    assert.equal(normalizeUrl('example.com:8443/x'), 'https://example.com:8443/x')
  })

  // The case this exists for: a dev server is the most common thing typed
  // into this bar, and https would produce a certificate error, not a page.
  it('sends localhost and loopback to http', () => {
    assert.equal(normalizeUrl('localhost:3000'), 'http://localhost:3000')
    assert.equal(normalizeUrl('127.0.0.1:8080/health'), 'http://127.0.0.1:8080/health')
  })

  it('sends bare public hosts to https', () => {
    assert.equal(normalizeUrl('x.ai'), 'https://x.ai')
    assert.equal(normalizeUrl('docs.x.ai/build/overview'), 'https://docs.x.ai/build/overview')
  })

  it('treats anything else as a search', () => {
    assert.match(normalizeUrl('how to use worktrees'), /^https:\/\/duckduckgo\.com\/\?q=/)
    assert.match(normalizeUrl('grok'), /duckduckgo/)
  })

  it('returns empty for empty input', () => {
    assert.equal(normalizeUrl('   '), '')
  })
})

describe('isAllowedExternalUrl', () => {
  it('allows only web and email protocols', () => {
    assert.equal(isAllowedExternalUrl('https://docs.x.ai/build/overview'), true)
    assert.equal(isAllowedExternalUrl('http://localhost:5173'), true)
    assert.equal(isAllowedExternalUrl('mailto:security@example.com'), true)
    assert.equal(isAllowedExternalUrl('file:///Users/demo/.ssh/id_ed25519'), false)
    assert.equal(isAllowedExternalUrl('javascript:alert(1)'), false)
    assert.equal(isAllowedExternalUrl('data:text/html,hello'), false)
    assert.equal(isAllowedExternalUrl('not a url'), false)
  })
})

describe('displayTitle', () => {
  it('prefers a real page title', () => {
    assert.equal(displayTitle('https://x.ai', 'Grok Build'), 'Grok Build')
  })

  it('falls back to the host', () => {
    assert.equal(displayTitle('https://docs.x.ai/build'), 'docs.x.ai')
  })

  it('uses the filename for file urls', () => {
    assert.equal(displayTitle('file:///tmp/report.html'), 'report.html')
  })

  it('survives a malformed url', () => {
    assert.equal(displayTitle(''), 'New tab')
  })
})
