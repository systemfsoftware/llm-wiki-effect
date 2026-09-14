import { NodeHttpClient } from '@effect/platform-node'
import { Cause, Effect, Exit, Layer } from 'effect'
import { Client, Domain, Errors } from 'llm-wiki-protocol'

export const SOCKET_PATH_ENV = 'LLM_WIKI_SOCKET_PATH'
export const BASE_URL_ENV = 'LLM_WIKI_BASE_URL'
export const API_TOKEN_ENV = 'LLM_WIKI_API_TOKEN'

const RPC_PATH = '/rpc'

const MISSING_ENDPOINT = `No LLM Wiki API endpoint is configured. Set ${SOCKET_PATH_ENV} to the desktop worker's ` +
  `socket path, or ${BASE_URL_ENV} to the standalone API base URL.`

export interface FilesRequest {
  readonly projectId: string
  readonly root: 'wiki' | 'sources' | 'all'
  readonly recursive?: boolean | undefined
  readonly maxFiles?: number | undefined
}

export interface FileContentRequest {
  readonly projectId: string
  readonly path: string
}

export interface ReviewsRequest {
  readonly projectId: string
  readonly status: 'unresolved' | 'resolved' | 'all'
  readonly type?: string | undefined
  readonly limit?: number | undefined
}

export interface SearchRequest {
  readonly projectId: string
  readonly query: string
  readonly topK?: number | undefined
  readonly includeContent?: boolean | undefined
}

export interface ChatRequest {
  readonly message: string
  readonly sessionId?: string | undefined
  readonly persistSession?: boolean | undefined
  readonly mode?: Domain.AgentMode | undefined
  readonly topK?: number | undefined
  readonly includeContent?: boolean | undefined
  readonly tools: { readonly wiki: boolean; readonly web: boolean; readonly anytxt: boolean }
  readonly skills?: ReadonlyArray<string> | undefined
}

export interface ChatCancelRequest {
  readonly projectId: string
  readonly sessionId: string
}

export interface GraphRequest {
  readonly projectId: string
  readonly q?: string | undefined
  readonly nodeType?: string | undefined
  readonly limit?: number | undefined
}

export interface RescanSourcesRequest {
  readonly projectId: string
}

export interface EmbedPageRequest {
  readonly projectId: string
  readonly path: string
  readonly force: boolean
}

export interface LlmWikiApi {
  health(): Effect.Effect<Domain.Health, unknown>
  projects(): Effect.Effect<Domain.ProjectsResponse, unknown>
  files(request: FilesRequest): Effect.Effect<Domain.FilesResponse, unknown>
  fileContent(request: FileContentRequest): Effect.Effect<Domain.FileContentResponse, unknown>
  reviews(request: ReviewsRequest): Effect.Effect<Domain.ReviewsResponse, unknown>
  search(request: SearchRequest): Effect.Effect<Domain.SearchResponse, unknown>
  chat(request: ChatRequest): Effect.Effect<Domain.ChatResponse, unknown>
  chatCancel(request: ChatCancelRequest): Effect.Effect<Domain.ChatCancelResponse, unknown>
  graph(request: GraphRequest): Effect.Effect<Domain.GraphResponse, unknown>
  rescanSources(request: RescanSourcesRequest): Effect.Effect<Domain.RescanSourcesResponse, unknown>
  embedPage(request: EmbedPageRequest): Effect.Effect<Domain.EmbedPageResponse, unknown>
}

const protocolApi = (client: Client.ApiClient): LlmWikiApi => ({
  health: () => client.health(undefined),
  projects: () => client.projects(undefined),
  files: (request) => client.files(request),
  fileContent: (request) => client.fileContent(request),
  reviews: (request) => client.reviews(request),
  search: (request) => client.search(request),
  chat: (request) => client.chat(request),
  chatCancel: (request) => client.chatCancel(request),
  graph: (request) => client.graph(request),
  rescanSources: (request) => client.rescanSources(request),
  embedPage: (request) => client.embedPage(request),
})

export interface LlmWikiApiClientOptions {
  readonly socketPath?: string | undefined
  readonly baseUrl?: string | undefined
  readonly token?: string | undefined
  readonly api?: LlmWikiApi | undefined
}

export type LlmWikiTransport =
  | { readonly mode: 'socket'; readonly path: string }
  | { readonly mode: 'http'; readonly url: string; readonly token: string | undefined }

