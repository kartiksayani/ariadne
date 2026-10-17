import type { Page } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import type { Server } from 'node:http';

/** Serves the repository with Vite for a Graph fixture page; every other origin is blocked. */
export async function serve(page: Page): Promise<{ readonly origin: string; readonly server: ViteDevServer }> {
  const repo = resolve('.');
  const server = await createServer({ configFile: false, root: repo, publicDir: resolve('apps/desktop/public'), plugins: [react()],
    logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false } });
  await server.listen(); const address = (server.httpServer as Server).address();
  if (!address || typeof address === 'string') throw new Error('Missing graph fixture server address');
  const origin = `http://127.0.0.1:${address.port}`;
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort('blockedbyclient'));
  return { origin, server };
}

/** Two frames: React's commit, layout effects and the resize observers they trigger have all run. */
export const settle = (page: Page) => page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
