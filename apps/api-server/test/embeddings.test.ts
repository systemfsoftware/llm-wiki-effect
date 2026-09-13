import { Duration, Effect, Option, Result } from 'effect'
import * as fc from 'fast-check'
import { Errors } from 'llm-wiki-protocol'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { Config } from '../src/config/Config.js'
import type { ConfigShape } from '../src/config/Config.js'
import { charCount, chunkMarkdown, enrichChunk, extractTitle } from '../src/embeddings/chunker.js'
import { chunkBatches, Embeddings } from '../src/embeddings/Embeddings.js'
import type { EmbeddingsShape, EmbeddingTransport } from '../src/embeddings/Embeddings.js'
import { contentRevision, embeddingFingerprint } from '../src/embeddings/fingerprint.js'
import {
  batchEmbeddingRequest,
  isLocalOrPrivateHttpEndpoint,
  looksLikeOversizeError,
  parseEmbeddingBatchValues,
  parseEmbeddingValues,
  singleEmbeddingRequest,
  supportsBatch,
} from '../src/embeddings/request.js'
import type { EmbeddingHttpRequest, EmbeddingHttpResponse } from '../src/embeddings/request.js'
import { invalidateRevision, loadRevision, saveRevision } from '../src/embeddings/revision.js'
import {
  clampChunkChars,
  clampOverlapChars,
  embeddingSpecFrom,
  MAX_CHUNK_CHARS,
  MAX_PAGE_CHUNKS,
} from '../src/embeddings/spec.js'
import type { EmbeddingSpec, EmbeddingTimeouts } from '../src/embeddings/spec.js'
import type { VectorStore, VectorTable } from '../src/embeddings/vector-store.js'
import { isRecord } from '../src/json.js'
import type { ProjectRegistryShape } from '../src/projects/Registry.js'

const tempDirs: Array<string> = []

const makeTempDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'llm-wiki-embed-'))
  tempDirs.push(dir)
  return dir
}

const makeProject = async (): Promise<string> => {
  const dir = await makeTempDir()
  await mkdir(join(dir, 'wiki', 'nested'), { recursive: true })
  return dir
}

afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

const first = <T>(items: ReadonlyArray<T>): T => {
  const value = items[0]
  if (value === undefined) throw new Error('expected a first element')
  return value
}

const recordOf = (text: string): Record<string, unknown> => {
  const parsed: unknown = JSON.parse(text)
  if (!isRecord(parsed)) throw new Error(`expected an object body, received ${text}`)
  return parsed
}

const spec = (overrides: Partial<EmbeddingSpec> = {}): EmbeddingSpec => ({
  provider: 'openai',
  model: 'text-embedding-3-small',
  endpoint: 'https://api.openai.com/v1/embeddings',
  apiKey: 'sk-test',
  outputDimensionality: undefined,
  extraHeaders: {},
  maxChunkChars: 1_000,
  overlapChunkChars: 200,
  enabled: true,
  ...overrides,
})

const succeed = <A>(result: Result.Result<A, unknown>): A => {
  if (Result.isFailure(result)) throw new Error(`expected a success, received ${String(result.failure)}`)
  return result.success
}

const googleText = (request: EmbeddingHttpRequest): string => {
  const content = recordOf(request.body)['content']
  if (!isRecord(content)) throw new Error('expected a content object')
  const parts = content['parts']
  if (!Array.isArray(parts)) throw new Error('expected content parts')
  const part = parts[0]
  if (!isRecord(part) || typeof part['text'] !== 'string') throw new Error('expected a text part')
  return part['text']
}

const GOOGLE_CONFIG = {
  embedding: { provider: 'google', model: 'gemini-embedding-001', dimensions: 3 },
  providerCredentials: {
    google: { apiKey: 'goog-key', baseUrl: 'https://generativelanguage.googleapis.com/v1beta' },
  },
}

const GOOGLE_VECTOR = JSON.stringify({ embedding: { values: [1, 2, 3] } })

