import { Layer, Schema } from 'effect'
import { Rpc, RpcGroup, RpcSerialization } from 'effect/unstable/rpc'
import type { RpcClient, RpcClientError } from 'effect/unstable/rpc'
import {
  AgentImage,
  AgentMode,
  AgentRetrievalMode,
  AgentSkillMode,
  AgentToolOptions,
  ChatCancelResponse,
  ChatMessage,
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
  ReviewStatus,
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

export const FilesPayload = Schema.Struct({
  projectId: Schema.String,
  root: Schema.optional(Schema.Literals(['wiki', 'sources', 'all'])),
  recursive: Schema.optional(Schema.Boolean),
  maxFiles: Schema.optional(Schema.Number),
})

export const FileContentPayload = Schema.Struct({
  projectId: Schema.String,
  path: Schema.String,
})

export const ReviewsPayload = Schema.Struct({
  projectId: Schema.String,
  status: Schema.optional(ReviewStatus),
  type: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.Number),
})

export const PatchReviewPayload = Schema.Struct({
  projectId: Schema.String,
  reviewId: Schema.String,
  resolved: Schema.optional(Schema.Boolean),
  action: Schema.optional(Schema.String),
})

export const ResolveReviewsPayload = Schema.Struct({
  projectId: Schema.String,
  ids: Schema.Array(Schema.String),
  action: Schema.optional(Schema.String),
})

export const SearchPayload = Schema.Struct({
  projectId: Schema.String,
  query: Schema.String,
  topK: Schema.optional(Schema.Number),
  includeContent: Schema.optional(Schema.Boolean),
})

export const GraphPayload = Schema.Struct({
  projectId: Schema.String,
  q: Schema.optional(Schema.String),
  nodeType: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.Number),
})

export const RescanSourcesPayload = Schema.Struct({
  projectId: Schema.String,
})

export const FileChangesPayload = Schema.Struct({
  projectId: Schema.String,
})

export const FileChangeTaskPayload = Schema.Struct({
  projectId: Schema.String,
  taskId: Schema.String,
})

export const EmbedPagePayload = Schema.Struct({
  projectId: Schema.String,
  path: Schema.String,
  force: Schema.optional(Schema.Boolean),
})

export const EmbedTextsPayload = Schema.Struct({
  provider: Schema.optional(Schema.String),
  texts: Schema.Array(Schema.String),
})

export const VectorProjectPayload = Schema.Struct({
  projectId: Schema.String,
})

export const VectorDeletePagePayload = Schema.Struct({
  projectId: Schema.String,
  pageId: Schema.String,
})

export const ChatPayload = Schema.Struct({
  message: Schema.String,
  sessionId: Schema.optional(Schema.String),
  runId: Schema.optional(Schema.String),
  mode: Schema.optional(AgentMode),
  retrievalMode: Schema.optional(AgentRetrievalMode),
  tools: Schema.optional(AgentToolOptions),
  topK: Schema.optional(Schema.Number),
  includeContent: Schema.optional(Schema.Boolean),
  history: Schema.optional(Schema.Array(ChatMessage)),
  historyExplicit: Schema.optional(Schema.Boolean),
  skills: Schema.optional(Schema.Array(Schema.String)),
  contextFiles: Schema.optional(Schema.Array(Schema.String)),
  skillMode: Schema.optional(AgentSkillMode),
  images: Schema.optional(Schema.Array(AgentImage)),
  persistSession: Schema.optional(Schema.Boolean),
})

export const ChatCancelPayload = Schema.Struct({
  projectId: Schema.String,
  sessionId: Schema.String,
})

export const SetCurrentProjectPayload = Schema.Struct({
  projectId: Schema.String,
})

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
