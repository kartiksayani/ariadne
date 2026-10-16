// The final-board project (playwright.config.ts `final`): every registered state (final-frames.ts) is drawn by the board
// (designs/Ariadne-final-board.zip, offline) and, once its `pending` flag is off, by the real app in the matching fixture,
// and the two are compared pixel for pixel against final-thresholds.json. See README.md in this folder.
import { test as base, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createSocket } from 'node:dgram';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { captureFrame, crop, type CaptureInput, type CompareResult, type Region } from './compare.mts';
import { boardContext, boardFrame, labelHeight, launchBoardBrowser, openBoard, renderBoard, settle } from './final-board.mts';
import { finalNow, finalStates, notYet, regionsFor, unhonoured, variantNames, variants, type FinalState, type Step, type Variant } from './final-frames';
import { cspReportPath, finalMembers, fontFile, fontPins, runtimeHashes } from './final-source.mts';
import { startDesignServer } from './server.mts';
import { repo } from './source.mts';
import thresholds from './final-thresholds.json' with { type: 'json' };

const output = resolve(repo, 'coverage/design/final');
/** FINAL_APP=1 also draws and compares the app for states that are still `pending`, recording the ratio without asserting it. */
const compareAlways = process.env.FINAL_APP === '1';
/**
 * The record-only canary: one pending state whose app side runs on every CI run with `threshold: null` (the ratio is written,
 * never asserted), so the gallery, the loading wait and the `act` steps are exercised while every state is still pending.
 * 13.2 light takes both kinds of step a builder uses most: a key (the switcher's shortcut) and typed words.
 */
const canaryState = { id: '13.2', variant: 'light' } as const;
const canary = (state: FinalState, variant: Variant) => state.id === canaryState.id && variant === canaryState.variant;
const threshold = (id: string, variant: Variant): number => (thresholds as Record<string, number>)[`${id} ${variant}`] ?? (thresholds as Record<string, number>)[id] ?? 0;

/** The worker's board context: every board page is opened in it and closed after its shot. */
interface Board { readonly context: BrowserContext; readonly denied: string[] }
const test = base.extend<Record<never, never>, { origin: string; boardBrowser: Browser; board: Board }>({
  origin: [async ({ browserName }, use) => {
    expect(browserName).toBe('chromium');
    // The board's support.js checks SRI on its CDN scripts; the same pinned bytes are served offline.
    for (const { url, expected, actual } of runtimeHashes(finalMembers()['support.js']!)) expect(actual, url).toBe(expected);
    // Warmed before the first test, so no test pays the cold transform inside its render wait.
    const { server, origin } = await startDesignServer();
    try { await use(origin); } finally { await server.close(); }
  }, { scope: 'worker', timeout: 240_000 }],
  // The board's own browser, launched with the resolver and WebRTC rules (boardBrowserArgs): the app's contexts stay in the default one.
  boardBrowser: [async ({ browserName }, use) => {
    expect(browserName).toBe('chromium');
    const browser = await launchBoardBrowser();
    try { await use(browser); } finally { await browser.close(); }
  }, { scope: 'worker' }],
  board: [async ({ boardBrowser, origin }, use) => {
    const denied: string[] = [], context = await boardContext(boardBrowser, origin, denied);
    await use({ context, denied });
    await context.close();
  }, { scope: 'worker' }],
});
test.describe.configure({ mode: 'parallel' });

/** A context for the app: the same clock, zone and motion as the board's, every request outside the dev server blocked and recorded. */
async function appContext(browser: { newContext: (options: object) => Promise<BrowserContext> }, origin: string, variant: Variant, denied: string[]): Promise<BrowserContext> {
  const { width, height } = variants[variant];
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, locale: 'en-US', timezoneId: 'UTC', colorScheme: variants[variant].theme, reducedMotion: 'reduce' });
  await context.route('**/*', request => {
    if (new URL(request.request().url()).origin === origin) return request.continue();
    denied.push(request.request().url());
    return request.abort('blockedbyclient');
  });
  return context;
}

