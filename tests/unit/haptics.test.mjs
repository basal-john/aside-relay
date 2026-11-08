import assert from 'node:assert/strict'
import test from 'node:test'
import { HAPTICS_STORAGE_KEY, isIos, loadHaptics } from '../../web/src/haptics.ts'

test('haptics stay on unless the user turned them off', () => {
  assert.equal(loadHaptics({ getItem: () => null }), true)
  assert.equal(loadHaptics({ getItem: key => key === HAPTICS_STORAGE_KEY ? 'off' : null }), false)
  assert.equal(loadHaptics({ getItem: () => 'on' }), true)
  assert.equal(loadHaptics({ getItem: () => { throw new Error('blocked') } }), true)
})

test('iPhone, iPad and touch iPadOS count as iOS, a Mac and Android do not', () => {
  const nav = (userAgent, platform = '', maxTouchPoints = 0) => ({ userAgent, platform, maxTouchPoints })
  assert.equal(isIos(nav('Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148', 'iPhone', 5)), true)
  assert.equal(isIos(nav('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15', 'MacIntel', 5)), true)
  assert.equal(isIos(nav('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15', 'MacIntel', 0)), false)
  assert.equal(isIos(nav('Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/140 Mobile', 'Linux armv8l', 5)), false)
})
