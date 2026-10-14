import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { createServer, type ViteDevServer } from 'vite';
import { repo } from './source.mts';

const gallery = '/tests/ui/design/gallery.tsx';

/**
 * Starts the Vite dev server that serves the gallery app and warms it: the dependency scan starts from
 * the gallery alone (not every html file under the repo), and the gallery's whole import graph is
 * transformed before this resolves. Without that, the first test a worker runs paid for the cold
 * transform and dependency optimisation inside its 60 s render wait, which a slow CI runner exceeded.
 */
export async function startDesignServer(): Promise<{ server: ViteDevServer; origin: string }> {
  const server = await createServer({ configFile: false, root: repo, publicDir: resolve(repo, 'apps/desktop/public'), plugins: [react()], logLevel: 'error',
    optimizeDeps: { entries: [resolve(repo, 'tests/ui/design/gallery.html')] },
    server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false } });
  try {
    await server.listen();
    const address = server.httpServer?.address();
    if (!address || typeof address === 'string') throw new Error('Missing design server address');
    await server.warmupRequest(gallery);
    await server.waitForRequestsIdle();
    return { server, origin: `http://127.0.0.1:${address.port}` };
  } catch (error) { await server.close(); throw error; }
}
