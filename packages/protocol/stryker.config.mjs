export default {
  $schema: 'https://onjsonschema.com/stryker-schema.json',
  packageManager: 'pnpm',
  testRunner: 'vitest',
  plugins: ['@stryker-mutator/vitest-runner'],
  vitest: { related: false },
  coverageAnalysis: 'perTest',
  reporters: ['html', 'clear-text'],
  mutate: ['src/**/*.ts'],
  tempDirName: '.stryker-tmp',
}
