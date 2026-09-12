#!/usr/bin/env node
/**
 * Copies the app version from package.json into the manifests that duplicate it.
 *
 * package.json is the source of truth: `.changeset/config.json` versions it, and
 * `src/lib/changelog.test.ts` checks the copies against it. Run this after
 * `changeset version` - it is what `pnpm release:version` calls second - and
 * before committing the release.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const readAppVersion = () => {
  const parsed = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const { version } = parsed
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`package.json version is not semver: ${String(version)}`)
  }
  return version
}

const version = readAppVersion()
const written = []

const edit = (relativePath, pattern, replacement) => {
  const path = join(root, relativePath)
  const before = readFileSync(path, 'utf8')
  const after = before.replace(pattern, replacement)
  if (after === before) return
  writeFileSync(path, after)
  written.push(relativePath)
}

// Bundle version: CFBundleShortVersionString, installer and artifact names.
edit('src-tauri/tauri.conf.json', /"version": "[^"]+"/, `"version": "${version}"`)
// The crate's own version, which cargo records in the lockfile below.
edit('src-tauri/Cargo.toml', /^version = "[^"]+"$/m, `version = "${version}"`)
edit('src-tauri/Cargo.lock', /(name = "llm-wiki"\nversion = ")[^"]+(")/, `$1${version}$2`)

console.log(
  written.length > 0 ? `synced ${version} into ${written.join(', ')}` : `already at ${version}`,
)
console.log('manual step left: prepend the in-app changelog entry (en + zh) in src/lib/changelog.ts')
