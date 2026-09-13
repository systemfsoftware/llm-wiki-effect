import { Result } from 'effect'
import { Errors } from 'llm-wiki-protocol'
import { guardRelativePath, isPublicProjectRel } from '../../files/paths.js'

export const AGENT_WORKSPACE_DIR = 'agent-workspace'

const WINDOWS_RESERVED_STEMS: Record<string, true> = {
  CON: true,
  PRN: true,
  AUX: true,
  NUL: true,
  COM1: true,
  COM2: true,
  COM3: true,
  COM4: true,
  COM5: true,
  COM6: true,
  COM7: true,
  COM8: true,
  COM9: true,
  LPT1: true,
  LPT2: true,
  LPT3: true,
  LPT4: true,
  LPT5: true,
  LPT6: true,
  LPT7: true,
  LPT8: true,
  LPT9: true,
}

const normalizeRelPath = (path: string): string => path.trim().replace(/\\/g, '/').replace(/^\/+/, '')

const isHiddenRel = (rel: string): boolean =>
  normalizeRelPath(rel).split('/').some((segment) => segment.startsWith('.'))

const violation = (message: string): Result.Result<never, Errors.PathViolation> =>
  Result.fail(new Errors.PathViolation({ message }))

const hasWindowsInvalidChar = (segment: string): boolean => {
  for (const char of segment) {
    const codePoint = char.codePointAt(0) ?? 0
    if (codePoint <= 0x1f || '<>:"|?*'.includes(char)) return true
  }
  return false
}

const portableSegmentError = (segment: string, tool: string): string | null => {
  if (segment === '') return `${tool} path contains an empty segment`
  if (/[ .]$/.test(segment)) {
    return `${tool} path contains a segment ending with a space or dot, which is not portable to Windows`
  }
  if (hasWindowsInvalidChar(segment)) {
    return `${tool} path contains characters that are invalid on Windows`
  }
  const stem = (segment.split('.')[0] ?? segment).replace(/ +$/, '').toUpperCase()
  if (WINDOWS_RESERVED_STEMS[stem] === true) {
    return `${tool} path uses a Windows reserved device name`
  }
  return null
}

export const guardWikiReadPath = (path: string): Result.Result<string, Errors.PathViolation> => {
  const rel = normalizeRelPath(path)
  if (!isPublicProjectRel(rel) || !rel.toLowerCase().startsWith('wiki/')) {
    return violation('wiki.read_page path must stay under wiki/')
  }
  return guardRelativePath(rel)
}

export const guardWikiWritePath = (
  path: string,
  tool = 'wiki.write_page',
): Result.Result<string, Errors.PathViolation> => {
  const rel = normalizeRelPath(path)
  const lower = rel.toLowerCase()
  if (!lower.startsWith('wiki/') || !lower.endsWith('.md')) {
    return violation(`${tool} path must be a Markdown file under wiki/`)
  }
  if (isHiddenRel(rel)) return violation(`${tool} cannot write hidden paths`)
  const guarded = guardRelativePath(rel)
  if (Result.isFailure(guarded)) return violation(`${tool} path must stay inside the project`)
  for (const segment of guarded.success.split('/')) {
    const message = portableSegmentError(segment, tool)
    if (message !== null) return violation(message)
  }
  return guarded
}

export const guardWorkspaceWritePath = (
  path: string,
  tool = 'workspace.write_file',
): Result.Result<string, Errors.PathViolation> => {
  const rel = normalizeRelPath(path)
  const lower = rel.toLowerCase()
  if (rel === '' || lower.startsWith('wiki/') || lower.startsWith('raw/') || isHiddenRel(rel)) {
    return violation(`${tool} path must be a relative file under ${AGENT_WORKSPACE_DIR}`)
  }
  const guarded = guardRelativePath(rel)
  if (Result.isFailure(guarded)) {
    return violation(`${tool} path must stay inside ${AGENT_WORKSPACE_DIR}`)
  }
  for (const segment of guarded.success.split('/')) {
    const message = portableSegmentError(segment, tool)
    if (message !== null) return violation(message)
  }
  return guarded
}

export const guardSkillReadPath = (path: string): Result.Result<string, Errors.PathViolation> => {
  const requested = path.trim()
  const fail = (): Result.Result<never, Errors.PathViolation> =>
    violation('skill.read_file path must be a safe relative path inside the skill directory')
  if (requested === '' || requested.startsWith('/')) return fail()
  const guarded = guardRelativePath(requested)
  if (Result.isFailure(guarded)) return fail()
  if (guarded.success === '') return fail()
  return guarded
}

const FILE_PATH_GUARDS: Record<
  string,
  (path: string) => Result.Result<string, Errors.PathViolation>
> = {
  'wiki.read_page': guardWikiReadPath,
  'wiki.write_page': guardWikiWritePath,
  'workspace.write_file': guardWorkspaceWritePath,
  'workspace.append_file': (path) => guardWorkspaceWritePath(path, 'workspace.append_file'),
  'skill.read_file': guardSkillReadPath,
}

export const filePathGuard = (
  tool: string,
): ((path: string) => Result.Result<string, Errors.PathViolation>) | undefined => FILE_PATH_GUARDS[tool]
