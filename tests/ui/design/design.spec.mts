// Design fidelity harness: each handoff frame of Ariadne Mockups.dc.html beside
// the real DesktopApp in the same state. Writes coverage/design/<frame>-design.png,
// -app.png and -diff.png, a per-frame result that teardown.ts gathers into
// report.json, and fails a frame whose mismatch ratio exceeds thresholds.json.
import { test as base, expect, type BrowserContext, type Page } from '@playwright/test';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, resolve, sep } from 'node:path';
import { designNow, frameSpec, graphFrame, type FrameSpec } from './frames';
import { handoffMembers, prefix, repo, sourceRoot } from './source.mts';
import thresholds from './thresholds.json' with { type: 'json' };

// Pixels whose channels differ by more than this count as mismatched.
const tolerance = 16;
const members = handoffMembers();
const served = resolve(sourceRoot, prefix);
const output = resolve(repo, 'coverage/design');
// Every frame that mounts the Ariadne component; ones without a fixture are skipped.
const designFrames = members['Ariadne Mockups.dc.html'].split('<div class="dv-opt" id="').slice(1)
  .filter(part => part.includes('<dc-import name="Ariadne"')).map(part => part.slice(0, part.indexOf('"')));
const requireRuntime = createRequire(resolve(repo, 'tests/ui/design/runtime/package.json'));
const runtimeFile = (name: string, file: string) => readFileSync(resolve(dirname(requireRuntime.resolve(`${name}/package.json`)), file));
const runtime: Record<string, Buffer> = {
  'https://unpkg.com/react@18.3.1/umd/react.production.min.js': runtimeFile('react', 'umd/react.production.min.js'),
  'https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js': runtimeFile('react-dom', 'umd/react-dom.production.min.js'),
  'https://unpkg.com/@babel/standalone@7.29.0/babel.min.js': runtimeFile('@babel/standalone', 'babel.min.js'),
};
const fontsCss = readFileSync(resolve(repo, 'apps/desktop/public/fonts/jetbrains-mono.css'), 'utf8');
const iconsCss = readFileSync(resolve(repo, 'apps/desktop/public/icons/phosphor.css'), 'utf8');
const phosphor = /^https:\/\/unpkg\.com\/@phosphor-icons\/web@2\.1\.1\/src\/(?:regular|fill)\/style\.css$/;
const contentTypes: Record<string, string> = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.md': 'text/markdown' };

const test = base.extend<Record<never, never>, { origin: string; designPage: Page }>({
  origin: [async ({ browserName }, use) => {
    expect(browserName).toBe('chromium');
    // support.js checks SRI on its CDN scripts; serve the same bytes offline.
    for (const [url, bytes] of Object.entries(runtime)) {
      const name = url.includes('react-dom') ? 'REACT_DOM' : url.includes('babel') ? 'BABEL' : 'REACT';
      const sri = members['support.js'].match(new RegExp(`var ${name}_SRI = "([^"]+)"`))?.[1];
      expect(`sha384-${createHash('sha384').update(bytes).digest('base64')}`, url).toBe(sri);
    }
    const server = await createServer({ configFile: false, root: repo, publicDir: resolve(repo, 'apps/desktop/public'), plugins: [react()], logLevel: 'error',
      server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false } });
    try {
      await server.listen();
      const address = server.httpServer?.address();
      if (!address || typeof address === 'string') throw new Error('Missing design server address');
      await use(`http://127.0.0.1:${address.port}`);
    } finally { await server.close(); }
  }, { scope: 'worker' }],
  designPage: [async ({ browser, origin }, use) => {
    const context = await browser.newContext({ viewport: { width: 1700, height: 1000 }, deviceScaleFactor: 1, locale: 'en-US', timezoneId: 'UTC',
      colorScheme: 'dark', reducedMotion: 'reduce' });
    const denied: string[] = [];
    await route(context, origin, denied);
    const page = await context.newPage();
    await page.clock.setFixedTime(designNow);
    await page.goto(`${origin}/source/${encodeURIComponent('Ariadne Mockups.dc.html')}`);
    await page.waitForFunction(() => {
      const cards = [...document.querySelectorAll('.dv-card')];
      return cards.length > 0 && cards.every(card => card.querySelector('.sc-host > *')) && !document.querySelector('.sc-placeholder, .sc-missing, .sc-logic-error, .sc-placeholder-error');
    }, null, { timeout: 180_000 });
    // Ariadne.dc.html:976 scrolls the selection at 400/1200/2500 ms after mount.
    await page.evaluate(async () => { await document.fonts.ready; await new Promise(resolve => setTimeout(resolve, 2600)); });
    expect(denied).toEqual([]);
    await use(page);
    await context.close();
  }, { scope: 'worker' }],
});

