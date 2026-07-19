import { join } from 'node:path'
import { app, BaseWindow, WebContentsView, dialog, ipcMain, shell } from 'electron'
import { watch, type FSWatcher } from 'node:fs'
import { SessionManager } from './sessions/SessionManager'
import { SessionStore } from './store/SessionStore'
import { HookServer } from './hooks/HookServer'
import { installHooks, socketPath, uninstallHooks } from './hooks/install'
import { BrowserManager } from './browser/BrowserManager'
import { GitService } from './git/GitService'
import { WorktreeManager } from './worktrees/WorktreeManager'
import { LineageStore } from './worktrees/LineageStore'
import { grokHome, sessionsRoot } from './store/paths'
import {
  inspectGrokRuntime,
  TESTED_GROK_VERSION,
  type RuntimeProbe,
} from './runtime/GrokRuntime'
import { isAllowedExternalUrl } from '../shared/url'
import type { Rect } from '../shared/panel'
import type { ForkRequest } from '../shared/worktrees'
import {
  IPC,
  type SessionAckRequest,
  type SessionCreateOptions,
  type SessionIdRequest,
  type SessionInputRequest,
  type SessionResizeRequest,
} from '../shared/ipc'

const isDev = !app.isPackaged

let win: BaseWindow | null = null
let shellView: WebContentsView | null = null

// Sessions outlive windows. Constructed once, at module scope, so closing and
// reopening a window never touches a running `grok` process.
const sessions = new SessionManager()

// Grok's hooks POST here. This is the app's only source of live agent state —
// nothing is inferred from terminal output.
const hooks = new HookServer()
hooks.onEvent((event) => sessions.handleHookEvent(event))

// Grok's own session history on disk. Read-only — ASV Agent Desk never writes here.
const grokRoot = grokHome()
const store = new SessionStore(grokRoot)

// The right-hand panel: native browser views, and read-only git for diffs.
const browsers = new BrowserManager()
const git = new GitService()

// Worktrees, and the fork lineage ASV Agent Desk records over them. The lineage file
// lives in the app's own data directory — `~/.grok` belongs to Grok, and this
// app only reads from it.
const worktrees = new WorktreeManager(grokRoot)
const lineage = new LineageStore(join(app.getPath('userData'), 'lineage.json'))
let storeWatcher: FSWatcher | null = null
let runtime: RuntimeProbe = {
  status: {
    installed: false,
    supported: false,
    testedVersion: TESTED_GROK_VERSION,
    error: 'Runtime preflight has not run yet.',
  },
}

async function refreshRuntime(): Promise<RuntimeProbe> {
  runtime = await inspectGrokRuntime()
  if (runtime.command) worktrees.setCommand(runtime.command)
  return runtime
}

function runtimeCommand(): string {
  if (!runtime.status.installed || !runtime.command) {
    throw new Error('Grok Build is not installed. Run the runtime preflight and install it first.')
  }
  return runtime.command
}

/**
 * Watch `~/.grok/sessions` so the sidebar updates while a session runs.
 *
 * Uses `fs.watch` rather than a watcher dependency. Grok writes to its
 * transcripts continuously, so events are coalesced — the renderer only needs
 * to know that *something* changed, and re-reads on its own schedule.
 */
function watchStore(): void {
  let timer: NodeJS.Timeout | null = null

  try {
    storeWatcher = watch(sessionsRoot(grokRoot), { recursive: true }, () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => send(IPC.storeChanged, {}), 400)
    })
  } catch {
    // No sessions directory yet, or the platform lacks recursive watching.
    // The sidebar still populates on demand; it just will not live-update.
  }
}

