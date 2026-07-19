import { contextBridge, ipcRenderer } from 'electron'
import {
  IPC,
  type AppDefaults,
  type RuntimeStatus,
  type SessionAttachResult,
  type SessionCreateOptions,
  type SessionDataEvent,
  type SessionInfo,
  type SessionStateEvent,
} from '../shared/ipc'
import type { StoredProject } from '../shared/store'
import type { BrowserState, BrowserTabState, FileDiff, Rect, RepoStatus } from '../shared/panel'
import type { ForkRequest, LineageEdge, Worktree } from '../shared/worktrees'

const api = {
  /** Resolved in main — a sandboxed preload has no reliable `process.env`. */
  defaults: (): Promise<AppDefaults> => ipcRenderer.invoke(IPC.appDefaults),

  /** Checks the separate Grok Build prerequisite without exposing its path. */
  runtimeStatus: (): Promise<RuntimeStatus> => ipcRenderer.invoke(IPC.appRuntimeStatus),

  /** Main applies the protocol allowlist before handing a URL to macOS. */
  openExternal: (url: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC.appOpenExternal, { url }),

  /** Native folder picker. Null if the user cancels. */
  pickDirectory: (defaultPath?: string): Promise<string | null> =>
    ipcRenderer.invoke(IPC.pickDirectory, { defaultPath }),

  /** The in-app browser. Tabs are native views positioned by main. */
  browser: {
    /** Current tabs and selection, owned by main. */
    list: (): Promise<BrowserState> => ipcRenderer.invoke(IPC.browserList),

    create: (url?: string): Promise<BrowserTabState> =>
      ipcRenderer.invoke(IPC.browserCreate, { url }),
    navigate: (id: string, url: string): void => {
      ipcRenderer.send(IPC.browserNavigate, { id, url })
    },
    back: (id: string): void => ipcRenderer.send(IPC.browserBack, { id }),
    forward: (id: string): void => ipcRenderer.send(IPC.browserForward, { id }),
    reload: (id: string): void => ipcRenderer.send(IPC.browserReload, { id }),
    openExternal: (id: string): void => ipcRenderer.send(IPC.browserExternal, { id }),
    close: (id: string): void => ipcRenderer.send(IPC.browserClose, { id }),

    /** Null hides all browser views, so a DOM diff tab can be seen. */
    setActive: (id: string | null): void => ipcRenderer.send(IPC.browserSetActive, { id }),

    /** Where the panel content area sits, in window coordinates. */
    setBounds: (rect: Rect): void => ipcRenderer.send(IPC.browserSetBounds, rect),
    setVisible: (visible: boolean): void =>
      ipcRenderer.send(IPC.browserSetVisible, { visible }),

    /** Fires with the whole tab list on any change, including popups. */
    onState: (cb: (state: BrowserState) => void): (() => void) => {
      const handler = (_: unknown, state: BrowserState): void => cb(state)
      ipcRenderer.on(IPC.browserState, handler)
      return () => ipcRenderer.removeListener(IPC.browserState, handler)
    },
  },

  /** Worktrees and fork lineage. */
  worktrees: {
    list: (): Promise<Worktree[]> => ipcRenderer.invoke(IPC.worktreeList),
    /** Persisted fork edges, for nesting sessions that are no longer running. */
    lineage: (): Promise<LineageEdge[]> => ipcRenderer.invoke(IPC.lineageList),
    remove: (name: string, force = false): Promise<{ ok: boolean; reason?: string }> =>
      ipcRenderer.invoke(IPC.worktreeRemove, { name, force }),
    /** Spawn a fork in an isolated worktree and record its parent. */
    fork: (request: ForkRequest): Promise<SessionInfo> =>
      ipcRenderer.invoke(IPC.sessionFork, request),
  },

  /** Read-only git, for the diff tabs. */
  git: {
    status: (cwd: string): Promise<RepoStatus> => ipcRenderer.invoke(IPC.gitStatus, { cwd }),
    diff: (cwd: string, path: string): Promise<FileDiff> =>
      ipcRenderer.invoke(IPC.gitDiff, { cwd, path }),
  },

  /** Grok's own session history, read from ~/.grok/sessions. */
  store: {
    projects: (): Promise<StoredProject[]> => ipcRenderer.invoke(IPC.storeProjects),

    /** Fires when the session directory changes, coalesced in main. */
    onChanged: (cb: () => void): (() => void) => {
      const handler = (): void => cb()
      ipcRenderer.on(IPC.storeChanged, handler)
      return () => ipcRenderer.removeListener(IPC.storeChanged, handler)
    },
  },

  sessions: {
    create: (opts: SessionCreateOptions): Promise<SessionInfo> =>
      ipcRenderer.invoke(IPC.sessionCreate, opts),

    list: (): Promise<SessionInfo[]> => ipcRenderer.invoke(IPC.sessionList),

    /** Binds a view and returns buffered output. Null if the id is unknown. */
    attach: (id: string): Promise<SessionAttachResult | null> =>
      ipcRenderer.invoke(IPC.sessionAttach, { id }),

    /** Unbinds the view. Does not stop the process. */
    detach: (id: string): void => {
      ipcRenderer.send(IPC.sessionDetach, { id })
    },

    write: (id: string, data: string): void => {
      ipcRenderer.send(IPC.sessionInput, { id, data })
    },

    resize: (id: string, cols: number, rows: number): void => {
      ipcRenderer.send(IPC.sessionResize, { id, cols, rows })
    },

    /** Confirms N bytes flushed, releasing backpressure in main. */
    ack: (id: string, bytes: number): void => {
      ipcRenderer.send(IPC.sessionAck, { id, bytes })
    },

    /** Terminates the process and drops the session. */
    close: (id: string): void => {
      ipcRenderer.send(IPC.sessionClose, { id })
    },

    /** Clears a pending `needs-you` when the user focuses the session. */
    acknowledge: (id: string): void => {
      ipcRenderer.send(IPC.sessionAcknowledge, { id })
    },

    onData: (cb: (e: SessionDataEvent) => void): (() => void) => {
      const handler = (_: unknown, payload: SessionDataEvent): void => cb(payload)
      ipcRenderer.on(IPC.sessionData, handler)
      return () => ipcRenderer.removeListener(IPC.sessionData, handler)
    },

    onStateChange: (cb: (e: SessionStateEvent) => void): (() => void) => {
      const handler = (_: unknown, payload: SessionStateEvent): void => cb(payload)
      ipcRenderer.on(IPC.sessionState, handler)
      return () => ipcRenderer.removeListener(IPC.sessionState, handler)
    },
  },
}

contextBridge.exposeInMainWorld('agentDesk', api)

export type AgentDeskApi = typeof api
