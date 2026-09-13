import { NodeHttpClient } from '@effect/platform-node'
import { Effect, Exit, Option, Stream } from 'effect'
import { Headers, HttpServerRequest } from 'effect/unstable/http'
import { RpcClient } from 'effect/unstable/rpc'
import { assert as fcAssert, constantFrom, integer, property as fcProperty, string as fcString } from 'fast-check'
import { Api, Catalog, Client, Domain, Errors, PROTOCOL_VERSION } from 'llm-wiki-protocol'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import type { IncomingHttpHeaders } from 'node:http'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { DEFAULT_MAX_BODY_BYTES } from '../src/auth/limits.js'
import type { RateLimiterOptions } from '../src/auth/limits.js'
import type { EmbeddingTransport } from '../src/embeddings/Embeddings.js'
import type { VectorStore as EmbeddingVectorStore } from '../src/embeddings/vector-store.js'
import type { ProviderClientShape } from '../src/provider/provider-client.js'
import type { SearchOptions } from '../src/search/Search.js'
import type { VectorStoreShape } from '../src/search/vector.js'
import { buildApp } from '../src/server/app.js'
import type { ServerAppInput } from '../src/server/app.js'
import { parseReadyLine, readyLine, standaloneHandshake, workerHandshake } from '../src/server/entrypoint.js'
import {
  isUpgradeOriginAllowed,
  makeHttpApp,
  RPC_PATH,
  RPC_STREAM_PATH,
  serveHttp,
  serveSocket,
} from '../src/server/mount.js'
import { normalizeSourceWatchConfig, shouldWatchRel, SOURCE_WATCH_DEFAULTS, watchRules } from '../src/server/rescan.js'

type ApiClient = Api.ApiClient
type ServerEnv = Readonly<Record<string, string | undefined>>

const createdRoots: Array<string> = []
const createdPaths: Array<string> = []

const tempPath = (prefix: string): string => {
  const path = join(tmpdir(), `llm-wiki-${prefix}-${randomUUID()}.sock`)
  createdPaths.push(path)
  return path
}

afterAll(async () => {
  await Promise.all(createdRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  await Promise.all(createdPaths.splice(0).map((path) => rm(path, { force: true })))
})

const DEFAULT_FILES: Readonly<Record<string, string>> = {
  'wiki/a.md': '# A\n\nAttention mechanism notes.\n\n[[b]]\n',
  'wiki/b.md': '# B\n\nBacklinks to [[a]].\n',
  'purpose.md': '# Purpose\n',
  'raw/sources/notes.txt': 'source notes\n',
}

const makeProjectRoot = async (files: Readonly<Record<string, string>>): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'llm-wiki-server-'))
  createdRoots.push(root)
  await mkdir(join(root, '.llm-wiki'), { recursive: true })
  await writeFile(join(root, '.llm-wiki', 'project.json'), JSON.stringify({ id: 'p1' }), 'utf8')
  for (const [relative, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, relative)), { recursive: true })
    await writeFile(join(root, relative), content, 'utf8')
  }
  return root
}

interface HarnessSpec {
  readonly files?: Readonly<Record<string, string>> | undefined
  readonly api?: Readonly<Record<string, unknown>> | undefined
  readonly embedding?: Readonly<Record<string, unknown>> | undefined
  readonly providerCredentials?: Readonly<Record<string, unknown>> | undefined
  readonly env?: ServerEnv | undefined
  readonly rateLimit?: RateLimiterOptions | undefined
  readonly providerClient?: ProviderClientShape | undefined
  readonly embeddingTransport?: EmbeddingTransport | undefined
  readonly embeddingStore?: EmbeddingVectorStore | undefined
  readonly search?: SearchOptions | undefined
}

interface Harness {
  readonly root: string
  readonly configPath: string
  readonly env: ServerEnv
}

