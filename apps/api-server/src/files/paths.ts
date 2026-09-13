import { Result } from 'effect'
import { Errors } from 'llm-wiki-protocol'

export const DEFAULT_MAX_FILES = 2_000
export const HARD_MAX_FILES = 10_000
export const MAX_FILE_CONTENT_BYTES = 2 * 1024 * 1024

export const PUBLIC_ROOTS: ReadonlyArray<string> = [
  'purpose.md',
  'schema.md',
  'wiki',
  'raw/sources',
]

const TEXT_EXTENSIONS: Record<string, true> = {
  md: true,
  mdx: true,
  txt: true,
  csv: true,
  json: true,
  yaml: true,
  yml: true,
  xml: true,
  html: true,
  htm: true,
  log: true,
}

export const normalizeProjectRel = (rel: string): string => rel.replace(/\\/g, '/')

export const isPublicProjectRel = (rel: string): boolean => {
  const normalized = normalizeProjectRel(rel).replace(/^\/+/, '')
  if (normalized.split('/').some((part) => part.length === 0 || part.startsWith('.'))) {
    return false
  }
  const lower = normalized.toLowerCase()
  return (
    lower === 'purpose.md' ||
    lower === 'schema.md' ||
    lower.startsWith('wiki/') ||
    lower.startsWith('raw/sources/')
  )
}

export const isTextContentRel = (rel: string): boolean => {
  const normalized = normalizeProjectRel(rel).toLowerCase()
  const base = normalized.slice(normalized.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  const extension = dot === -1 ? '' : base.slice(dot + 1)
  return TEXT_EXTENSIONS[extension] === true
}

export const clampMaxFiles = (value: number | undefined): number => {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_MAX_FILES
  return Math.min(Math.max(Math.trunc(value), 1), HARD_MAX_FILES)
}

export const resolveRootSelector = (
  rel: string | undefined,
): Result.Result<string, Errors.InvalidRequest> => {
  switch (rel) {
    case undefined:
    case '':
    case 'all':
      return Result.succeed('')
    case 'wiki':
      return Result.succeed('wiki')
    case 'sources':
    case 'raw':
    case 'raw/sources':
      return Result.succeed('raw/sources')
    default:
      return Result.fail(
        new Errors.InvalidRequest({ message: 'root must be wiki, sources, or all' }),
      )
  }
}

/**
 * Port of the component checks in `api_server.rs::safe_join`: a project-relative
 * path must not be absolute, UNC, drive-prefixed, or carry a `..` segment.
 */
export const guardRelativePath = (
  rel: string,
): Result.Result<string, Errors.PathViolation> => {
  if (rel.includes('\0')) {
    return Result.fail(new Errors.PathViolation({ message: 'Path contains a NUL byte' }))
  }
  const normalized = normalizeProjectRel(rel)
  const withoutLeadingSlash = normalized.replace(/^\/+/, '')
  if (normalized.startsWith('//') || /^[A-Za-z]:/.test(withoutLeadingSlash)) {
    return Result.fail(new Errors.PathViolation({ message: 'Paths outside the project are not allowed' }))
  }
  if (withoutLeadingSlash.split('/').includes('..')) {
    return Result.fail(new Errors.PathViolation({ message: 'Path traversal is not allowed' }))
  }
  return Result.succeed(withoutLeadingSlash)
}

export const isWithinRoot = (root: string, candidate: string): boolean => {
  if (candidate === root) return true
  return candidate.startsWith(root.endsWith('/') ? root : `${root}/`)
}
