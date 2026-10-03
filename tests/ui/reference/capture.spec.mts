import { test as base, expect, type Page, type BrowserContext, type Locator } from '@playwright/test';
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
import { assembledRegions, frameRegions } from './assembled-regions';

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
    __ariadneReferenceCases: CaptureCase[];
    getDC: (name: string) => unknown;
    React: { createElement: (component: unknown, props: Record<string, unknown>) => unknown };
    ReactDOM: { render: (element: unknown, root: HTMLElement) => void };
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

async function routeSource(context: BrowserContext, origin: string, denied: string[]) {
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
}

// Original screenshots prove the actual viewport. Compare component pixels at
// a shared integer raster origin, retaining their inheritance and dimensions.
async function normalizedComponent(region: Locator) {
  // Style-based locators can stop matching when normalization changes position.
  // Hold this exact node through capture and cleanup, including assertion failure.
  const component = await region.elementHandle();
  if (!component) throw new Error('Missing component before raster normalization');
  try {
    const originalStyle = await component.getAttribute('style');
    const originalBox = await component.boundingBox();
    if (!originalBox) throw new Error('Missing component box before raster normalization');
    // Removing a large component from flow can clamp its ancestor scroll range.
    // Retain the actual ancestor nodes, including the document scroll position.
    const scrollState = await component.evaluateHandle(element => {
      const ancestors = [];
      for (let node: Element | null = element; node; node = node.parentElement) ancestors.push({ node, left: node.scrollLeft, top: node.scrollTop });
      return { ancestors, left: window.scrollX, top: window.scrollY };
    });
    try {
      const originalScroll = await scrollState.evaluate(state => ({ ancestors: state.ancestors.map(({ node, left, top }) => ({ tag: node.tagName, id: node.id, sourceTemplate: node.getAttribute('data-dc-tpl'), left, top })), left: state.left, top: state.top }));
      const placement = await component.evaluate((element, box) => {
        const node = element as HTMLElement;
        let backdrop = '', preserveBackdrop = false, backingLayer = false;
        for (let ancestor: HTMLElement | null = node; ancestor; ancestor = ancestor.parentElement) {
          const style = getComputedStyle(ancestor), color = style.backgroundColor;
          if (style.backgroundImage !== 'none' || Number(style.opacity) !== 1) throw new Error(`Unsupported component backdrop: image=${style.backgroundImage}, opacity=${style.opacity}`);
          const match = color.match(/(?:rgba\([^)]*,\s*|\/\s*)([\d.]+)(%)?\s*\)$/);
          const alpha = match ? Number(match[1]) / (match[2] ? 100 : 1) : 1;
          if (alpha > 0 && alpha < 1) {
            if (ancestor !== node) throw new Error(`Unsupported translucent ancestor backdrop: ${color}`);
            backingLayer = true;
          }
          if (alpha === 1) { backdrop = color; preserveBackdrop = ancestor !== node; break; }
        }
        if (!backdrop) throw new Error('No solid component backdrop found');
        const temporaryStyles = { position: 'fixed', left: '0px', top: '0px', width: `${box.width}px`, height: `${box.height}px`, margin: '0px', zIndex: '10000', ...(preserveBackdrop && !backingLayer ? { backgroundColor: backdrop } : {}) };
        Object.assign(node.style, temporaryStyles);
        const temporaryBacking = backingLayer ? { position: 'fixed', left: '0px', top: '0px', width: `${box.width}px`, height: `${box.height}px`, zIndex: '9999', backgroundColor: backdrop, pointerEvents: 'none' } : null;
        if (temporaryBacking) {
          const backing = document.createElement('div'); backing.dataset.referenceRasterBackdrop = ''; backing.inert = true; backing.setAttribute('aria-hidden', 'true');
          Object.assign(backing.style, temporaryBacking); node.before(backing);
        }
        return { backdrop, preserveBackdrop, temporaryStyles, temporaryBacking };
      }, originalBox);
      const normalizedBox = await component.boundingBox();
      expect(normalizedBox).not.toBeNull();
      for (const dimension of ['width', 'height'] as const) expect(normalizedBox![dimension], `Normalization preserves ${dimension}`).toBeCloseTo(originalBox[dimension], 5);
      expect(normalizedBox!.x).toBe(0); expect(normalizedBox!.y).toBe(0);
      const png = await component.screenshot({ animations: 'disabled' });
      return { png, provenance: { originalBox, normalizedBox, originalScroll, ...placement, identity: 'Original ElementHandle retained for measurement, capture and restoration', purpose: 'Whole-component pixel comparison; does not prove original viewport visibility.' } };
    } finally {
      try {
        await component.evaluate((element, style) => {
          const backing = element.previousElementSibling;
          if (backing?.hasAttribute('data-reference-raster-backdrop')) backing.remove();
          if (style === null) element.removeAttribute('style'); else element.setAttribute('style', style); }, originalStyle);
        const scrollRestored = await scrollState.evaluate(state => {
          for (const { node, left, top } of [...state.ancestors].reverse()) node.scrollTo({ left, top, behavior: 'instant' });
          window.scrollTo({ left: state.left, top: state.top, behavior: 'instant' });
          return state.ancestors.every(({ node, left, top }) => node.scrollLeft === left && node.scrollTop === top) && window.scrollX === state.left && window.scrollY === state.top;
        });
        expect(scrollRestored, 'Original ancestor and document scroll offsets restored').toBe(true);
        expect(await component.evaluate(element => element.isConnected), 'Original component remains connected').toBe(true);
        expect(await component.getAttribute('style'), 'Original node inline styles restored').toBe(originalStyle);
        expect(await region.evaluate((resolved, original) => resolved === original, component), 'Locator resolves the original node after restoration').toBe(true);
        const restoredBox = await component.boundingBox();
        expect(restoredBox, 'Original node box restored').not.toBeNull();
        for (const dimension of ['x', 'y', 'width', 'height'] as const) expect(restoredBox![dimension], `Restoration preserves ${dimension}`).toBeCloseTo(originalBox[dimension], 5);
        expect(await region.page().locator('[data-reference-raster-backdrop]').count(), 'Temporary backing removed').toBe(0);
      } finally {
        await scrollState.dispose();
      }
    }
  } finally {
    await component.dispose();
  }
}

