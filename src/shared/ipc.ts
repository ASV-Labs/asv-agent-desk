/**
 * Single source of truth for IPC channel names and payload shapes.
 * Imported by main, preload, and renderer so the three can never drift.
 */

import type { ActivityState } from './hooks'

export const IPC = {
  appDefaults: 'app:defaults',
  appRuntimeStatus: 'app:runtime-status',
  appOpenExternal: 'app:open-external',
  pickDirectory: 'app:pick-directory',
  sessionAcknowledge: 'session:acknowledge',

  // renderer -> main (invoke)
  sessionCreate: 'session:create',
  sessionList: 'session:list',
  sessionAttach: 'session:attach',

  // renderer -> main (send)
  sessionDetach: 'session:detach',
  sessionInput: 'session:input',
  sessionResize: 'session:resize',
  sessionAck: 'session:ack',
  sessionClose: 'session:close',

  // session history on disk
  storeProjects: 'store:projects',

  // right panel — browser
  browserList: 'browser:list',
  browserCreate: 'browser:create',
  browserNavigate: 'browser:navigate',
  browserBack: 'browser:back',
  browserForward: 'browser:forward',
  browserReload: 'browser:reload',
  browserExternal: 'browser:external',
  browserClose: 'browser:close',
  browserSetActive: 'browser:set-active',
  browserSetBounds: 'browser:set-bounds',
  browserSetVisible: 'browser:set-visible',

  // right panel — diffs
  gitStatus: 'git:status',
  gitDiff: 'git:diff',

  // worktrees and fork lineage
  worktreeList: 'worktree:list',
  lineageList: 'lineage:list',
  worktreeRemove: 'worktree:remove',
  sessionFork: 'session:fork',

  // main -> renderer
  sessionData: 'session:data',
  sessionState: 'session:state',
  storeChanged: 'store:changed',
  browserState: 'browser:state',
} as const

export interface AppDefaults {
  home: string
  /** Directory ASV Agent Desk opens a session in when none has been chosen. */
  defaultCwd: string
  platform: NodeJS.Platform
}

/** Public runtime preflight. The executable path stays private to main. */
export interface RuntimeStatus {
  installed: boolean
  version?: string
  supported: boolean
  testedVersion: string
  error?: string
}

export type SessionState = 'running' | 'exited'

/**
 * The renderer's view of a session. Deliberately serialisable and free of any
 * PTY handle — the renderer never owns a process, it only observes one.
 */
export interface SessionInfo {
  id: string
  /**
   * Where the agent is actually working.
   *
   * For a worktree session this becomes the checkout Grok created, learned
   * from the first hook event. Everything that asks "what is this session
   * touching" — diffs, orphan detection, fork bases, sidebar grouping — must
   * use this rather than `baseCwd`.
   */
  cwd: string
  /** Directory the session was launched from. Unchanging. */
  baseCwd: string
  command: string
  args: string[]
  title: string
  /** Process liveness. Distinct from `activity`, which is what the agent is doing. */
  state: SessionState
  pid: number
  cols: number
  rows: number
  createdAt: number
  exitCode?: number

  /** Driven entirely by Grok's hooks — never by reading terminal output. */
  activity: ActivityState
  /** When the current activity began, for the rail's time-in-state readout. */
  activitySince: number
  subagents: number
  lastTool?: string
  /** Grok's own session id, once a hook event has let us correlate it. */
  grokSessionId?: string

  /** Session this one was forked from. ASV Agent Desk's own record, not Grok's. */
  parentSessionId?: string
  /** Worktree name when this session runs in one. */
  worktreeName?: string
  /** True when the session was spawned with `-w`. */
  isWorktree?: boolean
}

export interface SessionCreateOptions {
  cwd: string
  /** Defaults to `grok`. */
  command?: string
  args?: string[]
  title?: string
  cols: number
  rows: number
  /** First-run browser authentication, handled entirely by Grok Build. */
  oauth?: boolean
  /**
   * Resume an existing Grok session by id instead of starting a new one.
   *
   * The ASV Agent Desk session adopts this id, so hook correlation keeps working and
   * the live session lines up with its on-disk history.
   */
  resumeSessionId?: string
  /**
   * Run this session in an isolated git worktree.
   *
   * `name` and `ref` map to `--worktree=<name>` and `--ref <ref>`; omitting
   * both is a plain `-w`, which branches from current HEAD including
   * uncommitted changes.
   */
  worktree?: { name?: string; ref?: string }
  /** Session this fork came from, recorded by ASV Agent Desk for the lineage tree. */
  parentSessionId?: string
}

/** Returned on attach: current metadata plus buffered output to replay. */
export interface SessionAttachResult {
  info: SessionInfo
  replay: string
}

export interface SessionDataEvent {
  id: string
  data: string
}

/** Fired on create, exit, title change, or any other metadata mutation. */
export interface SessionStateEvent {
  info: SessionInfo
  /** True once the session has been removed from the registry. */
  removed?: boolean
}

export interface SessionInputRequest {
  id: string
  data: string
}

export interface SessionResizeRequest {
  id: string
  cols: number
  rows: number
}

/** Renderer confirms it flushed N bytes, so main can release backpressure. */
export interface SessionAckRequest {
  id: string
  bytes: number
}

export interface SessionIdRequest {
  id: string
}
