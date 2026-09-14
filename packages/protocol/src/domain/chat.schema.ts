import { Schema } from 'effect'

export const AgentMode = Schema.Literals(['fast', 'standard', 'deep', 'local_first'])
export const AgentRetrievalMode = Schema.Literals(['standard', 'smart', 'faithful'])
export const AgentSkillMode = Schema.Literals(['auto', 'explicit'])

export type AgentMode = Schema.Schema.Type<typeof AgentMode>
export type AgentRetrievalMode = Schema.Schema.Type<typeof AgentRetrievalMode>
export type AgentSkillMode = Schema.Schema.Type<typeof AgentSkillMode>

export class AgentImage extends Schema.Class<AgentImage>('AgentImage')({
  mediaType: Schema.String,
  dataBase64: Schema.String,
}) {}

export class AgentToolOptions extends Schema.Class<AgentToolOptions>('AgentToolOptions')({
  wiki: Schema.Boolean,
  web: Schema.Boolean,
  anytxt: Schema.Boolean,
}) {}

export class ChatMessage extends Schema.Class<ChatMessage>('ChatMessage')({
  role: Schema.String,
  content: Schema.String,
}) {}

export class ChatVersionSummary extends Schema.Class<ChatVersionSummary>('ChatVersionSummary')({
  timestamp: Schema.Number,
  author: Schema.String,
  tool: Schema.String,
}) {}

export class ChatKnowledgeContext extends Schema.Class<ChatKnowledgeContext>(
  'ChatKnowledgeContext',
)({
  relatedTo: Schema.optional(Schema.Array(Schema.String)),
  tags: Schema.optional(Schema.Array(Schema.String)),
  outgoingLinks: Schema.optional(Schema.Array(Schema.String)),
  backlinks: Schema.optional(Schema.Array(Schema.String)),
  linkCount: Schema.Number,
  latestVersion: Schema.optional(ChatVersionSummary),
}) {}

export class ChatReference extends Schema.Class<ChatReference>('ChatReference')({
  title: Schema.String,
  path: Schema.String,
  kind: Schema.String,
  snippet: Schema.optional(Schema.String),
  score: Schema.optional(Schema.Number),
  knowledgeContext: Schema.optional(ChatKnowledgeContext),
}) {}

export class ChatToolEvent extends Schema.Class<ChatToolEvent>('ChatToolEvent')({
  tool: Schema.String,
  status: Schema.String,
  detail: Schema.optional(Schema.String),
}) {}

export class ChatUserInputOption extends Schema.Class<ChatUserInputOption>('ChatUserInputOption')({
  label: Schema.String,
  value: Schema.String,
  description: Schema.optional(Schema.String),
  recommended: Schema.optional(Schema.Boolean),
}) {}

export class ChatUserInputField extends Schema.Class<ChatUserInputField>('ChatUserInputField')({
  id: Schema.String,
  type: Schema.String,
  label: Schema.String,
  description: Schema.optional(Schema.String),
  placeholder: Schema.optional(Schema.String),
  options: Schema.Array(ChatUserInputOption),
  defaultValue: Schema.optional(Schema.Unknown),
}) {}

export class ChatUserInputRequest extends Schema.Class<ChatUserInputRequest>('ChatUserInputRequest')({
  requestId: Schema.String,
  title: Schema.String,
  description: Schema.optional(Schema.String),
  fields: Schema.Array(ChatUserInputField),
}) {}

export class AgentStartEvent extends Schema.Class<AgentStartEvent>('AgentStartEvent')({
  type: Schema.Literal('agentStart'),
  sessionId: Schema.String,
}) {}

export class AgentTurnStartEvent extends Schema.Class<AgentTurnStartEvent>('AgentTurnStartEvent')({
  type: Schema.Literal('turnStart'),
  mode: Schema.String,
}) {}

export class AgentToolStartEvent extends Schema.Class<AgentToolStartEvent>('AgentToolStartEvent')({
  type: Schema.Literal('toolStart'),
  tool: Schema.String,
  input: Schema.NullOr(Schema.String),
}) {}

