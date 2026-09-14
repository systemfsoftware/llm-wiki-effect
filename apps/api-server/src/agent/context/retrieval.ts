/**
 * Retrieval-mode budgets and signatures.
 *
 * Ported from `agent_loop_iteration_budget` / `agent_loop_retrieval_budget` /
 * `retrieval_signature` / `project_context_for_retrieval_mode` in
 * apps/desktop/src-tauri/src/agent/runtime.rs. The iteration budget is the
 * Rust mode budget capped by the configured `chatLimits.maxTurns`; at the
 * defaults of a standard, skill-less turn that is exactly
 * `MAX_AGENT_TOOL_ITERATIONS`.
 */
import { Domain } from 'llm-wiki-protocol'
import type { ProjectContext } from './project.js'

export const MAX_AGENT_TOOL_ITERATIONS = 8

export const modeLabel = (mode: Domain.AgentMode): string => {
  switch (mode) {
    case 'fast':
      return 'fast'
    case 'deep':
      return 'deep'
    case 'local_first':
      return 'local_first'
    default:
      return 'standard'
  }
}

export const agentLoopIterationBudget = (mode: Domain.AgentMode, hasSkills: boolean): number => {
  const base = mode === 'fast' ? 4 : mode === 'deep' ? 12 : MAX_AGENT_TOOL_ITERATIONS
  if (!hasSkills) return base
  return mode === 'fast' ? 8 : mode === 'deep' ? 20 : 16
}

export const agentLoopRetrievalBudget = (
  mode: Domain.AgentMode,
  retrievalMode: Domain.AgentRetrievalMode,
  hasExplicitSkills: boolean,
): number => {
  if (retrievalMode === 'faithful') {
    return mode === 'fast' ? 2 : mode === 'deep' ? 5 : 3
  }
  if (retrievalMode === 'smart') {
    return mode === 'fast' ? 3 : mode === 'deep' ? 6 : 4
  }
  const base = mode === 'fast' ? 2 : mode === 'deep' ? 8 : 4
  return hasExplicitSkills ? base + 4 : base
}

const RETRIEVAL_TOOLS: ReadonlyArray<string> = [
  'wiki.search',
  'wiki.read_page',
  'source.search',
  'graph.search',
  'web.search',
  'anytxt.search',
]

export const isAgentRetrievalTool = (tool: string): boolean => RETRIEVAL_TOOLS.includes(tool)

const toJsonString = (value: unknown): string | undefined => {
  try {
    return JSON.stringify(value)
  } catch {
    return undefined
  }
}

export const canonicalJson = (value: unknown): string => {
  if (value === undefined) return 'null'
  return toJsonString(value) ?? toJsonString({ value: value }) ?? `"<unserializable ${typeof value}>"`
}

const normalizeRetrievalQuery = (value: string): string =>
  value
    .toLowerCase()
    .split(/[\s\p{P}]/u)
    .filter((part) => part !== '')
    .join(' ')

export const retrievalSignature = (
  tool: string,
  input: Readonly<Record<string, unknown>>,
  mode: Domain.AgentRetrievalMode,
): string => {
  if (mode === 'standard') return `${tool}:${canonicalJson(input)}`
  const normalized: Record<string, unknown> = { ...input }
  const query = normalized['query']
  if (typeof query === 'string') normalized['query'] = normalizeRetrievalQuery(query)
  return `${tool}:${canonicalJson(normalized)}`
}

export const projectContextForRetrievalMode = (
  project: ProjectContext,
  retrievalMode: Domain.AgentRetrievalMode,
): ProjectContext => retrievalMode === 'faithful' ? { ...project, overview: undefined, schema: undefined } : project

export const smartEvidenceCount = (
  references: ReadonlyArray<Domain.ChatReference>,
): number => new Set(references.map((reference) => `${reference.kind}:${reference.path}`)).size

export const retrievalAddedEvidence = (
  tool: string,
  summary: string,
  referenceCountBefore: number,
  referenceCountAfter: number,
): boolean =>
  referenceCountAfter > referenceCountBefore ||
  (tool === 'wiki.read_page' && summary.trim() !== '')