const configBody = (root: string, spec: HarnessSpec): Record<string, unknown> => ({
  api: {
    enabled: true,
    mcpEnabled: true,
    allowUnauthenticated: true,
    ...spec.api,
  },
  projects: [{ path: root }],
  currentProject: root,
  chat: { maxTokens: 2_048, maxTurns: 8 },
  ...(spec.embedding === undefined ? {} : { embedding: spec.embedding }),
  ...(spec.providerCredentials === undefined
    ? {}
    : { providerCredentials: spec.providerCredentials }),
})

const appInput = (spec: HarnessSpec, configPath: string): ServerAppInput => ({
  config: { mode: 'standalone', configPath, env: spec.env ?? {} },
  env: spec.env ?? {},
  agent: { provider: 'openai', model: 'gpt-4o' },
  ...(spec.rateLimit === undefined ? {} : { rateLimit: spec.rateLimit }),
  ...(spec.providerClient === undefined ? {} : { providerClient: spec.providerClient }),
  ...(spec.embeddingTransport === undefined && spec.embeddingStore === undefined
    ? {}
    : {
      embeddings: {
        ...(spec.embeddingTransport === undefined
          ? {}
          : { transport: spec.embeddingTransport }),
        ...(spec.embeddingStore === undefined ? {} : { store: spec.embeddingStore }),
      },
    }),
  ...(spec.search === undefined ? {} : { search: spec.search }),
})

const prepareHarness = (spec: HarnessSpec) =>
  Effect.gen(function*() {
    const root = yield* Effect.promise(() => makeProjectRoot(spec.files ?? DEFAULT_FILES))
    const configPath = join(root, 'server-config.json')
    yield* Effect.promise(async () => {
      await writeFile(configPath, JSON.stringify(configBody(root, spec)), 'utf8')
    })
    return { root, configPath, env: spec.env ?? {} } satisfies Harness
  })

const buildHarnessApp = (spec: HarnessSpec, harness: Harness) =>
  buildApp(appInput(spec, harness.configPath)).pipe(Effect.provide(NodeHttpClient.layerNodeHttp))

const withSocket = <A, E>(
  spec: HarnessSpec,
  body: (harness: Harness, client: ApiClient) => Effect.Effect<A, E>,
  headers?: Readonly<Record<string, string>>,
): Promise<A> => {
  const path = tempPath('socket')
  const program = Effect.gen(function*() {
    const harness = yield* prepareHarness(spec)
    const app = yield* buildHarnessApp(spec, harness)
    yield* serveSocket({ app, env: harness.env, path })
    const session = Effect.gen(function*() {
      const client = yield* Client.SocketApiClient
      return yield* body(harness, client)
    })
    return yield* Effect.provide(
      session.pipe(
        headers === undefined
          ? identity
          : Effect.provideService(RpcClient.CurrentHeaders, Headers.fromInput(headers)),
      ),
      Client.SocketApiClient.layer({ path }),
    )
  })
  return Effect.runPromise(Effect.scoped(program))
}

const identity = <A>(value: A): A => value

const rawNdjsonCall = (socketPath: string, frame: string): Promise<string> =>
  new Promise<string>((resolve, reject) => {
    const socket = connect({ path: socketPath })
    let buffer = ''
    socket.setEncoding('utf8')
    socket.on('connect', () => socket.write(frame))
    socket.on('data', (chunk: string) => {
      buffer += chunk
      if (buffer.includes('\n')) {
        socket.destroy()
        resolve(buffer)
      }
    })
    socket.on('error', reject)
    setTimeout(() => {
      socket.destroy()
      resolve(buffer)
    }, 1_000)
  })

const upgradeAttempt = (
  socketPath: string,
  headers: Readonly<Record<string, string>>,
): Promise<string> =>
  new Promise<string>((resolve) => {
    const call = httpRequest(
      { socketPath, path: RPC_STREAM_PATH, method: 'GET', headers },
      (response) => resolve(`response:${response.statusCode ?? 0}`),
    )
    call.on('upgrade', () => resolve('upgraded'))
    call.on('error', () => resolve('closed'))
    call.on('close', () => resolve('closed'))
    setTimeout(() => {
      call.destroy()
      resolve('closed')
    }, 1_000)
    call.end()
  })