export class AgentToolEndEvent extends Schema.Class<AgentToolEndEvent>('AgentToolEndEvent')({
  type: Schema.Literal('toolEnd'),
  tool: Schema.String,
  output: Schema.NullOr(Schema.String),
}) {}

export class AgentReferenceAddedEvent extends Schema.Class<AgentReferenceAddedEvent>(
  'AgentReferenceAddedEvent',
)({
  type: Schema.Literal('referenceAdded'),
  reference: ChatReference,
}) {}

export class AgentFileChangedEvent extends Schema.Class<AgentFileChangedEvent>(
  'AgentFileChangedEvent',
)({
  type: Schema.Literal('fileChanged'),
  path: Schema.String,
  tool: Schema.String,
  existedBefore: Schema.Boolean,
  previousContent: Schema.optional(Schema.String),
}) {}

export class AgentMessageDeltaEvent extends Schema.Class<AgentMessageDeltaEvent>(
  'AgentMessageDeltaEvent',
)({
  type: Schema.Literal('messageDelta'),
  text: Schema.String,
}) {}

export class AgentErrorEvent extends Schema.Class<AgentErrorEvent>('AgentErrorEvent')({
  type: Schema.Literal('error'),
  message: Schema.String,
}) {}

export class AgentUserInputRequiredEvent extends Schema.Class<AgentUserInputRequiredEvent>(
  'AgentUserInputRequiredEvent',
)({
  type: Schema.Literal('userInputRequired'),
  request: ChatUserInputRequest,
}) {}

export class AgentDoneEvent extends Schema.Class<AgentDoneEvent>('AgentDoneEvent')({
  type: Schema.Literal('done'),
  sessionId: Schema.String,
}) {}

export const AgentEvent = Schema.Union([
  AgentStartEvent,
  AgentTurnStartEvent,
  AgentToolStartEvent,
  AgentToolEndEvent,
  AgentReferenceAddedEvent,
  AgentFileChangedEvent,
  AgentMessageDeltaEvent,
  AgentErrorEvent,
  AgentUserInputRequiredEvent,
  AgentDoneEvent,
])

export type AgentEvent = Schema.Schema.Type<typeof AgentEvent>

export class ChatUsage extends Schema.Class<ChatUsage>('ChatUsage')({
  promptChars: Schema.Number,
  completionChars: Schema.Number,
  referenceCount: Schema.Number,
  toolEventCount: Schema.Number,
}) {}

export class ChatResponse extends Schema.Class<ChatResponse>('ChatResponse')({
  projectId: Schema.String,
  sessionId: Schema.String,
  mode: AgentMode,
  message: ChatMessage,
  references: Schema.Array(ChatReference),
  toolEvents: Schema.Array(ChatToolEvent),
  events: Schema.Array(AgentEvent),
  usage: Schema.optional(Schema.NullOr(ChatUsage)),
}) {}

export class ChatCancelResponse extends Schema.Class<ChatCancelResponse>('ChatCancelResponse')({
  sessionId: Schema.String,
  cancelled: Schema.Boolean,
}) {}

export class ChatStreamMeta extends Schema.Class<ChatStreamMeta>('ChatStreamMeta')({
  type: Schema.Literal('meta'),
  projectId: Schema.String,
  sessionId: Schema.String,
  runId: Schema.String,
}) {}

export class ChatStreamAgentEvent extends Schema.Class<ChatStreamAgentEvent>(
  'ChatStreamAgentEvent',
)({
  type: Schema.Literal('agentEvent'),
  event: AgentEvent,
}) {}

export class ChatStreamDone extends Schema.Class<ChatStreamDone>('ChatStreamDone')({
  type: Schema.Literal('done'),
  response: ChatResponse,
}) {}

export const ChatStreamEvent = Schema.Union([
  ChatStreamMeta,
  ChatStreamAgentEvent,
  ChatStreamDone,
])

export type ChatStreamEvent = Schema.Schema.Type<typeof ChatStreamEvent>
