// A local visual check, not part of any gate: screenshots every gallery frame in light and dark at 1280 x 800 and
// 900 x 650, and compares the frame's zones with the same rectangle of the Claude Design board shot.
// The shots live outside the repo: set ARIADNE_SHOTS to the board's shots/ folder (the default is the owner's mocks
// folder). Without them the screenshots are still taken and nothing is compared.
//   npx playwright test --config tests/ui/components/playwright.config.ts [-g "<frame id>"]
// Writes coverage/components/<frame>-<theme>[-900].png, <frame>-<theme>[-900]-<zone>-compare.png (design over app over diff)
// and report.json (per zone, the share of pixels with no match within one pixel in the design).
import { test, expect, type Page } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { createServer, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';
import { registry, sizeOf, type FrameMeta, type Zone } from './registry';

const repo = resolve(import.meta.dirname, '../../..');
const shots = process.env.ARIADNE_SHOTS ?? resolve(homedir(), 'Documents/Code/ariadne-mocks/final-design/shots');
const output = resolve(repo, 'coverage/components');
/** The board's shots carry a 28px label strip above the window. */
const strip = 28;
/** Pixels whose channels differ by more than this count as mismatched (the design harness uses the same). */
const tolerance = 16;
const results: Record<string, Record<string, number>> = {};

let server: ViteDevServer, origin = '';
test.beforeAll(async () => {
  mkdirSync(output, { recursive: true });
  server = await createServer({ configFile: false, root: repo, publicDir: resolve(repo, 'apps/desktop/public'), plugins: [react()], logLevel: 'error',
    optimizeDeps: { entries: [resolve(repo, 'tests/ui/components/gallery.html')] }, server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false } });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === 'string') throw new Error('no gallery server address');
  origin = `http://127.0.0.1:${address.port}`;
  await server.warmupRequest('/tests/ui/components/gallery.tsx');
  await server.waitForRequestsIdle();
});
test.afterAll(async () => {
  await server.close();
  writeFileSync(resolve(output, 'report.json'), `${JSON.stringify(results, null, 2)}\n`);
});

interface Rect { readonly x: number; readonly y: number; readonly width: number; readonly height: number }

/** `designX` is where the design draws the zone when the app places it differently. */
async function compare(page: Page, design: Buffer, app: Buffer, rect: Rect, designX: number) {
  return page.evaluate(async ({ design, app, rect, designX, strip, tolerance }) => {
    const load = (base64: string) => new Promise<HTMLImageElement>((done, fail) => {
      const image = new Image(); image.onload = () => done(image); image.onerror = fail; image.src = `data:image/png;base64,${base64}`;
    });
    const [left, right] = await Promise.all([load(design), load(app)]);
    const { width, height } = rect;
    const cut = (image: HTMLImageElement, x: number, dy: number) => {
      const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
      const context = canvas.getContext('2d')!; context.drawImage(image, x, rect.y + dy, width, height, 0, 0, width, height);
      return context.getImageData(0, 0, width, height).data;
    };
    const a = cut(left, designX, strip), b = cut(right, rect.x, 0);
    const out = document.createElement('canvas'); out.width = width; out.height = height * 3 + 8;
    const context = out.getContext('2d')!;
    context.fillStyle = '#f0f'; context.fillRect(0, 0, out.width, out.height);
    const diff = context.createImageData(width, height);
    // strict: the same pixel differs. near: no pixel within one pixel of it in the design matches either, so
    // a text edge that sits half a pixel off (font rendering) is not counted but a missing or misplaced mark is.
    const same = (from: number, to: number) => [0, 1, 2].every(channel => Math.abs(a[from + channel]! - b[to + channel]!) <= tolerance);
    let strict = 0, near = 0;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const index = (y * width + x) * 4;
      if (same(index, index)) { diff.data.set([b[index]! * 0.3, b[index + 1]! * 0.3, b[index + 2]! * 0.3, 255], index); continue; }
      strict++;
      let found = false;
      for (let dy = -1; dy <= 1 && !found; dy++) for (let dx = -1; dx <= 1 && !found; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx >= 0 && ny >= 0 && nx < width && ny < height && same((ny * width + nx) * 4, index)) found = true;
      }
      if (found) diff.data.set([b[index]! * 0.3 + 40, b[index + 1]! * 0.3 + 40, b[index + 2]! * 0.3, 255], index);
      else { near++; diff.data.set([255, 0, 64, 255], index); }
    }
    context.drawImage(left, designX, rect.y + strip, width, height, 0, 0, width, height);
    context.drawImage(right, rect.x, rect.y, width, height, 0, height + 4, width, height);
    context.putImageData(diff, 0, height * 2 + 8);
    return { strict: strict / (width * height), near: near / (width * height), png: out.toDataURL('image/png').split(',')[1]! };
  }, { design: design.toString('base64'), app: app.toString('base64'), rect, designX, strip, tolerance });
}

function cases(): Array<{ frame: FrameMeta; theme: 'light' | 'dark'; narrow: boolean; name: string; shot: string }> {
  return registry.flatMap(frame => (['light', 'dark'] as const).flatMap(theme => [false, true].filter(narrow => !(narrow && frame.wideOnly)).map(narrow => ({
    frame, theme, narrow, name: `${frame.id}-${theme}${narrow ? '-900' : ''}`, shot: `${frame.shot}-${theme}${narrow ? '-900' : ''}.png`.replace('-dark-900', '-light-900'),
  }))));
}

for (const { frame, theme, narrow, name, shot } of cases()) {
  test(name, async ({ page }) => {
    const size = sizeOf(narrow);
    await page.setViewportSize(size);
    await page.goto(`${origin}/tests/ui/components/gallery.html?frame=${frame.id}&theme=${theme}${narrow ? '&narrow=1' : ''}`);
    await page.locator('.gallery-window').waitFor();
    await page.evaluate(() => document.fonts.ready);
    const app = await page.screenshot({ animations: 'disabled', clip: { x: 0, y: 0, ...size } });
    writeFileSync(resolve(output, `${name}.png`), app);
    results[name] = {};
    const reference = resolve(shots, shot);
    // The 900 board draws light only: dark at 900 is looked at, not compared.
    if (!existsSync(reference) || (narrow && theme === 'dark')) return;
    const design = readFileSync(reference);
    for (const [zone, entry] of Object.entries(frame.zones)) {
      const spec = typeof entry === 'string' ? { selector: entry } as Zone : entry;
      const rect = await page.locator(spec.selector).first().evaluate(element => { const box = element.getBoundingClientRect(); return { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) }; });
      const designX = (narrow ? spec.designXNarrow : spec.designX) ?? rect.x;
      const { strict, near, png } = await compare(page, design, app, rect, designX);
      writeFileSync(resolve(output, `${name}-${zone}-compare.png`), Buffer.from(png, 'base64'));
      results[name]![zone] = Number(near.toFixed(4));
      console.log(`${name} ${zone}: ${(strict * 100).toFixed(2)}% strict, ${(near * 100).toFixed(2)}% beyond one pixel`);
      expect(near, `${name} ${zone}`).toBeLessThan(spec.limit ?? frame.limit ?? 0.03);
    }
  });
}
