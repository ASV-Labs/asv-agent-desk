import { useCallback, useEffect, useRef, useState } from 'react'
import DiffView from './DiffView'
import { displayTitle } from '../../../shared/url'
import Icon from '../ui/Icon'
import type { BrowserState } from '../../../shared/panel'

interface Props {
  /** Working directory of the active session, for the diff tab. */
  cwd: string | null
  /** Bumped when the agent touches files, to refresh diffs. */
  refreshToken: number
  visible: boolean
}

/**
 * The right-hand panel: browser tabs and diff tabs in one strip.
 *
 * **Main owns the browser tabs.** This component mirrors the list it is given
 * and never keeps its own copy. An earlier version did, and split-brained
 * twice: a popup created in main appeared under the previous tab's label, and
 * collapsing the panel unmounted the array while the native views stayed alive
 * — orphaned, invisible, and enough to hang the app on quit.
 *
 * The two tab kinds are different objects. A diff is DOM rendered here; a
 * browser tab is a native view painted over the window. They cannot overlap,
 * so exactly one is ever showing.
 */
export default function RightPanel({ cwd, refreshToken, visible }: Props): React.JSX.Element {
  const [browser, setBrowser] = useState<BrowserState>({ tabs: [], activeId: null })
  const [showDiff, setShowDiff] = useState(true)
  const [address, setAddress] = useState('')
  const [editing, setEditing] = useState(false)

  const contentRef = useRef<HTMLDivElement>(null)
  const activeBrowser = browser.tabs.find((t) => t.id === browser.activeId)
  const activeIsBrowser = !showDiff && !!activeBrowser

  /**
   * Adopt main's selection on mount rather than assuming Diffs.
   *
   * `showDiff` is the last piece of panel state the renderer owns, and
   * defaulting it to true on every mount meant collapsing and reopening the
   * panel silently deselected whatever browser tab was active — the pages
   * survived, but the view did not come back. Main already knows which tab is
   * selected; deriving from it closes the seam.
   */
  useEffect(() => {
    void window.agentDesk.browser.list().then((state) => {
      setBrowser(state)
      setShowDiff(state.activeId === null)
    })
    return window.agentDesk.browser.onState(setBrowser)
  }, [])

  // Keep the address bar in step with navigation, unless it is being typed in.
  useEffect(() => {
    if (!editing) setAddress(activeBrowser?.url ?? '')
  }, [activeBrowser?.url, activeBrowser?.id, editing])

  /**
   * Report the content rectangle to main.
   *
   * A native view cannot be laid out by CSS, so its position is pushed across
   * on every layout change: window resize, splitter drag, sidebar collapse,
   * tab switch. `getBoundingClientRect` is already in window coordinates.
   */
  const syncBounds = useCallback(() => {
    const el = contentRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    window.agentDesk.browser.setBounds({
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    })
  }, [])

  useEffect(() => {
    const el = contentRef.current
    if (!el) return

    let frame = 0
    const schedule = (): void => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(syncBounds)
    }

    const observer = new ResizeObserver(schedule)
    observer.observe(el)
    window.addEventListener('resize', schedule)
    schedule()

    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      window.removeEventListener('resize', schedule)
    }
  }, [syncBounds])

  // Only one of DOM or native content is shown. Null hides every browser view.
  // Guarded on `showDiff` alone so this does not fire before the initial
  // adoption above has run, which would immediately clear main's selection.
  useEffect(() => {
    if (showDiff) window.agentDesk.browser.setActive(null)
  }, [showDiff])

  useEffect(() => {
    window.agentDesk.browser.setVisible(visible)
  }, [visible])

  const newTab = useCallback(async () => {
    const state = await window.agentDesk.browser.create()
    // Clear before switching: a new tab is blank, so showing the previous
    // tab's URL in the address bar would be a lie.
    setAddress('')
    setEditing(true)
    setShowDiff(false)
    window.agentDesk.browser.setActive(state.id)
  }, [])

  const selectBrowserTab = useCallback((id: string) => {
    setShowDiff(false)
    setEditing(false)
    window.agentDesk.browser.setActive(id)
  }, [])

  const submitAddress = (e: React.FormEvent): void => {
    e.preventDefault()
    if (!browser.activeId) return
    window.agentDesk.browser.navigate(browser.activeId, address)
    setEditing(false)
  }

  return (
    <section className="right-panel">
      <div className="panel-tabs">
        <div
          className={`panel-tab${showDiff ? ' is-active' : ''}`}
          onClick={() => setShowDiff(true)}
          title="Working tree changes"
        >
          <Icon name="diff" size={13} />
          <span className="panel-tab-label">Diffs</span>
        </div>

        {browser.tabs.map((tab) => (
          <div
            key={tab.id}
            className={`panel-tab${!showDiff && tab.id === browser.activeId ? ' is-active' : ''}`}
            onClick={() => selectBrowserTab(tab.id)}
            title={tab.url}
          >
            <Icon name="globe" size={13} />
            <span className="panel-tab-label">{displayTitle(tab.url, tab.title)}</span>
            <button
              className="panel-tab-close"
              title="Close tab"
              onClick={(e) => {
                e.stopPropagation()
                window.agentDesk.browser.close(tab.id)
              }}
            >
              <Icon name="close" size={11} />
            </button>
          </div>
        ))}

        <button className="panel-tab-new" onClick={() => void newTab()} title="New browser tab">
          <Icon name="plus" size={13} />
        </button>
      </div>

      {activeIsBrowser && browser.activeId && (
        <form className="panel-address" onSubmit={submitAddress}>
          <button
            type="button"
            disabled={!activeBrowser?.canGoBack}
            onClick={() => window.agentDesk.browser.back(browser.activeId!)}
            title="Back"
          >
            <Icon name="back" />
          </button>
          <button
            type="button"
            disabled={!activeBrowser?.canGoForward}
            onClick={() => window.agentDesk.browser.forward(browser.activeId!)}
            title="Forward"
          >
            <Icon name="forward" />
          </button>
          <button
            type="button"
            onClick={() => window.agentDesk.browser.reload(browser.activeId!)}
            title={activeBrowser?.loading ? 'Stop' : 'Reload'}
          >
            <Icon name={activeBrowser?.loading ? 'stop' : 'reload'} />
          </button>
          <input
            value={address}
            placeholder="localhost:5173"
            spellCheck={false}
            autoFocus={editing}
            onChange={(e) => {
              setAddress(e.target.value)
              setEditing(true)
            }}
            onBlur={() => setEditing(false)}
          />
          <button
            type="button"
            onClick={() => window.agentDesk.browser.openExternal(browser.activeId!)}
            title="Open in default browser"
          >
            <Icon name="external" />
          </button>
        </form>
      )}

      {/*
        Always rendered, including for browser tabs: this element's bounds are
        what main uses to position the native view. Its children are empty in
        that case because the native view covers it.
      */}
      <div className="panel-content" ref={contentRef}>
        {showDiff &&
          (cwd ? (
            <DiffView cwd={cwd} refreshToken={refreshToken} />
          ) : (
            <div className="panel-empty-note">No active session</div>
          ))}

        {!showDiff && !activeBrowser && (
          <div className="panel-empty-note">No browser tab open — press + to add one</div>
        )}

        {activeIsBrowser && activeBrowser?.error && (
          <div className="panel-empty-note">{activeBrowser.error}</div>
        )}
      </div>
    </section>
  )
}
