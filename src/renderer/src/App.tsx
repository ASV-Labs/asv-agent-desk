import { useCallback, useEffect, useRef, useState } from 'react'
import TerminalPane from './TerminalPane'
import Sidebar from './layout/Sidebar'
import SessionRail from './layout/SessionRail'
import RightPanel from './panel/RightPanel'
import Splitter from './layout/Splitter'
import { useLayout } from './layout/useLayout'
import Icon from './ui/Icon'
import type { AppDefaults, RuntimeStatus, SessionInfo } from '../../shared/ipc'

const INSTALL_COMMAND = 'curl -fsSL https://x.ai/cli/install.sh | bash'
const GROK_DOCS = 'https://docs.x.ai/build/overview'
const ONBOARDED_KEY = 'asv-agent-desk.oauth-onboarding.v1'

interface RuntimeOnboardingProps {
  runtime: RuntimeStatus | null
  checking: boolean
  onContinue: () => void
  onRecheck: () => void
}

function RuntimeOnboarding({
  runtime,
  checking,
  onContinue,
  onRecheck,
}: RuntimeOnboardingProps): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const installed = runtime?.installed === true

  const copyInstall = async (): Promise<void> => {
    await navigator.clipboard.writeText(INSTALL_COMMAND)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1_800)
  }

  return (
    <section className="runtime-onboarding" aria-labelledby="runtime-title">
      <div className="runtime-kicker">LOCAL RUNTIME CHECK</div>
      <h1 id="runtime-title">
        {installed ? 'Connect Grok Build with OAuth' : 'Install Grok Build to begin'}
      </h1>
      <p>
        ASV Agent Desk runs the official fullscreen TUI as a separate local process. It never
        reads or stores your OAuth token.
      </p>

      {!installed && (
        <div className="runtime-command">
          <code>{INSTALL_COMMAND}</code>
          <button type="button" onClick={() => void copyInstall()}>
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      )}

      <div className="runtime-meta">
        <span className={`runtime-dot${installed ? ' is-ready' : ''}`} />
        {checking
          ? 'Checking the login-shell PATH…'
          : installed
            ? `Grok Build ${runtime?.version ?? 'version unknown'} · tested ${runtime?.testedVersion}`
            : runtime?.error ?? 'Grok Build was not found.'}
      </div>

      <div className="runtime-actions">
        {installed ? (
          <button className="runtime-primary" type="button" onClick={onContinue}>
            Continue with OAuth
          </button>
        ) : (
          <button
            className="runtime-primary"
            type="button"
            onClick={onRecheck}
            disabled={checking}
          >
            {checking ? 'Checking…' : 'Recheck'}
          </button>
        )}
        <button
          className="runtime-secondary"
          type="button"
          onClick={() => void window.agentDesk.openExternal(GROK_DOCS)}
        >
          Official setup guide
        </button>
      </div>

      {installed && runtime?.supported === false && runtime.error && (
        <p className="runtime-warning">{runtime.error} Core behavior may still work.</p>
      )}
    </section>
  )
}

