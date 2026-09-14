import { Layer, Schema } from 'effect'
import { Rpc, RpcGroup, RpcSerialization } from 'effect/unstable/rpc'
import type { RpcClient, RpcClientError } from 'effect/unstable/rpc'
import {
  ChatCancelResponse,
  ChatResponse,
  ChatStreamEvent,
  EmbedPageResponse,
  EmbedTextsResponse,
  FileChangeQueueResponse,
  FileContentResponse,
  FilesResponse,
  GraphResponse,
  Health,
  PatchReviewResponse,
  ProjectsResponse,
  ReloadConfigResponse,
  RescanSourcesResponse,
  ResolveReviewsResponse,
  ReviewsResponse,
  SearchResponse,
  SetCurrentProjectResponse,
  VectorDeletedResponse,
  VectorDropLegacyResponse,
  VectorOptimizeResponse,
  VectorStatsResponse,
} from './domain/index.js'
import {
  AgentError,
  ApiDisabled,
  Busy,
  ChatCancelled,
  EmbedError,
  InvalidRequest,
  McpDisabled,
  NotFound,
  PathViolation,
  RateLimited,
  TooLarge,
  Unauthorized,
  UnsupportedMediaType,
} from './errors/index.js'
import {
  ChatCancelPayload,
  ChatPayload,
  EmbedPagePayload,
  EmbedTextsPayload,
  FileChangesPayload,
  FileChangeTaskPayload,
  FileContentPayload,
  FilesPayload,
  GraphPayload,
  PatchReviewPayload,
  RescanSourcesPayload,
  ResolveReviewsPayload,
  ReviewsPayload,
  SearchPayload,
  SetCurrentProjectPayload,
  VectorDeletePagePayload,
  VectorProjectPayload,
} from './rpc.schema.js'

export * from './rpc.schema.js'

export const ApiSerialization: RpcSerialization.RpcSerialization['Service'] = RpcSerialization.ndjson

export const ApiSerializationLayer: Layer.Layer<RpcSerialization.RpcSerialization> = RpcSerialization.layerNdjson

const requestErrors = <Extra extends ReadonlyArray<Schema.Top>>(...extra: Extra) =>
  Schema.Union(
    [
      Unauthorized,
      ApiDisabled,
      NotFound,
      InvalidRequest,
      RateLimited,
      Busy,
      ...extra,
    ] as const,
  )

const mcpRequestErrors = <Extra extends ReadonlyArray<Schema.Top>>(...extra: Extra) =>
  Schema.Union(
    [
      Unauthorized,
      ApiDisabled,
      McpDisabled,
      NotFound,
      InvalidRequest,
      RateLimited,
      Busy,
      ...extra,
    ] as const,
  )

export const HealthRpc = Rpc.make('health', { success: Health })

export const ProjectsRpc = Rpc.make('projects', {
  success: ProjectsResponse,
  error: mcpRequestErrors(),
})

export const FilesRpc = Rpc.make('files', {
  payload: FilesPayload,
  success: FilesResponse,
  error: mcpRequestErrors(PathViolation, TooLarge),
})

export const FileContentRpc = Rpc.make('fileContent', {
  payload: FileContentPayload,
  success: FileContentResponse,
  error: mcpRequestErrors(PathViolation, UnsupportedMediaType, TooLarge),
})

export const ReviewsRpc = Rpc.make('reviews', {
  payload: ReviewsPayload,
  success: ReviewsResponse,
  error: mcpRequestErrors(),
})

export const PatchReviewRpc = Rpc.make('patchReview', {
  payload: PatchReviewPayload,
  success: PatchReviewResponse,
  error: requestErrors(),
})

export const ResolveReviewsRpc = Rpc.make('resolveReviews', {
  payload: ResolveReviewsPayload,
  success: ResolveReviewsResponse,
  error: requestErrors(),
})

export const SearchRpc = Rpc.make('search', {
  payload: SearchPayload,
  success: SearchResponse,
  error: mcpRequestErrors(EmbedError),
})

export const GraphRpc = Rpc.make('graph', {
  payload: GraphPayload,
  success: GraphResponse,
  error: mcpRequestErrors(),
})