interface SendOptions {
  readonly method: string
  readonly path: string
  readonly headers?: Readonly<Record<string, string>> | undefined
  readonly body?: string | undefined
}

type Send = (socketPath: string, options: SendOptions) => Promise<HttpResponse>

interface HttpResponse {
  readonly status: number
  readonly headers: IncomingHttpHeaders
  readonly body: string
}

const send: Send = (socketPath, options) =>
  new Promise<HttpResponse>((resolve, reject) => {
    const call = httpRequest(
      { socketPath, path: options.path, method: options.method, headers: options.headers },
      (response) => {
        const chunks: Array<string> = []
        response.setEncoding('utf8')
        response.on('data', (chunk: string) => chunks.push(chunk))
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: chunks.join(''),
          }))
      },
    )
    call.on('error', reject)
    if (options.body !== undefined) call.write(options.body)
    call.end()
  })

const withHttp = <A>(
  spec: HarnessSpec,
  body: (harness: Harness, socketPath: string, send: Send) => Promise<A>,
): Promise<A> => {
  const path = tempPath('http')
  const program = Effect.gen(function*() {
    const harness = yield* prepareHarness(spec)
    const app = yield* buildHarnessApp(spec, harness)
    yield* serveHttp({ app, env: harness.env, listen: { path } })
    return yield* Effect.promise(() => body(harness, path, send))
  })
  return Effect.runPromise(Effect.scoped(program))
}

const withRawSocket = <A>(
  spec: HarnessSpec,
  body: (socketPath: string) => Promise<A>,
): Promise<A> => {
  const path = tempPath('raw')
  const program = Effect.gen(function*() {
    const harness = yield* prepareHarness(spec)
    const app = yield* buildHarnessApp(spec, harness)
    yield* serveSocket({ app, env: harness.env, path })
    return yield* Effect.promise(() => body(path))
  })
  return Effect.runPromise(Effect.scoped(program))
}

const rpcFrame = (
  tag: string,
  payload?: unknown,
  headers: ReadonlyArray<readonly [string, string]> = [],
): string =>
  `${
    JSON.stringify({
      _tag: 'Request',
      id: '1',
      tag,
      payload: payload ?? null,
      headers,
    })
  }\n`

const failureOf = <A, E extends { readonly _tag: string; readonly message: string }, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<{ readonly tag: string; readonly message: string }, never, R> =>
  Effect.gen(function*() {
    const exit = yield* Effect.exit(effect)
    if (Exit.isSuccess(exit)) throw new Error('expected the RPC call to fail')
    for (const reason of exit.cause.reasons) {
      if (reason._tag === 'Fail') {
        const error = reason.error as { readonly _tag: string; readonly message: string }
        return { tag: error._tag, message: error.message }
      }
    }
    throw new Error(`expected a typed failure, saw ${JSON.stringify(exit.cause)}`)
  })

const scriptedProvider = (answer: string): ProviderClientShape => {
  const planner = JSON.stringify({ action: 'final', answer })
  return {
    complete: () => Effect.succeed({ text: planner }),
    stream: () =>
      Stream.fromIterable([
        { type: 'delta', text: planner },
        { type: 'complete', text: planner },
      ]),
  }
}

const fakeSearchVector = (): VectorStoreShape => ({
  searchChunks: () => Effect.succeed([]),
  optimizeIndex: () => Effect.void,
})

const fakeEmbeddingStore = (): EmbeddingVectorStore => ({
  openTable: () => Effect.succeed(Option.none()),
  createTable: () =>
    Effect.succeed({
      checkoutLatest: Effect.void,
      countPage: () => Effect.succeed(0),
      deletePage: () => Effect.void,
      addChunks: () => Effect.void,
    }),
})

const scriptedEmbeddingTransport = (): EmbeddingTransport => ({
  post: () => Effect.succeed({ status: 200, body: JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }) }),
})

const TOKEN_SPEC: HarnessSpec = {
  env: { LLM_WIKI_API_TOKEN: 'chat-token' },
  api: { allowUnauthenticated: true },
}