export default function App(): React.JSX.Element {
  const [defaults, setDefaults] = useState<AppDefaults | null>(null)
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null)
  const [checkingRuntime, setCheckingRuntime] = useState(true)
  const [showOnboarding, setShowOnboarding] = useState(false)
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [status, setStatus] = useState('starting…')

  const { layout, setSidebarWidth, setPanelWidth, togglePanel } = useLayout()
  const bootstrapped = useRef(false)

  // Declared before the callbacks that close over it.
  const active = sessions.find((s) => s.id === activeId) ?? null

  // Keep the session list in sync with main. Because main owns the processes,
  // this survives a renderer reload: on reconnect we adopt whatever is running
  // rather than spawning something new.
  useEffect(() => {
    return window.agentDesk.sessions.onStateChange(({ info, removed }) => {
      setSessions((prev) => {
        if (removed) return prev.filter((s) => s.id !== info.id)
        const idx = prev.findIndex((s) => s.id === info.id)
        if (idx === -1) return [...prev, info]
        const next = [...prev]
        next[idx] = info
        return next
      })
      if (removed) setActiveId((cur) => (cur === info.id ? null : cur))
    })
  }, [])

  useEffect(() => {
    if (bootstrapped.current) return
    bootstrapped.current = true

    void (async () => {
      const api = window.agentDesk.sessions
      const [d, runtimeStatus] = await Promise.all([
        window.agentDesk.defaults(),
        window.agentDesk.runtimeStatus(),
      ])
      setDefaults(d)
      setRuntime(runtimeStatus)
      setCheckingRuntime(false)

      const existing = await api.list()
      if (existing.length > 0) {
        setSessions(existing)
        setActiveId(existing[0].id)
        return
      }

      const hasOnboarded = window.localStorage.getItem(ONBOARDED_KEY) === 'true'
      if (!runtimeStatus.installed || !hasOnboarded) {
        setShowOnboarding(true)
        setStatus(runtimeStatus.installed ? 'OAuth setup' : 'Grok Build required')
        return
      }

      // Initial geometry is a rough guess; TerminalPane sends the authoritative
      // size the moment it attaches and has measured itself.
      const info = await api.create({ cwd: d.defaultCwd, cols: 120, rows: 32 })
      setSessions([info])
      setActiveId(info.id)
    })()
  }, [])

  const recheckRuntime = useCallback(async () => {
    setCheckingRuntime(true)
    const next = await window.agentDesk.runtimeStatus()
    setRuntime(next)
    setCheckingRuntime(false)
    setStatus(next.installed ? 'OAuth setup' : 'Grok Build required')
  }, [])

  const continueWithOAuth = useCallback(async () => {
    const cwd = defaults?.defaultCwd
    if (!cwd || !runtime?.installed) return
    const info = await window.agentDesk.sessions.create({
      cwd,
      cols: 120,
      rows: 32,
      oauth: true,
    })
    window.localStorage.setItem(ONBOARDED_KEY, 'true')
    setShowOnboarding(false)
    setActiveId(info.id)
  }, [defaults?.defaultCwd, runtime?.installed])

  // The primary action is deliberately immediate: "New session" means another
  // conversation in the current project, just as it does in other chat tools.
  // Choosing a different project remains available as a separate action.
  const newSession = useCallback(async () => {
    const cwd = active?.cwd ?? defaults?.defaultCwd
    if (!cwd) return
    const info = await window.agentDesk.sessions.create({ cwd, cols: 120, rows: 32 })
    setActiveId(info.id)
  }, [active?.cwd, defaults?.defaultCwd])

  const newSessionInFolder = useCallback(async () => {
    const cwd = await window.agentDesk.pickDirectory(active?.baseCwd ?? defaults?.defaultCwd)
    if (!cwd) return
    const info = await window.agentDesk.sessions.create({ cwd, cols: 120, rows: 32 })
    setActiveId(info.id)
  }, [active?.baseCwd, defaults?.defaultCwd])

  const closeSession = useCallback((id: string) => {
    window.agentDesk.sessions.close(id)
  }, [])

  /**
   * Fork the active session into an isolated worktree.
   *
   * The parent keeps working on its own checkout — that isolation is the whole
   * point, and it is what makes running several approaches at once safe rather
   * than a race to overwrite each other's files.
   */
  const forkSession = useCallback(async () => {
    if (!active) return
    const info = await window.agentDesk.worktrees.fork({
      parentSessionId: active.id,
      cwd: active.cwd,
      cols: 120,
      rows: 32,
    })
    setActiveId(info.id)
  }, [active])

  // ⌘⇧F, in the capture phase — xterm owns focus and eats keydown otherwise.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!e.metaKey || !e.shiftKey || e.key.toLowerCase() !== 'f') return
      e.preventDefault()
      e.stopPropagation()
      void forkSession()
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [forkSession])

  // Resuming adopts the stored id, so the live session and its on-disk history
  // stay the same session rather than becoming two.
  const resumeSession = useCallback(async (cwd: string, sessionId: string) => {
    const info = await window.agentDesk.sessions.create({
      cwd,
      cols: 120,
      rows: 32,
      resumeSessionId: sessionId,
    })
    setActiveId(info.id)
  }, [])

  // Selecting a session that was waiting on you clears the flag — this is what
  // drains the attention queue as you work through it.
  const selectSession = useCallback((id: string) => {
    setActiveId(id)
    window.agentDesk.sessions.acknowledge(id)
  }, [])

  useEffect(() => {
    if (activeId || sessions.length === 0) return
    setActiveId(sessions[0].id)
  }, [activeId, sessions])

  // Refresh diffs when the agent has plausibly touched files: a tool ran, or a
  // turn ended. Hook-driven, so no polling and no reading terminal output.
  const [diffToken, setDiffToken] = useState(0)
  const lastSignal = useRef('')

  useEffect(() => {
    if (!active) return
    const signal = `${active.id}:${active.lastTool ?? ''}:${active.activity}`
    if (signal === lastSignal.current) return
    lastSignal.current = signal
    setDiffToken((n) => n + 1)
  }, [active])

  // Browser views are native overlays owned by main, so they must be hidden
  // explicitly when the panel collapses — unmounting the React component
  // cannot make a native view disappear.
  useEffect(() => {
    window.agentDesk.browser.setVisible(!layout.panelCollapsed)
  }, [layout.panelCollapsed])

  return (
    <div className="app">
      {!layout.sidebarCollapsed && (
        <>
          <div className="sidebar-slot" style={{ width: layout.sidebarWidth }}>
            <Sidebar
              live={sessions}
              activeId={activeId}
              onSelect={selectSession}
              onResume={(cwd, id) => void resumeSession(cwd, id)}
              onNew={() => void newSession()}
              onNewInFolder={() => void newSessionInFolder()}
              onFork={active ? () => void forkSession() : undefined}
              onClose={closeSession}
            />
          </div>
          <Splitter side="left" onResize={setSidebarWidth} />
        </>
      )}

      {/*
        Header, rail and terminal are three fixed-or-flexible grid rows. The
        first two have constant heights: nothing in this column may change
        height at runtime, or the PTY resizes mid-render and the TUI tears.
      */}
      <div className="center">
        <header className="titlebar">
          <span className="cwd">{active?.cwd ?? defaults?.defaultCwd ?? '…'}</span>
          <span className="status">{status}</span>
          <button
            className="chrome-btn"
            onClick={togglePanel}
            title={layout.panelCollapsed ? 'Show panel (⌘\\)' : 'Hide panel (⌘\\)'}
          >
            <Icon name="panel-right" size={15} />
          </button>
        </header>

        <div className="rail-row">
          <SessionRail
            sessions={sessions}
            activeId={activeId}
            onSelect={selectSession}
            onClose={closeSession}
          />
        </div>

        <main className="terminal-column">
          {sessions.length === 0 &&
            (showOnboarding || checkingRuntime ? (
              <RuntimeOnboarding
                runtime={runtime}
                checking={checkingRuntime}
                onContinue={() => void continueWithOAuth()}
                onRecheck={() => void recheckRuntime()}
              />
            ) : (
              <div className="terminal-empty">No active session</div>
            ))}

          {/*
            Every session stays mounted and attached. Backgrounded agents keep
            working and their output keeps streaming into xterm's buffer —
            switching sessions is a visibility change, never a teardown.
          */}
          {sessions.map((s) => (
            <TerminalPane
              key={s.id}
              sessionId={s.id}
              hidden={s.id !== activeId}
              onStatus={s.id === activeId ? setStatus : undefined}
            />
          ))}
        </main>
      </div>

      {!layout.panelCollapsed && (
        <>
          <Splitter side="right" onResize={setPanelWidth} />
          <div className="panel-slot" style={{ width: layout.panelWidth }}>
            <RightPanel
              cwd={active?.cwd ?? null}
              refreshToken={diffToken}
              visible={!layout.panelCollapsed}
            />
          </div>
        </>
      )}
    </div>
  )
}
