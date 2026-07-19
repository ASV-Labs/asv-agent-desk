import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { SessionStore } from './SessionStore'
import { decodeCwd, encodeCwd, grokHome } from './paths'

/** Build a fake ~/.grok/sessions tree in the layout Grok actually writes. */
async function fixture(): Promise<{ home: string; add: AddSession; cleanup: () => Promise<void> }> {
  const home = await mkdtemp(join(tmpdir(), 'agent-desk-store-'))

  const add: AddSession = async (cwd, id, summary, files = {}) => {
    const dir = join(home, '.grok', 'sessions', encodeCwd(cwd), id)
    await mkdir(dir, { recursive: true })
    if (summary !== null) {
      await writeFile(join(dir, 'summary.json'), JSON.stringify(summary), 'utf8')
    }
    for (const [name, body] of Object.entries(files)) {
      await writeFile(join(dir, name), body, 'utf8')
    }
    return dir
  }

  return { home, add, cleanup: () => rm(home, { recursive: true, force: true }) }
}

type AddSession = (
  cwd: string,
  id: string,
  summary: Record<string, unknown> | null,
  files?: Record<string, string>,
) => Promise<string>

describe('session path encoding', () => {
  it('uses GROK_HOME as the single storage root when configured', () => {
    assert.equal(
      grokHome({ GROK_HOME: '/tmp/custom-grok-home' }, '/Users/demo'),
      '/tmp/custom-grok-home',
    )
    assert.equal(grokHome({}, '/Users/demo'), '/Users/demo/.grok')
  })

  it('round-trips a working directory', () => {
    const cwd = '/Users/demo/Projects/agent-sample'
    assert.equal(encodeCwd(cwd), '%2FUsers%2Fdemo%2FProjects%2Fagent-sample')
    assert.equal(decodeCwd(encodeCwd(cwd)), cwd)
  })

  it('survives a directory name that is not valid encoding', () => {
    // Must not throw — a malformed folder is still a real one on disk.
    assert.equal(decodeCwd('%zz'), '%zz')
  })

  it('handles spaces and unicode in paths', () => {
    const cwd = '/Users/demo/My Projects/café'
    assert.equal(decodeCwd(encodeCwd(cwd)), cwd)
  })
})

/**
 * Structurally derived from a real Grok Build 0.2.103 session and anonymized
 * for the public repository. Key names and value types are preserved.
 *
 * The first parser guessed at `title` / `name` / `summary` and matched none of
 * these keys, so every sidebar row rendered as `Session 9fc1b4a3` while 88
 * unit tests passed — because they asserted against the same invented schema.
 * Fixtures now come from real files.
 */
const REAL_SUMMARY = {
  info: {
    id: '11111111-2222-4333-8444-555555555555',
    cwd: '/Users/demo/Projects/agent-sample',
  },
  session_summary: 'Review the sample project and report the runtime boundary.',
  created_at: '2026-07-18T19:12:02.553420Z',
  updated_at: '2026-07-18T19:32:48.143076Z',
  num_messages: 9,
  num_chat_messages: 5,
  current_model_id: 'grok-4.5',
  next_trace_turn: 1,
  chat_format_version: 1,
  git_root_dir: '/Users/demo/Projects/agent-sample/',
  head_commit: '0123456789abcdef0123456789abcdef01234567',
  head_branch: 'feature/runtime-check',
  request_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  grok_home: '/Users/demo/.grok',
  last_active_at: '2026-07-18T19:32:48.139361Z',
  generated_title: 'Review the sample project and report the runtime boundary.',
  agent_name: 'grok-build-plan',
  sandbox_profile: 'off',
  reasoning_effort: 'high',
}

