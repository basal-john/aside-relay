import { test, expect } from '@playwright/test';

const MAX_DIFFERENT_SHARE = 0.001;
const CHANNEL_TOLERANCE = 8;

for (const scheme of ['light', 'dark'] as const) {
  test(`the first painted frame matches the ${scheme} iOS launch image`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile-webkit', 'Launch images exist only for iPhone screen sizes.');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: scheme });
    await page.route('**/assets/*.js', route => route.abort());
    await page.goto('/');
    const { width, height } = page.viewportSize()!;
    const dpr = await page.evaluate(() => window.devicePixelRatio);
    const media = `(prefers-color-scheme: ${scheme}) and (device-width: ${width}px) and (device-height: ${height}px) and (-webkit-device-pixel-ratio: ${dpr}) and (orientation: portrait)`;
    const link = page.locator(`link[rel="apple-touch-startup-image"][media="${media}"]`);
    await expect(link).toHaveCount(1);
    const name = (await link.getAttribute('href'))!;
    const shot = (await page.screenshot({ animations: 'disabled' })).toString('base64');
    const share = await page.evaluate(async ({ shot, name, tolerance }) => {
      const pixels = async (src: string) => {
        const image = new Image();
        image.src = src;
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const context = canvas.getContext('2d')!;
        context.drawImage(image, 0, 0);
        return context.getImageData(0, 0, canvas.width, canvas.height);
      };
      const [painted, launch] = await Promise.all([pixels(`data:image/png;base64,${shot}`), pixels(name)]);
      if (painted.width !== launch.width || painted.height !== launch.height) return 1;
      let different = 0;
      for (let i = 0; i < painted.data.length; i += 4) {
        if (Math.max(Math.abs(painted.data[i] - launch.data[i]), Math.abs(painted.data[i + 1] - launch.data[i + 1]), Math.abs(painted.data[i + 2] - launch.data[i + 2])) > tolerance) different++;
      }
      return different / (painted.width * painted.height);
    }, { shot, name, tolerance: CHANNEL_TOLERANCE });
    testInfo.annotations.push({ type: 'different pixel share', description: share.toFixed(5) });
    expect(share).toBeLessThan(MAX_DIFFERENT_SHARE);
  });
}