export const resolveTransport = (options: LlmWikiApiClientOptions): LlmWikiTransport | null => {
  const socketPath = options.socketPath?.trim() ?? ''
  if (socketPath !== '') return { mode: 'socket', path: socketPath }
  const baseUrl = options.baseUrl?.trim().replace(/\/+$/, '') ?? ''
  if (baseUrl === '') return null
  return {
    mode: 'http',
    url: baseUrl.endsWith(RPC_PATH) ? baseUrl : `${baseUrl}${RPC_PATH}`,
    token: options.token?.trim() || undefined,
  }
}

export class LlmWikiApiError extends Error {
  readonly tag: string | null

  constructor(tag: string | null, message: string) {
    super(message)
    this.name = 'LlmWikiApiError'
    this.tag = tag
  }
}

const protocolErrorTags: Readonly<Record<string, true>> = Object.fromEntries(
  Errors.ApiErrorTag.literals.map((tag) => [tag, true]),
)

const errorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message
  return typeof error === 'string' ? error : String(error)
}

const protocolErrorTag = (error: unknown): string | null => {
  if (!(error instanceof Error)) return null
  const tag = Reflect.get(error, '_tag')
  return typeof tag === 'string' && protocolErrorTags[tag] === true ? tag : null
}

const transportMessage = (error: unknown): string =>
  `LLM Wiki API request failed. Is the desktop app running? ${errorMessage(error)}`

const toApiError = (cause: Cause.Cause<unknown>): LlmWikiApiError => {
  const fail = cause.reasons.find((reason) => reason._tag === 'Fail')
  if (fail !== undefined && fail._tag === 'Fail') {
    const tag = protocolErrorTag(fail.error)
    if (tag !== null) {
      return new LlmWikiApiError(tag, `LLM Wiki API ${tag}: ${errorMessage(fail.error)}`)
    }
    return new LlmWikiApiError(null, transportMessage(fail.error))
  }
  const defect = cause.reasons.find((reason) => reason._tag === 'Die')
  if (defect !== undefined && defect._tag === 'Die') {
    return new LlmWikiApiError(null, transportMessage(defect.defect))
  }
  return new LlmWikiApiError(null, 'LLM Wiki API request was interrupted.')
}

const httpTransportLayer = (url: string, token: string | undefined): Layer.Layer<Client.HttpApiClient> =>
  Client.HttpApiClient.layer({ url, token }).pipe(Layer.provide(NodeHttpClient.layerNodeHttp))

export type ApiProject = Domain.Project
export type ApiFileNode = Domain.FileNode
export type ApiSearchResult = Domain.SearchResult
export type ApiGraphNode = Domain.GraphNode
export type ApiReviewItem = Domain.ReviewItem
export type ApiReviewsResponse = Domain.ReviewsResponse
export type ApiChatResponse = Domain.ChatResponse

export interface FilesOptions {
  readonly root?: 'wiki' | 'sources' | 'all' | undefined
  readonly recursive?: boolean | undefined
  readonly maxFiles?: number | undefined
}

export interface ReviewsOptions {
  readonly status?: Domain.ReviewStatus | undefined
  readonly type?: string | undefined
  readonly limit?: number | undefined
}

export interface SearchOptions {
  readonly topK?: number | undefined
  readonly includeContent?: boolean | undefined
}

export interface ChatOptions {
  readonly sessionId?: string | undefined
  readonly mode?: Domain.AgentMode | undefined
  readonly topK?: number | undefined
  readonly includeContent?: boolean | undefined
  readonly wiki?: boolean | undefined
  readonly web?: boolean | undefined
  readonly anytxt?: boolean | undefined
  readonly skills?: ReadonlyArray<string> | undefined
  readonly persistSession?: boolean | undefined
}

export interface GraphOptions {
  readonly q?: string | undefined
  readonly nodeType?: string | undefined
  readonly limit?: number | undefined
}

export class LlmWikiApiClient {
  private readonly socketPath: string | undefined
  private readonly baseUrl: string | undefined
  private readonly token: string | undefined
  private readonly seam: LlmWikiApi | undefined

  constructor(options: LlmWikiApiClientOptions = {}) {
    this.socketPath = options.socketPath ?? process.env[SOCKET_PATH_ENV]
    this.baseUrl = options.baseUrl ?? process.env[BASE_URL_ENV]
    this.token = options.token ?? process.env[API_TOKEN_ENV]
    this.seam = options.api
  }

  get endpoint(): string {
    const transport = resolveTransport(this.options())
    if (transport === null) return `no endpoint configured (set ${SOCKET_PATH_ENV} or ${BASE_URL_ENV})`
    return transport.mode === 'socket' ? `unix socket ${transport.path}` : transport.url
  }