describe('SessionStore against the real schema', () => {
  it('reads every field from a real summary.json', async () => {
    const { home, add, cleanup } = await fixture()
    try {
      await add('/Users/demo/Projects/agent-sample', REAL_SUMMARY.info.id, REAL_SUMMARY)

      const [project] = await new SessionStore(join(home, '.grok')).projects()
      const session = project.sessions[0]

      assert.equal(session.title, 'Review the sample project and report the runtime boundary.')
      assert.ok(!session.title.startsWith('Session '), 'must not fall back to the uuid stub')
      assert.equal(session.model, 'grok-4.5')
      assert.equal(session.messageCount, 5, 'chat turns, not raw message count')
      assert.equal(session.branch, 'feature/runtime-check')
      assert.equal(session.gitRoot, '/Users/demo/Projects/agent-sample/')
      assert.equal(session.updatedAt, Date.parse('2026-07-18T19:32:48.139361Z'))
      assert.equal(session.createdAt, Date.parse('2026-07-18T19:12:02.553420Z'))
    } finally {
      await cleanup()
    }
  })

  // Seven of these existed in the real corpus: opened, never prompted, so no
  // title data at all. A uuid stub reads like a parse failure; this does not.
  it('labels a session that was opened but never prompted', async () => {
    const { home, add, cleanup } = await fixture()
    try {
      await add('/tmp/p', 'e3bd56fc-a110-4f84-8f6e-345b67874dd0', {
        info: { id: 'e3bd56fc-a110-4f84-8f6e-345b67874dd0', cwd: '/tmp/p' },
        session_summary: '',
        num_messages: 1,
        num_chat_messages: 2,
        current_model_id: 'grok-4.5',
      })

      const [project] = await new SessionStore(join(home, '.grok')).projects()
      assert.equal(project.sessions[0].title, 'No prompt yet')
      assert.equal(project.sessions[0].prompted, false)
    } finally {
      await cleanup()
    }
  })

  it('marks a session with real activity as prompted', async () => {
    const { home, add, cleanup } = await fixture()
    try {
      await add('/tmp/p', 'id-1', REAL_SUMMARY)
      const [project] = await new SessionStore(join(home, '.grok')).projects()
      assert.equal(project.sessions[0].prompted, true)
    } finally {
      await cleanup()
    }
  })

  it('prefers generated_title over session_summary', async () => {
    const { home, add, cleanup } = await fixture()
    try {
      await add('/tmp/p', 'id-1', {
        ...REAL_SUMMARY,
        session_summary: 'the summary',
        generated_title: 'the title',
      })
      const [project] = await new SessionStore(join(home, '.grok')).projects()
      assert.equal(project.sessions[0].title, 'the title')
    } finally {
      await cleanup()
    }
  })

  // Titles are the opening prompt, which can run to a paragraph.
  it('flattens and truncates a long title', async () => {
    const { home, add, cleanup } = await fixture()
    try {
      await add('/tmp/p', 'id-1', {
        generated_title: `Migrate the auth layer\nfrom sessions to JWT ${'x'.repeat(200)}`,
      })
      const [project] = await new SessionStore(join(home, '.grok')).projects()
      const title = project.sessions[0].title

      assert.ok(title.length <= 80)
      assert.ok(title.endsWith('…'))
      assert.ok(!title.includes('\n'), 'newlines would break the row layout')
    } finally {
      await cleanup()
    }
  })

  it('keeps the decoded directory as the session cwd', async () => {
    const { home, add, cleanup } = await fixture()
    try {
      // The folder name is what groups sessions, so it must win to keep a
      // project and its sessions agreeing on where they live.
      await add('/tmp/real-place', 'id-1', {
        info: { id: 'id-1', cwd: '/tmp/somewhere-else' },
        generated_title: 'T',
      })
      const [project] = await new SessionStore(join(home, '.grok')).projects()
      assert.equal(project.cwd, '/tmp/real-place')
      assert.equal(project.sessions[0].cwd, '/tmp/real-place')
    } finally {
      await cleanup()
    }
  })
})

