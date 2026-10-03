import { coverageConfigDefaults, defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const e2e = process.env.VITE_ARIADNE_E2E === '1';
const output = resolve(root, e2e ? '../../target/native-e2e/desktop-dist' : '../../target/desktop-dist');
export default defineConfig({
  root,
  plugins: [react(), {
    name: 'ariadne-module-evidence',
    async generateBundle(_options, bundle) {
      const chunks = Object.values(bundle).filter(item => item.type === 'chunk').map(chunk => ({
        file: chunk.fileName,
        sha256: createHash('sha256').update(chunk.code).digest('hex'),
        modules: Object.keys(chunk.modules),
      }));
      const inventory = resolve(root, e2e ? '../../target/native-e2e/desktop-modules.json' : '../../target/desktop-modules.json');
      await mkdir(dirname(inventory), { recursive: true });
      await writeFile(inventory, JSON.stringify({ output, generatedAt: Date.now(), chunks }, null, 2));
    },
  }],
  clearScreen: false,
  server: { port: 1420, strictPort: true, host: process.env.TAURI_DEV_HOST || false, watch: { ignored: ['**/src-tauri/**'] } },
  build: { outDir: output, emptyOutDir: true },
  test: {
    environment: 'jsdom',
    projects: [
      { test: { name: 'desktop', environment: 'jsdom', include: ['tests/ui/**/*.test.tsx'] } },
      { test: { name: 'reference', environment: 'node', include: [resolve(root, '../../tests/ui/reference/**/*.test.ts')] } },
    ],
    coverage: { provider: 'v8', include: ['src/**/*.{ts,tsx}'], exclude: [...coverageConfigDefaults.exclude, '**/generated/**'], reporter: [['lcov', { projectRoot: resolve(root, '../..') }], 'text'], reportsDirectory: resolve(root, '../../coverage/web') },
  },
});
