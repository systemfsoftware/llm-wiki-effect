/**
 * RPC middleware for the wire group: kill switches, token auth, the rate
 * limiter, and the body cap, in the order the retired Rust server applied them
 * (gate → auth → rate limit → body cap).
 *
 * Execution order follows attachment order in the protocol runtime: the last
 * middleware attached to the group is the outermost wrapper.
 */
import { Effect, Layer, Schema } from 'effect'
import { Headers } from 'effect/unstable/http'
import { RpcGroup, RpcMiddleware } from 'effect/unstable/rpc'
import type { Rpc } from 'effect/unstable/rpc'
import { Api, Errors } from 'llm-wiki-protocol'
import { Auth } from '../auth/auth.js'
import type { AuthHeaders } from '../auth/auth.js'
import { Gate } from '../auth/gate.js'
import { checkBodySize, maxBodyBytesFor, RateLimiter } from '../auth/limits.js'
import type { ApiOperationName } from '../auth/requirements.js'

const OPERATION_HEADERS: ReadonlyArray<string> = ['authorization', 'x-llm-wiki-token']

const headerRecord = (headers: Headers.Headers): AuthHeaders => {
  const out: Record<string, string> = {}
  for (const name of OPERATION_HEADERS) {
    const value = Headers.get(headers, name)
    if (value._tag === 'Some') out[name] = value.value
  }
  return out
}

const isOperationName = (value: string): value is ApiOperationName => Api.ApiProtocol.requests.has(value)

const operationOf = (options: { readonly rpc: Rpc.AnyWithProps }): ApiOperationName => {
  const tag = options.rpc._tag
  if (!isOperationName(tag)) {
    throw new Error(`Unknown RPC operation: ${tag}`)
  }
  return tag
}

const payloadBytes = (payload: unknown): number => {
  try {
    return Buffer.byteLength(JSON.stringify(payload) ?? '', 'utf8')
  } catch {
    return 0
  }
}

export class ApiGate extends RpcMiddleware.Service<ApiGate>()(
  'llm-wiki-api-server/server/ApiGate',
  { error: Schema.Union([Errors.ApiDisabled, Errors.McpDisabled, Errors.InvalidRequest]) },
) {}

export class ApiAuth extends RpcMiddleware.Service<ApiAuth>()(
  'llm-wiki-api-server/server/ApiAuth',
  { error: Schema.Union([Errors.Unauthorized, Errors.InvalidRequest]) },
) {}

export class ApiRateLimit extends RpcMiddleware.Service<ApiRateLimit>()(
  'llm-wiki-api-server/server/ApiRateLimit',
  { error: Errors.RateLimited },
) {}

export class ApiBodyLimit extends RpcMiddleware.Service<ApiBodyLimit>()(
  'llm-wiki-api-server/server/ApiBodyLimit',
  { error: Errors.TooLarge },
) {}

const HEALTH_OPERATION: ApiOperationName = 'health'

const apiGateLive: Layer.Layer<ApiGate, never, Gate> = Layer.effect(
  ApiGate,
  Effect.map(Gate, (gate) => (effect, options) => {
    const operation = operationOf(options)
    return operation === HEALTH_OPERATION
      ? effect
      : Effect.andThen(gate.requireApi, Effect.andThen(gate.requireMcp(operation), effect))
  }),
)

const apiAuthLive: Layer.Layer<ApiAuth, never, Auth> = Layer.effect(
  ApiAuth,
  Effect.map(Auth, (auth) => (effect, options) => {
    const operation = operationOf(options)
    return operation === HEALTH_OPERATION
      ? effect
      : Effect.andThen(auth.authorize(operation, headerRecord(options.headers)), effect)
  }),
)

const apiRateLimitLive: Layer.Layer<ApiRateLimit, never, RateLimiter> = Layer.effect(
  ApiRateLimit,
  Effect.map(
    RateLimiter,
    (limiter) => (effect, options) => Effect.andThen(limiter.acquire(operationOf(options)), effect),
  ),
)

const apiBodyLimitLive: Layer.Layer<ApiBodyLimit> = Layer.succeed(
  ApiBodyLimit,
  (effect, options) =>
    Effect.andThen(
      checkBodySize(
        payloadBytes(options.payload),
        maxBodyBytesFor(operationOf(options)),
      ),
      effect,
    ),
)

export const rpcMiddlewareLayer: Layer.Layer<
  ApiGate | ApiAuth | ApiRateLimit | ApiBodyLimit,
  never,
  Gate | Auth | RateLimiter
> = Layer.mergeAll(
  apiGateLive,
  apiAuthLive,
  apiRateLimitLive,
  apiBodyLimitLive,
)

export type ApiGroup = RpcGroup.RpcGroup<
  Rpc.AddMiddleware<
    Rpc.AddMiddleware<
      Rpc.AddMiddleware<Rpc.AddMiddleware<Api.ApiRpc, typeof ApiBodyLimit>, typeof ApiRateLimit>,
      typeof ApiAuth
    >,
    typeof ApiGate
  >
>

export const apiGroup: ApiGroup = Api.ApiProtocol
  .middleware(ApiBodyLimit)
  .middleware(ApiRateLimit)
  .middleware(ApiAuth)
  .middleware(ApiGate)
