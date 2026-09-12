import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/**
 * The suite that talks to real model providers: it needs paid API keys and a
 * built app, so it is never part of `pnpm test:mocks` or CI. It lives in its own
 * config because the default excludes in `vite.config.ts` would filter it out,
 * and CLI `--exclude` flags cannot re-include what a config excluded.
 *
 * The `@` alias repeats `vite.config.ts` on purpose: that config exports a
 * function, which `mergeConfig` cannot merge.
 */
export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.real-llm.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    setupFiles: ['./src/test-helpers/load-test-env.ts'],
    fileParallelism: false,
  },
})
