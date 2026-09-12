import { existsSync } from 'node:fs'
import { dirname, isAbsolute, join, relative } from 'node:path'

const ROOT = process.cwd()
const DPRINT = join(ROOT, 'bin/dprint')
const NO_MATCH_OK = '--no-error-on-unmatched-pattern'

const absoluteOf = (file) => (isAbsolute(file) ? file : join(ROOT, file))

const packageRootOf = (absoluteFile) => {
  let dir = dirname(absoluteFile)
  while (dir.length >= ROOT.length) {
    if (existsSync(join(dir, 'oxlint.config.ts'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/** @type {import('lint-staged').Configuration} */
export default {
  '*.{js,jsx,ts,tsx,mjs,cjs}': (filenames) => {
    const commands = [`${DPRINT} fmt --allow-no-files -- ${filenames.join(' ')}`]
    const byPackage = new Map()
    for (const file of filenames) {
      const absolute = absoluteOf(file)
      const packageRoot = packageRootOf(absolute)
      if (packageRoot === null) continue
      const group = byPackage.get(packageRoot) ?? []
      group.push(relative(packageRoot, absolute))
      byPackage.set(packageRoot, group)
    }
    for (const [packageRoot, files] of byPackage) {
      commands.push(
        `cd ${packageRoot} && oxlint --fix ${NO_MATCH_OK} --type-aware --type-check --quiet ${files.join(' ')}`,
      )
    }
    return commands
  },
  '*.{json,jsonc,md,yaml,yml,toml,css,html}': (filenames) => [
    `${DPRINT} fmt --allow-no-files -- ${filenames.join(' ')}`,
  ],
}
