import { test as base, expect, type Page } from '@playwright/test';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sourceManifest from '../../../docs/planning/evidence/design-assets/source.json' with { type: 'json' };
import type { ReferenceCase } from './cases';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const archive = readFileSync(resolve(repo, sourceManifest.archive.path));
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const members: Record<string, string> = JSON.parse(execFileSync('python3', ['-c', `
import json, sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as archive:
    print(json.dumps({name.removeprefix('design_handoff_ariadne/'): archive.read(name).decode('utf-8')
                      for name in archive.namelist() if not name.endswith('/')}))
`, resolve(repo, sourceManifest.archive.path)], { encoding: 'utf8' }));
const requireSource = createRequire(resolve(repo, 'tests/ui/reference/source-runtime/package.json'));
const runtime = {
  'https://unpkg.com/react@18.3.1/umd/react.production.min.js': resolve(dirname(requireSource.resolve('react/package.json')), 'umd/react.production.min.js'),
  'https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js': resolve(dirname(requireSource.resolve('react-dom/package.json')), 'umd/react-dom.production.min.js'),
  'https://unpkg.com/@babel/standalone@7.29.0/babel.min.js': resolve(dirname(requireSource.resolve('@babel/standalone/package.json')), 'babel.min.js'),
};
const runtimeBytes = Object.fromEntries(Object.entries(runtime).map(([url, path]) => [url, readFileSync(path)]));
type CaptureCase = Omit<ReferenceCase, 'render'>;
declare global {
  interface Window {
    __dcSetProps: (name: string, props: Record<string, unknown>) => void;
    __dcRootName: () => string;
    __dcRegistry: Record<string, { Logic?: unknown }>;
  }
}

const test = base.extend<Record<never, never>, { origin: string }>({
  origin: [async ({ browserName }, use) => {
    expect(browserName).toBe('chromium');
    expect(sha256(archive)).toBe(sourceManifest.archive.sha256);
    // The original runtime checks SRI. Assert the same exact UMD bytes before
    // intercepting its CDN URLs; no network fallback is permitted.
    for (const [url, bytes] of Object.entries(runtimeBytes)) {
      const prefix = url.includes('react-dom') ? 'REACT_DOM' : url.includes('babel') ? 'BABEL' : 'REACT';
      const sri = members['support.js'].match(new RegExp(`var ${prefix}_SRI = "([^"]+)"`))?.[1];
      expect(`sha384-${createHash('sha384').update(bytes).digest('base64')}`).toBe(sri);
    }
    const server = await createServer({ configFile: false, root: repo, publicDir: resolve(repo, 'apps/desktop/public'), plugins: [react()], logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false } });
    try {
      await server.listen();
      const address = server.httpServer?.address();
      if (!address || typeof address === 'string') throw new Error('Missing reference server address');
      await use(`http://127.0.0.1:${address.port}`);
    } finally { await server.close(); }
  }, { scope: 'worker' }],
});

async function ready(page: Page, source: boolean) {
  if (source) {
    await page.waitForFunction(() => window.__dcRegistry?.[window.__dcRootName()]?.Logic);
    await expect(page.locator('.sc-placeholder, .sc-missing, .sc-logic-error')).toHaveCount(0);
  } else await expect(page.locator('#root > *')).toBeVisible();
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
}

