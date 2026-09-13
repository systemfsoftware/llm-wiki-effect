import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { Option, Schema } from 'effect'
import { Domain } from 'llm-wiki-protocol'

export const RPC_COMMAND = 'api_rpc'
export const CHAT_CANCEL_COMMAND = 'api_chat_cancel'
export const SHELL_APPROVAL_COMMAND = 'api_shell_approval'
export const AGENT_EVENT = 'agent-event'
export const WORKER_NOT_RUNNING = 'WorkerNotRunning'

const rpcWireError = Schema.Struct({
  _tag: Schema.String,
  message: Schema.String,
})

const rpcEnvelope = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), value: Schema.Unknown }),
  Schema.Struct({ ok: Schema.Literal(false), error: rpcWireError }),
])

export interface ApiRpcWireError {
  readonly _tag: string
  readonly message: string
}

export class RelayUnavailableError extends Error {
  readonly _tag = WORKER_NOT_RUNNING
  override readonly name = 'RelayUnavailableError'

  constructor(message = 'The LLM Wiki worker is not running.') {
    super(message)
  }
}

export class RelayError extends Error {
  readonly _tag: string
  override readonly name = 'RelayError'

  constructor(error: ApiRpcWireError) {
    super(error.message)
    this._tag = error._tag
  }
}

export function isRelayUnavailable(error: unknown): error is RelayUnavailableError {
  return error instanceof RelayUnavailableError
}

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error))

async function callCommand(
  command: string,
  args: Record<string, unknown>,
  operation: string,
): Promise<unknown> {
  let raw: unknown
  try {
    raw = await invoke<unknown>(command, args)
  } catch (error) {
    throw new RelayError({ _tag: 'Transport', message: `${operation} failed: ${describe(error)}` })
  }
  const envelope = Schema.decodeUnknownOption(rpcEnvelope)(raw)
  if (Option.isNone(envelope)) {
    throw new RelayError({
      _tag: 'ProtocolViolation',
      message: `Malformed ${operation} envelope from the LLM Wiki supervisor`,
    })
  }
  if (envelope.value.ok) return envelope.value.value
  if (envelope.value.error._tag === WORKER_NOT_RUNNING) {
    throw new RelayUnavailableError(envelope.value.error.message)
  }
  throw new RelayError(envelope.value.error)
}

async function callRpc(operation: string, payload: Record<string, unknown> | null): Promise<unknown> {
  return callCommand(RPC_COMMAND, { op: operation, payload }, operation)
}

async function call<A>(
  operation: string,
  payload: Record<string, unknown> | null,
  schema: Schema.ConstraintDecoder<A>,
): Promise<A> {
  const decoded = Schema.decodeUnknownOption(schema)(await callRpc(operation, payload))
  if (Option.isNone(decoded)) {
    throw new RelayError({
      _tag: 'ProtocolViolation',
      message: `Malformed ${operation} response from the LLM Wiki supervisor`,
    })
  }
  return decoded.value
}

export interface AgentEventPayload {
  readonly sessionId: string
  readonly runId?: string | undefined
  readonly event: Domain.AgentEvent
}

const agentEventEnvelope = Schema.Struct({
  sessionId: Schema.String,
  runId: Schema.optional(Schema.String),
  event: Domain.AgentEvent,
})

export interface AgentStreamMessage {
  readonly message: string
  readonly sessionId?: string
  readonly runId?: string
  readonly mode?: Domain.AgentMode
  readonly retrievalMode?: Domain.AgentRetrievalMode
  readonly skillMode?: Domain.AgentSkillMode
  readonly tools?: Domain.AgentToolOptions
  readonly topK?: number
  readonly includeContent?: boolean
  readonly history?: ReadonlyArray<{ readonly role: string; readonly content: string }>
  readonly historyExplicit?: boolean
  readonly skills?: ReadonlyArray<string>
  readonly contextFiles?: ReadonlyArray<string>
  readonly images?: ReadonlyArray<{ readonly mediaType: string; readonly dataBase64: string }>
  readonly persistSession?: boolean
}

