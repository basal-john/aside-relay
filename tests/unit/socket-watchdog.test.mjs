import assert from 'node:assert/strict'
import test from 'node:test'

import { SOCKET_SILENCE_LIMIT_MS, SOCKET_WATCHDOG_INTERVAL_MS, isSocketSilent } from '../../web/src/socketWatchdog.ts'

const now = 1_000_000
const onTime = now - SOCKET_WATCHDOG_INTERVAL_MS

test('a socket that missed two heartbeats is silent', () => {
  assert.equal(isSocketSilent({ lastMessageAt: now - SOCKET_SILENCE_LIMIT_MS - 1, lastTickAt: onTime, now, visible: true }), true)
})

test('a socket with a recent message is not silent', () => {
  assert.equal(isSocketSilent({ lastMessageAt: now - SOCKET_SILENCE_LIMIT_MS, lastTickAt: onTime, now, visible: true }), false)
  assert.equal(isSocketSilent({ lastMessageAt: now - 20_000, lastTickAt: onTime, now, visible: true }), false)
})

test('a hidden page never drops the socket', () => {
  assert.equal(isSocketSilent({ lastMessageAt: 0, lastTickAt: onTime, now, visible: false }), false)
})

test('the first tick after a suspension waits for buffered messages', () => {
  const afterSuspension = now - SOCKET_WATCHDOG_INTERVAL_MS * 2 - 1
  assert.equal(isSocketSilent({ lastMessageAt: 0, lastTickAt: afterSuspension, now, visible: true }), false)
})
