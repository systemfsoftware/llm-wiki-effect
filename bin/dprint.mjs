#!/usr/bin/env node
/**
 * dprint launcher: the pinned local install first, then whatever dprint is on
 * PATH. Node rather than the shell script it replaced, because pnpm runs scripts
 * through cmd.exe on Windows and `#!/usr/bin/env bash` is not a promise there.
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const local = join(root, 'node_modules', 'dprint', 'bin.cjs')

const result = existsSync(local)
  ? spawnSync(process.execPath, [local, ...args], { stdio: 'inherit' })
  : spawnSync('dprint', args, { stdio: 'inherit', shell: process.platform === 'win32' })

if (result.error == null) {
  process.exit(result.status ?? 1)
}

console.error('dprint is not installed - run `pnpm install` first')
process.exit(1)
