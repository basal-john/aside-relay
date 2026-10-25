import assert from 'node:assert/strict'
import test from 'node:test'
import { formatBytes } from '../../web/src/format.ts'
import { isRecord, parseProjects } from '../../web/src/responses.ts'
import { browserScrollDelta, getBrowserKey } from '../../web/src/browser.ts'

test('record boundaries reject arrays and primitives', () => {
  assert.equal(isRecord({ value: true }), true)
  for (const value of [[], null, undefined, 'text', 0, true]) assert.equal(isRecord(value), false)
})

test('file sizes retain the existing byte, kilobyte, and megabyte boundaries', () => {
  assert.deepEqual([0, 1023, 1024, 1048576].map(formatBytes), ['0 B', '1023 B', '1 KB', '1.0 MB'])
})

test('project decoding preserves archive policy as data for the consuming view', () => {
  assert.deepEqual(parseProjects({ items: [null, { id: 'a', name: 'Active' }, { id: 'b', title: 'Archived', archivedAt: 123 }, { id: false, name: 'Invalid' }] }), [
    { id: 'a', name: 'Active', archivedAt: undefined }, { id: 'b', name: 'Archived', archivedAt: 123 },
  ])
})

test('browser input uses supported keys and bounded integral wheel movement', () => {
  assert.equal(getBrowserKey(' '), 'Space')
  assert.equal(getBrowserKey('Tab'), 'Tab')
  assert.equal(getBrowserKey('Execute'), undefined)
  assert.deepEqual([1.5, -10000, 10000].map(browserScrollDelta), [2, -4000, 4000])
})
