import { defineConfig } from 'rolldown'

export default defineConfig({
  input: {
    'entries/worker': 'src/entries/worker.ts',
    'entries/standalone': 'src/entries/standalone.ts',
  },
  platform: 'node',
  external: ['@lancedb/lancedb'],
  output: {
    dir: 'dist',
    entryFileNames: 'src/[name].js',
    format: 'esm',
    cleanDir: true,
  },
})
