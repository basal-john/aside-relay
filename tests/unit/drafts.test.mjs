import assert from 'node:assert/strict'
import test from 'node:test'

import { DRAFT_LANGUAGES, describeDraft, parseDraft } from '../../web/src/drafts.ts'

test('draft fences parse only JSON objects and unwrap typed envelopes', () => {
  assert.deepEqual(parseDraft('{"to":["a@example.com"],"subject":"Hi"}'), { to: ['a@example.com'], subject: 'Hi' })
  assert.deepEqual(parseDraft('{"type":"gmail-draft","data":{"subject":"Wrapped"}}'), { subject: 'Wrapped' })
  for (const source of ['', '[1,2]', '"text"', '{"to": [', 'null']) assert.equal(parseDraft(source), undefined)
})

test('gmail drafts expose recipients, subject, body and the native Send action', () => {
  const draft = describeDraft('gmail-draft', { to: ['a@example.com', 'b@example.com'], cc: [], subject: 'Hello', body: 'Line one\n\nLine two' })
  assert.equal(draft.label, 'Email draft')
  assert.deepEqual(draft.fields.filter(([, value]) => value), [['To', 'a@example.com, b@example.com'], ['Subject', 'Hello']])
  assert.equal(draft.body, 'Line one\n\nLine two')
  assert.equal(draft.action, 'Send')
})

test('actions match the native app: drafts with a button get one, previews and chat drafts do not', () => {
  const actions = Object.fromEntries([...DRAFT_LANGUAGES].map(language => [language, describeDraft(language, {}).action]))
  assert.equal(actions['imessage-draft'], 'Send')
  assert.equal(actions['calendar-event-draft'], 'Send invite')
  assert.equal(actions['x-tweet-draft'], 'Post')
  assert.equal(actions['linkedin-post-draft'], 'Post')
  for (const language of ['tweet', 'x-post', 'linkedin-post', 'slack-draft', 'linkedin-draft']) assert.equal(actions[language], undefined, language)
})

test('chat drafts fall back to body and keep the thread context', () => {
  const draft = describeDraft('slack-draft', { channel: 'general', messages: [{ name: 'Jane', message: 'Ping' }, { name: 'Empty' }], body: 'Reply' })
  assert.deepEqual(draft.fields, [['Where', 'Slack · #general']])
  assert.deepEqual(draft.thread, [{ name: 'Jane', message: 'Ping' }])
  assert.equal(draft.body, 'Reply')
  assert.deepEqual(describeDraft('imessage-draft', { messages: [{ sender: 'me', message: 'Hi' }] }).thread, [{ name: 'Me', message: 'Hi' }])
})
