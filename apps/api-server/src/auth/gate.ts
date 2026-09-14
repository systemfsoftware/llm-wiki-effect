import { Context, Effect, Layer } from 'effect'
import { Errors } from 'llm-wiki-protocol'
import { Config } from '../config/Config.js'
import { isMcpGatedOperation } from './requirements.js'
import type { ApiOperationName } from './requirements.js'

export interface GateShape {
  readonly requireApi: Effect.Effect<void, Errors.ApiDisabled | Errors.InvalidRequest>
  readonly requireMcp: (
    operation: ApiOperationName,
  ) => Effect.Effect<void, Errors.McpDisabled | Errors.InvalidRequest>
}

export class Gate extends Context.Service<Gate, GateShape>()('llm-wiki-api-server/auth/Gate') {
  static readonly make: Effect.Effect<GateShape, never, Config> = Effect.gen(function*() {
    const config = yield* Config
    return {
      requireApi: Effect.gen(function*() {
        const values = yield* config.values
        if (!values.apiEnabled) {
          return yield* Effect.fail(new Errors.ApiDisabled({ message: 'API is disabled' }))
        }
        return undefined
      }),
      requireMcp: (operation) =>
        Effect.gen(function*() {
          if (!isMcpGatedOperation(operation)) return undefined
          const values = yield* config.values
          if (!values.mcpEnabled) {
            return yield* Effect.fail(
              new Errors.McpDisabled({ message: 'MCP operations are disabled' }),
            )
          }
          return undefined
        }),
    }
  })

  static readonly layer: Layer.Layer<Gate, never, Config> = Layer.effect(Gate, Gate.make)
}
