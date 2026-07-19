import { useEffect, useState } from 'react'
import type { FileDiff, RepoStatus } from '../../../shared/panel'

interface Props {
  cwd: string
  /** Bumped by the caller to force a refresh after the agent edits files. */
  refreshToken: number
}

/**
 * Working-tree changes for one project.
 *
 * Plain DOM, unlike the browser tabs — which is exactly why the panel hides
 * every native browser view while a diff tab is active. A WebContentsView
 * would paint straight over this.
 */
export default function DiffView({ cwd, refreshToken }: Props): React.JSX.Element {
  const [status, setStatus] = useState<RepoStatus | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [diff, setDiff] = useState<FileDiff | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)

    void window.agentDesk.git.status(cwd).then((next) => {
      if (cancelled) return
      setStatus(next)
      setLoading(false)
      // Keep the current selection across refreshes if it still has changes.
      setSelected((prev) =>
        prev && next.files.some((f) => f.path === prev) ? prev : (next.files[0]?.path ?? null),
      )
    })

    return () => {
      cancelled = true
    }
  }, [cwd, refreshToken])

  useEffect(() => {
    if (!selected) {
      setDiff(null)
      return
    }
    let cancelled = false
    void window.agentDesk.git.diff(cwd, selected).then((next) => {
      if (!cancelled) setDiff(next)
    })
    return () => {
      cancelled = true
    }
  }, [cwd, selected, refreshToken])

  if (loading) return <div className="panel-empty-note">Reading working tree…</div>

  if (!status?.root) {
    return <div className="panel-empty-note">Not a git repository</div>
  }

  if (status.files.length === 0) {
    return (
      <div className="panel-empty-note">
        No changes
        {status.branch && <div className="diff-branch">on {status.branch}</div>}
      </div>
    )
  }

  return (
    <div className="diff-view">
      <div className="diff-files">
        <div className="diff-summary">
          {status.branch && <span className="diff-branch">{status.branch}</span>}
          <span className="diff-added">+{status.added}</span>
          <span className="diff-removed">−{status.removed}</span>
        </div>

        {status.files.map((file) => (
          <div
            key={file.path}
            className={`diff-file${file.path === selected ? ' is-active' : ''}`}
            onClick={() => setSelected(file.path)}
            title={file.path}
          >
            <span className="diff-status">{file.status}</span>
            <span className="diff-path">{file.path}</span>
            <span className="diff-counts">
              <span className="diff-added">+{file.added}</span>
              <span className="diff-removed">−{file.removed}</span>
            </span>
          </div>
        ))}
      </div>

      <div className="diff-body">
        {diff?.binary && <div className="panel-empty-note">Binary file</div>}

        {diff &&
          !diff.binary &&
          diff.hunks.map((hunk, i) => (
            <div key={i} className="diff-hunk">
              <div className="diff-hunk-head">{hunk.header}</div>
              {hunk.lines.map((line, j) => (
                <div key={j} className={`diff-line is-${line.kind}`}>
                  <span className="diff-gutter">{line.oldLine ?? ''}</span>
                  <span className="diff-gutter">{line.newLine ?? ''}</span>
                  <span className="diff-mark">
                    {line.kind === 'add' ? '+' : line.kind === 'remove' ? '−' : ' '}
                  </span>
                  <span className="diff-text">{line.text || ' '}</span>
                </div>
              ))}
            </div>
          ))}

        {diff && !diff.binary && diff.hunks.length === 0 && (
          <div className="panel-empty-note">No textual changes</div>
        )}
      </div>
    </div>
  )
}
