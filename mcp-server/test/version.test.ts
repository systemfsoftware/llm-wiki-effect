import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { FALLBACK_VERSION, loadMcpServerVersion, VERSION } from '../src/version.js'

const pkgJson: unknown = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
if (
  typeof pkgJson !== 'object' ||
  pkgJson === null ||
  !('version' in pkgJson) ||
  typeof pkgJson.version !== 'string'
) {
  throw new Error('package.json is missing a string "version"')
}
const pkg = { version: pkgJson.version }

void test('MCP server version is read from package.json', () => {
  assert.equal(VERSION, pkg.version)
})

void test('MCP server version supports source-layout execution', () => {
  assert.equal(
    loadMcpServerVersion(new URL('../../src/version.ts', import.meta.url).href),
    pkg.version,
  )
})

void test('MCP server version falls back when package.json cannot be found', () => {
  assert.equal(loadMcpServerVersion('file:///tmp/llm-wiki-missing/dist/src/version.js'), FALLBACK_VERSION)
})

void test('MCP server version falls back for invalid meta URLs', () => {
  assert.equal(loadMcpServerVersion('not a url'), FALLBACK_VERSION)
})
