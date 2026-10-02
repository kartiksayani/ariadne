import js from '@eslint/js';
import tseslint from 'typescript-eslint';

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
];
