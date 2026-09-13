/**
 * U5 security surface: CORS origin policy, constant-time token comparison, the
 * auth/gating requirement matrix, body caps, and the rate limiter.
 *
 * Expected values are authored from the retired Rust HTTP server's documented
 * contracts (`cors.rs` allow-list, `is_token_required_request`, the body caps,
 * `RATE_LIMIT_MAX_REQUESTS`), never read back from the implementation.
 */
import { Effect, Exit, Layer, Option } from 'effect'
import { TestClock } from 'effect/testing'
import { assert, asyncProperty, boolean, constantFrom, integer, property, string, stringMatching } from 'fast-check'
import { Errors } from 'llm-wiki-protocol'
import type { Api } from 'llm-wiki-protocol'
import { describe, expect, it } from 'vitest'
import { constantTimeEqualBytes, constantTimeEqualStrings } from '../src/auth/constant-time.js'
import {
  CORS_ALLOW_HEADERS,
  CORS_ALLOW_METHODS,
  corsHeaders,
  decideCorsOrigin,
  isAllowedBrowserOrigin,
} from '../src/auth/cors.js'
import { Auth, Gate, middlewareLayer } from '../src/auth/index.js'
import type { AuthHeaders } from '../src/auth/index.js'
import {
  CHAT_MAX_BODY_BYTES,
  checkBodySize,
  consumeToken,
  DEFAULT_MAX_BODY_BYTES,
  maxBodyBytesFor,
  RATE_LIMIT_CAPACITY,
  RATE_LIMIT_WINDOW_MS,
  RateLimiter,
  shouldRateLimit,
  startTokenBucket,
} from '../src/auth/limits.js'
import {
  isAlwaysTokenOperation,
  isMcpGatedOperation,
  providedTokens,
  requiresToken,
  tokenMatches,
} from '../src/auth/requirements.js'
import { Config } from '../src/config/Config.js'
import type { ConfigValues } from '../src/config/Config.js'

type ApiOperationName = Api.ApiOperationName

const API_OPERATIONS = [
  'health',
  'projects',
  'files',
  'fileContent',
  'reviews',
  'patchReview',
  'resolveReviews',
  'search',
  'graph',
  'rescanSources',
  'embedPage',
  'chat',
  'chatStream',
  'chatCancel',
  'setCurrentProject',
  'reloadConfig',
] as const satisfies ReadonlyArray<ApiOperationName>

const TOKEN_REQUIRED_OPERATIONS: ReadonlyArray<ApiOperationName> = [
  'chat',
  'chatStream',
  'chatCancel',
  'embedPage',
]

const MCP_GATED_OPERATIONS: ReadonlyArray<ApiOperationName> = [
  'projects',
  'files',
  'fileContent',
  'reviews',
  'search',
  'graph',
  'rescanSources',
  'embedPage',
  'chat',
]

const headerValue = (
  headers: ReadonlyArray<readonly [string, string]>,
  name: string,
): string | undefined => headers.find(([key]) => key === name)?.[1]

