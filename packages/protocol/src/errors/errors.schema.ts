import { Schema } from 'effect'

export class Unauthorized extends Schema.TaggedError<Unauthorized>()('Unauthorized', {
  message: Schema.String,
}) {}

export class ApiDisabled extends Schema.TaggedError<ApiDisabled>()('ApiDisabled', {
  message: Schema.String,
}) {}

export class NotFound extends Schema.TaggedError<NotFound>()('NotFound', {
  message: Schema.String,
}) {}

export class InvalidRequest extends Schema.TaggedError<InvalidRequest>()('InvalidRequest', {
  message: Schema.String,
}) {}

export class PathViolation extends Schema.TaggedError<PathViolation>()('PathViolation', {
  message: Schema.String,
}) {}

export class UnsupportedMediaType extends Schema.TaggedError<UnsupportedMediaType>()(
  'UnsupportedMediaType',
  { message: Schema.String },
) {}

export class TooLarge extends Schema.TaggedError<TooLarge>()('TooLarge', {
  message: Schema.String,
}) {}

export class RateLimited extends Schema.TaggedError<RateLimited>()('RateLimited', {
  message: Schema.String,
}) {}

export class Busy extends Schema.TaggedError<Busy>()('Busy', {
  message: Schema.String,
}) {}

export class BindConflict extends Schema.TaggedError<BindConflict>()('BindConflict', {
  message: Schema.String,
}) {}

export class McpDisabled extends Schema.TaggedError<McpDisabled>()('McpDisabled', {
  message: Schema.String,
}) {}

export class ChatCancelled extends Schema.TaggedError<ChatCancelled>()('ChatCancelled', {
  message: Schema.String,
}) {}

export class AgentError extends Schema.TaggedError<AgentError>()('AgentError', {
  message: Schema.String,
}) {}

export const EmbedErrorKind = Schema.Literals([
  'InvalidRequest',
  'NotFound',
  'Provider',
  'Storage',
  'Conflict',
  'Timeout',
])

export class EmbedError extends Schema.TaggedError<EmbedError>()('EmbedError', {
  kind: EmbedErrorKind,
  message: Schema.String,
}) {}

export const ApiError = Schema.Union([
  Unauthorized,
  ApiDisabled,
  NotFound,
  InvalidRequest,
  PathViolation,
  UnsupportedMediaType,
  TooLarge,
  RateLimited,
  Busy,
  BindConflict,
  McpDisabled,
  ChatCancelled,
  AgentError,
  EmbedError,
])

export const ApiErrorTag = Schema.Literals([
  'Unauthorized',
  'ApiDisabled',
  'NotFound',
  'InvalidRequest',
  'PathViolation',
  'UnsupportedMediaType',
  'TooLarge',
  'RateLimited',
  'Busy',
  'BindConflict',
  'McpDisabled',
  'ChatCancelled',
  'AgentError',
  'EmbedError',
])

export type ApiError = Schema.Schema.Type<typeof ApiError>
export type ApiErrorTag = Schema.Schema.Type<typeof ApiErrorTag>
export type EmbedErrorKind = Schema.Schema.Type<typeof EmbedErrorKind>
