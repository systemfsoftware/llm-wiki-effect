import { defineConfig } from 'rolldown'

export default defineConfig({
  input: 'src/index.ts',
  platform: 'node',
  external: [/^effect(\/|$)/, /^@effect\//],
  output: {
    dir: 'dist',
    entryFileNames: 'src/[name].js',
    format: 'esm',
    cleanDir: true,
  },
})
