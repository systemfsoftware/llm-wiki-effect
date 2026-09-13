/**
 * Project context assembly inputs.
 *
 * Ported from apps/desktop/src-tauri/src/agent/context.rs: `overview.md` and
 * `schema.md` (or their `wiki/` twins) become bounded prompt context, and
 * user-selected `@`-attachment files are re-validated for project containment
 * before their bodies reach the model.
 */
import { Effect } from 'effect'
import { readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { agentWorkspaceDisplay } from './workspace.js'

export const MAX_OVERVIEW_CHARS = 8_000
export const MAX_SCHEMA_CHARS = 6_000
export const MAX_HISTORY_CHARS = 12_000
export const MAX_REFERENCE_CHARS = 24_000
export const MAX_SKILL_CHARS = 18_000
export const MAX_AUTO_SKILL_INDEX_CHARS = 12_000
export const MAX_AUTO_SKILLS = 48
export const MAX_EXPLICIT_CONTEXT_FILES = 8
export const MAX_EXPLICIT_CONTEXT_CHARS = 24_000
export const MAX_EXPLICIT_FILE_CHARS = 8_000

export interface ProjectContext {
  readonly overview: string | undefined
  readonly schema: string | undefined
  readonly agentWorkspace: string
}

export const trimChars = (value: string, maxChars: number): string => {
  const chars = Array.from(value)
  if (chars.length <= maxChars) return value
  return `${chars.slice(0, Math.max(0, maxChars - 3)).join('')}...`
}

export const collapseWhitespace = (value: string): string => value.split(/\s+/).filter(Boolean).join(' ')

export const escapeXml = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')

const readTrimmed = async (path: string, maxChars: number): Promise<string | undefined> => {
  try {
    const trimmed = (await readFile(path, 'utf8')).trim()
    return trimmed === '' ? undefined : trimChars(trimmed, maxChars)
  } catch {
    return undefined
  }
}

export const loadProjectContext = (projectRoot: string): Effect.Effect<ProjectContext> =>
  Effect.promise(async () => ({
    overview: (await readTrimmed(join(projectRoot, 'overview.md'), MAX_OVERVIEW_CHARS)) ??
      (await readTrimmed(join(projectRoot, 'wiki', 'overview.md'), MAX_OVERVIEW_CHARS)),
    schema: (await readTrimmed(join(projectRoot, 'schema.md'), MAX_SCHEMA_CHARS)) ??
      (await readTrimmed(join(projectRoot, 'wiki', 'schema.md'), MAX_SCHEMA_CHARS)),
    agentWorkspace: agentWorkspaceDisplay(projectRoot),
  }))

const isSafeRelativeAttachment = (path: string): boolean => {
  if (path === '' || isAbsolute(path)) return false
  return path.split('/').every((segment) => segment !== '' && segment !== '..' && !segment.startsWith('.'))
}

export const loadExplicitContextFiles = (
  projectRoot: string,
  requested: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<readonly [string, string]>> =>
  Effect.promise(async () => {
    let root: string
    try {
      root = await realpath(projectRoot)
    } catch {
      return []
    }
    const out: Array<readonly [string, string]> = []
    let remaining = MAX_EXPLICIT_CONTEXT_CHARS
    for (const requestedPath of requested.slice(0, MAX_EXPLICIT_CONTEXT_FILES)) {
      const normalized = requestedPath.trim().replaceAll('\\', '/')
      if (!isSafeRelativeAttachment(normalized)) continue
      const candidate = join(projectRoot, normalized)
      let resolved: string
      try {
        resolved = await realpath(candidate)
        if (!(resolved === root || resolved.startsWith(`${root}/`)) || !(await stat(resolved)).isFile()) {
          continue
        }
      } catch {
        continue
      }
      let content: string
      try {
        content = await readFile(resolved, 'utf8')
      } catch {
        continue
      }
      const fitted = trimChars(content.trim(), Math.min(remaining, MAX_EXPLICIT_FILE_CHARS))
      if (fitted === '') continue
      remaining -= Array.from(fitted).length
      out.push([candidate.replaceAll('\\', '/'), fitted])
      if (remaining <= 0) break
    }
    return out
  })