const chatPayload = (input: AgentStreamMessage): Record<string, unknown> => ({
  message: input.message,
  ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
  ...(input.runId === undefined ? {} : { runId: input.runId }),
  ...(input.mode === undefined ? {} : { mode: input.mode }),
  ...(input.retrievalMode === undefined ? {} : { retrievalMode: input.retrievalMode }),
  ...(input.skillMode === undefined ? {} : { skillMode: input.skillMode }),
  ...(input.tools === undefined ? {} : { tools: input.tools }),
  ...(input.topK === undefined ? {} : { topK: input.topK }),
  ...(input.includeContent === undefined ? {} : { includeContent: input.includeContent }),
  ...(input.history === undefined ? {} : { history: input.history }),
  ...(input.historyExplicit === undefined ? {} : { historyExplicit: input.historyExplicit }),
  ...(input.skills === undefined ? {} : { skills: input.skills }),
  ...(input.contextFiles === undefined ? {} : { contextFiles: input.contextFiles }),
  ...(input.images === undefined ? {} : { images: input.images }),
  ...(input.persistSession === undefined ? {} : { persistSession: input.persistSession }),
})

export interface RelayClient {
  health(): Promise<Domain.Health>
  projects(): Promise<Domain.ProjectsResponse>
  files(input: {
    projectId: string
    root?: 'wiki' | 'sources' | 'all'
    recursive?: boolean
    maxFiles?: number
  }): Promise<Domain.FilesResponse>
  fileContent(input: { projectId: string; path: string }): Promise<Domain.FileContentResponse>
  reviews(input: {
    projectId: string
    status?: Domain.ReviewStatus
    type?: string
    limit?: number
  }): Promise<Domain.ReviewsResponse>
  patchReview(input: {
    projectId: string
    reviewId: string
    resolved?: boolean
    action?: string
  }): Promise<Domain.PatchReviewResponse>
  resolveReviews(input: {
    projectId: string
    ids: ReadonlyArray<string>
    action?: string
  }): Promise<Domain.ResolveReviewsResponse>
  search(input: {
    projectId: string
    query: string
    topK?: number
    includeContent?: boolean
  }): Promise<Domain.SearchResponse>
  graph(input: {
    projectId: string
    q?: string
    nodeType?: string
    limit?: number
  }): Promise<Domain.GraphResponse>
  rescanSources(input: { projectId: string }): Promise<Domain.RescanSourcesResponse>
  retryFileChange(input: {
    projectId: string
    taskId: string
  }): Promise<Domain.FileChangeQueueResponse>
  ignoreFileChange(input: {
    projectId: string
    taskId: string
  }): Promise<Domain.FileChangeQueueResponse>
  embedPage(input: {
    projectId: string
    path: string
    force?: boolean
  }): Promise<Domain.EmbedPageResponse>
  embedTexts(input: {
    texts: ReadonlyArray<string>
    provider?: string
  }): Promise<Domain.EmbedTextsResponse>
  vectorStats(input: { projectId: string }): Promise<Domain.VectorStatsResponse>
  vectorOptimize(input: { projectId: string }): Promise<Domain.VectorOptimizeResponse>
  vectorClear(input: { projectId: string }): Promise<Domain.VectorDeletedResponse>
  vectorDeletePage(input: {
    projectId: string
    pageId: string
  }): Promise<Domain.VectorDeletedResponse>
  vectorDropLegacy(input: { projectId: string }): Promise<Domain.VectorDropLegacyResponse>
  chat(input: AgentStreamMessage): Promise<Domain.ChatResponse>
  chatStream(input: AgentStreamMessage): Promise<void>
  chatCancel(input: { projectId: string; sessionId: string }): Promise<Domain.ChatCancelResponse>
  setCurrentProject(input: { projectId: string }): Promise<Domain.SetCurrentProjectResponse>
  reloadConfig(): Promise<Domain.ReloadConfigResponse>
}

