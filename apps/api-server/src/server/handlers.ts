/**
 * RPC handler table: one handler per `ApiProtocol` operation, each a thin
 * mapping onto the landed services (the retired Rust `handle_request` dispatch).
 */
import { Effect } from 'effect'
import { Domain } from 'llm-wiki-protocol'
import { ChatService } from '../chat/ChatService.js'
import { Config, DEFAULT_BIND_HOST } from '../config/Config.js'
import type { ConfigShape, ConfigValues } from '../config/Config.js'
import { Embeddings } from '../embeddings/Embeddings.js'
import { Files } from '../files/Files.js'
import { GraphBuilder } from '../graph/GraphBuilder.js'
import { ProjectRegistry } from '../projects/Registry.js'
import { ReviewsStore } from '../reviews/ReviewsStore.js'
import { Search } from '../search/Search.js'
import { VERSION } from '../version.js'
import { apiGroup } from './middleware.js'
import { RescanSources } from './rescan.js'

export type ServerEnv = Readonly<Record<string, string | undefined>>

export interface HealthSnapshotInput {
  readonly values: ConfigValues
  readonly env: ServerEnv
  readonly version?: string | undefined
}

export const healthSnapshot = (input: HealthSnapshotInput): Domain.Health =>
  new Domain.Health({
    ok: true,
    status: 'running',
    version: input.version ?? VERSION,
    authRequired: !input.values.allowUnauthenticated,
    authConfigured: input.values.token._tag === 'Some',
    tokenSource: input.values.token._tag === 'None'
      ? 'none'
      : (input.env['LLM_WIKI_API_TOKEN'] ?? '') !== ''
      ? 'env'
      : 'store',
    enabled: input.values.apiEnabled,
    mcpEnabled: input.values.mcpEnabled,
    allowUnauthenticated: input.values.allowUnauthenticated,
    allowLanAccess: input.values.bindHost !== DEFAULT_BIND_HOST,
    agent: new Domain.HealthAgent({ chat: true, streaming: true, streamProtocol: 'ndjson' }),
  })

const cachedValues = (config: ConfigShape): ConfigValues => ({
  token: config.token,
  apiEnabled: config.apiEnabled,
  mcpEnabled: config.mcpEnabled,
  allowUnauthenticated: config.allowUnauthenticated,
  projectRoots: config.projectRoots,
  currentProject: config.currentProject,
  chatLimits: config.chatLimits,
  embedding: config.embedding,
  providerCredentials: config.providerCredentials,
  bindHost: config.bindHost,
})

const optional = <K extends string, V>(
  key: K,
  value: V | undefined,
): Partial<Record<K, V>> => {
  const entries: Partial<Record<K, V>> = {}
  if (value !== undefined) entries[key] = value
  return entries
}

export const handlersLayer = (env: ServerEnv) =>
  apiGroup.toLayer(
    Effect.gen(function*() {
      const config = yield* Config
      const projects = yield* ProjectRegistry
      const files = yield* Files
      const reviews = yield* ReviewsStore
      const search = yield* Search
      const graph = yield* GraphBuilder
      const rescan = yield* RescanSources
      const embeddings = yield* Embeddings
      const chat = yield* ChatService

      const projectIdFor = (selector: string) =>
        Effect.gen(function*() {
          const root = yield* projects.resolveRoot(selector)
          const listed = yield* projects.list
          const match = listed.find((project) => project.path === root)
          return { id: match?.id ?? selector, root }
        })

      return {
        health: () => Effect.sync(() => healthSnapshot({ values: cachedValues(config), env })),

        projects: () =>
          Effect.map(projects.list, (listed) =>
            new Domain.ProjectsResponse({
              projects: listed,
              currentProject: listed.find((project) => project.current) ?? null,
            })),

        files: (payload: {
          readonly projectId: string
          readonly root?: 'wiki' | 'sources' | 'all' | undefined
          readonly recursive?: boolean | undefined
          readonly maxFiles?: number | undefined
        }) =>
          Effect.gen(function*() {
            const { root } = yield* projectIdFor(payload.projectId)
            const selector = payload.root ?? 'all'
            const listed = yield* files.list(root, selector, {
              ...optional('recursive', payload.recursive),
              ...optional('maxFiles', payload.maxFiles),
            })
            return new Domain.FilesResponse({
              projectId: payload.projectId,
              root: selector,
              files: listed,
              truncated: false,
            })
          }),

        fileContent: (payload: { readonly projectId: string; readonly path: string }) =>
          Effect.gen(function*() {
            const { root } = yield* projectIdFor(payload.projectId)
            const content = yield* files.readContent(root, payload.path)
            return new Domain.FileContentResponse({
              projectId: payload.projectId,
              path: content.path,
              content: content.content,
            })
          }),

        reviews: (payload: {
          readonly projectId: string
          readonly status?: Domain.ReviewStatus | undefined
          readonly type?: string | undefined
          readonly limit?: number | undefined
        }) =>
          reviews.list(payload.projectId, {
            ...optional('status', payload.status),
            ...optional('type', payload.type),
            ...optional('limit', payload.limit),
          }),

        patchReview: (payload: {
          readonly projectId: string
          readonly reviewId: string
          readonly resolved?: boolean | undefined
          readonly action?: string | undefined
        }) =>
          reviews.patch(payload.projectId, payload.reviewId, {
            ...optional('resolved', payload.resolved),
            ...optional('action', payload.action),
          }),

        resolveReviews: (payload: {
          readonly projectId: string
          readonly ids: ReadonlyArray<string>
          readonly action?: string | undefined
        }) => reviews.resolve(payload.projectId, payload.ids, payload.action),

        search: (payload: {
          readonly projectId: string
          readonly query: string
          readonly topK?: number | undefined
          readonly includeContent?: boolean | undefined
        }) =>
          search.search({
            projectId: payload.projectId,
            query: payload.query,
            ...optional('topK', payload.topK),
            ...optional('includeContent', payload.includeContent),
          }),

        graph: (payload: {
          readonly projectId: string
          readonly q?: string | undefined
          readonly nodeType?: string | undefined
          readonly limit?: number | undefined
        }) =>
          graph.build(payload.projectId, {
            ...optional('q', payload.q),
            ...optional('nodeType', payload.nodeType),
            ...optional('limit', payload.limit),
          }),

        rescanSources: (payload: { readonly projectId: string }) =>
          Effect.map(
            rescan.rescan(payload.projectId),
            (result) => new Domain.RescanSourcesResponse({ projectId: payload.projectId, result }),
          ),

        embedPage: (payload: {
          readonly projectId: string
          readonly path: string
          readonly force?: boolean | undefined
        }) =>
          Effect.map(
            embeddings.embedPage(payload.projectId, payload.path, payload.force ?? false),
            (result) => new Domain.EmbedPageResponse({ projectId: payload.projectId, result }),
          ),

        chat: (payload: Parameters<typeof chat.chat>[0]) => chat.chat(payload),

        chatStream: (payload: Parameters<typeof chat.chatStream>[0]) => chat.chatStream(payload),

        chatCancel: (payload: { readonly projectId: string; readonly sessionId: string }) => chat.chatCancel(payload),

        setCurrentProject: (payload: { readonly projectId: string }) =>
          Effect.map(
            projects.setCurrent(payload.projectId),
            (project) => new Domain.SetCurrentProjectResponse({ project }),
          ),

        reloadConfig: () => Effect.map(config.reload, () => new Domain.ReloadConfigResponse({ reloaded: true })),
      }
    }),
  )
