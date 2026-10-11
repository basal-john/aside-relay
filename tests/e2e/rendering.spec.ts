import { test, expect, SESSION_A } from './fixture';

test('HTML visual renders in a sandbox and can switch to compact source', async ({ page, mockAside }) => {
  const visualTitle = 'Interactive workflow';
  mockAside.messages.get(SESSION_A)!.push({ seq: 2, role: 'assistant', ts: Date.now(), responseId: 'visual-response', model: 'gpt-6.1-sol', provider: 'openai-codex', blocks: [{ type: 'text', text: '```visual\n<!doctype html><html><body><h1>' + visualTitle + '</h1></body></html>\n```' }] });
  await page.goto(`/c/${SESSION_A}`);
  const frame = page.getByTitle('HTML visual');
  await expect(frame).toBeVisible();
  await expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
  await expect(frame).toHaveAttribute('referrerpolicy', 'no-referrer');
  await expect(frame.contentFrame().getByRole('heading', { name: visualTitle })).toBeVisible();
  await page.getByRole('button', { name: 'Show visual source' }).click();
  const source = page.getByRole('region', { name: 'Visual source' });
  await expect(source).toContainText(`<h1>${visualTitle}</h1>`);
  const typography = await source.evaluate(element => {
    const style = getComputedStyle(element);
    return { fontFamily: style.fontFamily, lineHeight: Number.parseFloat(style.lineHeight) / Number.parseFloat(style.fontSize) };
  });
  expect(typography.fontFamily).toContain('D2Coding');
  expect(typography.lineHeight).toBeLessThanOrEqual(1.45);
});

test('long unbroken content stays within the viewport and long history is virtualized', async ({ page, mockAside }) => {
  const messages = mockAside.messages.get(SESSION_A)!;
  for (let index = 2; index < 402; index += 1) messages.push({ seq: index, role: index % 2 ? 'assistant' : 'user', ts: Date.now() + index, responseId: index % 2 ? `response-${index}` : undefined, blocks: [{ type: 'text', text: index === 401 ? 'x'.repeat(3_000) : `Message ${index}` }] });
  await page.goto(`/c/${SESSION_A}`);
  await expect(page.getByRole('article', { name: 'Response' }).last()).toContainText('x'.repeat(80));
  const layout = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth, rendered: document.querySelectorAll('#messages article').length }));
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.viewport);
  expect(layout.rendered).toBeLessThan(80);
  const header = await page.locator('header').boundingBox();
  const composer = await page.locator('#composer').boundingBox();
  expect(header?.y).toBe(0);
  expect(composer && composer.y + composer.height).toBeLessThanOrEqual(await page.evaluate(() => innerHeight + 1));
});
