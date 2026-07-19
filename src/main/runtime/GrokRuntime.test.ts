import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { loginLookupArgs, parseGrokVersion } from './GrokRuntime'

describe('Grok runtime preflight', () => {
  it('reads documented and legacy version output', () => {
    assert.equal(parseGrokVersion('grok 0.2.103'), '0.2.103')
    assert.equal(parseGrokVersion('Grok Build version: 0.3.0-alpha.2'), '0.3.0-alpha.2')
    assert.equal(parseGrokVersion('unknown'), undefined)
  })

  it('passes the command positionally to the fixed login-shell program', () => {
    const hostile = 'grok; touch /tmp/should-not-exist'
    assert.deepEqual(loginLookupArgs(hostile), [
      '-l',
      '-c',
      'command -v -- "$1"',
      'asv-agent-desk-runtime',
      hostile,
    ])
    assert.ok(!loginLookupArgs(hostile)[2].includes(hostile))
  })
})
