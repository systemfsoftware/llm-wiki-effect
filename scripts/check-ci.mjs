#!/usr/bin/env node
/**
 * Runs every gate step and reports each one, so one failure does not hide the
 * rest. The steps come from the caller (`pnpm check:ci`), which keeps the list
 * next to the scripts it names.
 *
 * This exists because the accumulator it replaced was POSIX shell:
 * `s=0; a || s=1; ... exit $s` is a syntax error under cmd.exe, which npm and
 * pnpm use to run scripts on Windows.
 */

import { spawnSync } from 'node:child_process'

const steps = process.argv.slice(2)
if (steps.length === 0) {
  console.error('usage: check-ci.mjs <pnpm-script> [more...]')
  process.exit(2)
}

const failed = []
for (const step of steps) {
  const started = Date.now()
  const result = spawnSync('pnpm', [step], { stdio: 'inherit', shell: process.platform === 'win32' })
  const seconds = ((Date.now() - started) / 1000).toFixed(1)
  if (result.status === 0) {
    console.log(`[check:ci] ${step} ok (${seconds}s)`)
  } else {
    failed.push(step)
    console.error(`[check:ci] ${step} FAILED (${seconds}s)`)
  }
}

if (failed.length > 0) {
  console.error(`[check:ci] failed: ${failed.join(', ')}`)
  process.exit(1)
}
console.log('[check:ci] all steps passed')
