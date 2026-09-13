import { NodeHttpClient } from '@effect/platform-node'
import lancedb from '@lancedb/lancedb'
import { Effect, Exit } from 'effect'
import { RpcClient } from 'effect/unstable/rpc'
import { Api, Client } from 'llm-wiki-protocol'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { EmbeddingTransport } from '../src/embeddings/Embeddings.js'
import { isRecord } from '../src/json.js'
import { buildApp } from '../src/server/app.js'
import type { ServerAppInput } from '../src/server/app.js'
import { serveSocket } from '../src/server/mount.js'
import type { RescanOptions } from '../src/server/rescan.js'

type ApiClient = Api.ApiClient
type ServerEnv = Readonly<Record<string, string | undefined>>

const PROJECT_ID = 'p1'
const TOKEN = 'extension-token'
const TOKEN_ENV: ServerEnv = { LLM_WIKI_API_TOKEN: TOKEN }
const TOKEN_HEADERS: Readonly<Record<string, string>> = { 'x-llm-wiki-token': TOKEN }

const createdRoots: Array<string> = []
const createdPaths: Array<string> = []

afterAll(async () => {
  await Promise.all(createdRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  await Promise.all(createdPaths.splice(0).map((path) => rm(path, { force: true })))
})

const DEFAULT_FILES: Readonly<Record<string, string>> = {
  'wiki/a.md': '# A\n\nAlpha body text kept short so one chunk is indexed.\n',
  'wiki/b.md': '# B\n\nBeta body text.\n',
}

const makeProjectRoot = async (files: Readonly<Record<string, string>>): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'llm-wiki-extensions-'))
  createdRoots.push(root)
  await mkdir(join(root, '.llm-wiki'), { recursive: true })
  await writeFile(join(root, '.llm-wiki', 'project.json'), JSON.stringify({ id: PROJECT_ID }), 'utf8')
  for (const [relative, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, relative)), { recursive: true })
    await writeFile(join(root, relative), content, 'utf8')
  }
  return root
}

interface RecordedRequest {
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: string
}

const recordingTransport = (requests: Array<RecordedRequest>): EmbeddingTransport => ({
  post: (request) =>
    Effect.sync(() => {
      requests.push({ url: request.url, headers: request.headers, body: request.body })
      const parsed: unknown = JSON.parse(request.body)
      const record = isRecord(parsed) ? parsed : {}
      if (record['content'] !== undefined) {
        return { status: 200, body: JSON.stringify({ embedding: { values: [0.5, 0.5] } }) }
      }
      const rawInput: unknown = record['input']
      const inputs = Array.isArray(rawInput)
        ? rawInput.filter((value): value is string => typeof value === 'string')
        : typeof rawInput === 'string'
        ? [rawInput]
        : []
      const data = inputs.map((text, index) => ({ index, embedding: [text.length, 0.25] }))
      return { status: 200, body: JSON.stringify({ data: [...data].reverse() }) }
    }),
})

interface HarnessSpec {
  readonly files?: Readonly<Record<string, string>> | undefined
  readonly api?: Readonly<Record<string, unknown>> | undefined
  readonly env?: ServerEnv | undefined
  readonly embeddingTransport?: EmbeddingTransport | undefined
  readonly rescan?: RescanOptions | undefined
}

interface Harness {
  readonly root: string
  readonly configPath: string
  readonly env: ServerEnv
}

const EMBEDDING_CONFIG = {
  embedding: { provider: 'openai', model: 'text-embedding-3-small', dimensions: 2 },
  providerCredentials: {
    openai: { apiKey: 'test-key', baseUrl: 'https://example.test/v1/embeddings' },
  },
}

const configBody = (root: string, spec: HarnessSpec): Record<string, unknown> => ({
  api: { enabled: true, mcpEnabled: true, allowUnauthenticated: true, ...spec.api },
  projects: [{ path: root }],
  currentProject: root,
  ...EMBEDDING_CONFIG,
})

const appInput = (spec: HarnessSpec, configPath: string): ServerAppInput => ({
  config: { mode: 'standalone', configPath, env: spec.env ?? {} },
  env: spec.env ?? {},
  agent: { provider: 'openai', model: 'gpt-4o' },
  ...(spec.embeddingTransport === undefined
    ? {}
    : { embeddings: { transport: spec.embeddingTransport } }),
  ...(spec.rescan === undefined ? {} : { rescan: spec.rescan }),
})

const buildHarnessApp = (spec: HarnessSpec, harness: Harness) =>
  buildApp(appInput(spec, harness.configPath)).pipe(Effect.provide(NodeHttpClient.layerNodeHttp))

