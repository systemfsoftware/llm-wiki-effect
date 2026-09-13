import { Result } from 'effect'
import { Errors } from 'llm-wiki-protocol'
import { AGENT_WORKSPACE_DIR } from './paths.js'
import type { ToolCall } from './types.js'

export type AgentCapability =
  | 'read_project'
  | 'read_source'
  | 'search_wiki'
  | 'search_web'
  | 'search_any_txt'
  | 'write_wiki'
  | 'run_deep_research'
  | 'network'
  | 'process'

export interface PermissionPolicy {
  readonly allowed: ReadonlyArray<AgentCapability>
}

export const apiDefaultPolicy = (): PermissionPolicy => ({
  allowed: [
    'read_project',
    'read_source',
    'search_wiki',
    'search_web',
    'search_any_txt',
    'write_wiki',
    'network',
    'process',
  ],
})

const TOOL_CAPABILITIES: Record<string, ReadonlyArray<AgentCapability>> = {
  'wiki.search': ['search_wiki'],
  'wiki.read_page': ['read_project'],
  'source.search': ['read_source'],
  'web.search': ['network'],
  'graph.search': ['read_project'],
  'anytxt.search': ['network'],
  'deep_research.run': ['run_deep_research'],
  'wiki.write_page': ['write_wiki'],
  'llm.generate': ['network'],
  'skills.load': ['read_project'],
  'skill.read_file': ['read_project'],
  'workspace.write_file': ['write_wiki'],
  'workspace.append_file': ['write_wiki'],
  'shell.exec': ['process'],
}

export const capabilitiesFor = (tool: string): ReadonlyArray<AgentCapability> => TOOL_CAPABILITIES[tool] ?? []

export const allows = (policy: PermissionPolicy, capability: AgentCapability): boolean =>
  policy.allowed.includes(capability)

export const requireCapability = (
  policy: PermissionPolicy,
  capability: AgentCapability,
): Result.Result<true, Errors.AgentError> =>
  allows(policy, capability)
    ? Result.succeed(true)
    : Result.fail(new Errors.AgentError({ message: `Agent capability '${capability}' is not allowed` }))

export const APPROVAL_REQUIRED_OBSERVATION = 'shell.exec.approval_required'

export const shellCommandFromCall = (call: ToolCall): string | undefined => {
  const raw = call.input['command'] ?? call.input['query'] ?? call.input['content']
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  return trimmed === '' ? undefined : trimmed
}

export const isShellCommandApproved = (
  command: string,
  approved: ReadonlyArray<string>,
): boolean => {
  const trimmed = command.trim()
  return trimmed !== '' && approved.some((item) => item.trim() === trimmed)
}

const SHELL_TOKEN_DELIMITERS = /[\s;|&()<>]/

const tokenizeShellCommand = (command: string): ReadonlyArray<string> => {
  const tokens: Array<string> = []
  let current = ''
  let quote: string | null = null
  for (const character of command) {
    if (quote !== null) {
      if (character === quote) quote = null
      else current += character
      continue
    }
    if (character === "'" || character === '"') {
      quote = character
      continue
    }
    if (SHELL_TOKEN_DELIMITERS.test(character)) {
      if (current !== '') tokens.push(current)
      current = ''
      continue
    }
    current += character
  }
  if (current !== '') tokens.push(current)
  return tokens
}

const trimTokenQuotes = (value: string): string => value.replace(/^["',;]+/, '').replace(/["',;]+$/, '')

const HOME_PATH_MARKERS = [
  '$home',
  '${home',
  '%userprofile%',
  '%homepath%',
  '$xdg_',
  '${xdg_',
  '$tmp',
  '${tmp',
  '$temp',
  '${temp',
]

const NETWORK_OR_SUBSTITUTION_MARKERS = [
  'http://',
  'https://',
  'ftp://',
  'sftp://',
  'curl ',
  'wget ',
  'scp ',
  'ssh ',
  '$(',
]

const normalizeShellPathForCompare = (value: string): string =>
  value.replace(/^["']+/, '').replace(/["']+$/, '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

const isShellAbsolutePath = (value: string): boolean =>
  value.startsWith('/') || value.startsWith('\\\\') || value.charAt(1) === ':'

const agentWorkspaceDisplay = (projectRoot: string): string =>
  `${projectRoot}/${AGENT_WORKSPACE_DIR}`.replace(/\\/g, '/')

const tokenMentionsExternalLocation = (
  token: string,
  workspaceNorm: string,
  projectWorkspacePrefix: string,
): boolean => {
  const trimmed = trimTokenQuotes(token)
  if (trimmed === '') return false
  const lower = trimmed.toLowerCase()
  if (lower.startsWith('~') || HOME_PATH_MARKERS.some((marker) => lower.includes(marker))) {
    return true
  }
  if (
    trimmed === '..' ||
    trimmed.startsWith('../') ||
    trimmed.includes('/../') ||
    trimmed.endsWith('/..')
  ) {
    return true
  }
  const candidates = [trimmed]
  const assignment = trimmed.indexOf('=')
  if (assignment !== -1) candidates.push(trimmed.slice(assignment + 1))
  for (const candidate of candidates) {
    if (candidate === '' || !isShellAbsolutePath(candidate)) continue
    const normalized = normalizeShellPathForCompare(candidate)
    if (normalized === '') continue
    if (normalized === workspaceNorm || normalized.startsWith(`${workspaceNorm}/`)) continue
    if (
      normalized === projectWorkspacePrefix ||
      normalized.startsWith(`${projectWorkspacePrefix}/`)
    ) {
      continue
    }
    return true
  }
  return false
}

export const isShellCommandScopedToAgentWorkspace = (
  command: string,
  projectRoot: string,
): boolean => {
  const trimmed = command.trim()
  if (trimmed === '') return false
  const lower = trimmed.toLowerCase()
  if (
    NETWORK_OR_SUBSTITUTION_MARKERS.some((marker) => lower.includes(marker)) ||
    trimmed.includes('`')
  ) {
    return false
  }
  const workspaceNorm = normalizeShellPathForCompare(agentWorkspaceDisplay(projectRoot))
  const projectWorkspacePrefix = `${normalizeShellPathForCompare(projectRoot)}/${AGENT_WORKSPACE_DIR}`
  return tokenizeShellCommand(trimmed).every(
    (token) => !tokenMentionsExternalLocation(token, workspaceNorm, projectWorkspacePrefix),
  )
}

export const isShellCommandAllowedWithoutPrompt = (
  command: string,
  approved: ReadonlyArray<string>,
  projectRoot: string,
): boolean =>
  isShellCommandApproved(command, approved) ||
  isShellCommandScopedToAgentWorkspace(command, projectRoot)
