import { existsSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'

const ROOT = process.cwd()
const DPRINT = `node ${join(ROOT, 'bin/dprint.mjs')}`
const OXLINT = join(ROOT, 'node_modules/.bin/oxlint')
const NO_MATCH_OK = '--no-error-on-unmatched-pattern'

const owningConfig = (file) => {
  let dir = dirname(file)
  while (dir.startsWith(ROOT) && dir !== ROOT) {
    const candidate = join(dir, 'oxlint.config.ts')
    if (existsSync(candidate)) return candidate
    dir = dirname(dir)
  }
  return null
}

const groupByConfig = (files) => {
  const groups = new Map()
  for (const file of files) {
    const config = owningConfig(file)
    const group = groups.get(config)
    if (group === undefined) groups.set(config, [file])
    else group.push(file)
  }
  return groups
}

const formatCommands = (filenames) => [`${DPRINT} fmt --allow-no-files -- ${filenames.join(' ')}`]

const lintCommands = (filenames) =>
  [...groupByConfig(filenames)]
    .filter(([config]) => config !== null)
    .map(
      ([config, group]) =>
        `${OXLINT} --fix ${NO_MATCH_OK} --config ${relative(ROOT, config)} ${
          group.join(' ')
        } --type-aware --type-check --quiet`,
    )

/** @type {import('lint-staged').Configuration} */
export default {
  '*.{js,jsx,ts,tsx,mjs,cjs}': (filenames) => [...formatCommands(filenames), ...lintCommands(filenames)],
  '*.{json,jsonc,md,yaml,yml,toml,css,html}': (filenames) => formatCommands(filenames),
}