const prepareHarness = (spec: HarnessSpec) =>
  Effect.gen(function*() {
    const root = yield* Effect.promise(() => makeProjectRoot(spec.files ?? DEFAULT_FILES))
    const configPath = join(root, 'server-config.json')
    yield* Effect.promise(async () => {
      await writeFile(configPath, JSON.stringify(configBody(root, spec)), 'utf8')
    })
    return { root, configPath, env: spec.env ?? {} } satisfies Harness
  })

const withSocket = <A, E>(
  spec: HarnessSpec,
  body: (harness: Harness, client: ApiClient) => Effect.Effect<A, E>,
  headers?: Readonly<Record<string, string>>,
): Promise<A> => {
  const path = process.platform === 'win32'
    ? `\\\\.\\pipe\\llm-wiki-extensions-${randomUUID()}`
    : join(tmpdir(), `llm-wiki-extensions-${randomUUID()}.sock`)
  createdPaths.push(path)
  const program = Effect.gen(function*() {
    const harness = yield* prepareHarness(spec)
    const app = yield* buildHarnessApp(spec, harness)
    yield* serveSocket({ app, env: harness.env, path })
    return yield* Effect.provide(
      Effect.gen(function*() {
        const client = yield* Client.SocketApiClient
        return yield* body(harness, client)
      }).pipe(
        headers === undefined
          ? (self) => self
          : Effect.provideService(RpcClient.CurrentHeaders, headers),
      ),
      Client.SocketApiClient.layer({ path }),
    )
  })
  return Effect.runPromise(Effect.scoped(program))
}

const withClient = <A, E>(
  spec: HarnessSpec,
  body: (harness: Harness, client: ApiClient) => Effect.Effect<A, E>,
): Promise<A> => withSocket({ ...spec, env: TOKEN_ENV }, body, TOKEN_HEADERS)

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

describe('embedTexts', () => {
  it('orders the provider batch result back onto the request input', async () => {
    const requests: Array<RecordedRequest> = []
    const texts = ['a', 'bb', 'ccc', 'dddd']
    const response = await withClient(
      { embeddingTransport: recordingTransport(requests) },
      (_harness, client) => client.embedTexts({ texts }),
    )
    expect(response.vectors).toEqual([
      [1, 0.25],
      [2, 0.25],
      [3, 0.25],
      [4, 0.25],
    ])
    expect(requests).toHaveLength(1)
    expect(JSON.parse(requests[0]?.body ?? '{}')).toMatchObject({ input: texts })
  })

  it('serves the provider override through one request per text', async () => {
    const requests: Array<RecordedRequest> = []
    const response = await withClient(
      { embeddingTransport: recordingTransport(requests) },
      (_harness, client) => client.embedTexts({ provider: 'google', texts: ['a', 'bb'] }),
    )
    expect(response.vectors).toEqual([
      [0.5, 0.5],
      [0.5, 0.5],
    ])
    expect(requests).toHaveLength(2)
    for (const request of requests) {
      expect(request.url).toContain('generativelanguage.googleapis.com')
      expect(request.url).toContain(':embedContent')
    }
  })

  it('rejects a text count outside 1..512 with a typed EmbedError', async () => {
    const requests: Array<RecordedRequest> = []
    const spec = { embeddingTransport: recordingTransport(requests) }
    const empty = await withClient(spec, (_harness, client) => failureOf(client.embedTexts({ texts: [] })))
    expect(empty.tag).toBe('EmbedError')
    expect(empty.message).toContain('between 1 and 512')

    const oversized = await withClient(spec, (_harness, client) =>
      failureOf(
        client.embedTexts({ texts: Array.from({ length: 513 }, (_value, index) => `t${index}`) }),
      ))
    expect(oversized.tag).toBe('EmbedError')
    expect(oversized.message).toContain('between 1 and 512')
    expect(requests).toHaveLength(0)
  })
})