describe('CORS origin policy', () => {
  it.each([
    'chrome-extension://abc',
    'moz-extension://abc',
    'http://localhost',
    'http://localhost:19827',
    'http://127.0.0.1:5500',
    'http://[::1]:3000',
    'tauri://localhost',
    'http://tauri.localhost',
    'https://tauri.localhost',
  ])('accepts the allow-listed browser origin %s', (origin) => {
    expect(isAllowedBrowserOrigin(origin)).toBe(true)
  })

  it.each([
    '',
    'HTTP://LOCALHOST',
    'http://localhost.evil.com',
    'http://127.0.0.1.evil.com',
    'https://localhost',
    'http://evil.com',
    'https://evil.com',
  ])('rejects the foreign origin %s', (origin) => {
    expect(isAllowedBrowserOrigin(origin)).toBe(false)
  })

  it('accepts a port only when it follows a bare loopback host', () => {
    expect(isAllowedBrowserOrigin('http://localhost:')).toBe(true)
    expect(isAllowedBrowserOrigin('http://127.0.0.1:0')).toBe(true)
    expect(isAllowedBrowserOrigin('http://[::1]:65535')).toBe(true)
    expect(isAllowedBrowserOrigin('http://localhost')).toBe(true)
    expect(isAllowedBrowserOrigin('http://localhost.evil.com:19827')).toBe(false)
  })

  it('decides Allow only for a present, allow-listed origin', () => {
    expect(decideCorsOrigin(Option.some('chrome-extension://abc'))).toEqual({
      _tag: 'Allow',
      origin: 'chrome-extension://abc',
    })
    expect(decideCorsOrigin(Option.some('https://evil.com'))).toEqual({ _tag: 'Reject' })
    expect(decideCorsOrigin(Option.none())).toEqual({ _tag: 'Reject' })
  })

  it('reflects the origin only when allowed', () => {
    const allowed = corsHeaders({
      origin: Option.some('chrome-extension://abc'),
      allowHeaders: CORS_ALLOW_HEADERS,
    })
    expect(headerValue(allowed, 'Access-Control-Allow-Origin')).toBe('chrome-extension://abc')
    expect(headerValue(allowed, 'Access-Control-Allow-Private-Network')).toBe('true')
    expect(headerValue(allowed, 'Vary')).toBe('Origin')
    expect(headerValue(allowed, 'Access-Control-Allow-Methods')).toBe(CORS_ALLOW_METHODS)
    expect(headerValue(allowed, 'Access-Control-Allow-Headers')).toBe(CORS_ALLOW_HEADERS)
    expect(headerValue(allowed, 'Content-Type')).toBe('application/json')

    const denied = corsHeaders({
      origin: Option.some('https://evil.com'),
      allowHeaders: CORS_ALLOW_HEADERS,
    })
    expect(headerValue(denied, 'Access-Control-Allow-Origin')).toBeUndefined()
    expect(headerValue(denied, 'Access-Control-Allow-Private-Network')).toBeUndefined()
    expect(headerValue(denied, 'Vary')).toBeUndefined()

    const missing = corsHeaders({ origin: Option.none(), allowHeaders: CORS_ALLOW_HEADERS })
    expect(headerValue(missing, 'Access-Control-Allow-Origin')).toBeUndefined()
  })

  it('never reflects a foreign origin (property)', () => {
    assert(
      property(string(), string(), (host, path) => {
        const origin = `http://${host.replace(/[^a-z0-9.-]/gi, '')}.evil.com/${path}`
        return (
          !isAllowedBrowserOrigin(origin) && decideCorsOrigin(Option.some(origin))._tag === 'Reject'
        )
      }),
      { numRuns: 200 },
    )
  })
})

describe('constant-time token comparison', () => {
  it('matches equal bytes only', () => {
    const encode = (value: string): Uint8Array => new TextEncoder().encode(value)
    expect(constantTimeEqualBytes(encode('token'), encode('token'))).toBe(true)
    expect(constantTimeEqualBytes(encode(''), encode(''))).toBe(true)
    expect(constantTimeEqualBytes(encode('token'), encode('tokeN'))).toBe(false)
    expect(constantTimeEqualBytes(encode('token'), encode('token '))).toBe(false)
    expect(constantTimeEqualStrings('token', 'token')).toBe(true)
    expect(constantTimeEqualStrings('token', 'tokens')).toBe(false)
    expect(constantTimeEqualStrings('token', 'toke')).toBe(false)
    expect(constantTimeEqualStrings('', 't')).toBe(false)
  })

  it('agrees with string equality and is symmetric (property)', () => {
    assert(
      property(string(), string(), (left, right) => {
        const equal = constantTimeEqualStrings(left, right)
        return (
          equal === (left === right) &&
          equal === constantTimeEqualStrings(right, left) &&
          constantTimeEqualStrings(left, left)
        )
      }),
      { numRuns: 200 },
    )
  })

  it('compares generated text identically by bytes and by string (property)', () => {
    assert(
      property(string({ minLength: 1 }), string({ minLength: 1 }), (left, right) => {
        const encode = (value: string): Uint8Array => new TextEncoder().encode(value)
        return (
          constantTimeEqualBytes(encode(left), encode(right)) === constantTimeEqualStrings(left, right)
        )
      }),
      { numRuns: 200 },
    )
  })
})

