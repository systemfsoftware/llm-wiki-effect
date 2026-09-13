export default {
  $schema: 'https://onjsonschema.com/stryker-schema.json',
  packageManager: 'pnpm',
  testRunner: 'vitest',
  coverageAnalysis: 'perTest',
  reporters: ['html', 'clear-text'],
  mutate: ['src/**/*.ts'],
  tempDirName: '.stryker-tmp',
}
