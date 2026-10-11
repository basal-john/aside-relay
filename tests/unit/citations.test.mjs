import assert from 'node:assert/strict'
import test from 'node:test'

import { formatCitations } from '../../web/src/citations.ts'

const sources = [
  { id: 'primary', url: 'https://example.com/research notes?q=one two', title: 'Research "notes"' },
  { id: 'second', url: 'https://docs.example.org/guide' },
  { id: 'unsafe', url: 'javascript:alert(1)', title: 'Unsafe' },
]

test('citation tags become numbered source links without exposing transport markup', () => {
  const result = formatCitations({
    text: 'The result is confirmed.<citation refs="primary">Evidence</citation>',
    sources,
  })

  assert.equal(
    result,
    'The result is confirmed.Evidence [1](<https://example.com/research%20notes?q=one%20two> "Source: Research \\"notes\\"")',
  )
  assert.doesNotMatch(result, /<\/?citation/)
})

test('citation-looking text in inline and fenced code remains code', () => {
  const markdown = [
    '`<citation refs="primary">inline</citation>`',
    '',
    '```html',
    '<citation refs="primary">block</citation>',
    '```',
  ].join('\n')

  assert.equal(formatCitations({ text: markdown, sources }), markdown)
})

test('citation formatting preserves surrounding Markdown structure', () => {
  const markdown = '# Findings\n\n- **Confirmed:** <citation refs="second">documentation</citation>\n- [Existing link](https://example.net)'
  const result = formatCitations({ text: markdown, sources })

  assert.match(result, /^# Findings\n\n- \*\*Confirmed:\*\*/)
  assert.match(result, /documentation \[1\]\(<https:\/\/docs\.example\.org\/guide>/)
  assert.match(result, /- \[Existing link\]\(https:\/\/example\.net\)$/)
})

test('nested citations keep stable numbering and attach each source at its closing claim', () => {
  const result = formatCitations({
    text: '<citation refs="primary">Outer <citation refs="second">inner</citation> conclusion</citation>',
    sources,
  })

  assert.match(result, /^Outer inner \[1\]\(<https:\/\/docs\.example\.org\/guide>/)
  assert.match(result, /conclusion \[2\]\(<https:\/\/example\.com\/research%20notes/)
})

test('unknown and unsafe source references remove citation markup without creating links', () => {
  const result = formatCitations({
    text: '<citation refs="missing unsafe">Readable claim</citation>',
    sources,
  })

  assert.equal(result, 'Readable claim')
})

test('streaming output hides incomplete citation fragments until the tag is complete', () => {
  for (const tail of ['<cit', '<citation refs="primary"', '</citation']) {
    assert.equal(
      formatCitations({ text: `Visible text ${tail}`, sources, isStreaming: true }),
      'Visible text ',
    )
  }

  assert.equal(
    formatCitations({ text: 'Visible text <cit', sources, isStreaming: false }),
    'Visible text <cit',
  )
})

test('multiple source ids are deduplicated in first-reference order', () => {
  const result = formatCitations({
    text: '<citation refs="primary second primary">Claim</citation> <citation refs="second">More</citation>',
    sources,
  })

  assert.equal((result.match(/\[1\]/g) ?? []).length, 1)
  assert.equal((result.match(/\[2\]/g) ?? []).length, 2)
})