describe('auth requirement matrix', () => {
  it.each(API_OPERATIONS)('marks %s token-required exactly as the matrix declares', (operation) => {
    expect(isAlwaysTokenOperation(operation)).toBe(TOKEN_REQUIRED_OPERATIONS.includes(operation))
  })

  it('requires a token for every operation when unauthenticated reads are closed', () => {
    assert(
      property(constantFrom(...API_OPERATIONS), (operation) => requiresToken(operation, false)),
      { numRuns: 100 },
    )
  })

  it('requires a token only for chat and embed when unauthenticated reads are open', () => {
    assert(
      property(
        constantFrom(...API_OPERATIONS),
        (operation) => requiresToken(operation, true) === TOKEN_REQUIRED_OPERATIONS.includes(operation),
      ),
      { numRuns: 100 },
    )
  })

  it('matches any provided token candidate against the configured token', () => {
    expect(tokenMatches('secret', ['secret'])).toBe(true)
    expect(tokenMatches('secret', ['wrong', 'secret'])).toBe(true)
    expect(tokenMatches('secret', [])).toBe(false)
    expect(tokenMatches('secret', ['secrets'])).toBe(false)
    assert(
      property(string({ minLength: 1 }), integer({ min: 0, max: 4 }), (token, filler) => {
        const wrong = Array.from({ length: filler }, () => `not-${token}`)
        return (
          tokenMatches(token, [token]) &&
          tokenMatches(token, [...wrong, token]) &&
          !tokenMatches(token, [...wrong, `${token}!`])
        )
      }),
      { numRuns: 200 },
    )
  })

  it('reads the bearer and x-llm-wiki-token headers, ignoring anything else', () => {
    expect(providedTokens({ authorization: 'Bearer abc' })).toEqual(['abc'])
    expect(providedTokens({ 'x-llm-wiki-token': 'abc' })).toEqual(['abc'])
    expect(providedTokens({ authorization: 'bearer abc' })).toEqual([])
    expect(providedTokens({ authorization: 'Basic abc' })).toEqual([])
    expect(
      providedTokens({ authorization: 'Bearer abc', 'x-llm-wiki-token': 'def' }),
    ).toEqual(['def', 'abc'])
    expect(providedTokens({})).toEqual([])
    expect(providedTokens({ authorization: 'Bearer ' })).toEqual([''])
  })

  it.each(API_OPERATIONS)('gates %s exactly as the MCP map does', (operation) => {
    expect(isMcpGatedOperation(operation)).toBe(MCP_GATED_OPERATIONS.includes(operation))
  })

  it('leaves health ungated', () => {
    expect(isMcpGatedOperation('health')).toBe(false)
  })
})

describe('body caps', () => {
  it.each(API_OPERATIONS)('caps the %s body at its declared limit', (operation) => {
    const expected = operation === 'chat' || operation === 'chatStream'
      ? CHAT_MAX_BODY_BYTES
      : DEFAULT_MAX_BODY_BYTES
    expect(maxBodyBytesFor(operation)).toBe(expected)
  })

  it('declares the documented cap constants', () => {
    expect(CHAT_MAX_BODY_BYTES).toBe(40 * 1024 * 1024)
    expect(DEFAULT_MAX_BODY_BYTES).toBe(1024 * 1024)
  })

  it('fails TooLarge only when the body exceeds the cap (property)', async () => {
    await assert(
      asyncProperty(
        integer({ min: 0, max: 64 * 1024 * 1024 }),
        integer({ min: 0, max: 64 * 1024 * 1024 }),
        async (bytes, maxBytes) => {
          if (bytes <= maxBytes) {
            return Exit.isSuccess(await Effect.runPromise(Effect.exit(checkBodySize(bytes, maxBytes))))
          }
          const error = await Effect.runPromise(Effect.flip(checkBodySize(bytes, maxBytes)))
          return error._tag === 'TooLarge' && error instanceof Errors.TooLarge
        },
      ),
      { numRuns: 150 },
    )
  })

  it('accepts a body exactly at the cap and rejects one byte more', () => {
    expect(Exit.isSuccess(Effect.runSync(Effect.exit(checkBodySize(120, 120))))).toBe(true)
    const error = Effect.runSync(Effect.flip(checkBodySize(121, 120)))
    expect(error).toBeInstanceOf(Errors.TooLarge)
    expect(error._tag).toBe('TooLarge')
  })
})

