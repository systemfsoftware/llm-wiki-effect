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

export const EmbedPagePayload = Schema.Struct({
  projectId: Schema.String,
  path: Schema.String,
  force: Schema.optional(Schema.Boolean),
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

export const EmbedPageRpc = Rpc.make('embedPage', {
  payload: EmbedPagePayload,
  success: EmbedPageResponse,
  error: mcpRequestErrors(EmbedError, TooLarge),
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
  EmbedPageRpc,
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
