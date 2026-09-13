import { Context, Effect, Layer, Option } from 'effect'
import { Errors } from 'llm-wiki-protocol'
import { Config } from '../config/Config.js'
import { providedTokens, requiresToken, tokenMatches } from './requirements.js'
import type { ApiOperationName } from './requirements.js'

export type AuthHeaders = Readonly<Record<string, string>>

export interface AuthShape {
  readonly authorize: (
    operation: ApiOperationName,
    headers: AuthHeaders,
  ) => Effect.Effect<void, Errors.Unauthorized | Errors.InvalidRequest>
}

export class Auth extends Context.Service<Auth, AuthShape>()('llm-wiki-api-server/auth/Auth') {
  static readonly make: Effect.Effect<AuthShape, never, Config> = Effect.gen(function*() {
    const config = yield* Config
    return {
      authorize: (operation, headers) =>
        Effect.gen(function*() {
          const values = yield* config.values
          if (!requiresToken(operation, values.allowUnauthenticated)) return undefined
          const authorized = Option.match(values.token, {
            onNone: () => false,
            onSome: (configured) => tokenMatches(configured, providedTokens(headers)),
          })
          if (authorized) return undefined
          return yield* Effect.fail(
            new Errors.Unauthorized({ message: 'Missing or invalid API token' }),
          )
        }),
    }
  })

  static readonly layer: Layer.Layer<Auth, never, Config> = Layer.effect(Auth, Auth.make)
}
