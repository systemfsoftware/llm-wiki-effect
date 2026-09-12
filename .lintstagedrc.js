import { join } from 'node:path'

const ROOT = process.cwd()
const DPRINT = join(ROOT, 'bin/dprint')
const OXLINT = join(ROOT, 'node_modules/.bin/oxlint')
const NO_MATCH_OK = '--no-error-on-unmatched-pattern'

/** @type {import('lint-staged').Configuration} */
export default {
  '*.{js,jsx,ts,tsx,mjs,cjs}': (filenames) => [
    `${DPRINT} fmt --allow-no-files -- ${filenames.join(' ')}`,
    `${OXLINT} --fix ${NO_MATCH_OK} --type-aware --type-check --quiet ${filenames.join(' ')}`,
  ],
  '*.{json,jsonc,md,yaml,yml,toml,css,html}': (filenames) => [
    `${DPRINT} fmt --allow-no-files -- ${filenames.join(' ')}`,
  ],
}