test('normalization retains a style-selected node and restores scroll after failure', async ({ page }) => {
  await page.setContent(`<body style="min-height: 2000px"><main style="background: white; width: 500px; height: 160px; overflow: auto; margin-top: 800px">
    <div id="original" style="position: relative; width: 688px; height: 628px; background: rgba(80, 80, 255, 0.07)"><svg></svg></div>
    <div id="next" style="position: relative; width: 472px; height: 120px; background: white"><svg></svg></div>
  </main></body>`);
  await page.evaluate(() => { document.querySelector('main')!.scrollTo(4, 169); window.scrollTo(0, 400); });
  const region = page.locator('main div[style*="position: relative;"]:has(> svg)').first();
  const originalStyle = await page.locator('#original').getAttribute('style');
  const nextStyle = await page.locator('#next').getAttribute('style');
  const normalized = await normalizedComponent(region);
  expect(normalized.provenance.normalizedBox?.width).toBe(688);
  expect(normalized.provenance.temporaryBacking).not.toBeNull();
  expect(normalized.provenance.originalScroll.top).toBe(400);
  expect(normalized.png.byteLength).toBeGreaterThan(0);
  // Force an assertion failure after positioning/backing insertion, exercising
  // the same cleanup path that a failed screenshot or dimension check takes.
  await page.addStyleTag({ content: '#original[style*="fixed"] { width: 689px !important; }' });
  await expect(normalizedComponent(region)).rejects.toThrow(/Normalization preserves width/);
  expect(await page.locator('#original').getAttribute('style')).toBe(originalStyle);
  expect(await page.locator('#next').getAttribute('style')).toBe(nextStyle);
  expect(await region.getAttribute('id')).toBe('original');
  expect(await page.evaluate(() => ({ left: document.querySelector('main')!.scrollLeft, top: document.querySelector('main')!.scrollTop, windowTop: window.scrollY }))).toEqual({ left: 4, top: 169, windowTop: 400 });
  await expect(page.locator('[data-reference-raster-backdrop]')).toHaveCount(0);
});