describe('SessionStore', () => {
  it('returns nothing when grok has never run', async () => {
    const { home, cleanup } = await fixture()
    try {
      assert.deepEqual(await new SessionStore(join(home, '.grok')).projects(), [])
    } finally {
      await cleanup()
    }
  })

  it('groups sessions under their project', async () => {
    const { home, add, cleanup } = await fixture()
    try {
      await add('/tmp/alpha', 'id-1', { title: 'First' })
      await add('/tmp/alpha', 'id-2', { title: 'Second' })
      await add('/tmp/beta', 'id-3', { title: 'Third' })

      const projects = await new SessionStore(join(home, '.grok')).projects()

      assert.equal(projects.length, 2)
      const alpha = projects.find((p) => p.cwd === '/tmp/alpha')
      assert.equal(alpha?.name, 'alpha')
      assert.equal(alpha?.sessions.length, 2)
    } finally {
      await cleanup()
    }
  })

  it('orders sessions newest first', async () => {
    const { home, add, cleanup } = await fixture()
    try {
      await add('/tmp/p', 'old', { title: 'Old', updatedAt: 1000 })
      await add('/tmp/p', 'new', { title: 'New', updatedAt: 9000 })

      const [project] = await new SessionStore(join(home, '.grok')).projects()
      assert.deepEqual(
        project.sessions.map((s) => s.id),
        ['new', 'old'],
      )
    } finally {
      await cleanup()
    }
  })

  // summary.json is undocumented and changes between releases, so a missing or
  // broken one must cost a single row's detail, never the whole sidebar.
  it('survives a missing summary.json', async () => {
    const { home, add, cleanup } = await fixture()
    try {
      await add('/tmp/p', 'abc12345-0000-0000-0000-000000000000', null, {
        'updates.jsonl': '{}\n',
      })

      const [project] = await new SessionStore(join(home, '.grok')).projects()
      assert.equal(project.sessions.length, 1)
      assert.equal(project.sessions[0].title, 'Session abc12345')
      assert.ok(project.sessions[0].updatedAt > 0, 'falls back to directory mtime')
    } finally {
      await cleanup()
    }
  })

  it('survives a corrupt summary.json', async () => {
    const { home, add, cleanup } = await fixture()
    try {
      const dir = await add('/tmp/p', 'id-1', null)
      await writeFile(join(dir, 'summary.json'), 'not json at all', 'utf8')

      const [project] = await new SessionStore(join(home, '.grok')).projects()
      assert.equal(project.sessions.length, 1)
    } finally {
      await cleanup()
    }
  })

  it('reads epoch seconds, milliseconds and ISO strings alike', async () => {
    const { home, add, cleanup } = await fixture()
    try {
      await add('/tmp/a', 'secs', { title: 'S', updatedAt: 1784400000 })
      await add('/tmp/b', 'ms', { title: 'M', updatedAt: 1784400000000 })
      await add('/tmp/c', 'iso', { title: 'I', updatedAt: '2026-07-18T12:00:00Z' })

      const projects = await new SessionStore(join(home, '.grok')).projects()
      const at = (cwd: string) => projects.find((p) => p.cwd === cwd)!.sessions[0].updatedAt

      assert.equal(at('/tmp/a'), 1784400000000, 'seconds should scale to ms')
      assert.equal(at('/tmp/b'), 1784400000000)
      assert.equal(at('/tmp/c'), Date.parse('2026-07-18T12:00:00Z'))
    } finally {
      await cleanup()
    }
  })

  // Tolerance for older or newer schema variants, behind the real key names.
  it('accepts alternative key spellings', async () => {
    const { home, add, cleanup } = await fixture()
    try {
      await add('/tmp/p', 'id-1', {
        name: 'Via name',
        updated_at: 1784400000,
        num_messages: 12,
        model: 'grok-4.5',
      })

      const [project] = await new SessionStore(join(home, '.grok')).projects()
      assert.equal(project.sessions[0].title, 'Via name')
      assert.equal(project.sessions[0].messageCount, 12)
      assert.equal(project.sessions[0].model, 'grok-4.5')
    } finally {
      await cleanup()
    }
  })

  it('ignores stray files among the session directories', async () => {
    const { home, add, cleanup } = await fixture()
    try {
      await add('/tmp/p', 'id-1', { title: 'Real' })
      await writeFile(join(home, '.grok', 'sessions', encodeCwd('/tmp/p'), '.DS_Store'), '', 'utf8')
      await writeFile(join(home, '.grok', 'sessions', '.DS_Store'), '', 'utf8')

      const projects = await new SessionStore(join(home, '.grok')).projects()
      assert.equal(projects.length, 1)
      assert.equal(projects[0].sessions.length, 1)
    } finally {
      await cleanup()
    }
  })

  it('drops projects whose sessions are all unreadable', async () => {
    const { home, cleanup } = await fixture()
    try {
      await mkdir(join(home, '.grok', 'sessions', encodeCwd('/tmp/empty')), { recursive: true })
      assert.deepEqual(await new SessionStore(join(home, '.grok')).projects(), [])
    } finally {
      await cleanup()
    }
  })

  it('looks up sessions for one directory', async () => {
    const { home, add, cleanup } = await fixture()
    try {
      await add('/tmp/alpha', 'id-1', { title: 'A' })
      await add('/tmp/beta', 'id-2', { title: 'B' })

      const store = new SessionStore(join(home, '.grok'))
      assert.equal((await store.sessionsFor('/tmp/alpha'))[0].id, 'id-1')
      assert.deepEqual(await store.sessionsFor('/tmp/nowhere'), [])
    } finally {
      await cleanup()
    }
  })
})