/** Steps the state's spec takes in the app after it mounts (a key, a click on a named control, a hover, typed words). */
async function perform(page: Page, step: Step): Promise<void> {
  if ('key' in step) await page.keyboard.press(step.key);
  else if ('click' in step) await page.getByRole('button', { name: step.click }).or(page.getByRole('tab', { name: step.click })).or(page.getByRole('menuitem', { name: step.click })).first().click();
  else if ('hover' in step) await page.locator(step.hover).first().hover();
  else await page.keyboard.type(step.type);
  await settle(page);
}

/** The app in the state's fixture, at the variant's size and the board's clock. */
async function renderApp(page: Page, origin: string, state: FinalState, variant: Variant): Promise<Buffer> {
  const { theme, width, height } = variants[variant];
  await page.clock.setFixedTime(finalNow);
  await page.setViewportSize({ width, height });
  await page.goto(`${origin}/tests/ui/design/final-gallery.html?${new URLSearchParams({ state: state.id, variant })}`);
  await page.waitForFunction(() => (window as { __designError?: string }).__designError || (document.getElementById('root')?.innerText.length ?? 0) > 40, null, { timeout: 60_000 });
  expect(await page.evaluate(() => (window as { __designError?: string }).__designError), 'the gallery mounted').toBeUndefined();
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  if (state.app.sessions?.connection !== 'loading') await expect(page.getByText(/^(Loading|Opening)\b/)).toHaveCount(0, { timeout: 30_000 });
  await settle(page);
  for (const step of state.app.act ?? []) await perform(page, step);
  await page.mouse.move(0, 0);
  return page.screenshot({ animations: 'disabled' });
}

/**
 * How a frame is scored. Without regions: the whole frame against its threshold. With regions (final-frames.ts `regions`): only the
 * state's regions that apply to this size, each against its own threshold; the whole frame's ratio is written, never asserted.
 * `recordOnly` (a pending state) asserts nothing and still writes every ratio.
 */
function scoring(state: Pick<FinalState, 'id' | 'regions'>, variant: Variant, recordOnly: boolean): Pick<CaptureInput, 'threshold' | 'regions' | 'regionThresholds'> & { report: (result: CompareResult) => object } {
  const scored = regionsFor(state, variant);
  if (!scored.length) return { threshold: recordOnly ? null : threshold(state.id, variant), report: () => ({}) };
  const limits = scored.map(region => recordOnly ? null : region.threshold ?? 0);
  return {
    threshold: null, regionThresholds: limits,
    regions: scored.map(({ name, rect: [x, y, width, height] }) => ({ name, x, y, width, height })),
    report: result => ({ regions: scored.map((region, at) => ({ name: region.name, rect: region.rect, ratio: Number(result.regions[at]!.toFixed(4)), threshold: limits[at] })) })
  };
}