function createWindow(): void {
  win = new BaseWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'ASV Agent Desk',
    backgroundColor: '#14161a',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 18 },
  })

  // The app shell is itself a WebContentsView rather than a BrowserWindow's
  // web contents. Phase 5 adds sibling WebContentsViews for browser and diff
  // tabs; establishing the BaseWindow container now avoids reworking this.
  shellView = new WebContentsView({
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  win.contentView.addChildView(shellView)
  browsers.attachTo(win)

  const layout = (): void => {
    if (!win || !shellView) return
    const { width, height } = win.getContentBounds()
    shellView.setBounds({ x: 0, y: 0, width, height })
  }

  layout()
  win.on('resize', layout)

  const rendererUrl = process.env['ELECTRON_RENDERER_URL']
  if (isDev && rendererUrl) {
    void shellView.webContents.loadURL(rendererUrl)
    shellView.webContents.openDevTools({ mode: 'detach' })
  } else {
    void shellView.webContents.loadFile(join(__dirname, '../renderer/index.html'))
  }

  // Only ordinary web and email protocols may leave the app.
  shellView.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  win.on('closed', () => {
    browsers.closeAll()
    win = null
    shellView = null
    // Deliberately does NOT close sessions.
  })
}

function send(channel: string, payload: unknown): void {
  if (shellView && !shellView.webContents.isDestroyed()) {
    shellView.webContents.send(channel, payload)
  }
}

sessions.onData((id, data) => send(IPC.sessionData, { id, data }))
sessions.onStateChange((info, removed) => send(IPC.sessionState, { info, removed }))

ipcMain.handle(IPC.appDefaults, () => ({
  home: app.getPath('home'),
  defaultCwd: process.env.ASV_AGENT_DESK_CWD || app.getPath('home'),
  platform: process.platform,
}))

ipcMain.handle(IPC.appRuntimeStatus, async () => (await refreshRuntime()).status)

ipcMain.handle(IPC.appOpenExternal, async (_e, { url }: { url: string }) => {
  if (!isAllowedExternalUrl(url)) return false
  await shell.openExternal(url)
  return true
})

ipcMain.handle(IPC.pickDirectory, async (_e, { defaultPath }: { defaultPath?: string } = {}) => {
  const result = await dialog.showOpenDialog({
    title: 'Choose a project directory',
    defaultPath,
    properties: ['openDirectory', 'createDirectory'],
  })
  return result.canceled ? null : (result.filePaths[0] ?? null)
})

ipcMain.handle(IPC.storeProjects, () => store.projects())

browsers.onState((state) => send(IPC.browserState, state))

// Main owns tab identity and order; the renderer mirrors this list.
ipcMain.handle(IPC.browserList, () => browsers.state())
ipcMain.handle(IPC.browserCreate, (_e, { url }: { url?: string }) => browsers.create(url))
ipcMain.on(IPC.browserNavigate, (_e, { id, url }: { id: string; url: string }) =>
  browsers.navigate(id, url),
)
ipcMain.on(IPC.browserBack, (_e, { id }: SessionIdRequest) => browsers.goBack(id))
ipcMain.on(IPC.browserForward, (_e, { id }: SessionIdRequest) => browsers.goForward(id))
ipcMain.on(IPC.browserReload, (_e, { id }: SessionIdRequest) => browsers.reload(id))
ipcMain.on(IPC.browserExternal, (_e, { id }: SessionIdRequest) => browsers.openExternal(id))
ipcMain.on(IPC.browserClose, (_e, { id }: SessionIdRequest) => browsers.close(id))

// A null id hides every browser view — that is how a diff tab, which is plain
// DOM, gets to be visible without a native overlay painting over it.
ipcMain.on(IPC.browserSetActive, (_e, { id }: { id: string | null }) => browsers.setActive(id))
ipcMain.on(IPC.browserSetBounds, (_e, rect: Rect) => browsers.setBounds(rect))
ipcMain.on(IPC.browserSetVisible, (_e, { visible }: { visible: boolean }) =>
  browsers.setVisible(visible),
)

/**
 * Fork a session into an isolated worktree.
 *
 * Two steps that have to stay together: spawn the session with `-w`, and
 * record the parent edge. Grok has no notion of one session deriving from
 * another, so if ASV Agent Desk does not write that down, the relationship is gone.
 */
ipcMain.handle(IPC.sessionFork, async (_e, request: ForkRequest) => {
  const info = sessions.create({
    cwd: request.cwd,
    cols: request.cols,
    rows: request.rows,
    command: runtimeCommand(),
    parentSessionId: request.parentSessionId,
    worktree: { name: request.name, ref: request.ref },
  })

  await lineage.record({
    sessionId: info.id,
    parentSessionId: request.parentSessionId,
    worktreeName: request.name,
    createdAt: Date.now(),
  })

  return info
})

/**
 * Which sessions are live in which directory.
 *
 * Only SessionManager knows what is running, so this is assembled here rather
 * than inside WorktreeManager — which would otherwise need a dependency on it
 * purely to answer "is anything using this".
 *
 * Keyed on `cwd`, which for a worktree session is the checkout itself once the
 * first hook event has landed. Keying on the launch directory is what made a
 * live worktree look reapable.
 */
function liveSessionsByPath(): Map<string, string[]> {
  const map = new Map<string, string[]>()
  for (const session of sessions.list()) {
    const existing = map.get(session.cwd) ?? []
    existing.push(session.id)
    map.set(session.cwd, existing)
  }
  return map
}

ipcMain.handle(IPC.worktreeList, () => worktrees.list(liveSessionsByPath()))

// Persisted fork edges, so the sidebar can nest sessions that are no longer
// running. Without this the tree flattened on every relaunch.
ipcMain.handle(IPC.lineageList, () => lineage.all())

ipcMain.handle(
  IPC.worktreeRemove,
  async (_e, { name, force }: { name: string; force?: boolean }) => {
    // Re-derive the live map here rather than trusting the renderer's view or,
    // worse, calling list() with no map at all — which silently reported every
    // worktree as having no sessions and offered a live one for deletion.
    const all = await worktrees.list(liveSessionsByPath())
    const target = all.find((w) => w.name === name)
    if (!target) return { ok: false, reason: 'Worktree not found' }
    return worktrees.remove(target, force)
  },
)

ipcMain.handle(IPC.gitStatus, (_e, { cwd }: { cwd: string }) => git.status(cwd))
ipcMain.handle(IPC.gitDiff, (_e, { cwd, path }: { cwd: string; path: string }) =>
  git.diff(cwd, path),
)

ipcMain.handle(IPC.sessionCreate, (_e, opts: SessionCreateOptions) =>
  sessions.create({
    cwd: opts.cwd,
    cols: opts.cols,
    rows: opts.rows,
    title: opts.title,
    resumeSessionId: opts.resumeSessionId,
    parentSessionId: opts.parentSessionId,
    worktree: opts.worktree,
    oauth: opts.oauth === true,
    command: runtimeCommand(),
    // The renderer never supplies arbitrary CLI flags. OAuth, resume and
    // worktree choices are represented as typed fields and assembled in main.
    args: [],
  }),
)
ipcMain.handle(IPC.sessionList, () => sessions.list())
ipcMain.handle(IPC.sessionAttach, (_e, { id }: SessionIdRequest) => sessions.attach(id) ?? null)

ipcMain.on(IPC.sessionDetach, (_e, { id }: SessionIdRequest) => sessions.detach(id))
ipcMain.on(IPC.sessionInput, (_e, { id, data }: SessionInputRequest) => sessions.write(id, data))
ipcMain.on(IPC.sessionResize, (_e, { id, cols, rows }: SessionResizeRequest) =>
  sessions.resize(id, cols, rows),
)
ipcMain.on(IPC.sessionAck, (_e, { id, bytes }: SessionAckRequest) => sessions.ack(id, bytes))
ipcMain.on(IPC.sessionClose, (_e, { id }: SessionIdRequest) => sessions.close(id))
ipcMain.on(IPC.sessionAcknowledge, (_e, { id }: SessionIdRequest) => sessions.acknowledge(id))

/**
 * One instance only.
 *
 * `~/.grok/hooks/asv-agent-desk.json` holds a single ephemeral port. A second launch
 * would overwrite it, silently disconnecting the first instance's rail, and
 * its quit would delete the file out from under whichever instance survived.
 * A dev build and a packaged build running together hit this immediately.
 */
if (!app.requestSingleInstanceLock()) {
  app.quit()
}

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore()
    win.focus()
  } else {
    createWindow()
  }
})

