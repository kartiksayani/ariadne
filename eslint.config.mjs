import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import { readFileSync } from 'node:fs';
import selectors from './scripts/eslint/no-class-selectors.mjs';

// Test files that still find elements by CSS class. Frozen: it may only shrink. A file leaves the list
// when its last class selector is converted (scripts/eslint/baseline.test.ts fails on a stale entry).
// New and edited tests are not in it, so they get the rule.
const classSelectorBaseline = JSON.parse(readFileSync(new URL('./scripts/eslint/class-selector-baseline.json', import.meta.url), 'utf8'));
export const testFiles = ['**/*.{test,spec}.{js,mjs,cjs,ts,tsx,mts,cts}', 'tests/**/*.{js,mjs,cjs,ts,tsx,mts,cts}', 'apps/desktop/tests/**/*.{js,mjs,cjs,ts,tsx,mts,cts}'];

export default [
  { ignores: ['.worktrees/**', 'node_modules/**', '.cache/**', 'coverage/**', 'target/**', '.venv-quality/**', 'docs/**', 'designs/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended.map(config => ({ ...config, files: ['**/*.{ts,tsx,mts,cts}'] })),
  {
    files: ['**/*.{js,mjs,cjs,ts,tsx,mts,cts}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        document: 'readonly', window: 'readonly', ResizeObserver: 'readonly',
        requestAnimationFrame: 'readonly', FileReader: 'readonly', Blob: 'readonly',
        URL: 'readonly',
        browser: 'readonly', describe: 'readonly', it: 'readonly',
        console: 'readonly', process: 'readonly', Buffer: 'readonly',
        setTimeout: 'readonly', clearTimeout: 'readonly',
        setInterval: 'readonly', clearInterval: 'readonly',
      },
    },
  },
  {
    files: testFiles,
    ignores: classSelectorBaseline,
    plugins: { ariadne: selectors },
    rules: { 'ariadne/no-class-selectors': 'error' },
  },
];
