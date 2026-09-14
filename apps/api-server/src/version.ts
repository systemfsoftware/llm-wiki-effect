import { readFileSync } from 'node:fs'

export const FALLBACK_VERSION = '0.0.0'

export function loadApiServerVersion(metaUrl: string = import.meta.url): string {
  for (
    const relativePackageJson of [
      '../package.json',
      '../../package.json',
      '../../../package.json',
    ]
  ) {
    try {
      const candidate = new URL(relativePackageJson, metaUrl)
      const parsed: unknown = JSON.parse(readFileSync(candidate, 'utf8'))
      if (
        typeof parsed === 'object' && parsed !== null &&
        'version' in parsed && typeof parsed.version === 'string' && parsed.version.trim()
      ) {
        return parsed.version
      }
    } catch {
      continue
    }
  }

  process.stderr.write('[llm-wiki-api-server] package.json version not found; using fallback 0.0.0\n')
  return FALLBACK_VERSION
}

export const VERSION = loadApiServerVersion()
