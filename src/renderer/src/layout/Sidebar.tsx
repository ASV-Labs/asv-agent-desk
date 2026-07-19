import { useEffect, useState } from 'react'
import { buildSidebar } from './projects'
import WorktreePanel from './WorktreePanel'
import Icon from '../ui/Icon'
import type { SessionInfo } from '../../../shared/ipc'
import type { StoredProject } from '../../../shared/store'

interface Props {
  live: SessionInfo[]
  activeId: string | null
  onSelect: (id: string) => void
  onResume: (cwd: string, sessionId: string) => void
  onNew: () => void
  onNewInFolder: () => void
  /** Undefined when there is no active session to fork from. */
  onFork?: () => void
  onClose: (id: string) => void
}

function ago(then: number, now: number): string {
  const mins = Math.floor((now - then) / 60_000)
  if (mins < 1) return 'now'
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

/**
 * Projects and their sessions, read from `~/.grok/sessions`.
 *
 * The history is Grok's own — ASV Agent Desk only reads it. Sessions it is currently
 * running are joined in by id, so a row is either live (click to focus) or
 * historical (click to resume). That join is only reliable because ASV Agent Desk
 * supplies the session id at spawn via `--session-id`.
 */
export default function Sidebar({
  live,
  activeId,
  onSelect,
  onResume,
  onNew,
  onNewInFolder,
  onFork,
  onClose,
}: Props): React.JSX.Element {
  const [projects, setProjects] = useState<StoredProject[]>([])
  const [lineage, setLineage] = useState<Map<string, string>>(new Map())
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const load = (): void => {
      void window.agentDesk.store.projects().then(setProjects)
      // Fork edges live in ASV Agent Desk's own store, not in ~/.grok, so stored
      // sessions can still be nested after a relaunch.
      void window.agentDesk.worktrees
        .lineage()
        .then((edges) => setLineage(new Map(edges.map((e) => [e.sessionId, e.parentSessionId]))))
    }
    load()
    // Main coalesces filesystem noise, so this only fires on real changes.
    return window.agentDesk.store.onChanged(load)
  }, [])

  // Relative times are only honest if the clock advances. Previously `now` was
  // captured once, so a row could say "now" indefinitely.
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(t)
  }, [])

  const sidebar = buildSidebar(projects, live, lineage)

  const toggle = (cwd: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(cwd)) next.delete(cwd)
      else next.add(cwd)
      return next
    })
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <span className="sidebar-title">ASV Agent Desk</span>
      </div>

      <button className="sidebar-action" onClick={onNew} title="Start another session here">
        <Icon name="plus" />
        New session
      </button>

      <button
        className="sidebar-action"
        onClick={onNewInFolder}
        title="Start a session in a different folder"
      >
        <Icon name="folder" />
        Open folder…
      </button>

      <button
        className="sidebar-action"
        onClick={onFork}
        disabled={!onFork}
        title="Fork the active session into an isolated worktree (⌘⇧F)"
      >
        <Icon name="fork" />
        Fork session
      </button>

      <WorktreePanel />

      <div className="session-list">
        {sidebar.length === 0 && <div className="session-empty">No sessions yet</div>}

        {sidebar.map((project) => {
          const isCollapsed = collapsed.has(project.cwd)

          return (
            <div key={project.cwd}>
              <div className="project-head" onClick={() => toggle(project.cwd)} title={project.cwd}>
                <span className="project-caret">
                  <Icon name={isCollapsed ? 'chevron-right' : 'chevron-down'} size={12} />
                </span>
                <span className="project-name">{project.label}</span>
                {project.liveCount > 0 && (
                  <span className="project-count">{project.liveCount}</span>
                )}
              </div>

              {!isCollapsed &&
                project.rows.map((row) => {
                  const state = row.liveSession?.activity
                  return (
                    <div
                      key={row.id}
                      className={`session-row${row.id === activeId ? ' is-active' : ''}`}
                      // Forks are indented beneath the session they came from.
                      style={row.depth > 0 ? { paddingLeft: 18 + row.depth * 14 } : undefined}
                      onClick={() =>
                        row.liveSession ? onSelect(row.id) : onResume(row.cwd, row.id)
                      }
                      title={[
                        row.liveSession ? row.title : `Resume — ${row.title}`,
                        row.forkPath ? `fork ${row.forkPath}` : null,
                        // The generated checkout name is a filesystem label,
                        // not an identity. It belongs here and in the
                        // worktrees panel, not as the row's headline.
                        row.worktreeName ?? null,
                        row.messageCount ? `${row.messageCount} messages` : null,
                        row.branch ? `branch ${row.branch}` : null,
                      ]
                        .filter(Boolean)
                        .join('\n')}
                    >
                      <span
                        className={`dot ${state ? `is-${state}` : 'is-stored'}`}
                        title={state ?? 'not running'}
                      />
                      <div className="session-body">
                        <div className={`session-name${row.prompted === false ? ' is-muted' : ''}`}>
                          {row.depth > 0 && (
                            <span className="fork-mark">
                              <Icon name="fork" size={10} />
                            </span>
                          )}
                          {row.title}
                        </div>
                        {/*
                          Time only. The message count lives in the tooltip —
                          it reads as a turn count but is not one, and a bare
                          number next to a timestamp invites that reading.
                        */}
                        {/*
                          A fork reads as "fork 1.2 · running", not as a
                          generated directory name. The raw checkout is still
                          one hover away, and lives in full in the worktrees
                          panel where it is the actual subject.
                        */}
                        <div className="session-sub">
                          {row.forkPath && <span className="fork-badge">fork {row.forkPath}</span>}
                          {row.liveSession ? 'running' : ago(row.updatedAt, now)}
                        </div>
                      </div>
                      {row.liveSession && (
                        <button
                          className="session-close"
                          title="Close session"
                          onClick={(e) => {
                            e.stopPropagation()
                            onClose(row.id)
                          }}
                        >
                          <Icon name="close" size={12} />
                        </button>
                      )}
                    </div>
                  )
                })}
            </div>
          )
        })}
      </div>
    </aside>
  )
}