/** Serves the unzipped handoff at /source/, its CDN runtime, fonts and icons offline; blocks every other origin. */
async function route(context: BrowserContext, origin: string, denied: string[]) {
  await context.route('**/*', async request => {
    const url = request.request().url();
    if (runtime[url]) return request.fulfill({ body: runtime[url], contentType: 'application/javascript', headers: { 'access-control-allow-origin': '*' } });
    if (url.startsWith('https://fonts.googleapis.com/css2?family=JetBrains+Mono')) {
      return request.fulfill({ body: fontsCss.split('url("./').join(`url("${origin}/fonts/`), contentType: 'text/css' });
    }
    if (phosphor.test(url)) return request.fulfill({ body: iconsCss.split('url("./').join(`url("${origin}/icons/`), contentType: 'text/css' });
    const parsed = new URL(url);
    if (parsed.origin !== origin) { denied.push(url); return request.abort('blockedbyclient'); }
    if (parsed.pathname.startsWith('/source/')) {
      const file = resolve(served, decodeURIComponent(parsed.pathname.slice('/source/'.length)));
      if (!file.startsWith(served + sep) || !existsSync(file)) return request.fulfill({ status: 404, body: '' });
      return request.fulfill({ body: readFileSync(file), contentType: contentTypes[extname(file)] ?? 'application/octet-stream' });
    }
    return request.continue();
  });
}

async function settle(page: Page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>(resolve => setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve())), 300));
  });
}

/** Opens the frame in the app and puts it in the frame's state. */
async function openApp(page: Page, origin: string, spec: FrameSpec) {
  await page.setViewportSize({ width: spec.width, height: spec.height });
  await page.clock.setFixedTime(designNow);
  await page.goto(`${origin}/tests/ui/design/gallery.html?frame=${spec.id}`);
  await page.waitForFunction(() => (window as { __designError?: string }).__designError
    || /\d+ items/.test(document.querySelector('.shell-summary')?.textContent ?? ''), null, { timeout: 60_000 });
  expect(await page.evaluate(() => (window as { __designError?: string }).__designError)).toBeUndefined();
  await expect(page.locator('html')).toHaveAttribute('data-theme', spec.theme);
  if (spec.state !== 'loading') await expect(page.getByText(/^(Loading|Opening)\b/)).toHaveCount(0, { timeout: 30_000 });
  else await expect(page.getByText(/^Loading session/).first()).toBeVisible();
  const row = (id?: string) => id ? page.locator(`[data-item-id="${id}"]`) : page.locator('[data-item-id]').first();
  if (spec.answering) { await row(spec.answering).focus(); await page.keyboard.press('a'); }
  // open-mode opens the reply or follow-up box; r opens either (Ariadne.dc.html:1490). The frame draws it unfocused.
  if (spec.openMode) {
    await row(spec.selected).first().focus(); await page.keyboard.press('r');
    await page.locator('.detail-box textarea').waitFor();
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  }
  if (graphFrame(spec)) {
    await row(spec.selected).focus();
    if (spec.selected && !spec.detail) await page.keyboard.press('Escape');
    await page.keyboard.press('g');
  }
  await settle(page);
}