export const apiRelayClient: RelayClient = {
  health: () => call('health', null, Domain.Health),
  projects: () => call('projects', null, Domain.ProjectsResponse),
  files: (input) =>
    call(
      'files',
      {
        projectId: input.projectId,
        ...(input.root === undefined ? {} : { root: input.root }),
        ...(input.recursive === undefined ? {} : { recursive: input.recursive }),
        ...(input.maxFiles === undefined ? {} : { maxFiles: input.maxFiles }),
      },
      Domain.FilesResponse,
    ),
  fileContent: (input) =>
    call(
      'fileContent',
      { projectId: input.projectId, path: input.path },
      Domain.FileContentResponse,
    ),
  reviews: (input) =>
    call(
      'reviews',
      {
        projectId: input.projectId,
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.type === undefined ? {} : { type: input.type }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      },
      Domain.ReviewsResponse,
    ),
  patchReview: (input) =>
    call(
      'patchReview',
      {
        projectId: input.projectId,
        reviewId: input.reviewId,
        ...(input.resolved === undefined ? {} : { resolved: input.resolved }),
        ...(input.action === undefined ? {} : { action: input.action }),
      },
      Domain.PatchReviewResponse,
    ),
  resolveReviews: (input) =>
    call(
      'resolveReviews',
      {
        projectId: input.projectId,
        ids: input.ids,
        ...(input.action === undefined ? {} : { action: input.action }),
      },
      Domain.ResolveReviewsResponse,
    ),
  search: (input) =>
    call(
      'search',
      {
        projectId: input.projectId,
        query: input.query,
        ...(input.topK === undefined ? {} : { topK: input.topK }),
        ...(input.includeContent === undefined ? {} : { includeContent: input.includeContent }),
      },
      Domain.SearchResponse,
    ),
  graph: (input) =>
    call(
      'graph',
      {
        projectId: input.projectId,
        ...(input.q === undefined ? {} : { q: input.q }),
        ...(input.nodeType === undefined ? {} : { nodeType: input.nodeType }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      },
      Domain.GraphResponse,
    ),
  rescanSources: (input) => call('rescanSources', { projectId: input.projectId }, Domain.RescanSourcesResponse),
  retryFileChange: (input) =>
    call(
      'retryFileChange',
      { projectId: input.projectId, taskId: input.taskId },
      Domain.FileChangeQueueResponse,
    ),
  ignoreFileChange: (input) =>
    call(
      'ignoreFileChange',
      { projectId: input.projectId, taskId: input.taskId },
      Domain.FileChangeQueueResponse,
    ),
  embedTexts: (input) =>
    call(
      'embedTexts',
      {
        texts: input.texts,
        ...(input.provider === undefined ? {} : { provider: input.provider }),
      },
      Domain.EmbedTextsResponse,
    ),
  vectorStats: (input) => call('vectorStats', { projectId: input.projectId }, Domain.VectorStatsResponse),
  vectorOptimize: (input) => call('vectorOptimize', { projectId: input.projectId }, Domain.VectorOptimizeResponse),
  vectorClear: (input) => call('vectorClear', { projectId: input.projectId }, Domain.VectorDeletedResponse),
  vectorDeletePage: (input) =>
    call(
      'vectorDeletePage',
      { projectId: input.projectId, pageId: input.pageId },
      Domain.VectorDeletedResponse,
    ),
  vectorDropLegacy: (input) =>
    call('vectorDropLegacy', { projectId: input.projectId }, Domain.VectorDropLegacyResponse),
  embedPage: (input) =>
    call(
      'embedPage',
      {
        projectId: input.projectId,
        path: input.path,
        ...(input.force === undefined ? {} : { force: input.force }),
      },
      Domain.EmbedPageResponse,
    ),
  chat: (input) => call('chat', chatPayload(input), Domain.ChatResponse),
  chatStream: async (input) => {
    await callRpc('chatStream', chatPayload(input))
  },
  chatCancel: (input) =>
    call(
      'chatCancel',
      { projectId: input.projectId, sessionId: input.sessionId },
      Domain.ChatCancelResponse,
    ),
  setCurrentProject: (input) =>
    call('setCurrentProject', { projectId: input.projectId }, Domain.SetCurrentProjectResponse),
  reloadConfig: () => call('reloadConfig', null, Domain.ReloadConfigResponse),
}

let injected: RelayClient | null = null

export function setRelayClient(client: RelayClient | null): void {
  injected = client
}

export function relay(): RelayClient {
  return injected ?? apiRelayClient
}

export async function subscribeAgentEvents(
  handler: (payload: AgentEventPayload) => void,
): Promise<UnlistenFn> {
  return listen<unknown>(AGENT_EVENT, (event) => {
    const decoded = Schema.decodeUnknownOption(agentEventEnvelope)(event.payload)
    if (decoded._tag === 'Some') handler(decoded.value)
  })
}

export async function cancelChatTurnBestEffort(projectId: string, sessionId: string): Promise<void> {
  try {
    await invoke<unknown>(CHAT_CANCEL_COMMAND, { projectId, sessionId })
  } catch {
    // A turn that already finished has nothing to cancel.
  }
}

export async function approveShellCommands(input: {
  projectId: string
  sessionId: string
  commands: readonly string[]
}): Promise<void> {
  await callCommand(
    SHELL_APPROVAL_COMMAND,
    {
      projectId: input.projectId,
      sessionId: input.sessionId,
      commands: [...input.commands],
    },
    'shell approval',
  )
}
