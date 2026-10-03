import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';

// No ambient/global browser cache: CI explicitly provisions this pinned package's
// Chromium revision into the ignored task directory before running captures.
process.env.PLAYWRIGHT_BROWSERS_PATH = resolve('target/reference-browser');
export default defineConfig({
  testDir: '.', testMatch: 'capture.spec.mts', workers: 2, retries: 0, timeout: 240_000,
  outputDir: '../../../coverage/reference/results',
  snapshotPathTemplate: '{testDir}/../../../coverage/reference/source/{projectName}/{arg}{ext}',
  updateSnapshots: 'none',
  reporter: [['list'], ['html', { outputFolder: resolve('coverage/reference/report'), open: 'never' }]],
  use: { browserName: 'chromium', deviceScaleFactor: 1, locale: 'en-US', timezoneId: 'UTC', colorScheme: 'dark', reducedMotion: 'reduce', trace: 'retain-on-failure' },
  projects: ['dark', 'light'].flatMap(theme => [
    { name: `${theme}-1600x960`, use: { viewport: { width: 1600, height: 960 } } },
    { name: `${theme}-1000x700`, use: { viewport: { width: 1000, height: 700 } } },
  ]),
});