const TOKEN_HEADERS: Readonly<Record<string, string>> = {
  'x-llm-wiki-token': 'chat-token',
}

const EMBEDDING_SPEC = {
  embedding: { provider: 'openai', model: 'text-embedding-3-small', dimensions: 3 },
  providerCredentials: {
    openai: { apiKey: 'test-key', baseUrl: 'https://example.test/v1/embeddings' },
  },
}

describe('socket mount', () => {
  it('serves the health snapshot and the ready handshake version', async () => {
    const health = await withSocket({}, (_harness, client) => client.health())
    expect(health).toBeInstanceOf(Domain.Health)
    expect(health.ok).toBe(true)
    expect(health.status).toBe('running')
    expect(health.agent).toEqual(
      new Domain.HealthAgent({ chat: true, streaming: true, streamProtocol: 'ndjson' }),
    )
    expect(health.enabled).toBe(true)
    expect(health.mcpEnabled).toBe(true)
    expect(health.authRequired).toBe(false)
    expect(health.authConfigured).toBe(false)
    expect(health.tokenSource).toBe('none')

    const parsed = parseReadyLine(readyLine(workerHandshake('/tmp/x.sock', '/tmp/app-state.json')))
    expect(parsed?.protocolVersion).toBe(PROTOCOL_VERSION)
    expect(parsed?.socketPath).toBe('/tmp/x.sock')
    expect(parsed?.appStatePath).toBe('/tmp/app-state.json')
  })

  it('round-trips projects, files, file content, and graph', async () => {
    await withSocket({}, (_harness, client) =>
      Effect.gen(function*() {
        const projects = yield* client.projects()
        expect(projects.currentProject?.id).toBe('p1')
        expect(projects.projects).toHaveLength(1)

        const files = yield* client.files({ projectId: 'p1', root: 'wiki' })
        expect(files.root).toBe('wiki')
        expect(files.files.map((node) => node.path)).toEqual(['wiki/a.md', 'wiki/b.md'])

        const content = yield* client.fileContent({ projectId: 'p1', path: 'wiki/a.md' })
        expect(content.content).toContain('Attention mechanism')

        const graph = yield* client.graph({ projectId: 'p1' })
        expect(graph.nodes.map((node) => node.id).sort()).toEqual(['a', 'b'])
        expect(graph.edges.map((edge) => `${edge.source}->${edge.target}`)).toContain('a->b')
      }))
  })

  it('lists and patches reviews from the project review store', async () => {
    const review = {
      id: 'r1',
      type: 'missing-page',
      title: 'Missing page',
      options: [{ label: 'Create', action: 'create' }],
      resolved: false,
    }
    await withSocket(
      { files: { ...DEFAULT_FILES, '.llm-wiki/review.json': JSON.stringify([review]) } },
      (_harness, client) =>
        Effect.gen(function*() {
          const reviews = yield* client.reviews({ projectId: 'p1', status: 'all' })
          expect(reviews.count).toBe(1)
          expect(reviews.reviews[0]?.title).toBe('Missing page')

          const reviewId = reviews.reviews[0]?.id
          expect(reviewId).toBeDefined()
          const patched = yield* client.patchReview({
            projectId: 'p1',
            reviewId: reviewId ?? 'r1',
            resolved: true,
          })
          expect(patched.resolved).toBe(true)

          const reopened = yield* client.resolveReviews({
            projectId: 'p1',
            ids: [reviewId ?? 'r1'],
          })
          expect(reopened.count).toBe(1)
          expect(reopened.notFound).toEqual([])
        }),
    )
  })

  it('runs hybrid search and page embedding over the injected ports', async () => {
    await withSocket(
      {
        ...EMBEDDING_SPEC,
        ...TOKEN_SPEC,
        embeddingTransport: scriptedEmbeddingTransport(),
        embeddingStore: fakeEmbeddingStore(),
        search: {
          vector: fakeSearchVector(),
          embedQuery: () => Effect.succeed([0.1, 0.2, 0.3]),
        },
      },
      (_harness, client) =>
        Effect.gen(function*() {
          const search = yield* client.search({ projectId: 'p1', query: 'attention' })
          expect(search.results.map((result) => result.path)).toContain('wiki/a.md')

          const embedded = yield* client.embedPage({ projectId: 'p1', path: 'wiki/a.md' })
          expect(embedded.result.status).toBe('indexed')
          expect(embedded.result.chunks).toBeGreaterThan(0)
        }),
      TOKEN_HEADERS,
    )
  })

  it('rescans sources into the change queue and is idempotent on a second pass', async () => {
    await withSocket({}, (_harness, client) =>
      Effect.gen(function*() {
        const first = yield* client.rescanSources({ projectId: 'p1' })
        expect(first.result.changedTasks.map((task) => task.path)).toEqual([
          'purpose.md',
          'raw/sources/notes.txt',
          'wiki/a.md',
          'wiki/b.md',
        ])
        expect(first.result.changedTasks.every((task) => task.kind === 'created')).toBe(true)
        expect(first.result.queue.tasks).toHaveLength(4)

        const second = yield* client.rescanSources({ projectId: 'p1' })
        expect(second.result.changedTasks).toEqual([])
        expect(second.result.queue.tasks).toHaveLength(4)
      }))
  })

  it('switches the current project through setCurrentProject', async () => {
    await withSocket({}, (_harness, client) =>
      Effect.gen(function*() {
        const switched = yield* client.setCurrentProject({ projectId: 'p1' })
        expect(switched.project.current).toBe(true)
        expect(switched.project.id).toBe('p1')

        const listed = yield* client.projects()
        expect(listed.currentProject?.id).toBe('p1')
      }))
  })

  it('reloads the config file and reports the new auth state', async () => {
    const env: ServerEnv = { LLM_WIKI_API_TOKEN: 'fresh-token' }
    const path = tempPath('socket')
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const root = yield* Effect.promise(() => makeProjectRoot(DEFAULT_FILES))
          const configPath = join(root, 'server-config.json')
          const write = (api: Readonly<Record<string, unknown>>) =>
            writeFile(
              configPath,
              JSON.stringify({
                api: { enabled: true, mcpEnabled: true, ...api },
                projects: [{ path: root }],
                currentProject: root,
              }),
              'utf8',
            )
          yield* Effect.promise(() => write({ allowUnauthenticated: true }))
          const app = yield* buildApp(appInput({ env }, configPath)).pipe(
            Effect.provide(NodeHttpClient.layerNodeHttp),
          )
          yield* serveSocket({ app, env, path })
          yield* Effect.provide(
            Effect.gen(function*() {
              const client = yield* Client.SocketApiClient
              const before = yield* client.health()
              expect(before.authRequired).toBe(false)
              expect(before.enabled).toBe(true)
              expect(before.tokenSource).toBe('env')

              yield* Effect.promise(() => write({ allowUnauthenticated: false, enabled: false }))
              const reloaded = yield* client.reloadConfig()
              expect(reloaded.reloaded).toBe(true)

              const after = yield* client.health()
              expect(after.authRequired).toBe(true)
              expect(after.enabled).toBe(false)
              expect(after.authConfigured).toBe(true)

              const denied = yield* failureOf(client.projects())
              expect(denied.tag).toBe('ApiDisabled')
            }),
            Client.SocketApiClient.layer({ path }),
          )
        }),
      ),
    )
  })

  it('applies the token matrix to the socket transport', async () => {
    const tokenSpec: HarnessSpec = {
      env: { LLM_WIKI_API_TOKEN: 'secret-token' },
      api: { allowUnauthenticated: false },
    }
    const missing = await withSocket(tokenSpec, (_harness, client) => failureOf(client.projects()))
    expect(missing.tag).toBe('Unauthorized')

    const wrong = await withSocket(
      tokenSpec,
      (_harness, client) => failureOf(client.projects()),
      { authorization: 'Bearer nope' },
    )
    expect(wrong.tag).toBe('Unauthorized')

    const granted = await withSocket(
      tokenSpec,
      (_harness, client) => client.projects(),
      { 'x-llm-wiki-token': 'secret-token' },
    )
    expect(granted.projects).toHaveLength(1)

    const always = await withSocket(
      {},
      (_harness, client) => failureOf(client.embedPage({ projectId: 'p1', path: 'wiki/a.md' })),
    )
    expect(always.tag).toBe('Unauthorized')
  })

  it('enforces the api and mcp kill switches', async () => {
    const disabled = await withSocket({ api: { enabled: false } }, (_harness, client) =>
      Effect.gen(function*() {
        const health = yield* client.health()
        return { health }
      }))
    expect(disabled.health.ok).toBe(true)
    expect(disabled.health.enabled).toBe(false)

    const wire = await withRawSocket({ api: { enabled: false } }, (path) => rawNdjsonCall(path, rpcFrame('projects')))
    expect(wire).toContain('ApiDisabled')

    const mcpOff = await withSocket(
      { api: { mcpEnabled: false } },
      (_harness, client) => failureOf(client.projects()),
    )
    expect(mcpOff.tag).toBe('McpDisabled')
  })

  it('rejects an oversized payload with TooLarge before the handler runs', async () => {
    const tooLarge = await withSocket({}, (_harness, client) =>
      failureOf(
        client.fileContent({
          projectId: 'p1',
          path: 'wiki/'.concat('a'.repeat(DEFAULT_MAX_BODY_BYTES)),
        }),
      ))
    expect(tooLarge.tag).toBe('TooLarge')
  })

  it('rate limits a burst of reads', async () => {
    const limited = await withSocket(
      { rateLimit: { capacity: 1, refillPerSecond: 0.0001 } },
      (_harness, client) =>
        Effect.gen(function*() {
          const first = yield* client.projects()
          const second = yield* failureOf(client.projects())
          return { first, second }
        }),
    )
    expect(limited.first.projects).toHaveLength(1)
    expect(limited.second.tag).toBe('RateLimited')
  })

  it('serves chat turns and streams over the injected provider', async () => {
    const chat = await withSocket({ ...TOKEN_SPEC, providerClient: scriptedProvider('hello there') }, (
      _harness,
      client,
    ) =>
      Effect.gen(function*() {
        const response = yield* client.chat({ message: 'hi', sessionId: 's1', runId: 'r1' })
        const frames = yield* Stream.runCollect(
          client.chatStream({ message: 'hi', sessionId: 's2', runId: 'r2' }),
        )
        const cancelled = yield* client.chatCancel({ projectId: 'p1', sessionId: 's3' })
        return { response, frames: [...frames], cancelled }
      }), TOKEN_HEADERS)
    expect(chat.response.message.content).toBe('hello there')
    expect(chat.response.sessionId).toBe('s1')
    const types = chat.frames.map((frame) => frame.type)
    expect(types[0]).toBe('meta')
    expect(types[types.length - 1]).toBe('done')
    expect(types.slice(1, -1).every((type) => type === 'agentEvent')).toBe(true)
    const first = chat.frames[0]
    expect(first?.type === 'meta' ? first.sessionId : undefined).toBe('s2')
    const last = chat.frames[chat.frames.length - 1]
    expect(last?.type === 'done' ? last.response.message.content : undefined).toBe('hello there')
    expect(chat.cancelled.cancelled).toBe(false)
  })

  it('fails with BindConflict on a live socket and clears a stale socket file', async () => {
    const conflict = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const harness = yield* prepareHarness({})
          const app = yield* buildHarnessApp({}, harness)
          const path = tempPath('socket')
          yield* serveSocket({ app, env: {}, path })
          return yield* failureOf(serveSocket({ app, env: {}, path }))
        }),
      ),
    )
    expect(conflict.tag).toBe('BindConflict')

    const stalePath = tempPath('stale')
    await writeFile(stalePath, 'stale socket placeholder', 'utf8')
    const bound = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const harness = yield* prepareHarness({})
          const app = yield* buildHarnessApp({}, harness)
          return yield* serveSocket({ app, env: {}, path: stalePath })
        }),
      ),
    )
    expect(bound.path).toBe(stalePath)
  })
})

