import assert from 'node:assert/strict'
import test from 'node:test'

import {
  dailyBudget,
  elapsedPercent,
  paceLabel,
  resetText,
  shortModelLabel,
  usageTone,
} from '../../web/src/usageMetrics.ts'

test('short model labels follow the bb family map', () => {
  assert.equal(shortModelLabel('claude-opus-5-5', 'Claude Opus 5.5'), 'Opus')
  assert.equal(shortModelLabel('claude-sonnet-5-5'), 'Sonnet')
})

test('pace and elapsed match the bb usage panel rules', () => {
  const now = new Date('2026-11-12T16:08:00Z')
  const window = {
    kind: 'five_hour',
    label: '5 hours',
    usedPercent: 18,
    resetsAt: new Date(now.getTime() + 4.2 * 3_600_000).toISOString(),
  }
  const elapsed = elapsedPercent(window, now)
  assert.ok(elapsed != null)
  assert.equal(Math.round(elapsed), 16)
  assert.equal(paceLabel(18, 16), 'on pace')
  assert.equal(paceLabel(51, 90), 'under pace')
  assert.equal(paceLabel(88, 62), 'ahead of pace')
  assert.equal(usageTone(18), 'ok')
  assert.equal(usageTone(60), 'warn')
  assert.equal(usageTone(85), 'bad')
})

test('weekly budget line appears for multi-day windows', () => {
  const now = new Date('2026-11-12T16:08:00Z')
  const window = {
    kind: 'weekly',
    label: 'Weekly',
    usedPercent: 44,
    resetsAt: new Date(now.getTime() + 3.75 * 86_400_000).toISOString(),
  }
  const budget = dailyBudget(window, now)
  assert.ok(budget)
  assert.equal(budget.until, 'midnight')
  assert.ok(budget.perDay > 0)
  assert.match(resetText(window.resetsAt, now), /^in /)
})