describe('embedding request shaping', () => {
  it('builds the openai-compatible single request', () => {
    const request = singleEmbeddingRequest(spec(), 'hello')

    expect(request.url).toBe('https://api.openai.com/v1/embeddings')
    expect(request.headers['Authorization']).toBe('Bearer sk-test')
    expect(request.headers['Content-Type']).toBe('application/json')
    expect(request.headers['Origin']).toBeUndefined()
    expect(recordOf(request.body)).toEqual({ model: 'text-embedding-3-small', input: 'hello' })
  })

  it('addresses google through the models path with the goog api key header', () => {
    const request = singleEmbeddingRequest(
      spec({
        provider: 'google',
        endpoint: 'https://generativelanguage.googleapis.com/v1beta',
        apiKey: 'goog-key',
        model: 'gemini-embedding-001',
        outputDimensionality: 768,
      }),
      'hello',
    )

    expect(request.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent',
    )
    expect(request.headers['x-goog-api-key']).toBe('goog-key')
    expect(request.headers['Authorization']).toBeUndefined()
    expect(recordOf(request.body)).toEqual({
      model: 'models/gemini-embedding-001',
      content: { parts: [{ text: 'hello' }] },
      output_dimensionality: 768,
    })
  })

  it('normalizes a google batch endpoint and floors the dimensionality', () => {
    const request = singleEmbeddingRequest(
      spec({
        endpoint: 'https://generativelanguage.googleapis.com/v1beta/models/x:batchEmbedContents?key=URL',
        outputDimensionality: 1.9,
      }),
      'hello',
    )

    expect(request.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/x:embedContent',
    )
    expect(recordOf(request.body)['output_dimensionality']).toBe(1)
  })

  it('rewrites volcengine endpoints and emits the doubao multimodal body', () => {
    const plain = singleEmbeddingRequest(
      spec({ endpoint: 'https://ark.cn-beijing.volces.com/api/v3', model: 'doubao-embedding' }),
      'hello',
    )
    expect(plain.url).toBe('https://ark.cn-beijing.volces.com/api/v3/embeddings')

    const vision = singleEmbeddingRequest(
      spec({
        endpoint: 'https://ark.cn-beijing.volces.com/api/v3',
        model: 'doubao-embedding-vision',
      }),
      'hello',
    )
    expect(vision.url).toBe('https://ark.cn-beijing.volces.com/api/v3/embeddings/multimodal')
    expect(recordOf(vision.body)).toEqual({
      model: 'doubao-embedding-vision',
      encoding_format: 'float',
      input: [{ type: 'text', text: 'hello' }],
    })
  })

  it('leaves a non-volcengine endpoint untouched and does not duplicate the suffix', () => {
    expect(
      singleEmbeddingRequest(
        spec({ endpoint: 'https://gateway.example.com/proxy/volcengine?upstream=volces.com' }),
        'x',
      ).url,
    ).toBe('https://gateway.example.com/proxy/volcengine?upstream=volces.com')

    expect(
      singleEmbeddingRequest(
        spec({ endpoint: 'https://ARK.cn-beijing.volces.com/api/v3/embeddings' }),
        'x',
      ).url,
    ).toBe('https://ark.cn-beijing.volces.com/api/v3/embeddings')
  })

  it('elevates the batch endpoint to multimodal and demotes it for text models', () => {
    expect(
      batchEmbeddingRequest(
        spec({
          endpoint: 'https://ark.cn-beijing.volces.com/api/v3/embeddings',
          model: 'doubao-embedding-vision',
        }),
        ['a'],
      ).url,
    ).toBe('https://ark.cn-beijing.volces.com/api/v3/embeddings/multimodal')

    expect(
      batchEmbeddingRequest(
        spec({ endpoint: 'https://ark.cn-beijing.volces.com/api/v3/embeddings/multimodal' }),
        ['a'],
      ).url,
    ).toBe('https://ark.cn-beijing.volces.com/api/v3/embeddings')
  })

  it('sends the loopback Origin header for private and local endpoints only', () => {
    const privateRequest = singleEmbeddingRequest(
      spec({ endpoint: 'http://192.168.1.20:11434/v1/embeddings' }),
      'x',
    )
    expect(privateRequest.headers['Origin']).toBe('http://localhost')
    expect(singleEmbeddingRequest(spec(), 'x').headers['Origin']).toBeUndefined()

    expect(isLocalOrPrivateHttpEndpoint('http://127.0.0.1:1234/v1/embeddings')).toBe(true)
    expect(isLocalOrPrivateHttpEndpoint('http://172.16.0.5/v1/embeddings')).toBe(true)
    expect(isLocalOrPrivateHttpEndpoint('http://10.1.2.3/v1/embeddings')).toBe(true)
    expect(isLocalOrPrivateHttpEndpoint('https://api.openai.com/v1/embeddings')).toBe(false)
    expect(isLocalOrPrivateHttpEndpoint('not a url')).toBe(false)
  })

  it('carries extra headers but never reserved or malformed ones', () => {
    const request = singleEmbeddingRequest(
      spec({
        extraHeaders: {
          'X-Route': 'siliconflow',
          Authorization: 'stolen',
          'x-goog-api-key': 'stolen',
          'bad header': 'x',
          'X-Blank': '   ',
        },
      }),
      'x',
    )

    expect(request.headers['X-Route']).toBe('siliconflow')
    expect(request.headers['Authorization']).toBe('Bearer sk-test')
    expect(request.headers['x-goog-api-key']).toBeUndefined()
    expect(request.headers['bad header']).toBeUndefined()
    expect(request.headers['X-Blank']).toBeUndefined()
  })

  it('detects oversize rejections from the status and the body text', () => {
    expect(looksLikeOversizeError(413, '')).toBe(true)
    expect(looksLikeOversizeError(400, 'This input is too long for the model')).toBe(true)
    expect(looksLikeOversizeError(400, 'maximum context length exceeded')).toBe(true)
    expect(looksLikeOversizeError(401, 'invalid api key')).toBe(false)
  })

  it('parses each provider response envelope and rejects empty vectors', () => {
    expect(succeed(parseEmbeddingValues({ data: [{ embedding: [1, 2] }] }, false, false))).toEqual([1, 2])
    expect(succeed(parseEmbeddingValues({ embedding: { values: [3] } }, true, false))).toEqual([3])
    expect(succeed(parseEmbeddingValues({ data: { embedding: [4] } }, false, true))).toEqual([4])

    expect(Result.isFailure(parseEmbeddingValues({ data: [] }, false, false))).toBe(true)
    expect(Result.isFailure(parseEmbeddingValues({ data: [{ embedding: [] }] }, false, false))).toBe(true)
  })

  it('parses batch envelopes in index order and rejects inconsistent payloads', () => {
    const ordered = parseEmbeddingBatchValues(
      {
        data: [
          { index: 1, embedding: [2] },
          { index: 0, embedding: [1] },
        ],
      },
      2,
    )
    expect(succeed(ordered)).toEqual([[1], [2]])

    const short = parseEmbeddingBatchValues({ data: [{ index: 0, embedding: [1] }] }, 2)
    expect(Result.isFailure(short)).toBe(true)

    const ragged = parseEmbeddingBatchValues(
      {
        data: [
          { index: 0, embedding: [1, 2] },
          { index: 1, embedding: [1] },
        ],
      },
      2,
    )
    expect(Result.isFailure(ragged)).toBe(true)

    const duplicate = parseEmbeddingBatchValues(
      {
        data: [
          { index: 0, embedding: [1] },
          { index: 0, embedding: [1] },
        ],
      },
      2,
    )
    expect(Result.isFailure(duplicate)).toBe(true)
  })

  it('decides batch support from the endpoint predicate and the doubao model', () => {
    expect(supportsBatch(spec())).toBe(true)
    expect(supportsBatch(spec({ endpoint: 'https://x:embedContent' }))).toBe(false)
    expect(supportsBatch(spec({ model: 'doubao-embedding-vision' }))).toBe(false)
  })
})

