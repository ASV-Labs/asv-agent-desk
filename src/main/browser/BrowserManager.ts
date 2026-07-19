import { randomUUID } from 'node:crypto'
import { BaseWindow, WebContentsView, session, shell } from 'electron'
import { isAllowedExternalUrl, normalizeUrl } from '../../shared/url'
import type { BrowserState, BrowserTabState, Rect } from '../../shared/panel'

/** Cookies and storage kept away from the app's own session. */
const PARTITION = 'persist:asv-agent-desk-browser'

type StateListener = (state: BrowserState) => void

interface Tab {
  id: string
  view: WebContentsView
  /** Whether the view is currently a child of the window. */
  mounted: boolean
}

/**
 * The in-app browser.
 *
 * Each tab is a real `WebContentsView` — a native Chromium view, not an
 * iframe or the deprecated `<webview>` tag. That buys correct rendering and
 * process isolation, at the cost of the thing that shapes this whole class:
 *
 * **A WebContentsView is a native overlay.** It paints above the renderer's
 * DOM and knows nothing about CSS. It cannot be laid out by the page, cannot
 * be clipped by a parent, and cannot sit beneath anything the renderer draws.
 * So the renderer measures where the panel's content area is and reports that
 * rectangle here, and only the active tab is ever visible.
 */
export class BrowserManager {
  private readonly tabs = new Map<string, Tab>()
  private readonly errors = new Map<string, string>()
  private window: BaseWindow | null = null
  private activeId: string | null = null
  private bounds: Rect = { x: 0, y: 0, width: 0, height: 0 }
  private visible = false
  private listener: StateListener = () => {}

  attachTo(window: BaseWindow): void {
    this.window = window
  }

  onState(cb: StateListener): void {
    this.listener = cb
  }

  /** Full state, broadcast after anything that changes tabs or navigation. */
  private publish(): void {
    this.listener(this.state())
  }

  state(): BrowserState {
    return {
      tabs: [...this.tabs.values()].map((tab) => this.stateOf(tab)),
      activeId: this.activeId,
    }
  }

  create(url = ''): BrowserTabState {
    if (!this.window) throw new Error('BrowserManager has no window')

    const id = randomUUID()
    const view = new WebContentsView({
      webPreferences: {
        // Nothing from ASV Agent Desk is exposed to the page. No preload, no node.
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        session: session.fromPartition(PARTITION),
      },
    })

    // Not attached to the window until it becomes the active tab. Detaching
    // rather than merely hiding also keeps inactive pages out of the
    // accessibility tree, where they were still readable when only hidden.
    const tab: Tab = { id, view, mounted: false }
    this.tabs.set(id, tab)
    this.wire(tab)

    if (url) void view.webContents.loadURL(normalizeUrl(url))

    const state = this.stateOf(tab)
    this.publish()
    return state
  }

  private wire(tab: Tab): void {
    const { webContents } = tab.view
    const emit = (): void => this.publish()

    webContents.on('did-start-loading', emit)
    webContents.on('did-stop-loading', emit)
    webContents.on('did-navigate', emit)
    webContents.on('did-navigate-in-page', emit)
    webContents.on('page-title-updated', emit)
    webContents.on('page-favicon-updated', emit)

    webContents.on('did-fail-load', (_e, code, description, url, isMainFrame) => {
      // Sub-resource failures are noise, and -3 is a user-initiated abort.
      if (!isMainFrame || code === -3) return
      this.errors.set(tab.id, `${description} (${url})`)
      this.publish()
    })

    webContents.on('did-start-navigation', () => {
      this.errors.delete(tab.id)
    })

    // Popups become tabs in the panel rather than detached windows. Because
    // main owns the tab list, the renderer learns about this through the same
    // broadcast as any other change — it does not need to have initiated it.
    webContents.setWindowOpenHandler(({ url, disposition }) => {
      if (disposition === 'new-window' || disposition === 'foreground-tab') {
        const created = this.create(url)
        this.setActive(created.id)
      } else if (isAllowedExternalUrl(url)) {
        void shell.openExternal(url)
      }
      return { action: 'deny' }
    })
  }

