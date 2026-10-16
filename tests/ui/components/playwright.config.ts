import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';

// The same pinned Chromium as the design harness (target/reference-browser), run from the repo root.
process.env.PLAYWRIGHT_BROWSERS_PATH = resolve('target/reference-browser');
export default defineConfig({
  testDir: '.', testMatch: 'components.spec.mts', workers: 1, retries: 0, timeout: 120_000,
  outputDir: '../../../coverage/components/results',
  reporter: [['list']],
  use: { browserName: 'chromium', deviceScaleFactor: 1, locale: 'en-US', timezoneId: 'UTC', colorScheme: 'dark', reducedMotion: 'reduce' },
});
