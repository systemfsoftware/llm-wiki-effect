import { CHANGELOG } from '@/lib/changelog'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

function readJsonVersion(path: URL): unknown {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (typeof parsed !== 'object' || parsed === null || !('version' in parsed)) {
    throw new Error(`No version field in ${path.href}`)
  }
  return parsed.version
}

describe('release metadata', () => {
  it('keeps app manifests and the latest changelog version aligned', () => {
    const packageVersion = readJsonVersion(new URL('../../package.json', import.meta.url))
    const tauriVersion = readJsonVersion(new URL('../../src-tauri/tauri.conf.json', import.meta.url))
    const cargoToml = readFileSync(
      new URL('../../src-tauri/Cargo.toml', import.meta.url),
      'utf8',
    )
    const cargoVersion = cargoToml.match(/^version\s*=\s*"([^"]+)"/m)?.[1]

    expect(CHANGELOG[0]?.version).toBe(packageVersion)
    expect(tauriVersion).toBe(packageVersion)
    expect(cargoVersion).toBe(packageVersion)
  })
})
