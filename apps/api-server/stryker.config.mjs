import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

export default {
  $schema: 'https://onjsonschema.com/stryker-schema.json',
  packageManager: 'pnpm',
  testRunner: 'vitest',
  plugins: [require.resolve('@stryker-mutator/vitest-runner')],
  coverageAnalysis: 'perTest',
  reporters: ['html', 'clear-text'],
  mutate: ['src/**/*.ts'],
  tempDirName: '.stryker-tmp',
}