describe('vector index maintenance', () => {
  it('counts, deletes, clears, and optimizes the chunk index of a project', async () => {
    const requests: Array<RecordedRequest> = []
    const steps = await withClient(
      { embeddingTransport: recordingTransport(requests) },
      (_harness, client) =>
        Effect.gen(function*() {
          const before = yield* client.vectorStats({ projectId: PROJECT_ID })
          const indexed = yield* client.embedPage({ projectId: PROJECT_ID, path: 'wiki/a.md' })
          const afterIndex = yield* client.vectorStats({ projectId: PROJECT_ID })
          const deleted = yield* client.vectorDeletePage({ projectId: PROJECT_ID, pageId: 'a' })
          const afterDelete = yield* client.vectorStats({ projectId: PROJECT_ID })
          const reindexed = yield* client.embedPage({
            projectId: PROJECT_ID,
            path: 'wiki/a.md',
            force: true,
          })
          const cleared = yield* client.vectorClear({ projectId: PROJECT_ID })
          const afterClear = yield* client.vectorStats({ projectId: PROJECT_ID })
          const optimized = yield* client.vectorOptimize({ projectId: PROJECT_ID })
          return {
            before,
            indexed,
            afterIndex,
            deleted,
            afterDelete,
            reindexed,
            cleared,
            afterClear,
            optimized,
          }
        }),
    )

    expect(steps.before.chunks).toBe(0)
    expect(steps.before.legacyRows).toBe(0)
    expect(steps.indexed.result.status).toBe('indexed')
    const chunks = steps.indexed.result.chunks
    expect(chunks).toBeGreaterThan(0)
    expect(steps.afterIndex.chunks).toBe(chunks)
    expect(steps.deleted.ok).toBe(true)
    expect(steps.deleted.deleted).toBe(chunks)
    expect(steps.afterDelete.chunks).toBe(0)
    expect(steps.reindexed.result.status).toBe('indexed')
    expect(steps.cleared.ok).toBe(true)
    expect(steps.cleared.deleted).toBe(chunks)
    expect(steps.afterClear.chunks).toBe(0)
    expect(steps.optimized.ok).toBe(true)
  })

  it('reads the legacy v1 table beside the v2 chunk count and drops it once', async () => {
    const outcome = await withClient({}, (harness, client) =>
      Effect.gen(function*() {
        const connection = yield* Effect.promise(() => lancedb.connect(join(harness.root, '.llm-wiki', 'lancedb')))
        yield* Effect.promise(() =>
          connection.createTable('wiki_vectors', [
            { page_id: 'old-page', vector: [0.1, 0.2, 0.3] },
          ])
        )
        const before = yield* client.vectorStats({ projectId: PROJECT_ID })
        const dropped = yield* client.vectorDropLegacy({ projectId: PROJECT_ID })
        const after = yield* client.vectorStats({ projectId: PROJECT_ID })
        const again = yield* client.vectorDropLegacy({ projectId: PROJECT_ID })
        return { before, dropped, after, again }
      }))

    expect(outcome.before.legacyRows).toBe(1)
    expect(outcome.before.chunks).toBe(0)
    expect(outcome.dropped.ok).toBe(true)
    expect(outcome.dropped.dropped).toBe(true)
    expect(outcome.after.legacyRows).toBe(0)
    expect(outcome.again.dropped).toBe(false)
  })

  it('rejects a page id that would break the delete filter', async () => {
    const denied = await withClient(
      {},
      (_harness, client) => failureOf(client.vectorDeletePage({ projectId: PROJECT_ID, pageId: "bad'quote" })),
    )
    expect(denied.tag).toBe('EmbedError')
    expect(denied.message).toContain('disallowed character')
  })
})

