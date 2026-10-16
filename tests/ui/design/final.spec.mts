// The final-board project (playwright.config.ts `final`): every registered state (final-frames.ts) is drawn by the board
// (designs/Ariadne-final-board.zip, offline) and, once its `pending` flag is off, by the real app in the matching fixture,
// and the two are compared pixel for pixel against final-thresholds.json. See README.md in this folder.
import { test as base, expect, type BrowserContext, type Page } from '@playwright/test';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { captureFrame, crop, type Region } from './compare.mts';
import { boardContext, boardFrame, labelHeight, openBoard, renderBoard, settle } from './final-board.mts';
import { finalNow, finalStates, unhonoured, variantNames, variants, type FinalState, type Step, type Variant } from './final-frames';
import { finalMembers, fontFile, fontPins, runtimeHashes } from './final-source.mts';
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
const test = base.extend<Record<never, never>, { origin: string; board: Board }>({
  origin: [async ({ browserName }, use) => {
    expect(browserName).toBe('chromium');
    // The board's support.js checks SRI on its CDN scripts; the same pinned bytes are served offline.
    for (const { url, expected, actual } of runtimeHashes(finalMembers()['support.js']!)) expect(actual, url).toBe(expected);
    // Warmed before the first test, so no test pays the cold transform inside its render wait.
    const { server, origin } = await startDesignServer();
    try { await use(origin); } finally { await server.close(); }
  }, { scope: 'worker', timeout: 240_000 }],
  board: [async ({ browser, origin }, use) => {
    const denied: string[] = [], context = await boardContext(browser, origin, denied);
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
async function renderApp(page: Page, origin: string, state: FinalState, variant: Variant, denied: readonly string[]): Promise<Buffer> {
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
  expect(denied, 'the app asked for nothing outside the dev server').toEqual([]);
  return page.screenshot({ animations: 'disabled' });
}

for (const state of finalStates) for (const variant of variantNames) {
  test(`final ${state.id} ${variant}: ${state.title}`, async ({ browser, origin, board, page: canvas }, testInfo) => {
    testInfo.annotations.push({ type: 'pending', description: String(state.pending) });
    const seen = board.denied.length;
    const design = await renderBoard(board.context, origin, state, variant, board.denied);
    expect(board.denied.slice(seen), 'the board asked for nothing outside its own files').toEqual([]);
    // A frame the board failed to draw is blank or a placeholder; every state draws at least this many bytes of PNG.
    expect(design.length, 'the board frame is drawn').toBeGreaterThan(5_000);
    const id = `${state.id}-${variant}`, { width, height } = variants[variant];
    // Fields the fixture accepts but the current app cannot yet honour (see `unhonoured` in final-frames.ts): recorded in the frame's JSON.
    const notHonoured = unhonoured(state.app);
    if (state.pending && !compareAlways && !canary(state, variant)) {
      writeFileSync(resolve(output, `${id}-design.png`), design);
      writeFileSync(resolve(output, 'frames', `${id}.json`), `${JSON.stringify({ pending: true, owner: state.owner, size: { width, height }, unhonoured: notHonoured }, null, 2)}\n`);
      return;
    }
    const denied: string[] = [], context = await appContext(browser, origin, variant, denied);
    try {
      const app = await renderApp(await context.newPage(), origin, state, variant, denied);
      await captureFrame(canvas, { id, design, app, directory: output, threshold: state.pending ? null : threshold(state.id, variant),
        report: result => ({ pending: state.pending, owner: state.owner, size: { width: result.width, height: result.height }, unhonoured: notHonoured }) });
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

// The loader is deterministic: a state rendered twice in one worker matches to the last compared pixel (differences up to the
// comparison's tolerance of 16 per channel do not count; none is expected). Run with --repeat-each=10 on 2026-10-17: 50 of 50.
for (const [id, variant] of [['1.2', 'light'], ['2.1', 'dark'], ['3.2', 'narrow'], ['12.2', 'light'], ['14.1', 'narrow']] as const) {
  test(`determinism ${id} ${variant}`, async ({ origin, board, page: canvas }) => {
    const state = finalStates.find(value => value.id === id)!;
    const first = await renderBoard(board.context, origin, state, variant, board.denied), second = await renderBoard(board.context, origin, state, variant, board.denied);
    const result = await captureFrame(canvas, { id: `determinism-${id}-${variant}`, design: first, app: second, directory: output, threshold: 0 });
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
    const opened = await openBoard(board.context, origin, state.part, state.sid, variant);
    const local = await boardFrame(opened, variant).finally(() => opened.close()), { width, height } = variants[variant];
    const reference = await crop(canvas, readFileSync(resolve(shots, file!)), { x: 0, y: labelHeight, width, height });
    const result = await captureFrame(canvas, { id: `selfcheck-${id}-${variant}`, design: reference, app: local, directory: output,
      threshold: selfCheckThreshold, masks: staleInShot[`${id} ${variant}`], report: () => ({ shot: file }) });
    expect(result.height).toBe(height);
  });
}