describe('rate limiter', () => {
  const runRateLimiter = <A, E>(effect: Effect.Effect<A, E, RateLimiter>): Promise<A> =>
    Effect.runPromise(Effect.provide(effect, Layer.mergeAll(RateLimiter.layer(), TestClock.layer())))

  const outcome = (
    effect: Effect.Effect<void, Errors.RateLimited>,
  ): Effect.Effect<Option.Option<string>> =>
    Effect.exit(effect).pipe(
      Effect.map((exit) => Option.map(Exit.findErrorOption(exit), (error) => error._tag)),
    )

  it('is configured at 120 requests per second', () => {
    expect(RATE_LIMIT_CAPACITY).toBe(120)
    expect(RATE_LIMIT_WINDOW_MS).toBe(1000)
  })

  it.each(API_OPERATIONS)('exempts %s from rate limiting only when it is health', (operation) => {
    expect(shouldRateLimit(operation)).toBe(operation !== 'health')
  })

  it('allows a burst of capacity requests, then fails RateLimited', async () => {
    const observed = await runRateLimiter(
      Effect.gen(function*() {
        const limiter = yield* RateLimiter
        const accepted: Array<Option.Option<string>> = []
        for (let i = 0; i < RATE_LIMIT_CAPACITY; i++) {
          accepted.push(yield* outcome(limiter.acquire('projects')))
        }
        const overflowing = yield* outcome(limiter.acquire('projects'))
        return { accepted, overflowing }
      }),
    )
    expect(observed.accepted.every(Option.isNone)).toBe(true)
    expect(observed.overflowing).toEqual(Option.some('RateLimited'))
  })

  it('refills after the window elapses', async () => {
    const observed = await runRateLimiter(
      Effect.gen(function*() {
        const limiter = yield* RateLimiter
        yield* Effect.forEach(Array.from({ length: RATE_LIMIT_CAPACITY }), () => limiter.acquire('projects'))
        const blocked = yield* outcome(limiter.acquire('projects'))
        yield* TestClock.adjust(RATE_LIMIT_WINDOW_MS)
        const refilled: Array<Option.Option<string>> = []
        for (let i = 0; i < RATE_LIMIT_CAPACITY; i++) {
          refilled.push(yield* outcome(limiter.acquire('projects')))
        }
        const blockedAgain = yield* outcome(limiter.acquire('projects'))
        return { blocked, refilled, blockedAgain }
      }),
    )
    expect(observed.blocked).toEqual(Option.some('RateLimited'))
    expect(observed.refilled.every(Option.isNone)).toBe(true)
    expect(observed.blockedAgain).toEqual(Option.some('RateLimited'))
  })

  it('never charges health against the bucket', async () => {
    const observed = await runRateLimiter(
      Effect.gen(function*() {
        const limiter = yield* RateLimiter
        for (let i = 0; i < RATE_LIMIT_CAPACITY * 2; i++) {
          yield* limiter.acquire('health')
        }
        const afterHealth = yield* outcome(limiter.acquire('projects'))
        for (let i = 0; i < RATE_LIMIT_CAPACITY - 2; i++) {
          yield* limiter.acquire('projects')
        }
        const lastAllowed = yield* outcome(limiter.acquire('projects'))
        const overflowing = yield* outcome(limiter.acquire('projects'))
        return { afterHealth, lastAllowed, overflowing }
      }),
    )
    expect(observed.afterHealth).toEqual(Option.none())
    expect(observed.lastAllowed).toEqual(Option.none())
    expect(observed.overflowing).toEqual(Option.some('RateLimited'))
  })

  it('refills proportionally to elapsed time and never exceeds capacity (property)', () => {
    assert(
      property(
        integer({ min: 1, max: 240 }),
        integer({ min: 600, max: 2400 }),
        integer({ min: 0, max: 5000 }),
        integer({ min: 0, max: 400 }),
        (capacity, refillPerSecond, elapsedMs, drained) => {
          const options = { capacity, refillPerSecond }
          let state = startTokenBucket(capacity, 0)
          for (let i = 0; i < drained; i++) {
            state = consumeToken(state, 0, options)[1]
          }
          const [allowed, next] = consumeToken(state, elapsedMs, options)
          const accrued = state.tokens + (elapsedMs * refillPerSecond) / RATE_LIMIT_WINDOW_MS
          const expected = Math.min(capacity, accrued)
          const exact = allowed === (expected >= 1) &&
            Math.abs(next.tokens - (expected - (allowed ? 1 : 0))) < 1e-9 &&
            next.tokens <= capacity &&
            next.tokens >= 0 &&
            next.lastRefillMs >= state.lastRefillMs
          const [refilledAgain, capped] = consumeToken(next, elapsedMs + 60_000, options)
          return exact && refilledAgain && capped.tokens === capacity - 1
        },
      ),
      { numRuns: 200 },
    )
  })

  it('refuses requests beyond capacity at a single instant (property)', () => {
    assert(
      property(integer({ min: 1, max: 200 }), integer({ min: 1, max: 200 }), (capacity, requests) => {
        const options = { capacity, refillPerSecond: RATE_LIMIT_CAPACITY }
        let state = startTokenBucket(capacity, 0)
        let allowed = 0
        for (let i = 0; i < requests; i++) {
          const [ok, next] = consumeToken(state, 0, options)
          if (ok) {
            allowed += 1
          }
          state = next
        }
        return allowed === Math.min(capacity, requests) && state.tokens === capacity - allowed
      }),
      { numRuns: 200 },
    )
  })
})

