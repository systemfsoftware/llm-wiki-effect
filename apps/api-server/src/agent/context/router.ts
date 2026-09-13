/**
 * Conservative query router.
 *
 * Ported from apps/desktop/src-tauri/src/agent/router.rs: the router labels an
 * intent and exposes tool hints for the prompt, but never infers retrieval from
 * message shape alone — the model planner decides whether a tool runs.
 */
import { Domain } from 'llm-wiki-protocol'

export type QueryIntent =
  | 'needs_internal_search'
  | 'needs_external_search'
  | 'needs_raw_source_search'
  | 'needs_graph'
  | 'needs_write'
  | 'simple_conversational'
  | 'ambiguous'

export interface RouterDecision {
  readonly intent: QueryIntent
  readonly shouldSearchWiki: boolean
  readonly shouldHintWeb: boolean
  readonly shouldHintAnytxt: boolean
  readonly shouldIncludeSources: boolean
  readonly rationale: string
}

const containsAny = (haystack: string, needles: ReadonlyArray<string>): boolean =>
  needles.some((needle) => haystack.includes(needle))

const WEB_HINTS = [
  'web search',
  'search the web',
  'internet',
  'online',
  'latest',
  'today',
  '新闻',
  '联网',
  '网上',
  '最新',
]
const RAW_HINTS = ['raw source', 'source file', '原始资料', '原始文件', '源文件']
const GRAPH_HINTS = ['graph', 'relationship', '知识图谱', '关系图']
const WRITE_HINTS = ['write to wiki', 'create page', '写入', '创建页面']
const CONVERSATIONAL_HINTS = ['hi', 'hello', 'thanks', '谢谢', '你好', '好的', 'ok']

const rationaleFor = (intent: QueryIntent): string => {
  switch (intent) {
    case 'needs_external_search':
      return 'User appears to request current/external information.'
    case 'simple_conversational':
      return 'Short conversational turn; avoid unnecessary retrieval.'
    case 'needs_raw_source_search':
      return 'User explicitly referenced raw/source material.'
    case 'needs_graph':
      return 'User asks about graph/relationships.'
    case 'needs_write':
      return 'User asks to create or update wiki content.'
    case 'needs_internal_search':
      return 'User question likely benefits from project retrieval.'
    default:
      return 'Ambiguous request; let the tool planner decide whether retrieval is useful.'
  }
}

export const routeQuery = (
  message: string,
  mode: Domain.AgentMode,
  tools: Domain.AgentToolOptions,
): RouterDecision => {
  const lower = message.toLowerCase()
  const trimmed = message.trim()
  const explicitWeb = containsAny(lower, WEB_HINTS)
  const explicitRaw = containsAny(lower, RAW_HINTS)
  const explicitGraph = containsAny(lower, GRAPH_HINTS)
  const explicitWrite = containsAny(lower, WRITE_HINTS)
  const conversational = trimmed.length < 32 && containsAny(lower, CONVERSATIONAL_HINTS)

  const intent: QueryIntent = explicitWrite
    ? 'needs_write'
    : explicitGraph
    ? 'needs_graph'
    : explicitRaw
    ? 'needs_raw_source_search'
    : explicitWeb
    ? 'needs_external_search'
    : conversational
    ? 'simple_conversational'
    : 'ambiguous'

  return {
    intent,
    shouldSearchWiki: false,
    shouldHintWeb: tools.web,
    shouldHintAnytxt: tools.anytxt,
    shouldIncludeSources: explicitRaw || mode === 'deep',
    rationale: rationaleFor(intent),
  }
}
