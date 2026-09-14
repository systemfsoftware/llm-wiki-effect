/**
 * Model loop-action parsing.
 *
 * Ported from `parse_agent_loop_action` / `normalize_agent_loop_action` in
 * apps/desktop/src-tauri/src/agent/runtime.rs: the loop accepts one compact
 * JSON action per model turn, tolerates a JSON object embedded in prose, and
 * classifies unparseable tool-shaped text as `invalid_tool_json` so the model
 * gets one repair turn instead of the turn dying.
 */
import { isRecord } from '../../json.js'
import { looksLikeAgentToolJson } from '../context/prompt.js'

export interface AgentLoopAction {
  readonly action: string
  readonly tool?: string | undefined
  readonly answer?: string | undefined
  readonly title?: string | undefined
  readonly description?: string | undefined
  readonly query?: string | undefined
  readonly skill?: string | undefined
  readonly command?: string | undefined
  readonly timeoutSeconds?: number | undefined
  readonly path?: string | undefined
  readonly content?: string | undefined
  readonly allowOverwrite?: boolean | undefined
  readonly includeContent?: boolean | undefined
  readonly topK?: number | undefined
  readonly fields?: unknown
  readonly questions?: unknown
}

export const INVALID_TOOL_JSON = 'invalid_tool_json'

const LOOP_TOOL_NAMES: ReadonlyArray<string> = [
  'wiki.search',
  'wiki.read_page',
  'wiki.write_page',
  'source.search',
  'graph.search',
  'web.search',
  'anytxt.search',
  'skill.read_file',
  'workspace.write_file',
  'workspace.append_file',
  'shell.exec',
  'deep_research.run',
  'user.ask',
]

const USER_ASK_ALIASES: ReadonlyArray<string> = [
  'user.ask',
  'user_input.ask',
  'askUserQuestion',
  'AskUserQuestion',
  'ask_user_question',
]

export const isUserAskTool = (tool: string): boolean => USER_ASK_ALIASES.includes(tool.trim())

export const isAgentLoopToolName = (value: string): boolean => LOOP_TOOL_NAMES.includes(value) || isUserAskTool(value)

const asString = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)

const asBoolean = (value: unknown): boolean | undefined => (typeof value === 'boolean' ? value : undefined)

const asInteger = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined

const oneOf = (value: unknown, keys: ReadonlyArray<string>): unknown => {
  if (!isRecord(value)) return undefined
  for (const key of keys) {
    if (value[key] !== undefined && value[key] !== null) return value[key]
  }
  return undefined
}

const fromJson = (value: unknown): AgentLoopAction => ({
  action: asString(oneOf(value, ['action'])) ?? '',
  tool: asString(oneOf(value, ['tool'])),
  answer: asString(oneOf(value, ['answer'])),
  title: asString(oneOf(value, ['title'])),
  description: asString(oneOf(value, ['description'])),
  query: asString(oneOf(value, ['query'])),
  skill: asString(oneOf(value, ['skill'])),
  command: asString(oneOf(value, ['command'])),
  timeoutSeconds: asInteger(oneOf(value, ['timeoutSeconds', 'timeout_seconds'])),
  path: asString(oneOf(value, ['path'])),
  content: asString(oneOf(value, ['content'])),
  allowOverwrite: asBoolean(oneOf(value, ['allowOverwrite', 'allow_overwrite'])),
  includeContent: asBoolean(oneOf(value, ['includeContent', 'include_content'])),
  topK: asInteger(oneOf(value, ['topK', 'top_k'])),
  fields: oneOf(value, ['fields']),
  questions: oneOf(value, ['questions']),
})

const extractJsonObject = (raw: string): string | undefined => {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  return start === -1 || end <= start ? undefined : raw.slice(start, end + 1)
}

export const normalizeAgentLoopAction = (action: AgentLoopAction): AgentLoopAction => {
  let normalized = action
  const trimmedAction = normalized.action.trim()
  if (normalized.tool === undefined && isAgentLoopToolName(trimmedAction)) {
    normalized = { ...normalized, tool: trimmedAction, action: 'tool' }
  }
  if (normalized.tool !== undefined && isAgentLoopToolName(normalized.tool)) {
    normalized = { ...normalized, action: 'tool' }
  }
  if (normalized.action.trim() === '') {
    normalized = { ...normalized, action: normalized.tool === undefined ? 'final' : 'tool' }
  }
  if (normalized.tool !== undefined && isUserAskTool(normalized.tool)) {
    normalized = { ...normalized, tool: 'user.ask' }
  }
  return normalized
}

export const parseAgentLoopAction = (raw: string): AgentLoopAction => {
  const trimmed = raw.trim()
  for (const candidate of [trimmed, extractJsonObject(trimmed)]) {
    if (candidate === undefined) continue
    try {
      const parsed: unknown = JSON.parse(candidate)
      if (isRecord(parsed)) return normalizeAgentLoopAction(fromJson(parsed))
    } catch {
      continue
    }
  }
  return normalizeAgentLoopAction({
    action: INVALID_TOOL_JSON,
    answer: looksLikeAgentToolJson(trimmed)
      ? 'Invalid or truncated Agent tool JSON. Return one complete compact JSON object. For large generated files, initialize with workspace.write_file and continue with workspace.append_file chunks instead of putting the whole file or heredocs in one JSON object.'
      : 'Agent loop responses must be compact JSON. Return either a tool action like {"action":"tool","tool":"wiki.read_page","path":"..."} or a final action like {"action":"final","answer":"..."}. Do not return plain text.',
  })
}
