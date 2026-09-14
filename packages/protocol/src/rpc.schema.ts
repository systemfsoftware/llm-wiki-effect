import { Schema } from 'effect'
import {
  AgentImage,
  AgentMode,
  AgentRetrievalMode,
  AgentSkillMode,
  AgentToolOptions,
  ChatMessage,
  ReviewStatus,
} from './domain/index.js'

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
  queryEmbedding: Schema.optional(Schema.Array(Schema.Number)),
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