interface ConfigValuesInput {
  readonly token?: string | undefined
  readonly apiEnabled?: boolean
  readonly mcpEnabled?: boolean
  readonly allowUnauthenticated?: boolean
}

const configValues = (input: ConfigValuesInput = {}): ConfigValues => ({
  token: Option.fromNullishOr(input.token),
  apiEnabled: input.apiEnabled ?? true,
  mcpEnabled: input.mcpEnabled ?? false,
  allowUnauthenticated: input.allowUnauthenticated ?? false,
  projectRoots: [],
  currentProject: Option.none(),
  chatLimits: { maxTokens: 2048, maxTurns: 8 },
  embedding: { provider: 'openai', model: 'text-embedding-3-small', dimensions: 1536 },
  providerCredentials: {},
  bindHost: '127.0.0.1',
})

const configLayer = (values: ConfigValues): Layer.Layer<Config> =>
  Layer.succeed(Config, {
    ...values,
    values: Effect.succeed(values),
    reload: Effect.succeed(values),
  })

const tagOf = <A, E extends { readonly _tag: string }>(
  effect: Effect.Effect<A, E>,
): Effect.Effect<string> =>
  Effect.exit(effect).pipe(
    Effect.map((exit) =>
      Exit.isSuccess(exit)
        ? 'success'
        : Option.getOrElse(
          Option.map(Exit.findErrorOption(exit), (error) => error._tag),
          () => 'defect',
        )
    ),
  )

const stackLayer = (values: ConfigValues): Layer.Layer<Auth | Gate> => middlewareLayer(configLayer(values))

const authorizeTag = (
  values: ConfigValues,
  operation: ApiOperationName,
  headers: AuthHeaders,
): string =>
  Effect.runSync(
    tagOf(
      Effect.provide(
        Effect.gen(function*() {
          const auth = yield* Auth
          yield* auth.authorize(operation, headers)
        }),
        stackLayer(values),
      ),
    ),
  )

