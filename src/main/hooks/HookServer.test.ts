import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { HookServer } from './HookServer'
import {
  buildHookConfig,
  buildHookScript,
  installHooks,
  socketPath,
  uninstallHooks,
} from './install'
import { HOOK_EVENTS, type HookEvent } from '../../shared/hooks'

/** Run the generated hook script the way Grok does: event JSON on stdin. */
function runScript(script: string, stdin: string): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(script, [], { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString()
    })
    child.once('error', reject)
    child.once('close', (code) => resolve({ code: code ?? 0, stdout }))
    child.stdin.end(stdin)
  })
}

function collector(): { server: HookServer; seen: HookEvent[] } {
  const server = new HookServer()
  const seen: HookEvent[] = []
  server.onEvent((e) => seen.push(e))
  return { server, seen }
}

describe('HookServer', () => {
  it('parses a well-formed event', () => {
    const { server, seen } = collector()
    server.dispatch(
      JSON.stringify({
        hookEventName: 'Stop',
        sessionId: 'grok-1',
        cwd: '/tmp/p',
        workspaceRoot: '/tmp/p',
      }),
    )
    assert.equal(seen.length, 1)
    assert.equal(seen[0].hookEventName, 'Stop')
    assert.equal(seen[0].cwd, '/tmp/p')
  })

  it('carries the tool name through on tool events', () => {
    const { server, seen } = collector()
    server.dispatch(
      JSON.stringify({ hookEventName: 'PostToolUse', sessionId: 'g', toolName: 'Edit' }),
    )
    assert.equal(seen[0].toolName, 'Edit')
  })

  /**
   * Regression tests for the Phase 2 failure.
   *
   * Grok 0.2.103 subscribes with PascalCase keys but POSTs snake_case values.
   * The original suite only ever exercised the PascalCase envelope we invented,
   * which is why 59 tests passed while nothing worked live.
   */
  describe('real Grok 0.2.103 envelopes', () => {
    it('accepts snake_case event values', () => {
      const { server, seen } = collector()
      server.dispatch(
        JSON.stringify({
          hookEventName: 'user_prompt_submit',
          sessionId: 'grok-1',
          cwd: '/tmp/p',
        }),
      )
      assert.equal(seen[0]?.hookEventName, 'UserPromptSubmit')
    })

    it('normalises every event name in both conventions', () => {
      const pairs: Array<[string, string]> = [
        ['session_start', 'SessionStart'],
        ['session_end', 'SessionEnd'],
        ['user_prompt_submit', 'UserPromptSubmit'],
        ['post_tool_use', 'PostToolUse'],
        ['post_tool_use_failure', 'PostToolUseFailure'],
        ['permission_denied', 'PermissionDenied'],
        ['stop', 'Stop'],
        ['stop_failure', 'StopFailure'],
        ['notification', 'Notification'],
        ['subagent_start', 'SubagentStart'],
        ['subagent_stop', 'SubagentStop'],
        ['pre_compact', 'PreCompact'],
        ['post_compact', 'PostCompact'],
      ]

      for (const [wire, canonical] of pairs) {
        const { server, seen } = collector()
        server.dispatch(JSON.stringify({ hookEventName: wire, sessionId: 'g' }))
        assert.equal(seen[0]?.hookEventName, canonical, `${wire} should map to ${canonical}`)
      }
    })

    it('reads snake_case keys as well as camelCase ones', () => {
      const { server, seen } = collector()
      server.dispatch(
        JSON.stringify({
          hook_event_name: 'post_tool_use',
          session_id: 'grok-2',
          workspace_root: '/tmp/w',
          tool_name: 'Bash',
        }),
      )
      assert.equal(seen[0]?.hookEventName, 'PostToolUse')
      assert.equal(seen[0]?.sessionId, 'grok-2')
      assert.equal(seen[0]?.toolName, 'Bash')
      assert.equal(seen[0]?.workspaceRoot, '/tmp/w')
    })

    it('still rejects the blocking event in either convention', () => {
      const { server, seen } = collector()
      server.dispatch(JSON.stringify({ hookEventName: 'pre_tool_use', sessionId: 'g' }))
      server.dispatch(JSON.stringify({ hookEventName: 'PreToolUse', sessionId: 'g' }))
      assert.equal(seen.length, 0, 'PreToolUse must never be processed')
    })
  })

  it('drops malformed bodies without throwing', () => {
    const { server, seen } = collector()
    assert.doesNotThrow(() => {
      server.dispatch('not json')
      server.dispatch('null')
      server.dispatch('[]')
      server.dispatch('{}')
      server.dispatch(JSON.stringify({ hookEventName: 'Stop' }))
      server.dispatch(JSON.stringify({ sessionId: 'g' }))
      server.dispatch(JSON.stringify({ hookEventName: 'Invented', sessionId: 'g' }))
    })
    assert.equal(seen.length, 0)
  })

  it('binds only to loopback', async () => {
    const { server } = collector()
    const port = await server.start()
    assert.ok(port > 0)
    assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+\/e$/)
    await server.stop()
  })

  it('accepts a real POST over the wire', async () => {
    const { server, seen } = collector()
    await server.start()

    const res = await fetch(server.url, {
      method: 'POST',
      body: JSON.stringify({ hookEventName: 'UserPromptSubmit', sessionId: 'grok-9' }),
    })

    assert.equal(res.status, 200)
    await new Promise((r) => setTimeout(r, 20))
    assert.equal(seen[0]?.sessionId, 'grok-9')
    await server.stop()
  })

  it('rejects non-POST', async () => {
    const { server } = collector()
    await server.start()
    const res = await fetch(server.url)
    assert.equal(res.status, 405)
    await server.stop()
  })
})

