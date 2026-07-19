import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { RingBuffer } from './RingBuffer'

describe('RingBuffer', () => {
  it('returns everything while under the cap', () => {
    const b = new RingBuffer(1024)
    b.push('alpha')
    b.push('beta')
    assert.equal(b.snapshot(), 'alphabeta')
  })

  it('drops oldest chunks once over the cap', () => {
    const b = new RingBuffer(10)
    b.push('aaaaa')
    b.push('bbbbb')
    b.push('ccccc')
    const snap = b.snapshot()
    assert.ok(!snap.includes('aaaaa'), 'oldest chunk should be evicted')
    assert.ok(snap.endsWith('ccccc'), 'newest chunk must survive')
    assert.ok(b.byteLength <= 10)
  })

  it('never evicts the only chunk, even if oversized', () => {
    const b = new RingBuffer(4)
    b.push('a much longer chunk than the cap')
    assert.equal(b.snapshot(), 'a much longer chunk than the cap')
  })

  it('counts bytes not characters', () => {
    const b = new RingBuffer(1024)
    b.push('é') // two bytes in UTF-8
    assert.equal(b.byteLength, 2)
  })

  it('ignores empty pushes', () => {
    const b = new RingBuffer(64)
    b.push('')
    assert.equal(b.snapshot(), '')
    assert.equal(b.byteLength, 0)
  })

  it('clears', () => {
    const b = new RingBuffer(64)
    b.push('x')
    b.clear()
    assert.equal(b.snapshot(), '')
    assert.equal(b.byteLength, 0)
  })
})