  async health(): Promise<Domain.Health> {
    return this.request((api) => api.health())
  }

  async projects(): Promise<Domain.ProjectsResponse> {
    return this.request((api) => api.projects())
  }

  async files(projectId = 'current', options: FilesOptions = {}): Promise<Domain.FilesResponse> {
    return this.request((api) =>
      api.files({
        projectId,
        root: options.root ?? 'wiki',
        ...(options.recursive === undefined ? {} : { recursive: options.recursive }),
        ...(options.maxFiles === undefined ? {} : { maxFiles: options.maxFiles }),
      })
    )
  }

  async fileContent(projectId = 'current', path: string): Promise<Domain.FileContentResponse> {
    return this.request((api) => api.fileContent({ projectId, path }))
  }

  async reviews(projectId = 'current', options: ReviewsOptions = {}): Promise<Domain.ReviewsResponse> {
    return this.request((api) =>
      api.reviews({
        projectId,
        status: options.status ?? 'unresolved',
        ...(options.type === undefined ? {} : { type: options.type }),
        ...(options.limit === undefined ? {} : { limit: options.limit }),
      })
    )
  }

  async search(projectId = 'current', query: string, options: SearchOptions = {}): Promise<Domain.SearchResponse> {
    return this.request((api) =>
      api.search({
        projectId,
        query,
        ...(options.topK === undefined ? {} : { topK: options.topK }),
        ...(options.includeContent === undefined ? {} : { includeContent: options.includeContent }),
      })
    )
  }

  async chat(projectId = 'current', message: string, options: ChatOptions = {}): Promise<Domain.ChatResponse> {
    return this.request((api) =>
      api.chat({
        message,
        ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
        ...(options.persistSession === undefined ? {} : { persistSession: options.persistSession }),
        ...(options.mode === undefined ? {} : { mode: options.mode }),
        ...(options.topK === undefined ? {} : { topK: options.topK }),
        ...(options.includeContent === undefined ? {} : { includeContent: options.includeContent }),
        tools: {
          wiki: options.wiki ?? true,
          web: options.web ?? false,
          anytxt: options.anytxt ?? false,
        },
        ...(options.skills === undefined ? {} : { skills: options.skills }),
      })
    )
  }

  async cancelChat(projectId = 'current', sessionId: string): Promise<Domain.ChatCancelResponse> {
    return this.request((api) => api.chatCancel({ projectId, sessionId }))
  }

  async graph(projectId = 'current', options: GraphOptions = {}): Promise<Domain.GraphResponse> {
    return this.request((api) =>
      api.graph({
        projectId,
        ...(options.q ? { q: options.q } : {}),
        ...(options.nodeType ? { nodeType: options.nodeType } : {}),
        ...(options.limit === undefined ? {} : { limit: options.limit }),
      })
    )
  }

  async rescan(projectId = 'current'): Promise<Domain.RescanSourcesResponse> {
    return this.request((api) => api.rescanSources({ projectId }))
  }

  async embedPage(path: string, projectId = 'current', force = false): Promise<Domain.PageEmbeddingResult> {
    const response = await this.request((api) => api.embedPage({ projectId, path, force }))
    return response.result
  }

  private options(): LlmWikiApiClientOptions {
    return { socketPath: this.socketPath, baseUrl: this.baseUrl, token: this.token }
  }

  private async request<A>(run: (api: LlmWikiApi) => Effect.Effect<A, unknown>): Promise<A> {
    const exit = await Effect.runPromise(Effect.exit(this.call(run)))
    if (Exit.isSuccess(exit)) return exit.value
    throw toApiError(exit.cause)
  }

  private call<A>(run: (api: LlmWikiApi) => Effect.Effect<A, unknown>): Effect.Effect<A, unknown> {
    if (this.seam !== undefined) return run(this.seam)
    const transport = resolveTransport(this.options())
    if (transport === null) throw new LlmWikiApiError(null, MISSING_ENDPOINT)
    if (transport.mode === 'socket') {
      return Effect.gen(function*() {
        const client = yield* Client.SocketApiClient
        return yield* run(protocolApi(client))
      }).pipe(
        Effect.provide(
          Client.SocketApiClient.layer({ path: transport.path, retryTransientErrors: true }),
        ),
      )
    }
    return Effect.gen(function*() {
      const client = yield* Client.HttpApiClient
      return yield* run(protocolApi(client))
    }).pipe(Effect.provide(httpTransportLayer(transport.url, transport.token)))
  }
}