const requireApiTag = (values: ConfigValues): string =>
  Effect.runSync(
    tagOf(
      Effect.provide(
        Effect.gen(function*() {
          const gate = yield* Gate
          yield* gate.requireApi
        }),
        stackLayer(values),
      ),
    ),
  )

const requireMcpTag = (values: ConfigValues, operation: ApiOperationName): string =>
  Effect.runSync(
    tagOf(
      Effect.provide(
        Effect.gen(function*() {
          const gate = yield* Gate
          yield* gate.requireMcp(operation)
        }),
        stackLayer(values),
      ),
    ),
  )

const AUTHORIZED_READ_OPERATIONS: ReadonlyArray<ApiOperationName> = [
  'health',
  'projects',
  'files',
  'fileContent',
  'reviews',
  'patchReview',
  'resolveReviews',
  'search',
  'graph',
  'rescanSources',
  'setCurrentProject',
  'reloadConfig',
]

describe('auth middleware', () => {
  it('accepts a matching bearer token and rejects missing or mismatched ones', () => {
    const values = configValues({ token: 'secret' })
    expect(authorizeTag(values, 'projects', { authorization: 'Bearer secret' })).toBe('success')
    expect(authorizeTag(values, 'projects', { 'x-llm-wiki-token': 'secret' })).toBe('success')
    expect(authorizeTag(values, 'projects', { authorization: 'Bearer wrong' })).toBe('Unauthorized')
    expect(authorizeTag(values, 'projects', { authorization: 'Bearer secret ' })).toBe('Unauthorized')
    expect(authorizeTag(values, 'projects', { authorization: 'bearer secret' })).toBe('Unauthorized')
    expect(authorizeTag(values, 'projects', {})).toBe('Unauthorized')
  })

  it.each(AUTHORIZED_READ_OPERATIONS)(
    'leaves the read operation %s open without a token',
    (operation) => {
      const values = configValues({ token: 'secret', allowUnauthenticated: true })
      expect(authorizeTag(values, operation, {})).toBe('success')
    },
  )

  it.each(['chat', 'chatStream', 'chatCancel', 'embedPage'] as const)(
    'keeps %s token-required while reads are open',
    (operation) => {
      const values = configValues({ token: 'secret', allowUnauthenticated: true })
      expect(authorizeTag(values, operation, {})).toBe('Unauthorized')
      expect(authorizeTag(values, operation, { authorization: 'Bearer secret' })).toBe('success')
    },
  )

  it.each(API_OPERATIONS)(
    'fails %s closed when no token is configured and reads are closed',
    (operation) => {
      const values = configValues()
      expect(authorizeTag(values, operation, {})).toBe('Unauthorized')
    },
  )

  it('opens reads but not chat when unauthenticated reads are allowed and no token exists', () => {
    const values = configValues({ allowUnauthenticated: true })
    expect(authorizeTag(values, 'projects', {})).toBe('success')
    expect(authorizeTag(values, 'chat', {})).toBe('Unauthorized')
    expect(authorizeTag(values, 'chat', { authorization: 'Bearer anything' })).toBe('Unauthorized')
  })

  it('re-reads the config snapshot on every operation', () => {
    const initial = configValues({ token: 'old' })
    const rotated = configValues({ token: 'new' })
    const snapshots = [initial, rotated]
    let served = -1
    const layer = Layer.succeed(Config, {
      ...initial,
      values: Effect.sync(() => {
        served = Math.min(served + 1, snapshots.length - 1)
        return snapshots[served] ?? initial
      }),
      reload: Effect.succeed(rotated),
    })
    const tag = (headers: AuthHeaders): string =>
      Effect.runSync(
        tagOf(
          Effect.provide(
            Effect.gen(function*() {
              const auth = yield* Auth
              yield* auth.authorize('projects', headers)
            }),
            middlewareLayer(layer),
          ),
        ),
      )
    expect(tag({ authorization: 'Bearer new' })).toBe('Unauthorized')
    expect(tag({ authorization: 'Bearer new' })).toBe('success')
  })

  it('composes over the real Config layer', () => {
    const layer = middlewareLayer(
      Config.layer({ mode: 'standalone', env: { LLM_WIKI_API_TOKEN: 'from-env' } }),
    )
    const tag = (headers: AuthHeaders): string =>
      Effect.runSync(
        tagOf(
          Effect.provide(
            Effect.gen(function*() {
              const auth = yield* Auth
              yield* auth.authorize('projects', headers)
            }),
            layer,
          ),
        ),
      )
    expect(tag({ authorization: 'Bearer from-env' })).toBe('success')
    expect(tag({ authorization: 'Bearer other' })).toBe('Unauthorized')
  })

  it('accepts exactly the generated matching token (property)', () => {
    const tokenArbitrary = stringMatching(/^[a-zA-Z0-9_.-]{1,24}$/)
    assert(
      property(tokenArbitrary, tokenArbitrary, (configured, provided) => {
        const values = configValues({ token: configured })
        const tag = authorizeTag(values, 'projects', { authorization: `Bearer ${provided}` })
        return tag === (configured === provided ? 'success' : 'Unauthorized')
      }),
      { numRuns: 150 },
    )
  })
})