describe('file change queue', () => {
  const QUEUE_FILE = join('.llm-wiki', 'file-change-queue.json')

  const failedTask = (id: string): Record<string, unknown> => ({
    id,
    projectId: PROJECT_ID,
    path: 'raw/sources/notes.txt',
    kind: 'modified',
    status: 'failed',
    hashBefore: 'before',
    hashAfter: 'after',
    size: 12,
    mtimeMs: 5,
    createdAt: 1,
    updatedAt: 2,
    retryCount: 3,
    error: 'ingest failed',
    needsRerun: false,
  })

  const writeQueueFile = async (root: string, tasks: ReadonlyArray<unknown>): Promise<void> => {
    await mkdir(join(root, '.llm-wiki'), { recursive: true })
    await writeFile(
      join(root, QUEUE_FILE),
      `${JSON.stringify({ version: 1, tasks }, null, 2)}\n`,
      'utf8',
    )
  }

  const readQueueFile = async (
    root: string,
  ): Promise<ReadonlyArray<Record<string, unknown>>> => {
    const parsed: unknown = JSON.parse(await readFile(join(root, QUEUE_FILE), 'utf8'))
    if (!isRecord(parsed) || !Array.isArray(parsed['tasks'])) return []
    return parsed['tasks'].filter(isRecord)
  }

  it('snapshots the queue a rescan writes, empty before the first change', async () => {
    const outcome = await withClient({}, (_harness, client) =>
      Effect.gen(function*() {
        const empty = yield* client.fileChanges({ projectId: PROJECT_ID })
        yield* client.rescanSources({ projectId: PROJECT_ID })
        const scanned = yield* client.fileChanges({ projectId: PROJECT_ID })
        return { empty, scanned }
      }))

    expect(outcome.empty.projectId).toBe(PROJECT_ID)
    expect(outcome.empty.queue.version).toBe(1)
    expect(outcome.empty.queue.tasks).toEqual([])
    expect(outcome.scanned.queue.tasks.map((task) => task.path)).toEqual([
      'wiki/a.md',
      'wiki/b.md',
    ])
    expect(outcome.scanned.queue.tasks.every((task) => task.status === 'pending')).toBe(true)
  })

  it('resets a failed task to pending and persists the queue', async () => {
    const outcome = await withClient({ rescan: { now: () => 1_234 } }, (harness, client) =>
      Effect.gen(function*() {
        yield* Effect.promise(() => writeQueueFile(harness.root, [failedTask('task_1')]))
        const queue = yield* client.retryFileChange({
          projectId: PROJECT_ID,
          taskId: 'task_1',
        })
        const persisted = yield* Effect.promise(() => readQueueFile(harness.root))
        return { task: queue.queue.tasks[0], persisted }
      }))

    expect(outcome.task?.status).toBe('pending')
    expect(outcome.task?.retryCount).toBe(0)
    expect(outcome.task?.error).toBeNull()
    expect(outcome.task?.needsRerun).toBe(false)
    expect(outcome.task?.updatedAt).toBe(1_234)
    expect(outcome.persisted[0]?.['status']).toBe('pending')
    expect(outcome.persisted[0]?.['retryCount']).toBe(0)
    expect(outcome.persisted[0]?.['error']).toBeNull()
  })

  it('ignores exactly the named task and leaves unknown ids alone', async () => {
    const outcome = await withClient({}, (harness, client) =>
      Effect.gen(function*() {
        yield* Effect.promise(() => writeQueueFile(harness.root, [failedTask('task_1'), failedTask('task_2')]))
        const unknown = yield* client.ignoreFileChange({
          projectId: PROJECT_ID,
          taskId: 'task_nope',
        })
        const ignored = yield* client.ignoreFileChange({
          projectId: PROJECT_ID,
          taskId: 'task_1',
        })
        const persisted = yield* Effect.promise(() => readQueueFile(harness.root))
        return { unknown, ignored, persisted }
      }))

    expect(outcome.unknown.queue.tasks.map((task) => task.id)).toEqual(['task_1', 'task_2'])
    expect(outcome.ignored.queue.tasks.map((task) => task.id)).toEqual(['task_2'])
    expect(outcome.persisted.map((task) => task['id'])).toEqual(['task_2'])
  })

  it('leaves the queue untouched when the task id is unknown', async () => {
    const queue = await withClient({}, (harness, client) =>
      Effect.gen(function*() {
        yield* Effect.promise(() => writeQueueFile(harness.root, [failedTask('task_1')]))
        return yield* client.retryFileChange({ projectId: PROJECT_ID, taskId: 'task_nope' })
      }))
    expect(queue.queue.tasks.map((task) => task.id)).toEqual(['task_1'])
    expect(queue.queue.tasks[0]?.status).toBe('failed')
    expect(queue.queue.tasks[0]?.retryCount).toBe(3)
  })
})

describe('token requirements', () => {
  it('keeps the nine new operations token-required while reads are open', async () => {
    const openSpec: HarnessSpec = {
      env: TOKEN_ENV,
      api: { allowUnauthenticated: true },
    }
    const calls: ReadonlyArray<
      (client: ApiClient) => Effect.Effect<unknown, { readonly _tag: string; readonly message: string }>
    > = [
      (client: ApiClient) => client.embedTexts({ texts: ['a'] }),
      (client: ApiClient) => client.fileChanges({ projectId: PROJECT_ID }),
      (client: ApiClient) => client.retryFileChange({ projectId: PROJECT_ID, taskId: 'task_1' }),
      (client: ApiClient) => client.ignoreFileChange({ projectId: PROJECT_ID, taskId: 'task_1' }),
      (client: ApiClient) => client.vectorStats({ projectId: PROJECT_ID }),
      (client: ApiClient) => client.vectorOptimize({ projectId: PROJECT_ID }),
      (client: ApiClient) => client.vectorClear({ projectId: PROJECT_ID }),
      (client: ApiClient) => client.vectorDeletePage({ projectId: PROJECT_ID, pageId: 'a' }),
      (client: ApiClient) => client.vectorDropLegacy({ projectId: PROJECT_ID }),
    ]
    for (const call of calls) {
      const denied = await withSocket(openSpec, (_harness, client) => failureOf(call(client)))
      expect(denied.tag).toBe('Unauthorized')
    }

    const granted = await withSocket(
      openSpec,
      (_harness, client) => client.vectorStats({ projectId: PROJECT_ID }),
      TOKEN_HEADERS,
    )
    expect(granted.chunks).toBe(0)
  })
})
