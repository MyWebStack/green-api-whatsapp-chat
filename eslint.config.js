import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import hooks from 'eslint-plugin-react-hooks';
import refresh from 'eslint-plugin-react-refresh';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'coverage/**',
      'playwright-report/**',
      'test-results/**',
      'artifacts/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    plugins: { 'react-hooks': hooks, 'react-refresh': refresh },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/infrastructure/*'],
              message: 'Compose infrastructure at the app boundary.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/chat/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                'react',
                'react-dom',
                'zustand*',
                'zod',
                '**/application/*',
                '**/infrastructure/*',
                '**/ui/*',
              ],
              message: 'Domain must remain framework and IO independent.',
            },
          ],
        },
      ],
    },
  },
  {
    files: [
      'src/chat/infrastructure/**',
      'src/session/**',
      'src/app/**',
      '**/*.test.*',
      'tests/**',
    ],
    rules: { 'no-restricted-imports': 'off' },
  },
  { files: ['eslint.config.js'], languageOptions: { globals: { process: 'readonly' } } },
);
