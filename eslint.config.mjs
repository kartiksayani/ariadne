import js from '@eslint/js';

export default [
  { ignores: ['node_modules/**', '.cache/**', 'coverage/**', 'target/**', '.venv-quality/**', 'docs/**', 'designs/**'] },
  js.configs.recommended,
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        document: 'readonly', window: 'readonly', ResizeObserver: 'readonly',
        requestAnimationFrame: 'readonly', FileReader: 'readonly', Blob: 'readonly',
        URL: 'readonly',
        console: 'readonly', process: 'readonly', Buffer: 'readonly',
        setTimeout: 'readonly', clearTimeout: 'readonly',
        setInterval: 'readonly', clearInterval: 'readonly',
      },
    },
  },
];