const CONFIG_BASE = {
  embedding: { provider: 'openai', model: 'text-embedding-3-small', dimensions: 3 },
  providerCredentials: {
    openai: { apiKey: 'sk-test', baseUrl: 'https://api.openai.com/v1/embeddings' },
  },
}

const makeConfig = async (dir: string, config: unknown): Promise<ConfigShape> => {
  const configPath = join(dir, 'config.json')
  await writeFile(configPath, JSON.stringify(config), 'utf8')
  return Effect.runPromise(Config.make({ mode: 'standalone', configPath, env: {} }))
}

describe('embedding spec from Config', () => {
  it('derives provider, model and dimensions from the landed ConfigValues', async () => {
    const dir = await makeTempDir()
    const config = await makeConfig(dir, {
      embedding: { provider: 'google', model: 'gemini-embedding-001', dimensions: 768 },
      providerCredentials: { google: { apiKey: 'goog-key', baseUrl: '' } },
    })

    const values = await Effect.runPromise(config.values)
    const derived = embeddingSpecFrom(values)

    expect(derived.provider).toBe('google')
    expect(derived.model).toBe('gemini-embedding-001')
    expect(derived.outputDimensionality).toBe(768)
    expect(derived.apiKey).toBe('goog-key')
    expect(derived.enabled).toBe(true)

    const request = singleEmbeddingRequest(derived, 'hello')
    expect(request.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent',
    )
    expect(request.headers['x-goog-api-key']).toBe('goog-key')
    expect(recordOf(request.body)['output_dimensionality']).toBe(768)
  })

  it('takes the endpoint from provider credentials and disables a provider without one', async () => {
    const dir = await makeTempDir()
    const configured = await makeConfig(dir, {
      ...CONFIG_BASE,
      providerCredentials: {
        openai: { apiKey: 'sk-x', baseUrl: 'https://gateway.example/v1/embeddings' },
      },
    })
    const derived = embeddingSpecFrom(await Effect.runPromise(configured.values))
    expect(derived.endpoint).toBe('https://gateway.example/v1/embeddings')

    const orphan = await makeConfig(dir, {
      embedding: { provider: 'mystery', model: 'unknown-model', dimensions: 3 },
    })
    const orphanSpec = embeddingSpecFrom(await Effect.runPromise(orphan.values))
    expect(orphanSpec.endpoint).toBe('')
    expect(orphanSpec.enabled).toBe(false)
  })
})

