import { createServer, type Server } from 'node:http'
import { rmSync } from 'node:fs'
import { normalizeHookEventName, type HookEvent } from '../../shared/hooks'

export type HookListener = (event: HookEvent) => void

const MAX_BODY = 256 * 1024

/**
 * The endpoint Grok's hooks deliver events to.
 *
 * **Why a unix domain socket and not a TCP port.** Grok 0.2.103 refuses HTTP
 * hook URLs under an SSRF policy — `only https:// URLs are allowed for HTTP
 * hooks, got http://` — and rejects them before opening a connection, so a
 * loopback HTTP endpoint is never contacted at all. Terminating TLS locally
 * would mean minting a certificate the agent is willing to trust, which is a
 * lot of machinery to bolt onto a local IPC problem. A unix socket has no URL
 * scheme to police, no port, and filesystem permissions for access control.
 *
 * Delivery is a `command` hook that pipes the event through
 * `curl --unix-socket` (see `install.ts`).
 *
 * Handlers reply 200 immediately and parse asynchronously: hooks are on a
 * timeout and a slow GUI must never become the agent's problem. Grok fails
 * hooks open, so a dropped event costs a stale dot in the rail, not a stalled
 * session.
 */
export class HookServer {
  private server: Server | null = null
  private listener: HookListener = () => {}
  private boundPort = 0
  private socketPath: string | null = null

  onEvent(cb: HookListener): void {
    this.listener = cb
  }

  get port(): number {
    return this.boundPort
  }

  /** Only meaningful for the TCP fallback used in tests. */
  get url(): string {
    return `http://127.0.0.1:${this.boundPort}/e`
  }

  get path(): string | null {
    return this.socketPath
  }

  /**
   * Listen on a unix socket.
   *
   * A stale socket file from a crashed run would make `listen` fail with
   * EADDRINUSE, so it is removed first. That is safe because the single
   * instance lock guarantees no other ASV Agent Desk owns it.
   */
  async startUnix(socketPath: string): Promise<string> {
    if (this.server) return this.socketPath ?? socketPath
    rmSync(socketPath, { force: true })

    const server = this.build()
    this.server = server
    this.socketPath = socketPath

    return new Promise<string>((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, () => resolve(socketPath))
    })
  }

  /** TCP loopback. Retained for tests; Grok will not talk to it. */
  async start(): Promise<number> {
    if (this.server) return this.boundPort

    const server = this.build()
    this.server = server

    return new Promise<number>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address()
        this.boundPort = typeof addr === 'object' && addr ? addr.port : 0
        resolve(this.boundPort)
      })
    })
  }

  private build(): Server {
    return createServer((req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405).end()
        return
      }

      let body = ''
      let tooBig = false

      req.on('data', (chunk: Buffer) => {
        if (tooBig) return
        body += chunk.toString('utf8')
        if (body.length > MAX_BODY) {
          tooBig = true
          body = ''
        }
      })

      req.on('end', () => {
        // Answer first, parse after. Never make Grok wait on us.
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}')
        if (tooBig) return
        queueMicrotask(() => this.dispatch(body))
      })
    })
  }

  /** Exposed for tests: feed a raw body without going over the wire. */
  dispatch(body: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(body)
    } catch {
      return
    }

    if (!parsed || typeof parsed !== 'object') return
    const record = parsed as Record<string, unknown>

    // Keys are read in both conventions too. Grok 0.2.103 uses camelCase keys
    // with snake_case values, but that pairing is not something to depend on.
    const pick = (...keys: string[]): string | undefined => {
      for (const key of keys) {
        const value = record[key]
        if (typeof value === 'string' && value) return value
      }
      return undefined
    }

    const rawName = pick('hookEventName', 'hook_event_name')
    const sessionId = pick('sessionId', 'session_id')
    if (!rawName || !sessionId) return

    const hookEventName = normalizeHookEventName(rawName)
    if (!hookEventName) return

    this.listener({
      hookEventName,
      sessionId,
      cwd: pick('cwd'),
      workspaceRoot: pick('workspaceRoot', 'workspace_root'),
      toolName: pick('toolName', 'tool_name'),
    } satisfies HookEvent)
  }

  async stop(): Promise<void> {
    const server = this.server
    if (!server) return
    this.server = null
    await new Promise<void>((resolve) => server.close(() => resolve()))
    if (this.socketPath) {
      rmSync(this.socketPath, { force: true })
      this.socketPath = null
    }
  }
}
