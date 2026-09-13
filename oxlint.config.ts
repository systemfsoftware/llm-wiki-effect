import { defineConfig } from 'oxlint'

export default defineConfig({
  plugins: ['typescript', 'react', 'jsx-a11y', 'import', 'oxc', 'promise', 'vitest', 'node'],

  env: { browser: true, node: true },

  categories: {
    correctness: 'error',
    suspicious: 'warn',
  },

  rules: {
    'react/react-in-jsx-scope': 'off',
    'typescript/no-non-null-assertion': 'error',
    'import/no-unassigned-import': ['error', { allow: ['**/*.css'] }],
  },

  overrides: [
    { files: ['**/*.test.ts', '**/*.test.tsx', '**/test-helpers/**/*.ts'], env: { vitest: true } },
    { files: ['extension/**/*.js'], env: { browser: true, webextensions: true } },
  ],

  ignorePatterns: [
    'dist/**',
    'dist-test/**',
    'dist-rc/**',
    'dist-portable/**',
    'coverage/**',
    'reports/**',
    'extension/Readability.js',
    'extension/Turndown.js',
    'src-tauri/**',
    'repos/**',
  ],
})