export const RescanSourcesRpc = Rpc.make('rescanSources', {
  payload: RescanSourcesPayload,
  success: RescanSourcesResponse,
  error: mcpRequestErrors(),
})

export const FileChangesRpc = Rpc.make('fileChanges', {
  payload: FileChangesPayload,
  success: FileChangeQueueResponse,
  error: requestErrors(),
})

export const RetryFileChangeRpc = Rpc.make('retryFileChange', {
  payload: FileChangeTaskPayload,
  success: FileChangeQueueResponse,
  error: requestErrors(),
})

export const IgnoreFileChangeRpc = Rpc.make('ignoreFileChange', {
  payload: FileChangeTaskPayload,
  success: FileChangeQueueResponse,
  error: requestErrors(),
})

export const EmbedPageRpc = Rpc.make('embedPage', {
  payload: EmbedPagePayload,
  success: EmbedPageResponse,
  error: mcpRequestErrors(EmbedError, TooLarge),
})

export const EmbedTextsRpc = Rpc.make('embedTexts', {
  payload: EmbedTextsPayload,
  success: EmbedTextsResponse,
  error: requestErrors(EmbedError),
})

export const VectorStatsRpc = Rpc.make('vectorStats', {
  payload: VectorProjectPayload,
  success: VectorStatsResponse,
  error: requestErrors(EmbedError),
})

export const VectorOptimizeRpc = Rpc.make('vectorOptimize', {
  payload: VectorProjectPayload,
  success: VectorOptimizeResponse,
  error: requestErrors(EmbedError),
})

export const VectorClearRpc = Rpc.make('vectorClear', {
  payload: VectorProjectPayload,
  success: VectorDeletedResponse,
  error: requestErrors(EmbedError),
})

export const VectorDeletePageRpc = Rpc.make('vectorDeletePage', {
  payload: VectorDeletePagePayload,
  success: VectorDeletedResponse,
  error: requestErrors(EmbedError),
})

export const VectorDropLegacyRpc = Rpc.make('vectorDropLegacy', {
  payload: VectorProjectPayload,
  success: VectorDropLegacyResponse,
  error: requestErrors(EmbedError),
})

export const ChatRpc = Rpc.make('chat', {
  payload: ChatPayload,
  success: ChatResponse,
  error: mcpRequestErrors(ChatCancelled, AgentError),
})

export const ChatStreamRpc = Rpc.make('chatStream', {
  payload: ChatPayload,
  success: ChatStreamEvent,
  error: requestErrors(ChatCancelled, AgentError),
  stream: true,
})

export const ChatCancelRpc = Rpc.make('chatCancel', {
  payload: ChatCancelPayload,
  success: ChatCancelResponse,
  error: requestErrors(),
})

export const SetCurrentProjectRpc = Rpc.make('setCurrentProject', {
  payload: SetCurrentProjectPayload,
  success: SetCurrentProjectResponse,
  error: requestErrors(),
})

export const ReloadConfigRpc = Rpc.make('reloadConfig', {
  success: ReloadConfigResponse,
  error: requestErrors(),
})

export const ApiProtocol = RpcGroup.make(
  HealthRpc,
  ProjectsRpc,
  FilesRpc,
  FileContentRpc,
  ReviewsRpc,
  PatchReviewRpc,
  ResolveReviewsRpc,
  SearchRpc,
  GraphRpc,
  RescanSourcesRpc,
  FileChangesRpc,
  RetryFileChangeRpc,
  IgnoreFileChangeRpc,
  EmbedPageRpc,
  EmbedTextsRpc,
  VectorStatsRpc,
  VectorOptimizeRpc,
  VectorClearRpc,
  VectorDeletePageRpc,
  VectorDropLegacyRpc,
  ChatRpc,
  ChatStreamRpc,
  ChatCancelRpc,
  SetCurrentProjectRpc,
  ReloadConfigRpc,
)

export type ApiProtocol = typeof ApiProtocol
export type ApiRpc = RpcGroup.Rpcs<typeof ApiProtocol>
export type ApiOperationName = ApiRpc['_tag']
export type ApiClient = RpcClient.RpcClient<ApiRpc, RpcClientError.RpcClientError>