for (const component of ['Status Badge', 'Item Row', 'Answer Control', 'Message Excerpt']) {
  test(`source parity: ${component}`, async ({ page, context, origin, browser }, testInfo) => {
    const theme = testInfo.project.name.startsWith('light') ? 'light' : 'dark';
    const denied: string[] = [], errors: string[] = [];
    context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
    page.on('pageerror', error => errors.push(error.message));
    await routeSource(context, origin, denied);
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
      let comparedSource = sourcePng, comparedApp = appPng;
      if (fixture.shortcutHint) {
        const oldHint = original.getByText(fixture.shortcutHint.source, { exact: true });
        const newHint = page.getByText(fixture.shortcutHint.app, { exact: true });
        await expect(oldHint).toHaveCount(1); await expect(newHint).toHaveCount(1);
        // Preserve full unmasked PNGs below. Only the exact prototype shortcut
        // text differs by the release keyboard contract; no control is hidden.
        await oldHint.evaluate(node => { node.style.visibility = 'hidden'; });
        await newHint.evaluate(node => { node.style.visibility = 'hidden'; });
        comparedSource = await sourceRegion.screenshot({ animations: 'disabled' });
        comparedApp = await appRegion.screenshot({ animations: 'disabled' });
      }
      const expected = testInfo.snapshotPath(`${fixture.id}.png`);
      await mkdir(dirname(expected), { recursive: true });
      await writeFile(expected, comparedSource);
      await testInfo.attach(`${fixture.id}-source`, { body: sourcePng, contentType: 'image/png' });
      await testInfo.attach(`${fixture.id}-app`, { body: appPng, contentType: 'image/png' });
      await testInfo.attach(`${fixture.id}-provenance`, { body: JSON.stringify({ archive: sourceManifest.archive, member: `design_handoff_ariadne/${component}.dc.html`, runtime: Object.entries(runtimeBytes).map(([url, bytes]) => ({ url, sha256: sha256(bytes) })), browser: browser.version(), project: testInfo.project.name, viewport: page.viewportSize(), source: fixture.source, sourceBox, appBox, shortcutHintException: fixture.shortcutHint }), contentType: 'application/json' });
      // This expected PNG is freshly rendered SOURCE, never an app-generated
      // golden. Playwright retains its real actual/diff images on mismatch.
      expect(comparedApp).toMatchSnapshot(`${fixture.id}.png`, { threshold: 0.2, maxDiffPixelRatio: 0.005 });
      if (['row-selected-focused', 'message-rail-active'].includes(fixture.id)) {
        await page.keyboard.press('Tab');
        const focusedRoot = page.locator('#root > .ariadne-reference');
        await expect(focusedRoot).toBeFocused();
        await expect(focusedRoot).toHaveCSS('outline-style', 'solid');
        await expect(focusedRoot).toHaveCSS('outline-width', '2px');
        await expect(focusedRoot).toHaveCSS('outline-offset', '2px');
      }
    }
    expect(denied).toEqual([]); expect(errors).toEqual([]);
    await original.close();
  });
}

