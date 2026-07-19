import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { loginShellSpawnArgs } from './pty'

describe('login-shell PTY invocation', () => {
  it('preserves command arguments exactly', () => {
    const args = ['--ref', 'feature/space name', '--rules', 'say "$HOME"; $(touch /tmp/nope)']
    const spawnArgs = loginShellSpawnArgs('/opt/tools/grok build', args)

    assert.deepEqual(spawnArgs, [
      '-l',
      '-c',
      'exec "$0" "$@"',
      '/opt/tools/grok build',
      ...args,
    ])
  })

  it('never interpolates command data into the shell program', () => {
    const hostile = 'grok; touch /tmp/agent-desk-injection'
    const spawnArgs = loginShellSpawnArgs(hostile, ['$(open https://example.invalid)'])

    assert.equal(spawnArgs[2], 'exec "$0" "$@"')
    assert.ok(!spawnArgs[2].includes(hostile))
    assert.ok(!spawnArgs[2].includes('example.invalid'))
  })
})