describe('http app probe', () => {
  it('returns 404 for an unknown route when driven directly', async () => {
    const outcome = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const harness = yield* prepareHarness({})
          const app = yield* buildHarnessApp({}, harness)
          const httpApp = yield* makeHttpApp({ app, env: {} })
          const request = HttpServerRequest.fromWeb(
            new Request('http://localhost/nope', { method: 'POST' }),
          )
          const exit = yield* Effect.exit(
            httpApp.pipe(
              Effect.provideService(HttpServerRequest.HttpServerRequest, request),
            ),
          )
          return Exit.isSuccess(exit)
            ? `ok:${exit.value.status}`
            : `fail:${JSON.stringify(exit.cause).slice(0, 300)}`
        }),
      ),
    )
    expect(outcome).toBe('ok:404')
  })
})

describe('standalone HTTP mount', () => {
  it('serves RPC frames over POST and rejects bad content types and routes', async () => {
    await withHttp({}, async (_harness, socketPath, call) => {
      const missing = await call(socketPath, { method: 'POST', path: '/nope' })
      expect(missing.status).toBe(404)

      const wrongMethod = await call(socketPath, { method: 'GET', path: RPC_PATH })
      expect(wrongMethod.status).toBe(405)

      const wrongType = await call(socketPath, {
        method: 'POST',
        path: RPC_PATH,
        headers: { 'content-type': 'application/json' },
        body: rpcFrame('health'),
      })
      expect(wrongType.status).toBe(415)
      expect(wrongType.body).toContain(Api.ApiSerialization.contentType)

      const health = await call(socketPath, {
        method: 'POST',
        path: RPC_PATH,
        headers: { 'content-type': Api.ApiSerialization.contentType },
        body: rpcFrame('health'),
      })
      expect(health.status).toBe(200)
      expect(health.body).toContain('"ok":true')
    })
  })

  it('carries typed failures over HTTP and honours the token matrix', async () => {
    const env: ServerEnv = { LLM_WIKI_API_TOKEN: 'secret-token' }
    await withHttp({ env, api: { allowUnauthenticated: false } }, async (
      _harness,
      socketPath,
      call,
    ) => {
      const denied = await call(socketPath, {
        method: 'POST',
        path: RPC_PATH,
        headers: { 'content-type': Api.ApiSerialization.contentType },
        body: rpcFrame('projects'),
      })
      expect(denied.body).toContain('Unauthorized')

      const granted = await call(socketPath, {
        method: 'POST',
        path: RPC_PATH,
        headers: {
          'content-type': Api.ApiSerialization.contentType,
          authorization: 'Bearer secret-token',
        },
        body: rpcFrame('projects'),
      })
      expect(granted.body).toContain('Success')
      expect(granted.body).toContain('p1')
    })
  })

  it('reflects allowed browser origins and rejects foreign websocket origins', async () => {
    await withHttp({}, async (_harness, socketPath, call) => {
      const preflight = await call(socketPath, {
        method: 'OPTIONS',
        path: RPC_PATH,
        headers: {
          origin: 'http://localhost:5173',
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'content-type',
        },
      })
      expect(preflight.headers['access-control-allow-origin']).toBe('http://localhost:5173')

      const allowed = await call(socketPath, {
        method: 'POST',
        path: RPC_PATH,
        headers: {
          'content-type': Api.ApiSerialization.contentType,
          origin: 'http://localhost:5173',
        },
        body: rpcFrame('health'),
      })
      expect(allowed.status).toBe(200)
      expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:5173')
    })

    const socketPath = tempPath('ws')
    const outcomes = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const harness = yield* prepareHarness({})
          const app = yield* buildHarnessApp({}, harness)
          yield* serveHttp({ app, env: {}, listen: { path: socketPath } })
          return yield* Effect.promise(async () => ({
            foreign: await upgradeAttempt(socketPath, {
              upgrade: 'websocket',
              connection: 'Upgrade',
              origin: 'https://evil.com',
            }),
            nested: await upgradeAttempt(socketPath, {
              upgrade: 'websocket',
              connection: 'Upgrade',
              origin: 'http://localhost.evil.com',
            }),
          }))
        }),
      ),
    )
    expect(outcomes.foreign).not.toBe('upgraded')
    expect(outcomes.foreign).toBe('response:403')
    expect(outcomes.nested).toBe('response:403')

    const allowed = (origin: string | undefined): boolean =>
      isUpgradeOriginAllowed(
        Headers.fromInput(origin === undefined ? {} : { origin }),
      )
    expect(allowed('https://evil.com')).toBe(false)
    expect(allowed('http://localhost.evil.com')).toBe(false)
    expect(allowed('http://localhost:5173')).toBe(true)
    expect(allowed('tauri://localhost')).toBe(true)
    expect(allowed(undefined)).toBe(true)
  })

  it('reports the standalone address handshake', () => {
    const handshake = standaloneHandshake('127.0.0.1', 19_828)
    expect(handshake.mode).toBe('standalone')
    expect(handshake.url).toBe('http://127.0.0.1:19828')
    expect(handshake.protocolVersion).toBe(PROTOCOL_VERSION)
  })
})

