#!/usr/bin/env node
/**
 * Copies the app version from package.json into the manifests that duplicate it.
 *
 * package.json is the source of truth: `.changeset/config.json` versions it, and
 * `src/lib/changelog.test.ts` checks the copies against it. Run this after
 * `changeset version` - it is what `pnpm release:version` calls second - and
 * before committing the release.
 *
 * Every rewrite is verified after the fact. A pattern that stops matching (a
 * manifest reformatted, a key renamed) would otherwise leave one artifact at the
 * old version while this script reports success.
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

/** Each target: the file, the single line to rewrite, and the text that proves it. */
const targets = [
  {
    path: 'src-tauri/tauri.conf.json',
    // Bundle version: CFBundleShortVersionString, installer and artifact names.
    pattern: /"version": "[^"]+"/,
    replacement: `"version": "${version}"`,
    proof: `"version": "${version}"`,
  },
  {
    path: 'src-tauri/Cargo.toml',
    // The crate's own version, which cargo records in the lockfile below.
    pattern: /^version = "[^"]+"$/m,
    replacement: `version = "${version}"`,
    proof: `version = "${version}"`,
  },
  {
    path: 'src-tauri/Cargo.lock',
    pattern: /(name = "llm-wiki"\nversion = ")[^"]+(")/,
    replacement: `$1${version}$2`,
    proof: `name = "llm-wiki"\nversion = "${version}"`,
  },
]

const reads = targets.map((target) => ({ ...target, before: readFileSync(join(root, target.path), 'utf8') }))

for (const { path, proof, before } of reads) {
  if (!before.includes(proof)) throw new Error(`${path} does not carry ${version} (expected ${proof})`)
}

const written = []
for (const { path, pattern, replacement, before } of reads) {
  const after = before.replace(pattern, replacement)
  if (after === before) continue
  writeFileSync(join(root, path), after)
  written.push(path)
}

console.log(
  written.length > 0 ? `synced ${version} into ${written.join(', ')}` : `already at ${version}`,
)
console.log('manual step left: prepend the in-app changelog entry (en + zh) in src/lib/changelog.ts')