describe('gate middleware', () => {
  it('refuses every non-health operation while the API is disabled', () => {
    expect(requireApiTag(configValues({ apiEnabled: false }))).toBe('ApiDisabled')
    expect(requireApiTag(configValues({ apiEnabled: true }))).toBe('success')
    expect(requireApiTag(configValues())).toBe('success')
  })

  it('fails MCP-mapped operations with McpDisabled but leaves health and unmapped ones alone', () => {
    const disabled = configValues({ mcpEnabled: false })
    expect(requireMcpTag(disabled, 'chat')).toBe('McpDisabled')
    expect(requireMcpTag(disabled, 'files')).toBe('McpDisabled')
    expect(requireMcpTag(disabled, 'health')).toBe('success')
    expect(requireMcpTag(disabled, 'chatStream')).toBe('success')
    expect(requireMcpTag(disabled, 'patchReview')).toBe('success')
    expect(requireMcpTag(disabled, 'reloadConfig')).toBe('success')

    const enabled = configValues({ mcpEnabled: true })
    expect(requireMcpTag(enabled, 'chat')).toBe('success')
    expect(requireMcpTag(enabled, 'health')).toBe('success')
  })

  it('gates and kills exactly per the config flags (property)', () => {
    assert(
      property(
        constantFrom(...API_OPERATIONS),
        boolean(),
        boolean(),
        (operation, apiEnabled, mcpEnabled) => {
          const values = configValues({ apiEnabled, mcpEnabled })
          return (
            requireApiTag(values) === (apiEnabled ? 'success' : 'ApiDisabled') &&
            requireMcpTag(values, operation) ===
              (MCP_GATED_OPERATIONS.includes(operation) && !mcpEnabled ? 'McpDisabled' : 'success')
          )
        },
      ),
      { numRuns: 150 },
    )
  })
})

describe('composed middleware stack', () => {
  it('surfaces the protocol error classes in order over one layer stack', async () => {
    const values = configValues({ token: 'secret', mcpEnabled: false })
    const stack = Layer.mergeAll(stackLayer(values), RateLimiter.layer({ capacity: 1 }))
    const observed = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function*() {
          const auth = yield* Auth
          const gate = yield* Gate
          const limiter = yield* RateLimiter
          const unauthorized = yield* Effect.flip(auth.authorize('chat', {}))
          const mcpDisabled = yield* Effect.flip(gate.requireMcp('chat'))
          const firstAllowed = yield* limiter.acquire('projects').pipe(
            Effect.as('allowed' as const),
          )
          const rateLimited = yield* Effect.flip(limiter.acquire('projects'))
          return { unauthorized, mcpDisabled, firstAllowed, rateLimited }
        }),
        stack,
      ),
    )
    expect(observed.unauthorized).toBeInstanceOf(Errors.Unauthorized)
    expect(observed.mcpDisabled).toBeInstanceOf(Errors.McpDisabled)
    expect(observed.firstAllowed).toBe('allowed')
    expect(observed.rateLimited).toBeInstanceOf(Errors.RateLimited)
  })
})