for (const state of finalStates) for (const variant of variantNames) {
  test(`final ${state.id} ${variant}: ${state.title}`, async ({ browser, origin, board, page: canvas }, testInfo) => {
    testInfo.annotations.push({ type: 'pending', description: String(state.pending) });
    const id = `${state.id}-${variant}`, { width, height } = variants[variant], seen = board.denied.length;
    // A frame that cannot be drawn still leaves its JSON, with what the board asked for meanwhile: that is the evidence a timeout needs.
    const failed = (reason: string) => writeFileSync(resolve(output, 'frames', `${id}.json`), `${JSON.stringify({ pending: state.pending, owner: state.owner, size: { width, height }, failed: reason, denied: board.denied.slice(seen) }, null, 2)}\n`);
    const drawn = await renderBoard(board.context, origin, state, variant, board.denied).catch((error: unknown) => { failed(error instanceof Error ? error.message : String(error)); throw error; });
    const { png: design, denied: boardDenied } = drawn;
    // A frame the board failed to draw is blank or a placeholder; every state draws at least this many bytes of PNG.
    if (design.length <= 5_000) failed(`the board frame is ${design.length} bytes`);
    expect(design.length, 'the board frame is drawn').toBeGreaterThan(5_000);
    // Fields the fixture accepts but the current app cannot yet honour (see `unhonoured` in final-frames.ts): recorded in the frame's JSON.
    const notHonoured = unhonoured(state.app);
    if (state.pending && !compareAlways && !canary(state, variant)) {
      writeFileSync(resolve(output, `${id}-design.png`), design);
      writeFileSync(resolve(output, 'frames', `${id}.json`), `${JSON.stringify({ pending: true, owner: state.owner, size: { width, height }, unhonoured: notHonoured, denied: boardDenied }, null, 2)}\n`);
      // After the JSON: a frame whose board asked for something outside its files still leaves its evidence.
      expect(boardDenied, 'the board asked for nothing outside its own files').toEqual([]);
      return;
    }
    const denied: string[] = [], context = await appContext(browser, origin, variant, denied);
    try {
      const app = await renderApp(await context.newPage(), origin, state, variant);
      const { report, ...score } = scoring(state, variant, state.pending);
      await captureFrame(canvas, { id, design, app, directory: output, ...score,
        report: result => ({ pending: state.pending, owner: state.owner, size: { width: result.width, height: result.height }, unhonoured: notHonoured, ...report(result) }),
        denied: [...boardDenied, ...denied] });
    } finally { await context.close(); }
  });
}

// The font route serves the six files fonts.css names, byte-checked against their pins, and nothing else: the board is untrusted,
// so a request that names anything outside them (`..` segments, encoded or not, a folder, another file) is refused.
const fontNames = ['..%2f..%2f..%2fpackage.json', '..%2fpackage.json', '%2e%2e%2f%2e%2e%2f%2e%2e%2fpackage.json', '..%2ficons%2fPhosphor.woff2',
  'fonts%2f..%2f..%2fpackage.json', '..%5c..%5c..%5cpackage.json', '%2fetc%2fhosts', 'Phosphor.woff2%00', 'phosphor.woff2', 'phosphor.css', 'jetbrains-mono.css'];