app.whenReady().then(async () => {
  app.setName('ASV Agent Desk')
  await refreshRuntime()

  // Hooks must be registered before the first session spawns, or that session
  // starts without reporting state. Failure here is non-fatal: the app still
  // works, the rail just shows no activity.
  try {
    const sock = await hooks.startUnix(socketPath())
    await installHooks(sock, grokRoot)
  } catch (err) {
    console.error('[asv-agent-desk] hook server unavailable, rail will not update:', err)
  }

  createWindow()
  watchStore()

  app.on('activate', () => {
    if (!win) createWindow()
  })
})

app.on('window-all-closed', () => {
  // macOS convention keeps the app alive, and sessions with it.
  if (process.platform !== 'darwin') {
    sessions.closeAll()
    app.quit()
  }
})

/**
 * Shutdown.
 *
 * Everything here is synchronous: `before-quit` does not wait for promises,
 * and an async uninstall removed the config but left the hook script behind
 * because the process exited between two awaits.
 *
 * The await is the fix for the crash on quit. The app aborted with
 * `Napi::ThreadSafeFunction::CallJS` inside `Environment::CleanupHandles()` —
 * node-pty had callbacks queued in its thread-safe queue, and Node's teardown
 * drained them after the JS environment was being freed.
 *
 * Two earlier attempts failed for the same underlying reason: detaching JS
 * listeners does not cancel work already queued below that layer, and exiting
 * sooner does not outrun a queue the teardown drains regardless. Waiting for
 * each PTY to genuinely exit empties the queue first, which is the only order
 * that actually works. `app.exit` then skips a teardown with nothing left to do.
 */
let shuttingDown = false

app.on('before-quit', (event) => {
  if (shuttingDown) return
  shuttingDown = true

  event.preventDefault()

  storeWatcher?.close()
  uninstallHooks(grokRoot)

  // Browser views must be destroyed here, not only when the window closes. A
  // live WebContents keeps its own renderer process alive, and quitting with
  // one attached hung the app indefinitely — every other cleanup completed, so
  // the terminal looked clean while the process never exited.
  browsers.closeAll()

  void (async () => {
    // Bounded internally: a PTY that ignores SIGHUP settles after 1.5s.
    await sessions.closeAll()
    await hooks.stop()
    app.exit(0)
  })()
})