test('assembled frame regions and canonical pinned geometry', async ({ page, context, origin, browser }, testInfo) => {
  const theme = testInfo.project.name.startsWith('light') ? 'light' : 'dark';
  const denied: string[] = [], errors: string[] = [];
  context.on('page', tab => tab.on('pageerror', error => errors.push(error.message)));
  page.on('pageerror', error => errors.push(error.message));
  await routeSource(context, origin, denied);
  const original = await context.newPage();
  const applicationFrames = sourceManifest.frames.filter(frame => frame.member.endsWith('/Ariadne.dc.html'));
  const expanded = applicationFrames.find(frame => frame.id === '1d')!;
  for (const frame of [...applicationFrames, { ...expanded, id: 'graph-expanded-replacement', props: { ...expanded.props, expand: '1.3.1.2' } }, { ...expanded, id: 'graph-filtered', props: { ...expanded.props, selected: '', query: 'Redis' } }]) {
    const props = Object.fromEntries(Object.entries(frame.props).filter(([key]) => !['name', 'style', 'hint-size'].includes(key)).map(([key, value]) => [key.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase()), value === '{{ true }}' ? true : value === '{{ false }}' ? false : key === 'hover-msg' ? Number(value) : value]));
    await original.goto(`${origin}/source/Ariadne.dc.html`);
    await ready(original, true);
    // The main prototype reads scenarios in its constructor. A fresh keyed
    // source mount must receive props before construction; changing registry
    // overrides on the already mounted default would compare the wrong state.
    await original.evaluate(props => window.ReactDOM.render(window.React.createElement(window.getDC('Ariadne'), props), document.getElementById('dc-root')!), { ...props, key: frame.id, theme, embedded: true });
    await original.addStyleTag({ content: 'body{margin:0}#dc-root{width:100vw;height:100vh}' });
    await ready(original, true);
    await page.goto(`${origin}/tests/ui/reference/gallery.html?frame=${frame.id}&theme=${theme}`);
    await ready(page, false);
    const dimensions = await page.evaluate(() => {
      const box = (selector: string) => {
        const node = document.querySelector<HTMLElement>(selector)!;
        const rect = node.getBoundingClientRect();
        return { width: rect.width, height: rect.height, x: rect.x, y: rect.y };
      };
      const scroll = document.querySelector<HTMLElement>('.ref-workspace-scroll')!;
      return { header: box('.ref-header'), tabs: box('.ref-tabs'), footer: box('.ref-footer'), waiting: box('.ref-waiting'), center: box('.ref-center'), detail: document.querySelector('.ref-detail') ? box('.ref-detail') : null, rail: document.querySelector('.ref-rail') ? box('.ref-rail') : null, overflow: scroll.scrollWidth > scroll.clientWidth };
    });
    await expect(page.locator('.ref-workspace')).toHaveCSS('font-size', '14px');
    await expect(page.locator('.ref-workspace')).toHaveCSS('line-height', '21px');
    expect(dimensions.header.height).toBe(48); expect(dimensions.tabs.height).toBe(38); expect(dimensions.footer.height).toBe(30);
    expect(dimensions.waiting.width).toBe(300); expect(dimensions.center.width).toBeGreaterThanOrEqual(560);
    if (dimensions.detail) expect(dimensions.detail.width).toBe(400);
    if (dimensions.rail) expect(dimensions.rail.width).toBe(240);
    for (const node of await page.locator('.ref-graph-node').all()) {
      const box = await node.boundingBox(); expect(box?.width).toBe(190); expect(box?.height).toBe(66);
    }
    const sourceWhole = await original.screenshot({ animations: 'disabled' });
    const appWhole = await page.screenshot({ animations: 'disabled' });
    await testInfo.attach(`${frame.id}-source-whole-unmasked`, { body: sourceWhole, contentType: 'image/png' });
    await testInfo.attach(`${frame.id}-app-whole-unmasked`, { body: appWhole, contentType: 'image/png' });
    for (const name of frameRegions[frame.id] ?? ['graph'] as const) {
      const region = assembledRegions[name];
      const sourceRegions = original.locator(region.source), appRegions = page.locator(region.app);
      const sourceCount = await sourceRegions.count(), appCount = await appRegions.count();
      expect.soft(sourceCount, `${frame.id}/${name} matching region count`).toBe(appCount);
      for (let index = 0; index < Math.min(sourceCount, appCount); index++) {
      const sourceRegion = sourceRegions.nth(index), appRegion = appRegions.nth(index);
      await expect(sourceRegion).toBeAttached(); await expect(appRegion).toBeAttached();
      const sourceBox = await sourceRegion.boundingBox(), appBox = await appRegion.boundingBox();
      expect(sourceBox).not.toBeNull(); expect(appBox).not.toBeNull();
      for (const dimension of ['width', 'height'] as const) expect.soft(Math.abs(sourceBox![dimension] - appBox![dimension]), `${frame.id}/${name} ${dimension}`).toBeLessThanOrEqual(1);
      const sourcePng = await sourceRegion.screenshot({ animations: 'disabled' });
      await testInfo.attach(`${frame.id}-${name}-${index}-source`, { body: sourcePng, contentType: 'image/png' });
      const appPng = await appRegion.screenshot({ animations: 'disabled' });
      await testInfo.attach(`${frame.id}-${name}-${index}-app`, { body: appPng, contentType: 'image/png' });
      await testInfo.attach(`${frame.id}-${name}-${index}-original-provenance`, { body: JSON.stringify({ archive: sourceManifest.archive, member: frame.member, boardLine: frame.line, props, theme, viewport: page.viewportSize(), browser: browser.version(), sourceBox, appBox, dimensions, region, masks: [], normalized: false, wholeFrameParity: false }), contentType: 'application/json' });
      const normalizedSource = await normalizedComponent(sourceRegion), normalizedApp = await normalizedComponent(appRegion);
      const snapshot = `${frame.id}-${name}-${index}-normalized.png`;
      const expected = testInfo.snapshotPath(snapshot);
      await mkdir(dirname(expected), { recursive: true }); await writeFile(expected, normalizedSource.png);
      await testInfo.attach(`${frame.id}-${name}-${index}-normalized-source`, { body: normalizedSource.png, contentType: 'image/png' });
      await testInfo.attach(`${frame.id}-${name}-${index}-normalized-app`, { body: normalizedApp.png, contentType: 'image/png' });
      await testInfo.attach(`${frame.id}-${name}-${index}-provenance`, { body: JSON.stringify({ archive: sourceManifest.archive, member: frame.member, boardLine: frame.line, props, theme, viewport: page.viewportSize(), browser: browser.version(), sourceBox, appBox, normalizedSource: normalizedSource.provenance, normalizedApp: normalizedApp.provenance, dimensions, region, masks: [], wholeFrameParity: false }), contentType: 'application/json' });
      // Keep the gate failing while retaining every downstream region pair.
      expect.soft(normalizedApp.png).toMatchSnapshot(snapshot, { threshold: 0.2, maxDiffPixelRatio: 0.005 });
      }
    }
    await page.locator('.ref-workspace-scroll').evaluate(node => { node.scrollLeft = 400; });
    const pinned = await page.locator('.ref-waiting').boundingBox();
    expect(pinned?.x).toBe(dimensions.waiting.x); expect(pinned?.width).toBe(300);
    if (page.viewportSize()!.width === 1000 && (dimensions.detail || dimensions.rail)) expect(dimensions.overflow).toBe(true);
    await expect(page.locator('.ref-footer')).toContainText('⌘↵');
    if (frame.id === '1y') {
      await expect(page.getByRole('dialog')).toContainText('new local IDs with immutable source references');
      await expect(page.getByRole('dialog')).toContainText('The source stays unchanged');
    }
  }
  for (const [frame, variant] of [['1x', 'archive-blocked'], ['1x', 'archive-eligible'], ['1ac', 'close-guard'], ['1y', 'target-error'], ['1u', 'ask-only'], ['1a', 'paused-follow'], ['1o', 'reconnect-choice'], ['1o', 'reconnect-draft']]) {
    await page.goto(`${origin}/tests/ui/reference/gallery.html?frame=${frame}&variant=${variant}&theme=${theme}`);
    await ready(page, false);
    if (['archive-blocked', 'archive-eligible', 'close-guard', 'target-error'].includes(variant)) {
      await expect(page.getByRole('dialog')).toBeVisible();
      const box = await page.getByRole('dialog').boundingBox();
      expect(box!.x).toBeGreaterThanOrEqual(24); expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width - 24);
    } else if (variant === 'paused-follow') await expect(page.getByRole('button', { name: '3 new messages · Jump to latest' })).toBeVisible();
    else if (variant.startsWith('reconnect-')) {
      const detail = page.getByRole('complementary', { name: 'Item detail' });
      await expect(detail.getByText(/Reconnecting to claude-code/)).toBeVisible();
      await expect(detail.getByRole('button', { name: 'Send reply' })).toBeDisabled();
      if (variant === 'reconnect-choice') {
        await expect(detail.getByRole('button', { name: /No, keep both/, pressed: true })).toBeVisible();
        await expect(detail.getByRole('button', { name: /Send “No, keep both”/ })).toBeDisabled();
      } else await expect(detail.getByRole('textbox', { name: 'Reply in your own words' })).toHaveValue('Please keep the rule only in AGENTS.md and link to it from CLAUDE.md.');
    } else await expect(page.locator('.ref-round-card')).toHaveCount(1);
    await testInfo.attach(`${variant}-app-no-supplied-matching-frame`, { body: await page.screenshot({ animations: 'disabled' }), contentType: 'image/png' });
  }
  expect(denied).toEqual([]); expect(errors).toEqual([]);
  await original.close();
});
