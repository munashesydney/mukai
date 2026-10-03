import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';
import hooks from 'eslint-plugin-react-hooks';
import refresh from 'eslint-plugin-react-refresh';

export default tseslint.config(
  { ignores: ['node_modules', 'out', 'dist', '**/dist/**', 'release', 'artifacts', '.dev-data'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
  },
  {
    files: ['src/server/services/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'node:http', message: 'HTTP transport belongs in server/http.' },
            { name: 'node:sqlite', message: 'Database access belongs in repositories.' },
          ],
          patterns: [
            {
              group: ['**/db/**', '**/http/**'],
              message: 'Services use repositories and domain models.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/server/http/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: ['node:sqlite'],
          patterns: [
            {
              group: ['**/db/**', '**/repositories/**'],
              message: 'HTTP handlers call services, not the database.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/server/repositories/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/services/**', '**/http/**'],
              message: 'Repositories only handle persistence.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/renderer/src/{features,components}/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-globals': ['error', { name: 'fetch', message: 'Use a typed API service.' }],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/services/http'],
              message: 'Use a typed API service instead of the HTTP transport.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': hooks, 'react-refresh': refresh },
    rules: {
      ...hooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  },
);
