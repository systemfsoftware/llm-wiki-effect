import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { FALLBACK_VERSION, loadApiServerVersion, VERSION } from '../src/version.js'

const packageJson: { version: string } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
)

describe('api server version', () => {
  it('resolves the package version from the source layout', () => {
    expect(VERSION).toBe(packageJson.version)
  })

  it('falls back when no package.json is reachable from the module url', () => {
    expect(
      loadApiServerVersion(new URL('../../../missing/version.js', import.meta.url).href),
    ).toBe(FALLBACK_VERSION)
  })
})
