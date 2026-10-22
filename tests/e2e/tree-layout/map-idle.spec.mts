// The Map stops redrawing while idle (alpha.23 F6). On a 2,000-item session nothing the owner sees changes while the agent is quiet,
// so the polls and the host's heartbeats (each a presence publish) draw no item row again; a row click redraws the rows it changed,
// plus at most the two redraws of every row while the selection's view write saves (accepted, F6e).
//
// The counter is React's development hook, installed before the app loads. It counts renders, not the fibers a commit walks past:
// a component that bailed out keeps its old fiber, flags and all, in the committed tree, so a fiber counts only the first time it is
// seen with its "performed work" flag, and seeing it (or its alternate) without the flag forgets it.
import { test, expect, type Page } from '@playwright/test';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import type { Server } from 'node:http';

interface Counts { ItemRow: number; TreeView: number }

async function serve(run: (origin: string) => Promise<void>) {
  const server = await createServer({ configFile: false, root: resolve('.'), publicDir: resolve('apps/desktop/public'), plugins: [react()],
    logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false } });
  try {
    await server.listen();
    const address = (server.httpServer as Server).address();
    if (!address || typeof address === 'string') throw new Error('Missing layout fixture server address');
    await run(`http://127.0.0.1:${address.port}`);
  } finally { await server.close(); }
}

function counter() {
  type Fiber = { tag: number; type: unknown; flags: number; alternate: Fiber | null; child: Fiber | null; sibling: Fiber | null };
  const PERFORMED_WORK = 1, counted = new WeakSet<Fiber>(), counts = { ItemRow: 0, TreeView: 0 };
  const name = (fiber: Fiber) => typeof fiber.type === 'function' ? (fiber.type as { name?: string }).name : undefined;
  const rendered = (fiber: Fiber) => {
    if (!(fiber.flags & PERFORMED_WORK)) { counted.delete(fiber); if (fiber.alternate) counted.delete(fiber.alternate); return false; }
    if (counted.has(fiber)) return false;
    counted.add(fiber); if (fiber.alternate) counted.delete(fiber.alternate);
    return true;
  };
  const walk = (root: Fiber | null) => {
    const stack: Fiber[] = root ? [root] : [];
    while (stack.length) {
      const fiber = stack.pop()!, kind = name(fiber);
      if ((kind === 'ItemRow' || kind === 'TreeView') && rendered(fiber)) counts[kind]++;
      if (fiber.sibling) stack.push(fiber.sibling);
      if (fiber.child) stack.push(fiber.child);
    }
  };
  const none = () => {};
  (window as unknown as { __REACT_DEVTOOLS_GLOBAL_HOOK__: unknown }).__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true, isDisabled: false, renderers: new Map(), inject: () => 1, checkDCE: none, setStrictMode: none,
    onScheduleFiberRoot: none, onCommitFiberUnmount: none, onPostCommitFiberRoot: none,
    onCommitFiberRoot: (_id: number, root: { current: Fiber }) => { walk(root.current); },
  };
  (window as unknown as { renders: Counts }).renders = counts;
}
const counts = (page: Page) => page.evaluate(() => ({ ...(window as unknown as { renders: Counts }).renders }));
const heartbeat = (page: Page) => page.evaluate(() => (window as unknown as { treeLayout: { agent(change: string): void } }).treeLayout.agent('heartbeat'));
const reset = (page: Page) => page.evaluate(() => { const renders = (window as unknown as { renders: Counts }).renders; renders.ItemRow = 0; renders.TreeView = 0; });

test('an idle 2,000-item Map redraws no row, and a click redraws only what it changed', async ({ page }) => {
  test.setTimeout(120_000);
  await page.addInitScript(counter);
  await serve(async origin => {
    await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort('blockedbyclient'));
    await page.goto(`${origin}/tests/e2e/tree-layout/fixture.html?many`);
    await page.locator('[data-popover-trigger="switcher"]').click();
    await page.getByRole('dialog', { name: 'Switch session or project' }).getByRole('button', { name: 'All sessions' }).click();
    const session = page.locator('button[data-session-id]').first();
    await expect(session).toBeEnabled(); await session.click();
    const tree = page.getByRole('region', { name: 'Session tree' }), rows = page.locator('[role="treeitem"][data-item-id]');
    await expect(tree).toHaveAttribute('data-session-busy', 'false', { timeout: 30_000 });
    await expect.poll(() => rows.count(), { timeout: 30_000 }).toBeGreaterThan(2000);
    const shown = await rows.count();
    // Settled: the opening reads, the first polls and the fonts are done, and the host has reported the agent quiet (its first
    // heartbeat, which can change a delivery line that waited for a busy agent).
    await heartbeat(page);
    await page.waitForTimeout(3000);
    // 5 s idle: the session polls every 2 s and, as a running agent's host does, reports a heartbeat each second.
    await reset(page);
    for (let second = 0; second < 5; second++) { await heartbeat(page); await page.waitForTimeout(1000); }
    const idle = await counts(page);
    console.log(`map-idle: ${shown} rows; 5 s idle: ${idle.ItemRow} ItemRow renders, ${idle.TreeView} TreeView commits`);
    expect(idle.ItemRow).toBe(0);

    // One click on a row near the top of its topic: the old and new selection and the rows the selection thread crosses change,
    // and every row redraws at most twice more while the selection's view write saves (F6e).
    await reset(page);
    const target = page.locator('[role="treeitem"][data-item-id="9"]'), started = Date.now();
    await target.click();
    await expect(page.locator('[data-detail-item-id="9"]')).toBeVisible({ timeout: 15_000 });
    const opened = Date.now() - started;
    await page.waitForTimeout(2000);
    const click = await counts(page);
    console.log(`map-idle: click to Details ${opened} ms; ${click.ItemRow} ItemRow renders, ${click.TreeView} TreeView commits`);
    expect(click.ItemRow).toBeGreaterThan(0);
    expect(click.ItemRow).toBeLessThanOrEqual(2 * shown + 40);
    await expect(target).toHaveAttribute('aria-selected', 'true');
  });
});