  private stateOf(tab: Tab): BrowserTabState {
    const wc = tab.view.webContents
    return {
      id: tab.id,
      url: wc.getURL(),
      title: wc.getTitle(),
      loading: wc.isLoading(),
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward(),
      error: this.errors.get(tab.id),
    }
  }

  navigate(id: string, input: string): void {
    const tab = this.tabs.get(id)
    if (!tab) return
    const url = normalizeUrl(input)
    if (url) void tab.view.webContents.loadURL(url)
  }

  goBack(id: string): void {
    const wc = this.tabs.get(id)?.view.webContents
    if (wc?.navigationHistory.canGoBack()) wc.navigationHistory.goBack()
  }

  goForward(id: string): void {
    const wc = this.tabs.get(id)?.view.webContents
    if (wc?.navigationHistory.canGoForward()) wc.navigationHistory.goForward()
  }

  reload(id: string): void {
    this.tabs.get(id)?.view.webContents.reload()
  }

  openExternal(id: string): void {
    const url = this.tabs.get(id)?.view.webContents.getURL()
    if (url && isAllowedExternalUrl(url)) void shell.openExternal(url)
  }

  /**
   * Show exactly one tab, or none.
   *
   * Passing null is how a diff tab gets to be visible: diffs are DOM, and a
   * native browser view would paint straight over them.
   */
  setActive(id: string | null): void {
    this.activeId = id && this.tabs.has(id) ? id : null
    this.applyVisibility()
    this.publish()
  }

  /** Panel collapsed, or the window hidden. */
  setVisible(visible: boolean): void {
    this.visible = visible
    this.applyVisibility()
  }

  /** Where the panel's content area is, in window coordinates. */
  setBounds(rect: Rect): void {
    this.bounds = rect
    this.applyVisibility()
  }

  /**
   * Attach exactly the view that should be on screen, and detach the rest.
   *
   * Attaching and detaching rather than toggling `setVisible` is deliberate:
   * a merely hidden view stays in the window's view tree, and its document
   * remains readable through the accessibility tree even though nothing is
   * painted. Detaching removes it entirely. The `WebContents` is untouched, so
   * the page keeps its state and can be reattached instantly.
   */
  private applyVisibility(): void {
    const showable = this.visible && this.bounds.width > 0 && this.bounds.height > 0

    for (const [id, tab] of this.tabs) {
      const show = showable && id === this.activeId

      if (show && !tab.mounted) {
        this.window?.contentView.addChildView(tab.view)
        tab.mounted = true
      } else if (!show && tab.mounted) {
        this.window?.contentView.removeChildView(tab.view)
        tab.mounted = false
      }

      if (show) tab.view.setBounds(this.bounds)
    }
  }

  close(id: string): void {
    const tab = this.tabs.get(id)
    if (!tab) return

    const order = [...this.tabs.keys()].indexOf(id)
    this.tabs.delete(id)
    this.errors.delete(id)

    // Select the positional neighbour rather than whatever happens to be last.
    // Falling back to the last tab avoided a blank panel but could jump the
    // user across the strip when closing something in the middle.
    if (this.activeId === id) {
      const remaining = [...this.tabs.keys()]
      const next = remaining[Math.min(order, remaining.length - 1)]
      this.activeId = next ?? null
    }

    if (tab.mounted) {
      this.window?.contentView.removeChildView(tab.view)
      tab.mounted = false
    }

    // Stop network activity before teardown; a loading page otherwise keeps
    // fetching into a view nobody can see.
    try {
      tab.view.webContents.stop()
      tab.view.webContents.close()
    } catch {
      // Already gone.
    }

    this.applyVisibility()
    this.publish()
  }

  /**
   * Destroy every view.
   *
   * Must run during `before-quit`, not only when the window closes. A live
   * `WebContents` keeps its own renderer process alive, and quitting with one
   * attached left the app process hanging indefinitely — every other cleanup
   * completed, so the terminal looked clean while the process never exited.
   */
  closeAll(): void {
    for (const id of [...this.tabs.keys()]) this.close(id)
  }

  get size(): number {
    return this.tabs.size
  }
}
