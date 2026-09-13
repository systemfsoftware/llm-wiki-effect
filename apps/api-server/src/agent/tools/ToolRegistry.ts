import { Context, Effect, Layer, Result } from 'effect'
import { Errors } from 'llm-wiki-protocol'
import { denyAll } from './Approver.js'
import type { Approver } from './Approver.js'
import { filePathGuard } from './paths.js'
import {
  apiDefaultPolicy,
  APPROVAL_REQUIRED_OBSERVATION,
  capabilitiesFor,
  requireCapability,
  shellCommandFromCall,
} from './permissions.js'
import type { PermissionPolicy } from './permissions.js'
import { requiresApproval, specFor, TOOL_SPECS } from './specs.js'
import type { ToolSpec } from './specs.js'
import type { ToolCall, ToolError, ToolExecutors, ToolResult } from './types.js'

export interface ToolRegistryShape {
  readonly specs: ReadonlyArray<ToolSpec>
  readonly execute: (call: ToolCall) => Effect.Effect<ToolResult, ToolError>
}

export interface ToolRegistryOptions {
  readonly approver?: Approver | undefined
  readonly executors?: ToolExecutors | undefined
  readonly policy?: PermissionPolicy | undefined
}

const toolPathInput = (call: ToolCall): string | undefined => {
  const raw = call.input['path']
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  return trimmed === '' ? undefined : trimmed
}

export const makeToolRegistry = (options: ToolRegistryOptions = {}): ToolRegistryShape => {
  const approver = options.approver ?? denyAll
  const executors = options.executors ?? {}
  const policy = options.policy ?? apiDefaultPolicy()

  const execute = (call: ToolCall): Effect.Effect<ToolResult, ToolError> =>
    Effect.gen(function*() {
      const spec = specFor(call.tool)
      if (spec === undefined) {
        return yield* Effect.fail(
          new Errors.InvalidRequest({ message: `Unknown Agent tool: ${call.tool}` }),
        )
      }
      for (const capability of capabilitiesFor(call.tool)) {
        const permitted = requireCapability(policy, capability)
        if (Result.isFailure(permitted)) return yield* Effect.fail(permitted.failure)
      }
      if (requiresApproval(spec)) {
        const approved = yield* approver.approve(call)
        if (!approved) {
          const command = shellCommandFromCall(call) ?? ''
          return {
            status: 'approval_required',
            observation: APPROVAL_REQUIRED_OBSERVATION,
            detail: `approval required: ${command}`,
          }
        }
      }
      const guard = filePathGuard(call.tool)
      if (guard !== undefined) {
        const path = toolPathInput(call)
        if (path === undefined) {
          return yield* Effect.fail(
            new Errors.InvalidRequest({ message: `${call.tool} requires path` }),
          )
        }
        const guarded = guard(path)
        if (Result.isFailure(guarded)) return yield* Effect.fail(guarded.failure)
      }
      const executor = executors[call.tool]
      if (executor === undefined) {
        return yield* Effect.fail(
          new Errors.AgentError({ message: `No executor registered for Agent tool: ${call.tool}` }),
        )
      }
      const output = yield* executor(call)
      return { status: 'executed', tool: call.tool, output }
    })

  return { specs: TOOL_SPECS, execute }
}

export class ToolRegistry extends Context.Service<ToolRegistry, ToolRegistryShape>()(
  'llm-wiki-api-server/ToolRegistry',
) {
  static readonly make = makeToolRegistry

  static readonly layer = (options?: ToolRegistryOptions): Layer.Layer<ToolRegistry> =>
    Layer.succeed(ToolRegistry, makeToolRegistry(options))
}
