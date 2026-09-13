#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const packageJson = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
const entries = ['worker', 'standalone'].map((name) => ({
  name,
  path: join(packageRoot, 'dist', 'src', 'entries', `${name}.js`),
}))

const missing = entries.filter((entry) => !existsSync(entry.path))
if (missing.length > 0) {
  process.stderr.write(
    `The api-server bundle is not built: ${missing.map((entry) => entry.path).join(', ')}\n` +
      'Run `pnpm api:build` from the repository root, then re-run this script.\n',
  )
  process.exit(1)
}

let failed = false
for (const entry of entries) {
  const result = spawnSync(process.execPath, [entry.path], { encoding: 'utf8', timeout: 30_000 })
  const stdout = (result.stdout ?? '').trim()
  const expected = `llm-wiki-api-server ${entry.name} ${packageJson.version}`
  const ok = result.status === 0 && stdout.includes(expected)
  process.stdout.write(
    `${ok ? 'ok' : 'FAIL'} ${entry.name}: exit=${result.status} stdout=${JSON.stringify(stdout)}\n`,
  )
  if (!ok) {
    failed = true
    if (result.stderr) process.stderr.write(result.stderr)
  }
}

process.exit(failed ? 1 : 0)