const PROSE_UNIT = fc.constantFrom('a', 'b', ' ', '\n', '#', '中', '。', 'x', '\t')

describe('markdown chunker', () => {
  it('never exceeds the hard provider bound for arbitrary markdown', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 400 }),
        fc.integer({ min: 8, max: 400 }),
        (text, target) => {
          const bound = Math.max(target, MAX_CHUNK_CHARS)
          for (const chunk of chunkMarkdown(text, target, Math.floor(target / 2))) {
            expect(charCount(chunk.text)).toBeLessThanOrEqual(bound)
            expect(chunk.text.trim()).not.toBe('')
          }
        },
      ),
      { numRuns: 200 },
    )
  })

  it('never exceeds the target for prose without fences or tables', () => {
    fc.assert(
      fc.property(
        fc.string({ unit: PROSE_UNIT, maxLength: 400 }),
        fc.integer({ min: 8, max: 200 }),
        (text, target) => {
          for (const chunk of chunkMarkdown(text, target, Math.floor(target / 2))) {
            expect(charCount(chunk.text)).toBeLessThanOrEqual(target)
          }
        },
      ),
      { numRuns: 200 },
    )
  })

  it('is deterministic for identical input', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 300 }), fc.integer({ min: 8, max: 200 }), (text, target) => {
        expect(chunkMarkdown(text, target, 8)).toEqual(chunkMarkdown(text, target, 8))
      }),
      { numRuns: 100 },
    )
  })

  it('strips crlf frontmatter and preserves the heading breadcrumb', () => {
    const input = '---\r\ntitle: 测试页面\r\n---\r\n# 第一章\r\n\r\n内容一。\r\n## 第二节\r\n内容二。'
    const chunks = chunkMarkdown(input, 64, 8)

    expect(extractTitle(input, 'fallback')).toBe('测试页面')
    expect(chunks.every((chunk) => !chunk.text.includes('title:'))).toBe(true)
    expect(chunks.some((chunk) => chunk.headingPath.includes('# 第一章'))).toBe(true)
    expect(chunks.some((chunk) => chunk.headingPath.includes('## 第二节'))).toBe(true)
  })

  it('uses character boundaries and keeps the overlap for cjk text', () => {
    const text = '中文内容用于验证字符边界不会发生截断异常。'.repeat(20)
    const chunks = chunkMarkdown(text, 64, 8)

    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.every((chunk) => charCount(chunk.text) <= 64)).toBe(true)
    for (let index = 1; index < chunks.length; index += 1) {
      const previous = chunks[index - 1]
      const current = chunks[index]
      if (previous === undefined || current === undefined) throw new Error('missing chunk')
      const suffix = Array.from(previous.text).slice(-8).join('')
      expect(current.text.startsWith(suffix)).toBe(true)
    }
  })

  it('keeps fenced code and tables atomic', () => {
    const code = ['```rust', ...Array.from({ length: 12 }, () => 'let value = 1;'), '```'].join('\n')
    const table = ['| Name | Value |', '| --- | --- |', ...Array.from({ length: 12 }, () => '| A | B |')].join(
      '\n',
    )
    const chunks = chunkMarkdown(`# Page\n\nBefore text.\n\n${code}\n\n${table}\n\nAfter text.`, 64, 8)

    expect(chunks.some((chunk) => chunk.text.trim() === code.trim())).toBe(true)
    expect(chunks.some((chunk) => chunk.text.trim() === table.trim())).toBe(true)
    expect(chunks.filter((chunk) => chunk.text.includes('```rust'))).toHaveLength(1)
    expect(chunks.filter((chunk) => chunk.text.includes('| Name | Value |'))).toHaveLength(1)
  })

  it('caps an oversized atomic block at the hard provider limit', () => {
    const input = `\`\`\`text\n${'x'.repeat(MAX_CHUNK_CHARS + 500)}\n`
    const chunks = chunkMarkdown(input, 1_000, 200)

    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.every((chunk) => charCount(chunk.text) <= MAX_CHUNK_CHARS)).toBe(true)
  })

  it('requires a standalone fence to close the frontmatter', () => {
    const input = '---\ntitle: Kept\nnote: ---not-a-fence\n---\n# Body'
    expect(extractTitle(input, 'fallback')).toBe('Kept')
    expect(chunkMarkdown(input, 64, 8).every((chunk) => !chunk.text.includes('Kept'))).toBe(true)
  })

  it('enriches a chunk with the title and the heading path', () => {
    expect(
      enrichChunk('Title', { text: ' body ', headingPath: ' ## Section ' }),
    ).toBe('Title\n\n## Section\n\nbody')
  })

  it('clamps chunk and overlap parameters the way the port does', () => {
    expect(clampChunkChars(0)).toBe(64)
    expect(clampChunkChars(1_000)).toBe(1_000)
    expect(clampChunkChars(99_999)).toBe(32_000)
    expect(clampOverlapChars(200, 1_000)).toBe(200)
    expect(clampOverlapChars(900, 1_000)).toBe(500)
  })
})

