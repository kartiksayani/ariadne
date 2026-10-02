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
        console: 'readonly', process: 'readonly', Buffer: 'readonly',
        setTimeout: 'readonly', clearTimeout: 'readonly',
        setInterval: 'readonly', clearInterval: 'readonly',
      },
    },
  },
];