/** Pixel diff in the browser canvas: mismatch ratio and a diff image (mismatches red over the dimmed app). */
async function compare(page: Page, design: Buffer, app: Buffer, region: Region | null) {
  return page.evaluate(async ({ design, app, tolerance, region }) => {
    const load = (base64: string) => new Promise<HTMLImageElement>((done, fail) => {
      const image = new Image(); image.onload = () => done(image); image.onerror = fail; image.src = `data:image/png;base64,${base64}`;
    });
    const [left, right] = await Promise.all([load(design), load(app)]);
    const width = Math.max(left.width, right.width), height = Math.max(left.height, right.height);
    const pixels = (image: HTMLImageElement) => {
      const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
      const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0); return context.getImageData(0, 0, width, height).data;
    };
    const a = pixels(left), b = pixels(right), canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d')!, out = context.createImageData(width, height);
    let mismatched = 0, inRegion = 0;
    const inside = (index: number) => {
      if (!region) return false;
      const x = (index / 4) % width, y = Math.floor(index / 4 / width);
      return x >= region.x && x < region.x + region.width && y >= region.y && y < region.y + region.height;
    };
    for (let index = 0; index < a.length; index += 4) {
      const differs = [0, 1, 2, 3].some(channel => Math.abs(a[index + channel] - b[index + channel]) > tolerance);
      if (differs) { mismatched++; if (inside(index)) inRegion++; out.data.set([255, 0, 64, 255], index); }
      else out.data.set([b[index] * 0.3, b[index + 1] * 0.3, b[index + 2] * 0.3, 255], index);
    }
    context.putImageData(out, 0, 0);
    return { ratio: mismatched / (width * height), detail: region ? inRegion / (region.width * region.height) : null, width, height,
      png: canvas.toDataURL('image/png').split(',')[1] };
  }, { design: design.toString('base64'), app: app.toString('base64'), tolerance, region });
}
interface Region { readonly x: number; readonly y: number; readonly width: number; readonly height: number }

test.describe.configure({ mode: 'parallel' });
for (const id of designFrames) {
  test(`frame ${id}`, async ({ page, origin, designPage }) => {
    let spec: FrameSpec;
    try { spec = frameSpec(id); } catch (error) { test.skip(true, (error as Error).message); return; }
    const denied: string[] = [];
    await route(page.context(), origin, denied);
    await openApp(page, origin, spec);
    const shell = await page.evaluate(() => {
      const height = (selector: string) => document.querySelector(selector)?.getBoundingClientRect().height ?? null;
      const columns = [...document.querySelector('.shell-body')!.children].map(child => ({
        name: ['waiting', 'center', 'detail'].find(name => child.classList.contains(`shell-${name}`)) ?? 'rail', width: child.getBoundingClientRect().width }));
      return { header: height('.shell-header'), tabs: height('.shell-tabs'), footer: height('.shell-footer'), columns };
    });
    expect(shell.header).toBe(48); expect(shell.tabs).toBe(38); expect(shell.footer).toBe(30);
    const fixed: Record<string, number> = { waiting: 300, detail: 400, rail: 240 };
    for (const column of shell.columns) {
      if (column.name === 'center') expect(column.width, 'centre column').toBeGreaterThanOrEqual(560);
      else expect(column.width, `${column.name} column`).toBe(fixed[column.name]);
    }
    const app = await page.screenshot({ animations: 'disabled' });
    // The card sits at a fractional page offset; clip the frame's exact size at the rounded origin.
    const box = await designPage.locator(`[id="${id}"] .dv-card`).evaluate(node => {
      const rect = node.getBoundingClientRect(); return { x: rect.x + window.scrollX, y: rect.y + window.scrollY };
    });
    const design = await designPage.screenshot({ animations: 'disabled', fullPage: true,
      clip: { x: Math.round(box.x), y: Math.round(box.y), width: spec.width, height: spec.height } });
    // The detail column alone, so a work package can follow its own area.
    const region = await page.evaluate(() => {
      const rect = document.querySelector('.shell-detail')?.getBoundingClientRect();
      return rect ? { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) } : null;
    });
    const canvas = await page.context().newPage();
    const result = await compare(canvas, design, app, region);
    await canvas.close();
    writeFileSync(resolve(output, `${id}-design.png`), design);
    writeFileSync(resolve(output, `${id}-app.png`), app);
    writeFileSync(resolve(output, `${id}-diff.png`), Buffer.from(result.png, 'base64'));
    const threshold = (thresholds as Record<string, number>)[id] ?? 0;
    writeFileSync(resolve(output, 'frames', `${id}.json`), `${JSON.stringify({ ratio: Number(result.ratio.toFixed(4)), threshold, tolerance,
      detail: result.detail === null ? null : { ratio: Number(result.detail.toFixed(4)), region },
      size: { width: result.width, height: result.height }, viewport: { width: spec.width, height: spec.height }, shell }, null, 2)}\n`);
    expect(denied).toEqual([]);
    expect(result.ratio, `${id} mismatch ratio`).toBeLessThanOrEqual(threshold);
  });
}