describe('embedding fingerprint', () => {
  it('is stable across api key rotation and changes with embedding semantics', () => {
    const base = spec()
    expect(embeddingFingerprint('sha256:content', base)).toBe(
      embeddingFingerprint('sha256:content', spec({ apiKey: 'rotated' })),
    )
    expect(embeddingFingerprint('sha256:content', base)).not.toBe(
      embeddingFingerprint('sha256:content', spec({ model: 'text-embedding-3-large' })),
    )
    expect(embeddingFingerprint('sha256:content', base)).not.toBe(
      embeddingFingerprint('sha256:content', spec({ endpoint: 'https://other.example/v1/embeddings' })),
    )
    expect(embeddingFingerprint('sha256:content', base)).not.toBe(
      embeddingFingerprint('sha256:other', base),
    )
    expect(embeddingFingerprint('sha256:content', base)).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it('is a pure function of its inputs', () => {
    fc.assert(
      fc.property(
        fc.string(),
        fc.string(),
        fc.option(fc.integer({ min: 1, max: 4_096 }), { nil: undefined }),
        (revision, model, dimensions) => {
          const value = spec({ model, outputDimensionality: dimensions })
          expect(embeddingFingerprint(revision, value)).toBe(embeddingFingerprint(revision, value))
          expect(contentRevision(revision)).toBe(contentRevision(revision))
        },
      ),
      { numRuns: 100 },
    )
  })
})

describe('embedding revision records', () => {
  it('round-trips per page and invalidates one page without touching another', async () => {
    const root = await makeTempDir()

    expect(await Effect.runPromise(loadRevision(root, 'current'))).toEqual(Option.none())
    expect(await Effect.runPromise(saveRevision(root, 'current', 'sha256:one'))).toBe(true)
    expect(await Effect.runPromise(saveRevision(root, 'other', 'sha256:two'))).toBe(true)

    expect(await Effect.runPromise(loadRevision(root, 'current'))).toEqual(Option.some('sha256:one'))
    await Effect.runPromise(invalidateRevision(root, 'current'))
    expect(await Effect.runPromise(loadRevision(root, 'current'))).toEqual(Option.none())
    expect(await Effect.runPromise(loadRevision(root, 'other'))).toEqual(Option.some('sha256:two'))

    await Effect.runPromise(invalidateRevision(root, 'missing'))
  })
})

interface StoreProbe {
  readonly store: VectorStore
  readonly calls: Array<string>
}

const storeProbe = (options: {
  create?: boolean
  pageChunks?: number
  checkoutFailure?: boolean
  createFailure?: boolean
} = {}): StoreProbe => {
  const calls: Array<string> = []
  const table: VectorTable = {
    checkoutLatest: Effect.suspend(() => {
      calls.push('checkoutLatest')
      return options.checkoutFailure === true
        ? Effect.fail(new Errors.EmbedError({ kind: 'Storage', message: 'Checkout latest error' }))
        : Effect.void
    }),
    countPage: () =>
      Effect.sync(() => {
        calls.push('countPage')
        return options.pageChunks ?? 3
      }),
    deletePage: () =>
      Effect.suspend(() => {
        calls.push('deletePage')
        return Effect.void
      }),
    addChunks: () =>
      Effect.suspend(() => {
        calls.push('addChunks')
        return Effect.void
      }),
  }
  const store: VectorStore = {
    openTable: () =>
      Effect.sync(() => {
        calls.push('openTable')
        return options.create === true ? Option.none<VectorTable>() : Option.some(table)
      }),
    createTable: () =>
      options.createFailure === true
        ? Effect.fail(new Errors.EmbedError({ kind: 'Storage', message: 'Create table error' }))
        : Effect.sync(() => {
          calls.push('createTable')
          return table
        }),
  }
  return { store, calls }
}

const responseFor = (request: EmbeddingHttpRequest): EmbeddingHttpResponse => {
  const input = recordOf(request.body)['input']
  const inputs = Array.isArray(input) ? input : [input]
  return {
    status: 200,
    body: JSON.stringify({
      data: inputs.map((_, index) => ({ index, embedding: [1, 2, 3] })),
    }),
  }
}

interface HarnessOptions {
  readonly config?: unknown
  readonly respond?: (request: EmbeddingHttpRequest, index: number) => EmbeddingHttpResponse
  readonly store?: StoreProbe
  readonly timeouts?: EmbeddingTimeouts
  readonly content?: string
  readonly create?: boolean
  readonly hang?: boolean
}

const harness = async (options: HarnessOptions = {}) => {
  const root = await makeProject()
  const config = await makeConfig(root, options.config ?? CONFIG_BASE)
  const requests: Array<EmbeddingHttpRequest> = []
  const transport: EmbeddingTransport = {
    post: (request) => {
      const index = requests.length
      requests.push(request)
      if (options.hang === true) return Effect.never
      return Effect.succeed((options.respond ?? responseFor)(request, index))
    },
  }
  const probe = options.store ?? storeProbe(options.create === undefined ? {} : { create: options.create })
  const registry: ProjectRegistryShape = {
    list: Effect.succeed([]),
    setCurrent: () => Effect.fail(new Errors.NotFound({ message: 'unused' })),
    resolveRoot: () => Effect.succeed(root),
  }
  const service: EmbeddingsShape = Embeddings.make({
    config,
    registry,
    transport,
    store: probe.store,
    ...(options.timeouts === undefined ? {} : { timeouts: options.timeouts }),
  })
  await writeFile(
    join(root, 'wiki', 'nested', 'page.md'),
    options.content ?? '# Page\n\nA short body of text.',
    'utf8',
  )
  return {
    root,
    config,
    requests,
    calls: probe.calls,
    service,
    embed: (path = 'wiki/nested/page.md', force = false) => service.embedPage(root, path, force),
    run: (path = 'wiki/nested/page.md', force = false) => Effect.runPromise(service.embedPage(root, path, force)),
  }
}

const embedFailure = async (effect: Effect.Effect<unknown, unknown>): Promise<Errors.EmbedError> => {
  const error = await Effect.runPromise(Effect.flip(effect))
  if (!(error instanceof Errors.EmbedError)) {
    throw new Error(`expected an EmbedError, received ${String(error)}`)
  }
  return error
}

const mutationsOf = (calls: ReadonlyArray<string>): ReadonlyArray<string> =>
  calls.filter((call) => call !== 'openTable' && call !== 'countPage')

describe('page embedding pipeline', () => {
  it('indexes a page, writes chunks after checkoutLatest, and records the revision', async () => {
    const { run, requests, calls, root, config } = await harness()

    const result = await run()

    expect(result.status).toBe('indexed')
    expect(result.pageId).toBe('page')
    expect(result.path).toBe('wiki/nested/page.md')
    expect(result.vectorsWritten).toBe(result.chunks)
    expect(result.revision).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(mutationsOf(calls)).toEqual(['checkoutLatest', 'deletePage', 'addChunks'])
    const values = await Effect.runPromise(config.values)
    expect(await Effect.runPromise(loadRevision(root, 'page'))).toEqual(
      Option.some(embeddingFingerprint(result.revision, embeddingSpecFrom(values))),
    )

    const sent = first(requests)
    expect(sent.url).toBe('https://api.openai.com/v1/embeddings')
    expect(recordOf(sent.body)['model']).toBe('text-embedding-3-small')
  })

  it('returns unchanged without any provider call or mutation for an unchanged page', async () => {
    const { run, requests, calls } = await harness()

    const firstRun = await run()
    const mutationsAfterFirst = mutationsOf(calls)
    const requestsAfterFirst = requests.length

    const second = await run()

    expect(second.status).toBe('unchanged')
    expect(second.vectorsWritten).toBe(0)
    expect(second.revision).toBe(firstRun.revision)
    expect(requests).toHaveLength(requestsAfterFirst)
    expect(mutationsOf(calls)).toEqual(mutationsAfterFirst)
  })

  it('rebuilds an unchanged page when force is set', async () => {
    const { run, requests } = await harness()

    await run()
    const afterFirst = requests.length
    const forced = await run('wiki/nested/page.md', true)

    expect(forced.status).toBe('indexed')
    expect(requests.length).toBeGreaterThan(afterFirst)
  })

  it('re-indexes when the page content changes', async () => {
    const project = await makeProject()
    const config = await makeConfig(project, CONFIG_BASE)
    const requests: Array<EmbeddingHttpRequest> = []
    const probe = storeProbe()
    const registry: ProjectRegistryShape = {
      list: Effect.succeed([]),
      setCurrent: () => Effect.fail(new Errors.NotFound({ message: 'unused' })),
      resolveRoot: () => Effect.succeed(project),
    }
    const service = Embeddings.make({
      config,
      registry,
      transport: {
        post: (request) => {
          requests.push(request)
          return Effect.succeed(responseFor(request))
        },
      },
      store: probe.store,
    })
    const path = join(project, 'wiki', 'nested', 'page.md')
    await writeFile(path, '# Page\n\nFirst body.', 'utf8')
    const firstRun = await Effect.runPromise(service.embedPage(project, 'wiki/nested/page.md'))

    await writeFile(path, '# Page\n\nSecond body, longer.', 'utf8')
    const second = await Effect.runPromise(service.embedPage(project, 'wiki/nested/page.md'))

    expect(second.revision).not.toBe(firstRun.revision)
    expect(second.status).toBe('indexed')
  })

  it('creates the table on the first index of a project', async () => {
    const probe = storeProbe({ create: true })
    const { run } = await harness({ store: probe })

    await run()

    expect(probe.calls).toContain('createTable')
    expect(probe.calls).not.toContain('checkoutLatest')
  })

  it('batches chunks into requests of at most 64 in order', async () => {
    const sections = Array.from(
      { length: 100 },
      (_, index) => `## Section ${index}\n${'x'.repeat(40)}`,
    ).join('\n\n')
    const { run, requests } = await harness({ content: `# Page\n\n${sections}` })

    const result = await run()

    expect(result.chunks).toBeGreaterThan(64)
    expect(result.chunks).toBeLessThanOrEqual(MAX_PAGE_CHUNKS)
    expect(requests).toHaveLength(2)
    const sizes = requests.map((request) => {
      const input = recordOf(request.body)['input']
      return Array.isArray(input) ? input.length : 0
    })
    expect(sizes).toEqual([64, result.chunks - 64])
  })

  it('retries a single-chunk request at half size after an oversize rejection', async () => {
    const { run, requests } = await harness({
      config: GOOGLE_CONFIG,
      content: `# Page\n\n${'x'.repeat(400)}`,
      respond: (request, index) =>
        index === 0 ? { status: 413, body: 'input too long' } : { status: 200, body: GOOGLE_VECTOR },
    })

    const result = await run()

    expect(result.status).toBe('indexed')
    expect(requests).toHaveLength(2)
    const [firstRequest, secondRequest] = requests
    if (firstRequest === undefined || secondRequest === undefined) {
      throw new Error('expected two requests')
    }
    expect(googleText(firstRequest).length).toBeGreaterThan(googleText(secondRequest).length)
  })

  it('fails with Provider when the provider rejects the input at the floor', async () => {
    const { embed } = await harness({
      config: GOOGLE_CONFIG,
      content: `# Page\n\n${'x'.repeat(400)}`,
      respond: () => ({ status: 413, body: 'input too long' }),
    })

    const error = await embedFailure(embed())

    expect(error.kind).toBe('Provider')
    expect(error.message).toContain('Endpoint rejected input even at')
  })

  it('maps every rust failure site onto an EmbedError kind', async () => {
    const disabled = await harness({
      config: { embedding: { provider: 'mystery', model: 'm', dimensions: 3 } },
    })
    expect((await embedFailure(disabled.embed())).kind).toBe('InvalidRequest')

    const missing = await harness()
    const missingError = await embedFailure(missing.embed('wiki/absent.md'))
    expect(missingError.kind).toBe('NotFound')

    const outside = await harness()
    const outsideError = await embedFailure(outside.embed('outside.md'))
    expect(outsideError.kind).toBe('InvalidRequest')

    const traversal = await harness()
    const traversalError = await embedFailure(traversal.embed('../secret.md'))
    expect(traversalError.kind).toBe('InvalidRequest')

    const aggregate = await harness()
    await writeFile(join(aggregate.root, 'wiki', 'index.md'), '# Index', 'utf8')
    const aggregateError = await embedFailure(aggregate.embed('wiki/index.md'))
    expect(aggregateError.kind).toBe('InvalidRequest')

    const provider = await harness({ respond: () => ({ status: 500, body: 'boom' }) })
    expect((await embedFailure(provider.embed())).kind).toBe('Provider')

    const ragged = await harness({
      content: '# Page\n\nfirst paragraph here.\n\n## Second\n\nsecond paragraph here.',
      respond: () => ({
        status: 200,
        body: JSON.stringify({ data: [{ index: 0, embedding: [1, 2, 3] }] }),
      }),
    })
    expect((await embedFailure(ragged.embed())).kind).toBe('Provider')

    const storage = await harness({ store: storeProbe({ create: true, createFailure: true }) })
    expect((await embedFailure(storage.embed())).kind).toBe('Storage')

    const timeout = await harness({
      timeouts: { request: Duration.seconds(30), providerPhase: Duration.millis(1) },
      hang: true,
    })
    expect((await embedFailure(timeout.embed())).kind).toBe('Timeout')
  })

  it('refuses to mutate storage when checkoutLatest fails', async () => {
    const probe = storeProbe({ checkoutFailure: true })
    const { embed, calls } = await harness({ store: probe })

    const error = await embedFailure(embed())

    expect(error.kind).toBe('Storage')
    expect(probe.calls).toContain('checkoutLatest')
    expect(probe.calls).not.toContain('deletePage')
    expect(probe.calls).not.toContain('addChunks')
    expect(calls).toContain('checkoutLatest')
  })

  it('rejects a second wiki page that shares a filename stem', async () => {
    const { root, embed } = await harness()
    await mkdir(join(root, 'wiki', 'other'), { recursive: true })
    await writeFile(join(root, 'wiki', 'other', 'page.md'), '# Second', 'utf8')

    const error = await embedFailure(embed())

    expect(error.kind).toBe('Conflict')
  })

  it('rejects an aggregate or invalid page name before provider work', async () => {
    const { root, embed, requests } = await harness()
    await writeFile(join(root, 'wiki', 'overview.md'), '# Overview', 'utf8')

    const error = await embedFailure(embed('wiki/overview.md'))

    expect(error.kind).toBe('InvalidRequest')
    expect(requests).toHaveLength(0)
  })

  it('rejects a page above the 2 MiB indexing limit', async () => {
    const { root, embed, requests } = await harness()
    await writeFile(join(root, 'wiki', 'big.md'), 'x'.repeat(2 * 1024 * 1024 + 1), 'utf8')

    const error = await embedFailure(embed('wiki/big.md'))

    expect(error.kind).toBe('InvalidRequest')
    expect(error.message).toContain('2 MiB')
    expect(requests).toHaveLength(0)
  })

  it('accepts a windows-style path inside wiki', async () => {
    const { run } = await harness()

    const result = await run('wiki\\nested\\page.md')

    expect(result.path).toBe('wiki/nested/page.md')
  })

  it('picks up an embedding model change after reloadConfig, not after the ttl', async () => {
    const { root } = await harness()
    const fresh = await Effect.runPromise(
      Config.make({
        mode: 'standalone',
        configPath: join(root, 'config.json'),
        env: {},
        now: () => 1_000,
      }),
    )
    const requests: Array<EmbeddingHttpRequest> = []
    const probe = storeProbe()
    const registry: ProjectRegistryShape = {
      list: Effect.succeed([]),
      setCurrent: () => Effect.fail(new Errors.NotFound({ message: 'unused' })),
      resolveRoot: () => Effect.succeed(root),
    }
    const tuned = Embeddings.make({
      config: fresh,
      registry,
      transport: {
        post: (request) => {
          requests.push(request)
          return Effect.succeed(responseFor(request))
        },
      },
      store: probe.store,
    })

    await Effect.runPromise(tuned.embedPage(root, 'wiki/nested/page.md', true))
    expect(recordOf(first(requests).body)['model']).toBe('text-embedding-3-small')

    await writeFile(
      join(root, 'config.json'),
      JSON.stringify({
        ...CONFIG_BASE,
        embedding: { provider: 'openai', model: 'text-embedding-3-large', dimensions: 3 },
      }),
      'utf8',
    )
    await Effect.runPromise(fresh.reload)
    await Effect.runPromise(tuned.embedPage(root, 'wiki/nested/page.md', true))

    expect(recordOf(requests[1]?.body ?? '{}')['model']).toBe('text-embedding-3-large')
  })
})

describe('embedding batch chunking', () => {
  it('preserves order and the batch bound', () => {
    fc.assert(
      fc.property(fc.array(fc.string(), { maxLength: 200 }), (texts) => {
        const batches = chunkBatches(texts, 64)
        expect(batches.flat()).toEqual(texts)
        expect(batches.every((batch) => batch.length >= 1 && batch.length <= 64)).toBe(true)
        expect(batches).toHaveLength(Math.ceil(texts.length / 64))
      }),
      { numRuns: 200 },
    )
  })
})
