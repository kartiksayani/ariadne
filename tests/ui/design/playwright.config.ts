import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';

// No ambient/global browser cache: CI explicitly provisions this pinned package's
// Chromium revision into the ignored task directory before running the harness.
process.env.PLAYWRIGHT_BROWSERS_PATH = resolve('target/reference-browser');
export default defineConfig({
  testDir: '.', testMatch: 'design.spec.mts', workers: 2, retries: 0, timeout: 240_000,
  globalSetup: './setup.mts', globalTeardown: './teardown.mts',
  outputDir: '../../../coverage/design/results',
  reporter: [['list'], ['html', { outputFolder: resolve('coverage/design/playwright'), open: 'never' }]],
  use: { browserName: 'chromium', deviceScaleFactor: 1, locale: 'en-US', timezoneId: 'UTC', colorScheme: 'dark', reducedMotion: 'reduce', trace: 'retain-on-failure' },
  projects: [
    { name: 'design' },
    { name: 'graph-2000', testDir: resolve('tests/e2e/graph'), testMatch: '*.spec.mts', use: { viewport: { width: 1000, height: 700 } } },
    { name: 'owner-input-layout', testDir: resolve('tests/e2e/owner-input'), testMatch: '*.spec.mts', use: { viewport: { width: 1000, height: 700 } } },
  ],
});