for (const component of ['Status Badge', 'Item Row', 'Answer Control', 'Message Excerpt']) {
  test(`source parity: ${component}`, async ({ page, context, origin, browser }, testInfo) => {
    const theme = testInfo.project.name.startsWith('light') ? 'light' : 'dark';
    const denied: string[] = [], errors: string[] = [];
    context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
    page.on('pageerror', error => errors.push(error.message));
    await context.route('**/*', async route => {
      const url = route.request().url();
      if (runtimeBytes[url]) return route.fulfill({ body: runtimeBytes[url], contentType: 'application/javascript', headers: { 'access-control-allow-origin': '*' } });
      if (url.startsWith('https://fonts.googleapis.com/')) return route.fulfill({ body: readFileSync(resolve(repo, 'apps/desktop/public/fonts/inter.css'), 'utf8').split('url("./').join(`url("${origin}/fonts/`), contentType: 'text/css' });
      if (['https://unpkg.com/@phosphor-icons/web@2.1.1/src/regular/style.css', 'https://unpkg.com/@phosphor-icons/web@2.1.1/src/fill/style.css'].includes(url)) return route.fulfill({ body: readFileSync(resolve(repo, 'apps/desktop/public/icons/phosphor.css'), 'utf8').split('url("./').join(`url("${origin}/icons/`), contentType: 'text/css' });
      const parsed = new URL(url);
      if (parsed.origin !== origin) { denied.push(url); return route.abort('blockedbyclient'); }
      if (parsed.pathname.startsWith('/source/')) {
        const name = decodeURIComponent(parsed.pathname.slice('/source/'.length));
        if (members[name] === undefined) throw new Error(`Unknown source member: ${name}`);
        return route.fulfill({ body: members[name], contentType: name.endsWith('.js') ? 'application/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html' });
      }
      return route.continue();
    });
    await page.goto(`${origin}/tests/ui/reference/gallery.html?case=status-open-pill&theme=${theme}`);
    await ready(page, false);
    const fixtures = await page.evaluate(component => window.__ariadneReferenceCases.filter(fixture => fixture.component === component), component);
    expect(fixtures.length).toBeGreaterThan(0);
    const original = await context.newPage();
    await original.goto(`${origin}/source/${encodeURIComponent(component)}.dc.html`);
    await ready(original, true);
    // Source role values are recorded against immutable member/line evidence;
    // its complete base stylesheet is supplied from the archive unchanged.
    const themeRoles = sourceManifest.tokens.filter(token => token.scope === theme).map(token => `${token.name}:${token.value}`).join(';');
    await original.addStyleTag({ content: `:root{${themeRoles}}body{margin:32px;background:var(--a-bg)}#dc-root{width:min(760px,calc(100vw - 320px))}` });
    for (const fixture of fixtures as CaptureCase[]) {
      await original.evaluate(({ component, source }) => window.__dcSetProps(component, source), fixture);
      await ready(original, true);
      await page.goto(`${origin}/tests/ui/reference/gallery.html?case=${fixture.id}&theme=${theme}`);
      await ready(page, false);
      const sourceRegion = original.locator(fixture.region === 'textarea' ? 'textarea' : '#dc-root');
      const appRegion = page.locator(fixture.region === 'textarea' ? 'textarea' : '#root');
      const sourceBox = await sourceRegion.boundingBox(), appBox = await appRegion.boundingBox();
      expect(sourceBox).not.toBeNull(); expect(appBox).not.toBeNull();
      for (const dimension of ['width', 'height'] as const) expect(Math.abs(sourceBox![dimension] - appBox![dimension]), `${fixture.id} ${dimension}`).toBeLessThanOrEqual(1);
      const sourcePng = await sourceRegion.screenshot({ animations: 'disabled' });
      const appPng = await appRegion.screenshot({ animations: 'disabled' });
      const expected = testInfo.snapshotPath(`${fixture.id}.png`);
      await mkdir(dirname(expected), { recursive: true });
      await writeFile(expected, sourcePng);
      await testInfo.attach(`${fixture.id}-source`, { body: sourcePng, contentType: 'image/png' });
      await testInfo.attach(`${fixture.id}-app`, { body: appPng, contentType: 'image/png' });
      await testInfo.attach(`${fixture.id}-provenance`, { body: JSON.stringify({ archive: sourceManifest.archive, member: `design_handoff_ariadne/${component}.dc.html`, runtime: Object.entries(runtimeBytes).map(([url, bytes]) => ({ url, sha256: sha256(bytes) })), browser: browser.version(), project: testInfo.project.name, viewport: page.viewportSize(), source: fixture.source, sourceBox, appBox }), contentType: 'application/json' });
      // This expected PNG is freshly rendered SOURCE, never an app-generated
      // golden. Playwright retains its real actual/diff images on mismatch.
      expect(appPng).toMatchSnapshot(`${fixture.id}.png`, { threshold: 0.2, maxDiffPixelRatio: 0.005 });
    }
    expect(denied).toEqual([]); expect(errors).toEqual([]);
    await original.close();
  });
}