test('font route: the pinned names are exactly the ones fonts.css names, and their bytes match', async () => {
  const named = [...finalMembers()['ariadne-ds/fonts/fonts.css']!.matchAll(/url\("\.\/([^"]+)"\)/g)].map(match => match[1]!).sort();
  expect(Object.keys(fontPins).sort()).toEqual([...new Set(named)]);
  for (const name of Object.keys(fontPins)) expect(fontFile(name)?.length, name).toBeGreaterThan(1000);
});
test('font route: a name outside the six fonts is refused', async ({ origin, board }) => {
  for (const name of ['../../../package.json', '../package.json', '../icons/Phosphor.woff2', 'fonts/../../package.json', '/etc/hosts', '..\\..\\package.json', 'Phosphor.woff2\0']) expect(fontFile(name), name).toBeUndefined();
  const page = await board.context.newPage();
  try {
    await page.goto(`${origin}/final/ariadne-ds/styles.css`);
    const status = (path: string) => page.evaluate(async url => (await fetch(url)).status, `${origin}/final/${path}`);
    for (const name of fontNames) expect(await status(`ariadne-ds/fonts/${name}`), name).toBe(404);
    expect(await status('ariadne-ds/fonts/Phosphor.woff2'), 'a pinned font is served').toBe(200);
  } finally { await page.close(); }
});

// The board is untrusted and its renders are published, so its context reaches nothing but its own files. Each test builds its own
// context and record, so what it provokes does not land in the worker's record that the render tests assert on.
test('board context: a request to the dev server outside /final/ is answered 404 and recorded', async ({ boardBrowser, origin }) => {
  const denied: string[] = [], context = await boardContext(boardBrowser, origin, denied);
  try {
    const page = await context.newPage();
    await page.goto(`${origin}/final/ariadne-ds/styles.css`);
    const status = (url: string) => page.evaluate(async target => (await fetch(target)).status, url);
    expect(await status(`${origin}/final/ariadne-ds/styles.css`), 'a board file is served').toBe(200);
    expect(denied, 'a board file is not a denied request').toEqual([]);
    const outside = ['/package.json', '/apps/desktop/package.json', '/tests/ui/design/server.mts', '/@fs/etc/hosts', '/final'].map(path => `${origin}${path}`);
    for (const url of outside) expect(await status(url), url).toBe(404);
    expect(denied).toEqual(outside);
    // A malformed escape and a directory are answered too (they used to throw in the route and leave the request hanging), and recorded.
    const unanswered = ['/final/%zz', '/final/ariadne-ds/', '/final/ariadne-ds'].map(path => `${origin}${path}`);
    for (const url of unanswered) expect(await status(url), url).toBe(404);
    expect(denied.slice(outside.length), 'the unanswerable requests are recorded').toEqual(unanswered);
    // Another origin is refused. The CSP (`connect-src 'self'`) stops the fetch before a route sees it, so its violation report is what is recorded.
    expect(await page.evaluate(async url => fetch(url).then(() => 'fetched', () => 'blocked'), 'http://example.invalid/x')).toBe('blocked');
    await expect.poll(() => denied.at(-1), 'the refused fetch is recorded').toBe(`${origin}${cspReportPath}`);
    // A page with no CSP (about:blank) reaches the route, which blocks and records the URL itself.
    const bare = await context.newPage();
    expect(await bare.evaluate(async url => fetch(url).then(() => 'fetched', () => 'blocked'), 'http://example.invalid/y')).toBe('blocked');
    expect(denied.at(-1)).toBe('http://example.invalid/y');
  } finally { await context.close(); }
});
test('board context: a WebSocket is closed and recorded, and no service worker can be registered', async ({ boardBrowser, origin }) => {
  const denied: string[] = [], context = await boardContext(boardBrowser, origin, denied);
  try {
    const page = await context.newPage();
    await page.goto(`${origin}/final/ariadne-ds/styles.css`);
    const socket = `${origin.replace('http', 'ws')}/socket`;
    const ended = await page.evaluate(url => new Promise<string>(done => {
      const attempt = new WebSocket(url), timer = setTimeout(() => done('still open'), 10_000);
      attempt.onclose = () => { clearTimeout(timer); done('closed'); };
    }), socket);
    expect(ended, 'the socket is closed').toBe('closed');
    expect(denied, 'the socket is recorded').toEqual([socket]);
    // Playwright's own block replaces `register` with a no-op that script can undo, so the original is called too.
    const attempts = await page.evaluate(async () => {
      if (!('serviceWorker' in navigator)) return { api: false, original: '', registrations: -1 };
      const original = await ServiceWorkerContainer.prototype.register.call(navigator.serviceWorker, '/final/support.js').then(() => 'registered', (error: Error) => `refused: ${error.name}`);
      await navigator.serviceWorker.register('/final/support.js');
      return { api: true, original, registrations: (await navigator.serviceWorker.getRegistrations()).length };
    });
    expect(attempts, 'no service worker is registered, by either route').toEqual({ api: true, original: 'refused: SecurityError', registrations: 0 });
  } finally { await context.close(); }
});

// Playwright's WebSocket block is a replacement class in the page, and board script can reach past it: `_apiConnect()` on the replacement
// opens a real socket, and so does `_ws.constructor`. These tests start a real WebSocket server and require that none of those attempts
// reaches it. Two layers hold: the board files' CSP (`connect-src 'self'`), and the browser's resolver rules (every host but 127.0.0.1).
interface WebSocketMock { _apiConnect(): void; _ws: WebSocket }
/** A WebSocket server on the loopback address that counts every connection made to it, a TCP connection included. */
async function listening(run: (port: number, connections: () => number) => Promise<void>): Promise<void> {
  let count = 0;
  const server = createServer().on('connection', socket => { count++; socket.destroy(); });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  try { await run((server.address() as AddressInfo).port, () => count); } finally { await new Promise(done => server.close(done)); }
}
/** Opens real sockets to `url` from the page, by every route round the replacement; resolves when all are closed (or after 10 s). */
const reachPast = (page: Page, url: string) => page.evaluate(target => new Promise<string>(done => {
  const mock = new WebSocket(target) as unknown as WebSocketMock;
  mock._apiConnect();
  const direct = new (mock._ws.constructor as typeof WebSocket)(target), sockets = [mock._ws, direct];
  const timer = setInterval(() => {
    if (sockets.some(socket => socket.readyState !== WebSocket.CLOSED)) return;
    clearInterval(timer); done('closed');
  }, 50);
  setTimeout(() => { clearInterval(timer); done('still open'); }, 10_000);
}), url);

test('board context: board script cannot open a real WebSocket past the replacement (CSP)', async ({ boardBrowser, origin }) => {
  const denied: string[] = [], context = await boardContext(boardBrowser, origin, denied);
  try {
    await listening(async (port, connections) => {
      const page = await context.newPage();
      await page.goto(`${origin}/final/ariadne-ds/styles.css`);
      expect(await reachPast(page, `ws://127.0.0.1:${port}/`), 'both attempts end').toBe('closed');
      await page.waitForTimeout(500);
      expect(connections(), 'the server was never reached').toBe(0);
      expect(denied, 'the refusal is recorded').toContain(`${origin}${cspReportPath}`);
    });
  } finally { await context.close(); }
});
test('board context: a page without the CSP still reaches no host but the loopback (resolver rules)', async ({ boardBrowser, origin }) => {
  const context = await boardContext(boardBrowser, origin, []);
  try {
    await listening(async (port, connections) => {
      // about:blank carries no CSP. The loopback address is excluded from the rules (the board is served from it), so the control reaches
      // the server: the attempts work, and only the CSP stands between a board file and the loopback.
      const page = await context.newPage();
      await reachPast(page, `ws://127.0.0.1:${port}/`);
      await expect.poll(connections, 'the control reaches the server').toBeGreaterThan(0);
      const before = connections();
      // Every other name does not resolve, though it would lead to the same server (localhost is 127.0.0.1).
      expect(await reachPast(page, `ws://localhost:${port}/`), 'both attempts end').toBe('closed');
      await page.waitForTimeout(500);
      expect(connections(), 'a name other than 127.0.0.1 reaches nothing').toBe(before);
    });
  } finally { await context.close(); }
});
test('board context: WebRTC sends no UDP of its own (STUN)', async ({ boardBrowser, origin }) => {
  const context = await boardContext(boardBrowser, origin, []), packets: number[] = [];
  const udp = createSocket('udp4').on('message', message => packets.push(message.length));
  await new Promise<void>(done => udp.bind(0, '127.0.0.1', done));
  try {
    const page = await context.newPage();
    await page.goto(`${origin}/final/ariadne-ds/styles.css`);
    // The offer is gathered against a STUN server on the loopback: with the browser's default policy it is sent a binding request.
    await page.evaluate(async port => {
      const peer = new RTCPeerConnection({ iceServers: [{ urls: `stun:127.0.0.1:${port}` }] });
      peer.createDataChannel('probe');
      await peer.setLocalDescription(await peer.createOffer());
      await new Promise(done => setTimeout(done, 3000));
      peer.close();
    }, udp.address().port);
    expect(packets, 'no STUN request reached the server').toEqual([]);
  } finally { udp.close(); await context.close(); }
});

// A frame whose render asked for something it may not leaves its evidence: the report carries `denied`, and the assertion comes after.
/** A white PNG with black squares ([x, y, width, height]), drawn in the browser. */
async function picture(page: Page, width: number, height: number, squares: readonly (readonly [number, number, number, number])[] = []): Promise<Buffer> {
  const base64 = await page.evaluate(({ width, height, squares }) => {
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d')!; context.fillStyle = '#fff'; context.fillRect(0, 0, width, height);
    context.fillStyle = '#000'; for (const [x, y, w, h] of squares) context.fillRect(x, y, w, h);
    return canvas.toDataURL('image/png').split(',')[1]!;
  }, { width, height, squares });
  return Buffer.from(base64, 'base64');
}
/** A scratch output folder with the `frames` folder captureFrame writes to, outside coverage/ so teardown does not gather it. */
async function inScratch(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(resolve(tmpdir(), 'final-spec-'));
  mkdirSync(resolve(directory, 'frames'));
  try { await run(directory); } finally { rmSync(directory, { recursive: true, force: true }); }
}
const frameJson = (directory: string, id: string) => JSON.parse(readFileSync(resolve(directory, 'frames', `${id}.json`), 'utf8')) as Record<string, unknown>;

test('frame report: denied requests are written into the JSON, then the capture fails', async ({ page: canvas }) => {
  await inScratch(async directory => {
    const same = await picture(canvas, 20, 20), url = 'http://127.0.0.1:1/package.json';
    await expect(captureFrame(canvas, { id: 'dirty', design: same, app: same, directory, threshold: 0, denied: [url] })).rejects.toThrow(/nothing outside the allowed files/);
    expect(frameJson(directory, 'dirty').denied, 'the evidence is in the JSON').toEqual([url]);
    for (const file of ['dirty-design.png', 'dirty-app.png', 'dirty-diff.png']) expect(existsSync(resolve(directory, file)), file).toBe(true);
    await captureFrame(canvas, { id: 'clean', design: same, app: same, directory, threshold: 0, denied: [] });
    expect(frameJson(directory, 'clean').denied).toEqual([]);
    await captureFrame(canvas, { id: 'unwatched', design: same, app: same, directory, threshold: 0 });
    expect(frameJson(directory, 'unwatched'), 'a frame that tracks no requests has no key').not.toHaveProperty('denied');
  });
});

// Regions: the app is compared only in the named rectangles. The design is a white 100 x 100 frame; the app has a 10 x 10 black square at
// (5, 5): 1% of the frame, 25% of the 20 x 20 region that holds it, and in no other region below.
type ScoringCase = { name: string; regions: FinalState['regions']; variant: Variant; recordOnly?: boolean; passes: boolean; ratios?: number[]; whole: number | null };
const scoringCases: readonly ScoringCase[] = [
  { name: 'no regions: the whole frame is asserted (1% > 0)', regions: undefined, variant: 'light', passes: false, whole: 0 },
  { name: 'a region away from the square passes while the whole frame differs', regions: [{ name: 'quiet', rect: [50, 50, 20, 20] }], variant: 'light', passes: true, ratios: [0], whole: null },
  { name: 'a region on the square must match exactly by default', regions: [{ name: 'busy', rect: [0, 0, 20, 20] }], variant: 'light', passes: false, ratios: [0.25], whole: null },
  { name: 'a region passes at its own threshold', regions: [{ name: 'busy', rect: [0, 0, 20, 20], threshold: 0.25 }], variant: 'light', passes: true, ratios: [0.25], whole: null },
  { name: 'a region fails just over its threshold', regions: [{ name: 'busy', rect: [0, 0, 20, 20], threshold: 0.2 }], variant: 'light', passes: false, ratios: [0.25], whole: null },
  { name: 'one bad region fails the frame', regions: [{ name: 'quiet', rect: [50, 50, 20, 20] }, { name: 'busy', rect: [0, 0, 20, 20] }], variant: 'light', passes: false, ratios: [0, 0.25], whole: null },
  { name: 'regions of other sizes do not apply: the whole frame is asserted', regions: [{ name: 'quiet', rect: [50, 50, 20, 20], variants: ['dark'] }], variant: 'light', passes: false, whole: 0 },
  { name: 'a region that applies to this size is the only thing asserted', regions: [{ name: 'quiet', rect: [50, 50, 20, 20], variants: ['dark'] }], variant: 'dark', passes: true, ratios: [0], whole: null },
  { name: 'record only: nothing is asserted, the ratio is written', regions: [{ name: 'busy', rect: [0, 0, 20, 20] }], variant: 'light', recordOnly: true, passes: true, ratios: [0.25], whole: null }
];
for (const { name, regions, variant, recordOnly, passes, ratios, whole } of scoringCases) {
  test(`frame regions: ${name}`, async ({ page: canvas }) => {
    await inScratch(async directory => {
      const design = await picture(canvas, 100, 100), app = await picture(canvas, 100, 100, [[5, 5, 10, 10]]);
      const score = scoring({ id: 'self-test', regions }, variant, recordOnly ?? false), { report, ...input } = score;
      const capture = captureFrame(canvas, { id: 'scored', design, app, directory, ...input, report });
      if (passes) await capture; else await expect(capture).rejects.toThrow(/mismatch ratio/);
      const saved = frameJson(directory, 'scored');
      expect(saved.threshold, 'the whole frame threshold').toBe(whole);
      expect((saved.regions as { ratio: number }[] | undefined)?.map(region => region.ratio)).toEqual(ratios);
    });
  });
}
test('final-frames: every region is a whole-pixel rectangle inside the frames it applies to, with a threshold of at least 0 and below 1', () => {
  for (const state of finalStates) {
    const names = (state.regions ?? []).map(region => region.name);
    expect(new Set(names).size, `${state.id} region names are distinct`).toBe(names.length);
    for (const region of state.regions ?? []) {
      const [x, y, width, height] = region.rect;
      expect([x, y, width, height].every(Number.isInteger) && x >= 0 && y >= 0 && width > 0 && height > 0, `${state.id} ${region.name} is a whole-pixel rectangle`).toBe(true);
      for (const variant of region.variants ?? variantNames) expect(x + width <= variants[variant].width && y + height <= variants[variant].height, `${state.id} ${region.name} fits ${variant}`).toBe(true);
      // A threshold is a share of the region's pixels: below 0 or from 1 up it would assert nothing (or nothing can fail).
      expect(region.threshold === undefined || (region.threshold >= 0 && region.threshold < 1), `${state.id} ${region.name} threshold is at least 0 and below 1`).toBe(true);
    }
  }
});

// `unhonoured` reads the values a state sets against a list of values, one entry each: turning one on must not hide the others.
test('unhonoured: each value is flagged on its own and removing one leaves the rest', () => {
  for (const overlay of notYet.overlay) expect(unhonoured({ chrome: { overlay } }), overlay).toEqual([`chrome.overlay=${overlay}`]);
  for (const connection of notYet.connection) expect(unhonoured({ sessions: { connection } }), connection).toEqual([`sessions.connection=${connection}`]);
  expect(unhonoured({ sessions: { connection: 'live' } }), 'live needs nothing').toEqual([]);
  const withoutHelpKeys = { ...notYet, overlay: notYet.overlay.filter(overlay => overlay !== 'help-keys') };
  expect(unhonoured({ chrome: { overlay: 'help-keys' } }, withoutHelpKeys)).toEqual([]);
  expect(unhonoured({ chrome: { overlay: 'help-marks' } }, withoutHelpKeys)).toEqual(['chrome.overlay=help-marks']);
  expect(unhonoured({ chrome: { overlay: 'switcher' }, sessions: { connection: 'stale' } }, withoutHelpKeys)).toEqual(['chrome.overlay=switcher', 'sessions.connection=stale']);
});

// The loader is deterministic: a state rendered twice in one worker matches to the last compared pixel (differences up to the
// comparison's tolerance of 16 per channel do not count; none is expected). Run with --repeat-each=10 on 2026-10-17: 50 of 50.
for (const [id, variant] of [['1.2', 'light'], ['2.1', 'dark'], ['3.2', 'narrow'], ['12.2', 'light'], ['14.1', 'narrow']] as const) {
  test(`determinism ${id} ${variant}`, async ({ origin, board, page: canvas }) => {
    const state = finalStates.find(value => value.id === id)!;
    const first = await renderBoard(board.context, origin, state, variant, board.denied), second = await renderBoard(board.context, origin, state, variant, board.denied);
    const result = await captureFrame(canvas, { id: `determinism-${id}-${variant}`, design: first.png, app: second.png, directory: output, threshold: 0, denied: [...first.denied, ...second.denied] });
    expect(result.ratio).toBe(0);
  });
}

// The loader's self-check: the local render of the board against the Claude Design screenshots (shots/NN-screen-SS-state-<size>.png,
// each with a label above the frame). Runs where the screenshots are (set ARIADNE_FINAL_SHOTS to move them); CI has none and skips it.
/**
 * Exactly: no pixel of the frame may differ by more than the comparison's tolerance. Measured 2026-10-17: every checked state
 * (all 112 not skipped, at every size, three runs) matched at 0, and the five determinism pairs matched in 10 repeats each. A 0.02% allowance
 * once stood here for "anti-aliasing flips"; it hid nothing real, and a renderer change should fail this test, not slip under it.
 */
const selfCheckThreshold = 0;
const shots = process.env.ARIADNE_FINAL_SHOTS ?? resolve(homedir(), 'Documents/Code/ariadne-mocks/final-design/shots');
// Twelve states across the screens by default; FINAL_SELFCHECK=all checks every registered state at every size.
const selfCheck: readonly (readonly [string, Variant])[] = process.env.FINAL_SELFCHECK === 'all'
  ? finalStates.flatMap(state => variantNames.map(variant => [state.id, variant] as const))
  : [['1.1', 'light'], ['1.3', 'dark'], ['2.1', 'light'], ['2.5', 'dark'], ['2.9', 'narrow'], ['3.6', 'light'], ['12.3', 'light'], ['12.7', 'dark'],
    ['13.1', 'dark'], ['14.2', 'narrow'], ['15.1', 'light'], ['16.2', 'light']];
const shotFor = (id: string, variant: Variant): string | undefined => {
  const [screen, step] = id.split('.').map(part => part.padStart(2, '0'));
  return existsSync(shots) ? readdirSync(shots).find(name => name.startsWith(`${screen}-`) && name.includes(`-${step}-`) && name.endsWith(`-${variants[variant].shot}.png`)) : undefined;
};
/** Shots captured mid-scroll: the Map in the shot is scrolled to another place than a fresh render of the board, so they cannot be compared. Skipped, with the reason. */
const midScroll: ReadonlySet<string> = new Set(['2.6 light', '2.6 dark', '2.6 narrow', '3.1 light', '3.1 dark']);
/** What a shot shows and a fresh render cannot, masked out of the comparison: 2.1 light and 3.1 narrow carry the "Back to ..." pill that only appears after a real scroll. */
const staleInShot: Readonly<Record<string, readonly Region[]>> = {
  '2.1 light': [{ name: 'Back to pill', x: 512, y: 87, width: 256, height: 40 }],
  '3.1 narrow': [{ name: 'Back to pill', x: 170, y: 86, width: 220, height: 40 }]
};
for (const [id, variant] of selfCheck) {
  test(`selfcheck ${id} ${variant}`, async ({ origin, board, page: canvas }) => {
    test.skip(midScroll.has(`${id} ${variant}`), `the Claude Design shot of ${id} ${variant} was captured mid-scroll: its Map is scrolled to another place than a fresh render`);
    const file = shotFor(id, variant);
    test.skip(!file, `no Claude Design screenshot for ${id} ${variant} in ${shots}`);
    const state = finalStates.find(value => value.id === id)!;
    const seen = board.denied.length;
    const opened = await openBoard(board.context, origin, state.part, state.sid, variant);
    const local = await boardFrame(opened, variant).finally(() => opened.close()), { width, height } = variants[variant];
    const reference = await crop(canvas, readFileSync(resolve(shots, file!)), { x: 0, y: labelHeight, width, height });
    const result = await captureFrame(canvas, { id: `selfcheck-${id}-${variant}`, design: reference, app: local, directory: output,
      threshold: selfCheckThreshold, masks: staleInShot[`${id} ${variant}`], report: () => ({ shot: file }), denied: board.denied.slice(seen) });
    expect(result.height).toBe(height);
  });
}
