import assert from 'node:assert/strict'
import test from 'node:test'

import {
  parseChatMessage,
  parseMessagesResponse,
  parseModelConfig,
  parseModels,
  parseRunRequest,
  parseSessionsResponse,
  parseStartedRun,
  parseUploadAttachment,
} from '../../web/src/responses.ts'

const invalidResponse = { message: 'Invalid server response.' }

test('model responses require complete typed configuration and at least one thinking level', () => {
  assert.deepEqual(parseModelConfig({ provider: 'openai', modelId: 'gpt-6.1', thinkingLevel: 'high', fastMode: false }), {
    provider: 'openai', modelId: 'gpt-6.1', thinkingLevel: 'high', fastMode: false,
  })

  assert.throws(() => parseModelConfig({ provider: 'openai', modelId: 'gpt-6.1', thinkingLevel: 'high', fastMode: 'false' }), invalidResponse)
  assert.throws(() => parseModels({ items: [{ id: 'gpt', name: 'GPT', provider: 'openai', thinkingLevels: [], supportsFastMode: true }], current: {} }), invalidResponse)
})

test('message responses reject unsupported roles, blocks, and invalid sequence bounds', () => {
  const valid = { seq: 0, role: 'assistant', blocks: [{ type: 'text', text: 'Hello' }] }
  assert.deepEqual(parseChatMessage(valid).blocks, [{ type: 'text', text: 'Hello' }])

  assert.throws(() => parseChatMessage({ ...valid, role: 'developer' }), invalidResponse)
  assert.throws(() => parseChatMessage({ ...valid, seq: -1 }), invalidResponse)
  assert.throws(() => parseChatMessage({ ...valid, seq: 1.5 }), invalidResponse)
  assert.throws(() => parseChatMessage({ ...valid, seq: Number.MAX_SAFE_INTEGER + 1 }), invalidResponse)
  assert.throws(() => parseChatMessage({ ...valid, blocks: [{ type: 'audio', url: '/voice' }] }), invalidResponse)
})

test('session pagination rejects negative, fractional, and unsafe counters', () => {
  const payload = { items: [], total: 0, matched: 0 }
  assert.deepEqual(parseSessionsResponse(payload), { items: [], nextCursor: undefined, total: 0, matched: 0 })

  for (const total of [-1, 0.1, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => parseSessionsResponse({ ...payload, total }), invalidResponse)
  }
})

test('message page offsets and next sequence values use non-negative safe integers', () => {
  const payload = { sessionId: 's1', messages: [], offset: 0, nextSeq: 1, running: false }
  assert.equal(parseMessagesResponse(payload).nextSeq, 1)
  assert.throws(() => parseMessagesResponse({ ...payload, offset: -1 }), invalidResponse)
  assert.throws(() => parseMessagesResponse({ ...payload, nextSeq: Number.NaN }), invalidResponse)
})

test('run requests only accept known states and started runs require both identifiers', () => {
  assert.deepEqual(parseRunRequest({ status: 'pending' }), {
    status: 'pending', sessionId: undefined, runId: undefined, message: undefined,
  })
  assert.deepEqual(parseRunRequest({ status: 'started', sessionId: 's1', runId: 'r1' }), {
    status: 'started', sessionId: 's1', runId: 'r1', message: undefined,
  })
  assert.throws(() => parseRunRequest({ status: 'complete' }), invalidResponse)
  assert.throws(() => parseRunRequest({ status: 'started', sessionId: 's1' }), invalidResponse)
  assert.throws(() => parseStartedRun({ sessionId: 's1', runId: 'r1', running: 1 }), invalidResponse)
})

test('upload responses reject invalid byte counts and field types', () => {
  const payload = { id: 'file-1', name: 'image.png', mime: 'image/png', bytes: 12, url: '/api/files/file-1' }
  assert.deepEqual(parseUploadAttachment(payload), payload)

  for (const bytes of [-1, 1.2, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => parseUploadAttachment({ ...payload, bytes }), invalidResponse)
  }
  assert.throws(() => parseUploadAttachment({ ...payload, url: null }), invalidResponse)
})