describe('rescan rules', () => {
  it('never watches files under an excluded directory', () => {
    fcAssert(
      fcProperty(
        constantFrom(...SOURCE_WATCH_DEFAULTS.excludeDirs),
        fcString(),
        (excludedDir, rest) => {
          const rules = watchRules(normalizeSourceWatchConfig())
          expect(shouldWatchRel(`raw/sources/${excludedDir}/${rest}.md`, rules)).toBe(false)
        },
      ),
      { numRuns: 150 },
    )
  })

  it('watches only the public source surface', () => {
    const rules = watchRules(normalizeSourceWatchConfig())
    expect(shouldWatchRel('purpose.md', rules)).toBe(true)
    expect(shouldWatchRel('schema.md', rules)).toBe(true)
    expect(shouldWatchRel('wiki/a.md', rules)).toBe(true)
    expect(shouldWatchRel('wiki/a.txt', rules)).toBe(false)
    expect(shouldWatchRel('wiki/media/a.png', rules)).toBe(false)
    expect(shouldWatchRel('.llm-wiki/review.json', rules)).toBe(false)
    expect(shouldWatchRel('raw/sources/notes.pdf', rules)).toBe(true)
    expect(shouldWatchRel('raw/sources/notes.exe', rules)).toBe(false)
    expect(shouldWatchRel('raw/other/notes.md', rules)).toBe(false)
  })

  it('encodes arbitrary ready handshakes as a single parseable line', () => {
    fcAssert(
      fcProperty(
        fcString({ minLength: 1 }),
        integer({ min: 0, max: 100 }),
        (socketPath, protocolVersion) => {
          const line = readyLine({
            protocolVersion,
            serverVersion: '1.2.3',
            mode: 'worker',
            socketPath,
            appStatePath: '/tmp/app-state.json',
          })
          expect(line.split('\n')).toHaveLength(1)
          const parsed = parseReadyLine(line)
          expect(parsed?.protocolVersion).toBe(protocolVersion)
          expect(parsed?.socketPath).toBe(socketPath)
        },
      ),
      { numRuns: 150 },
    )
  })
})

describe('protocol surface', () => {
  it('keeps every catalog operation on the mounted group', () => {
    for (const name of Catalog.ApiCatalogNames) {
      expect(Api.ApiProtocol.requests.has(name)).toBe(true)
    }
    expect(Catalog.ApiCatalogNames).toHaveLength(25)
  })

  it('keeps the typed error space reachable', () => {
    expect(new Errors.Unauthorized({ message: 'x' })._tag).toBe('Unauthorized')
    expect(new Errors.BindConflict({ message: 'x' })._tag).toBe('BindConflict')
    expect(new Errors.TooLarge({ message: 'x' })._tag).toBe('TooLarge')
  })
})
