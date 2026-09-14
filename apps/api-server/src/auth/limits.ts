/**
 * Body caps and the request rate limiter, ported from the retired Rust HTTP
 * server (`MAX_BODY_BYTES`, `MAX_CHAT_BODY_BYTES`, `RATE_LIMIT_MAX_REQUESTS`
 * per `RATE_LIMIT_WINDOW`, with `/health` exempt from rate limiting).
 */
import { Clock, Context, Effect, Layer, Option, Ref } from 'effect'
import { Errors } from 'llm-wiki-protocol'
import type { ApiOperationName } from './requirements.js'

export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024
export const CHAT_MAX_BODY_BYTES = 40 * 1024 * 1024
export const RATE_LIMIT_CAPACITY = 120
export const RATE_LIMIT_WINDOW_MS = 1000

export const maxBodyBytesFor = (operation: ApiOperationName): number =>
  operation === 'chat' || operation === 'chatStream' ? CHAT_MAX_BODY_BYTES : DEFAULT_MAX_BODY_BYTES

export const shouldRateLimit = (operation: ApiOperationName): boolean => operation !== 'health'

export const checkBodySize = (
  bytes: number,
  maxBytes: number,
): Effect.Effect<void, Errors.TooLarge> =>
  bytes > maxBytes
    ? Effect.fail(new Errors.TooLarge({ message: `Request body exceeds ${maxBytes} bytes` }))
    : Effect.void

export interface TokenBucket {
  readonly tokens: number
  readonly lastRefillMs: number
}

export interface TokenBucketOptions {
  readonly capacity: number
  readonly refillPerSecond: number
}

export const startTokenBucket = (capacity: number, nowMs: number): TokenBucket => ({
  tokens: capacity,
  lastRefillMs: nowMs,
})

export const consumeToken = (
  state: TokenBucket,
  nowMs: number,
  options: TokenBucketOptions,
): readonly [boolean, TokenBucket] => {
  const now = Math.max(state.lastRefillMs, nowMs)
  const accrued = state.tokens + ((now - state.lastRefillMs) * options.refillPerSecond) / RATE_LIMIT_WINDOW_MS
  const tokens = Math.min(options.capacity, accrued)
  return tokens >= 1
    ? [true, { tokens: tokens - 1, lastRefillMs: now }]
    : [false, { tokens, lastRefillMs: now }]
}

export interface RateLimiterOptions {
  readonly capacity?: number
  readonly refillPerSecond?: number
}

export interface RateLimiterShape {
  readonly acquire: (operation: ApiOperationName) => Effect.Effect<void, Errors.RateLimited>
}

export class RateLimiter extends Context.Service<RateLimiter, RateLimiterShape>()(
  'llm-wiki-api-server/auth/RateLimiter',
) {
  static readonly make = (options: RateLimiterOptions = {}): Effect.Effect<RateLimiterShape> =>
    Effect.gen(function*() {
      const capacity = options.capacity ?? RATE_LIMIT_CAPACITY
      const bucketOptions: TokenBucketOptions = {
        capacity,
        refillPerSecond: options.refillPerSecond ?? capacity,
      }
      const bucket = yield* Ref.make<Option.Option<TokenBucket>>(Option.none())
      return {
        acquire: (operation) =>
          shouldRateLimit(operation)
            ? Effect.gen(function*() {
              const nowMs = yield* Clock.currentTimeMillis
              const allowed = yield* Ref.modify(bucket, (current) => {
                const [nextAllowed, next] = consumeToken(
                  Option.getOrElse(current, () => startTokenBucket(capacity, nowMs)),
                  nowMs,
                  bucketOptions,
                )
                return [nextAllowed, Option.some(next)] as const
              })
              if (!allowed) {
                return yield* Effect.fail(
                  new Errors.RateLimited({ message: 'Too many requests' }),
                )
              }
              return undefined
            })
            : Effect.void,
      }
    })

  static readonly layer = (options: RateLimiterOptions = {}): Layer.Layer<RateLimiter> =>
    Layer.effect(RateLimiter, RateLimiter.make(options))
}