/**
 * The transport, tested through the path Grok actually uses.
 *
 * Phase 2b failed because everything was verified against a synthetic HTTP
 * server that Grok flatly refused to contact — it blocks `http://` hook URLs
 * under an SSRF policy. These tests run the generated script with real curl
 * against a real socket, so the delivery mechanism itself is covered rather
 * than just the parser behind it.
 */
describe('unix socket transport', () => {
  it('accepts an event delivered by the generated script', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-desk-test-'))
    const sock = join(dir, 's.sock')
    const { server, seen } = collector()

    try {
      await server.startUnix(sock)
      await installHooks(sock, join(dir, '.grok'))

      const script = join(dir, '.grok', 'hooks', 'asv-agent-desk-emit.sh')
      // Grok delivers the event JSON on stdin, in snake_case.
      const { code } = await runScript(
        script,
        JSON.stringify({ hookEventName: 'stop', sessionId: 'grok-77' }),
      )
      assert.equal(code, 0)

      await new Promise((r) => setTimeout(r, 150))
      assert.equal(seen[0]?.hookEventName, 'Stop')
      assert.equal(seen[0]?.sessionId, 'grok-77')
    } finally {
      await server.stop()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('exits 0 even when nothing is listening', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-desk-test-'))
    try {
      await installHooks(join(dir, 'absent.sock'), join(dir, '.grok'))
      const script = join(dir, '.grok', 'hooks', 'asv-agent-desk-emit.sh')
      // A closed ASV Agent Desk must not make Grok report a failed hook run.
      const { code, stdout } = await runScript(script, '{}')
      assert.equal(code, 0)
      assert.equal(stdout, '')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('writes an executable script', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-desk-test-'))
    try {
      await installHooks('/tmp/x.sock', join(dir, '.grok'))
      const info = await stat(join(dir, '.grok', 'hooks', 'asv-agent-desk-emit.sh'))
      assert.ok(info.mode & 0o100, 'script must be owner-executable')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  // A crash leaves the socket file behind; bind would then fail EADDRINUSE.
  it('recovers from a stale socket file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-desk-test-'))
    const sock = join(dir, 's.sock')
    const server = new HookServer()
    try {
      await writeFile(sock, 'stale')
      await server.startUnix(sock)
      assert.equal(server.path, sock)
    } finally {
      await server.stop()
      await rm(dir, { recursive: true, force: true })
    }
  })

  // Synchronous because it runs from `before-quit`, which does not await.
  // The async version left the script behind when the process exited early.
  it('removes both files on uninstall', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-desk-test-'))
    try {
      await installHooks('/tmp/x.sock', join(dir, '.grok'))
      uninstallHooks(join(dir, '.grok'))
      await assert.rejects(() => readFile(join(dir, '.grok', 'hooks', 'asv-agent-desk.json')))
      await assert.rejects(() => readFile(join(dir, '.grok', 'hooks', 'asv-agent-desk-emit.sh')))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('quotes a socket path containing a single quote', () => {
    const script = buildHookScript("/tmp/wei'rd/asv-agent-desk.sock")
    assert.match(script, /--unix-socket '\/tmp\/wei'\\''rd\/asv-agent-desk\.sock'/)
  })

  it('falls back to /tmp when TMPDIR would overflow the socket path limit', () => {
    const long = `/tmp/${'x'.repeat(120)}`
    assert.equal(socketPath(long), '/tmp/asv-agent-desk.sock')
    assert.ok(Buffer.byteLength(socketPath('/var/folders/ab/cdef/T')) < 100)
  })
})

describe('hook config', () => {
  const config = () =>
    buildHookConfig('/tmp/emit.sh') as {
      hooks: Record<string, Array<{ hooks: Array<{ type: string; command: string }> }>>
    }

  it('subscribes to every passive event', () => {
    assert.deepEqual(Object.keys(config().hooks).sort(), [...HOOK_EVENTS].sort())
  })

  // PreToolUse is the only blocking event: Grok waits for the response before
  // running the tool, so a hung GUI would stall the agent.
  it('never subscribes to the blocking PreToolUse event', () => {
    assert.equal('PreToolUse' in config().hooks, false)
  })

  // Grok blocks http:// hook URLs entirely, so this must stay a command hook.
  it('uses command hooks, never http', () => {
    for (const entries of Object.values(config().hooks)) {
      assert.equal(entries[0].hooks[0].type, 'command')
      assert.equal(entries[0].hooks[0].command, '/tmp/emit.sh')
    }
  })

  it('bounds the script well inside grok hook timeouts', () => {
    assert.match(buildHookScript('/tmp/s.sock'), /--max-time 2/)
    assert.match(buildHookScript('/tmp/s.sock'), /exit 0/)
  })
})
