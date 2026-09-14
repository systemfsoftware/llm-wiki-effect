import type { Effect } from 'effect'
import type { Errors } from 'llm-wiki-protocol'

export interface ToolCall {
  readonly projectRoot: string
  readonly tool: string
  readonly input: Readonly<Record<string, unknown>>
}

export interface ToolCallContext {
  readonly sessionId: string
}

export interface ToolExecuted {
  readonly status: 'executed'
  readonly tool: string
  readonly output: unknown
}

export interface ToolApprovalRequired {
  readonly status: 'approval_required'
  readonly observation: string
  readonly detail: string
}

export type ToolResult = ToolExecuted | ToolApprovalRequired

export type ToolError =
  | Errors.InvalidRequest
  | Errors.NotFound
  | Errors.PathViolation
  | Errors.TooLarge
  | Errors.UnsupportedMediaType
  | Errors.AgentError

export type ToolExecutor = (call: ToolCall) => Effect.Effect<unknown, ToolError>

export type ToolExecutors = Readonly<Record<string, ToolExecutor>>
