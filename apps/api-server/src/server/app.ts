import { Context, Effect, Layer, Scope } from 'effect'
import { HttpClient } from 'effect/unstable/http'
import { Errors } from 'llm-wiki-protocol'
import { Redactor } from '../agent/redaction/Redactor.js'
import { AgentRuntime, agentRuntimeLayer } from '../agent/runtime/AgentRuntime.js'
import type { AgentRuntimeOptions } from '../agent/runtime/AgentRuntime.js'
import { CancelRegistry } from '../agent/sessions/CancelRegistry.js'
import { SessionStore } from '../agent/sessions/SessionStore.js'
import { Auth } from '../auth/auth.js'
import { Gate } from '../auth/gate.js'
import { RateLimiter } from '../auth/limits.js'
import type { RateLimiterOptions } from '../auth/limits.js'
import { ChatService } from '../chat/ChatService.js'
import { Config } from '../config/Config.js'
import type { ConfigInput, ConfigShape } from '../config/Config.js'
import { Embeddings } from '../embeddings/Embeddings.js'
import type { EmbeddingTransport } from '../embeddings/Embeddings.js'
import { lanceVectorStore, VectorIndex } from '../embeddings/vector-store.js'
import type { VectorStore as EmbeddingVectorStore } from '../embeddings/vector-store.js'
import { Files } from '../files/Files.js'
import { GraphBuilder } from '../graph/GraphBuilder.js'
import { ProjectRegistry } from '../projects/Registry.js'
import { ProviderClient } from '../provider/provider-client.js'
import type { ProviderClientShape } from '../provider/provider-client.js'
import { providerClientLayer } from '../provider/provider-layer.js'
import { ReviewsStore } from '../reviews/ReviewsStore.js'
import { Search } from '../search/Search.js'
import type { SearchOptions } from '../search/Search.js'
import { makeVectorStore } from '../search/vector.js'
import type { ServerEnv } from './handlers.js'
import { RescanSources } from './rescan.js'
import type { RescanOptions } from './rescan.js'
import { httpEmbeddingTransport, httpQueryEmbedder } from './transports.js'

export interface ServerAppInput {
  readonly config: ConfigInput
  readonly env?: ServerEnv | undefined
  readonly registryStatePath?: string | undefined
  readonly agent: AgentRuntimeOptions
  readonly rateLimit?: RateLimiterOptions | undefined
  readonly rescan?: RescanOptions | undefined
  readonly embeddings?: {
    readonly transport?: EmbeddingTransport | undefined
    readonly store?: EmbeddingVectorStore | undefined
  } | undefined
  readonly search?: SearchOptions | undefined
  readonly providerClient?: ProviderClientShape | undefined
}

class EmbeddingTransportService extends Context.Service<EmbeddingTransportService, EmbeddingTransport>()(
  'llm-wiki-api-server/server/EmbeddingTransport',
) {}

export type AppService =
  | Config
  | EmbeddingTransportService
  | ProjectRegistry
  | Files
  | ReviewsStore
  | GraphBuilder
  | Search
  | RescanSources
  | Embeddings
  | VectorIndex
  | ProviderClient
  | SessionStore
  | CancelRegistry
  | Redactor
  | AgentRuntime
  | ChatService
  | Auth
  | Gate
  | RateLimiter

export type AppContext = Context.Context<AppService>

export const appLayer = (
  input: ServerAppInput,
): Layer.Layer<AppService, Errors.InvalidRequest, HttpClient.HttpClient> => {
  const configLayer = Config.layer(input.config)

  const registryLayer = Layer.effect(
    ProjectRegistry,
    Effect.gen(function*() {
      const config = yield* Config
      return yield* ProjectRegistry.make(
        config,
        input.registryStatePath === undefined ? {} : { statePath: input.registryStatePath },
      )
    }),
  ).pipe(Layer.provide(configLayer))

  const transportLayer = input.embeddings?.transport === undefined
    ? Layer.effect(
      EmbeddingTransportService,
      Effect.map(HttpClient.HttpClient, httpEmbeddingTransport),
    )
    : Layer.succeed(EmbeddingTransportService, input.embeddings.transport)

  const embeddingStore = input.embeddings?.store ?? lanceVectorStore

  const embeddingsLayer = Layer.effect(
    Embeddings,
    Effect.gen(function*() {
      const config = yield* Config
      const registry = yield* ProjectRegistry
      const transport = yield* EmbeddingTransportService
      return Embeddings.make({ config, registry, transport, store: embeddingStore })
    }),
  )

  const searchLayer = Layer.effect(
    Search,
    Effect.gen(function*() {
      const config: ConfigShape = yield* Config
      const registry = yield* ProjectRegistry
      const vector = input.search?.vector ?? makeVectorStore()
      const embedQuery = input.search?.embedQuery ??
        httpQueryEmbedder(yield* EmbeddingTransportService, config)
      return yield* Search.make(registry, config, { ...input.search, vector, embedQuery })
    }),
  )

  const providerClient = input.providerClient
  const providerLayer = providerClient === undefined
    ? providerClientLayer
    : Layer.succeed(ProviderClient, providerClient)

  const shared = Layer.mergeAll(
    configLayer,
    registryLayer,
    Files.layer,
    SessionStore.layer,
    CancelRegistry.layer,
    Redactor.layer,
    transportLayer,
  )

  const provider = providerLayer.pipe(Layer.provide(shared))

  const runtime = agentRuntimeLayer(input.agent).pipe(
    Layer.provide(Layer.mergeAll(shared, provider)),
  )

  return Layer.mergeAll(
    shared,
    ReviewsStore.layer.pipe(Layer.provide(shared)),
    GraphBuilder.layer.pipe(Layer.provide(shared)),
    RescanSources.layer(input.rescan).pipe(Layer.provide(shared)),
    embeddingsLayer.pipe(Layer.provide(shared)),
    VectorIndex.layer(),
    searchLayer.pipe(Layer.provide(shared)),
    provider,
    runtime,
    ChatService.layer.pipe(Layer.provide(Layer.mergeAll(shared, runtime))),
    Auth.layer.pipe(Layer.provide(configLayer)),
    Gate.layer.pipe(Layer.provide(configLayer)),
    RateLimiter.layer(input.rateLimit),
  )
}

export const buildApp = (
  input: ServerAppInput,
): Effect.Effect<AppContext, Errors.InvalidRequest, HttpClient.HttpClient | Scope.Scope> => Layer.build(appLayer(input))
