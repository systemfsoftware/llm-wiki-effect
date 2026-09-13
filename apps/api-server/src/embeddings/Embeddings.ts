import { Context, Duration, Effect, Layer, Option, Result } from 'effect'
import { Domain, Errors } from 'llm-wiki-protocol'
import type { Dirent } from 'node:fs'
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, sep } from 'node:path'
import type { ConfigShape } from '../config/Config.js'
import { Config } from '../config/Config.js'
import { hasErrorCode } from '../json.js'
import { ProjectRegistry } from '../projects/Registry.js'
import type { ProjectRegistryShape } from '../projects/Registry.js'
import { chunkMarkdown, enrichChunk, extractTitle } from './chunker.js'
import { contentRevision, embeddingFingerprint } from './fingerprint.js'
import {
  batchEmbeddingRequest,
  halveText,
  isDoubaoMultimodal,
  looksLikeOversizeError,
  parseEmbeddingBatchValues,
  parseEmbeddingValues,
  singleEmbeddingRequest,
  supportsBatch,
} from './request.js'
import type { EmbeddingHttpRequest, EmbeddingHttpResponse } from './request.js'
import { invalidateRevision, loadRevision, saveRevision } from './revision.js'
import {
  AGGREGATE_PAGE_STEMS,
  clampChunkChars,
  clampOverlapChars,
  DEFAULT_EMBEDDING_TIMEOUTS,
  EMBEDDING_BATCH_SIZE,
  embeddingDisabled,
  embeddingSpecFrom,
  isGoogleEndpoint,
  LANCEDB_DIR,
  MAX_PAGE_BYTES,
  MAX_PAGE_CHUNKS,
  MAX_PAGE_ID_CHARS,
} from './spec.js'
import type { EmbeddingSpec, EmbeddingTimeouts } from './spec.js'
import type { ChunkRow, VectorStore } from './vector-store.js'

export interface EmbeddingTransport {
  readonly post: (
    request: EmbeddingHttpRequest,
  ) => Effect.Effect<EmbeddingHttpResponse, Errors.EmbedError>
}

export interface EmbeddingsShape {
  readonly embedPage: (
    projectId: string,
    path: string,
    force?: boolean,
  ) => Effect.Effect<
    Domain.PageEmbeddingResult,
    Errors.EmbedError | Errors.NotFound | Errors.InvalidRequest
  >
}

export interface EmbeddingsDependencies {
  readonly config: ConfigShape
  readonly registry: ProjectRegistryShape
  readonly transport: EmbeddingTransport
  readonly store: VectorStore
  readonly timeouts?: EmbeddingTimeouts
}

interface EmbeddingRuntime {
  readonly config: ConfigShape
  readonly transport: EmbeddingTransport
  readonly store: VectorStore
  readonly timeouts: EmbeddingTimeouts
}

interface FetchFailure {
  readonly oversize: boolean
  readonly message: string
}

const embedError = (kind: Errors.EmbedErrorKind, message: string): Errors.EmbedError =>
  new Errors.EmbedError({ kind, message })

const describeError = (error: unknown): string => error instanceof Error ? error.message : String(error)

const preview = (body: string): string => Array.from(body).slice(0, 200).join('')

const parseJson = (body: string): Result.Result<unknown, string> => {
  try {
    return Result.succeed(JSON.parse(body) as unknown)
  } catch (error) {
    return Result.fail(describeError(error))
  }
}

const isControlCode = (code: number): boolean => (code >= 0x00 && code <= 0x1f) || (code >= 0x7f && code <= 0x9f)

const DISALLOWED_CHARS: Readonly<Record<string, true>> = {
  '/': true,
  '\\': true,
  "'": true,
  '"': true,
  '\u00AD': true,
  '\u061C': true,
  '\uFEFF': true,
}
const DISALLOWED_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2060, 0x206f],
  [0xfff9, 0xfffb],
  [0xe0000, 0xe007f],
]

export const validatePageId = (pageId: string): string | undefined => {
  const chars = Array.from(pageId)
  if (chars.length === 0 || chars.length > MAX_PAGE_ID_CHARS) {
    return 'Invalid page_id: empty or too long'
  }
  for (const char of chars) {
    const code = char.codePointAt(0) ?? 0
    const disallowed = isControlCode(code) ||
      DISALLOWED_CHARS[char] === true ||
      DISALLOWED_RANGES.some(([from, to]) => code >= from && code <= to)
    if (disallowed) {
      return `Invalid page_id: contains disallowed character \\u{${code.toString(16)}}: ${pageId}`
    }
  }
  return undefined
}

const extensionOf = (name: string): string | undefined => {
  const index = name.lastIndexOf('.')
  return index <= 0 ? undefined : name.slice(index + 1)
}

const stemOf = (name: string): string => {
  const extension = extensionOf(name)
  return extension === undefined ? name : name.slice(0, name.length - extension.length - 1)
}

const pathComponents = (raw: string): ReadonlyArray<string> => {
  const out: Array<string> = []
  for (const part of raw.split('/')) {
    if (part === '') continue
    if (part === '.') {
      if (out.length === 0) out.push('.')
      continue
    }
    out.push(part)
  }
  return out
}

const resolveWikiMarkdownPath = (
  projectRoot: string,
  relativePath: string,
): Effect.Effect<{ readonly pagePath: string; readonly normalizedPath: string }, Errors.EmbedError> =>
  Effect.gen(function*() {
    const raw = relativePath.trim().replace(/\\/g, '/')
    if (raw === '') return yield* Effect.fail(embedError('InvalidRequest', 'path is required'))
    const components = pathComponents(raw)
    const first = components[0]
    const name = components[components.length - 1] ?? ''
    if (
      isAbsolute(raw) ||
      components.some((component) => component === '..') ||
      first !== 'wiki' ||
      (extensionOf(name) ?? '').toLowerCase() !== 'md'
    ) {
      return yield* Effect.fail(
        embedError('InvalidRequest', 'path must be a project-relative Markdown file under wiki/'),
      )
    }
    const project = yield* Effect.tryPromise({
      try: () => realpath(projectRoot),
      catch: (error) => embedError('NotFound', `Failed to resolve project path: ${describeError(error)}`),
    })
    const wiki = yield* Effect.tryPromise({
      try: () => realpath(join(projectRoot, 'wiki')),
      catch: (error) => embedError('NotFound', `Failed to resolve project wiki directory: ${describeError(error)}`),
    })
    const page = yield* Effect.tryPromise({
      try: () => realpath(join(projectRoot, raw)),
      catch: (error) => embedError('NotFound', `Wiki page not found: ${describeError(error)}`),
    })
    const isFile = yield* Effect.promise(async () => {
      try {
        return (await stat(page)).isFile()
      } catch {
        return false
      }
    })
    const insideWiki = page === wiki || page.startsWith(`${wiki}${sep}`)
    if (!insideWiki || !isFile || (extensionOf(basename(page)) ?? '').toLowerCase() !== 'md') {
      return yield* Effect.fail(
        embedError('InvalidRequest', 'path must resolve to a file inside the project wiki directory'),
      )
    }
    return { pagePath: page, normalizedPath: relative(project, page).replace(/\\/g, '/') }
  })

const walkFiles = async (dir: string): Promise<Array<string>> => {
  let entries: Array<Dirent>
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out: Array<string> = []
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await walkFiles(full)))
    else if (entry.isFile()) out.push(full)
  }
  return out
}

const stemCollision = async (
  files: ReadonlyArray<string>,
  pagePath: string,
  pageId: string,
): Promise<string | undefined> => {
  for (const file of files) {
    const name = basename(file)
    if ((extensionOf(name) ?? '').toLowerCase() !== 'md') continue
    if (stemOf(name).toLowerCase() !== pageId.toLowerCase()) continue
    try {
      const resolved = await realpath(file)
      if (resolved !== pagePath) return resolved
    } catch {
      continue
    }
  }
  return undefined
}

const ensureUniquePageStem = (
  projectRoot: string,
  pagePath: string,
  pageId: string,
): Effect.Effect<void, Errors.EmbedError> =>
  Effect.gen(function*() {
    const wikiRoot = yield* Effect.tryPromise({
      try: () => realpath(join(projectRoot, 'wiki')),
      catch: (error) => embedError('NotFound', `Failed to resolve project wiki directory: ${describeError(error)}`),
    })
    const files = yield* Effect.promise(() => walkFiles(wikiRoot))
    const collision = yield* Effect.promise(() => stemCollision(files, pagePath, pageId))
    if (collision !== undefined) {
      return yield* Effect.fail(
        embedError(
          'Conflict',
          `Cannot index this page because another wiki page has the same filename stem: ${collision}`,
        ),
      )
    }
    return yield* Effect.void
  })

const fetchOnce = (
  runtime: EmbeddingRuntime,
  spec: EmbeddingSpec,
  text: string,
): Effect.Effect<ReadonlyArray<number>, FetchFailure> =>
  Effect.gen(function*() {
    const posted = yield* Effect.result(
      Effect.timeoutOption(
        runtime.transport.post(singleEmbeddingRequest(spec, text)),
        runtime.timeouts.request,
      ),
    )
    if (Result.isFailure(posted)) {
      return yield* Effect.fail({ oversize: false, message: posted.failure.message })
    }
    const timed = posted.success
    if (Option.isNone(timed)) {
      return yield* Effect.fail({
        oversize: false,
        message: `Embedding request timed out after ${Duration.toSeconds(runtime.timeouts.request)} seconds`,
      })
    }
    const response = timed.value
    if (response.status < 200 || response.status >= 300) {
      return yield* Effect.fail({
        oversize: looksLikeOversizeError(response.status, response.body),
        message: `Embedding API HTTP ${response.status}: ${preview(response.body)}`,
      })
    }
    const parsed = parseJson(response.body)
    if (Result.isFailure(parsed)) {
      return yield* Effect.fail({
        oversize: false,
        message: `Embedding response parse failed: ${parsed.failure}: ${preview(response.body)}`,
      })
    }
    const values = parseEmbeddingValues(
      parsed.success,
      isGoogleEndpoint(spec.endpoint),
      isDoubaoMultimodal(spec),
    )
    if (Result.isFailure(values)) {
      return yield* Effect.fail({ oversize: false, message: values.failure })
    }
    return values.success
  })

const fetchWithRetry = (
  runtime: EmbeddingRuntime,
  spec: EmbeddingSpec,
  text: string,
  maxRetries: number,
): Effect.Effect<ReadonlyArray<number>, Errors.EmbedError> =>
  Effect.gen(function*() {
    let current = text
    let attempts = 0
    for (;;) {
      attempts += 1
      const outcome = yield* Effect.result(fetchOnce(runtime, spec, current))
      if (Result.isSuccess(outcome)) return outcome.success
      const failure = outcome.failure
      if (!failure.oversize) {
        return yield* Effect.fail(embedError('Provider', failure.message))
      }
      const halved = Array.from(current).length > 64 ? halveText(current) : undefined
      if (attempts <= maxRetries && halved !== undefined) {
        current = halved
        continue
      }
      return yield* Effect.fail(
        embedError(
          'Provider',
          `Endpoint rejected input even at ${current.length} chars. Lower Settings -> Embedding -> Max Chunk Chars. ${failure.message}`,
        ),
      )
    }
  })

const fetchBatch = (
  runtime: EmbeddingRuntime,
  spec: EmbeddingSpec,
  texts: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<ReadonlyArray<number>>, Errors.EmbedError> =>
  Effect.gen(function*() {
    if (texts.length === 0 || texts.length > EMBEDDING_BATCH_SIZE) {
      return yield* Effect.fail(
        embedError('Provider', 'Embedding batch must contain between 1 and 64 inputs'),
      )
    }
    if (!supportsBatch(spec)) {
      return yield* Effect.fail(
        embedError('Provider', 'This embedding provider does not use the OpenAI-compatible batch format'),
      )
    }
    const timed = yield* Effect.timeoutOption(
      runtime.transport.post(batchEmbeddingRequest(spec, texts)),
      runtime.timeouts.request,
    )
    if (Option.isNone(timed)) {
      return yield* Effect.fail(
        embedError(
          'Provider',
          `Embedding batch request timed out after ${Duration.toSeconds(runtime.timeouts.request)} seconds`,
        ),
      )
    }
    const response = timed.value
    if (response.status < 200 || response.status >= 300) {
      return yield* Effect.fail(
        embedError(
          'Provider',
          `Embedding batch API HTTP ${response.status}: ${preview(response.body)}`,
        ),
      )
    }
    const parsed = parseJson(response.body)
    if (Result.isFailure(parsed)) {
      return yield* Effect.fail(
        embedError(
          'Provider',
          `Embedding batch response parse failed: ${parsed.failure}: ${preview(response.body)}`,
        ),
      )
    }
    const values = parseEmbeddingBatchValues(parsed.success, texts.length)
    if (Result.isFailure(values)) {
      return yield* Effect.fail(embedError('Provider', values.failure))
    }
    return values.success
  })

export const chunkBatches = <A>(
  items: ReadonlyArray<A>,
  size: number,
): ReadonlyArray<ReadonlyArray<A>> => {
  const out: Array<ReadonlyArray<A>> = []
  for (let start = 0; start < items.length; start += size) {
    out.push(items.slice(start, start + size))
  }
  return out
}

const chunkRow = (
  pageId: string,
  index: number,
  chunk: { readonly text: string; readonly headingPath: string },
  vector: ReadonlyArray<number>,
): ChunkRow => ({
  chunkId: `${pageId}#${index}`,
  pageId,
  chunkIndex: index,
  chunkText: chunk.text,
  headingPath: chunk.headingPath,
  vector,
})

const prepareEmbeddingRows = (
  runtime: EmbeddingRuntime,
  spec: EmbeddingSpec,
  pageId: string,
  title: string,
  chunks: ReadonlyArray<{ readonly text: string; readonly headingPath: string }>,
): Effect.Effect<ReadonlyArray<ChunkRow>, Errors.EmbedError> =>
  Effect.gen(function*() {
    const rows: Array<ChunkRow> = []
    if (supportsBatch(spec)) {
      for (const batch of chunkBatches(chunks, EMBEDDING_BATCH_SIZE)) {
        const embeddings = yield* fetchBatch(
          runtime,
          spec,
          batch.map((chunk) => enrichChunk(title, chunk)),
        )
        if (embeddings.length !== batch.length) {
          return yield* Effect.fail(
            embedError('Provider', 'Embedding provider returned an incomplete batch'),
          )
        }
        for (const [index, chunk] of batch.entries()) {
          const embedding = embeddings[index]
          if (embedding === undefined) {
            return yield* Effect.fail(
              embedError('Provider', 'Embedding provider returned an incomplete batch'),
            )
          }
          rows.push(chunkRow(pageId, rows.length, chunk, embedding))
        }
      }
      return rows
    }
    for (const [index, chunk] of chunks.entries()) {
      const embedding = yield* fetchWithRetry(runtime, spec, enrichChunk(title, chunk), 3)
      rows.push(chunkRow(pageId, index, chunk, embedding))
    }
    return rows
  })

const validateEmbeddingRows = (rows: ReadonlyArray<ChunkRow>): Errors.EmbedError | undefined => {
  const first = rows[0]
  if (first === undefined) return embedError('Provider', 'Embedding provider returned no vectors')
  const expected = first.vector.length
  if (expected === 0 || rows.some((row) => row.vector.length !== expected)) {
    return embedError(
      'Provider',
      'Embedding provider returned empty or inconsistent vector dimensions',
    )
  }
  return undefined
}

const revisionMatch = (
  runtime: EmbeddingRuntime,
  projectRoot: string,
  pageId: string,
  fingerprint: string,
): Effect.Effect<Option.Option<number>, Errors.EmbedError> =>
  Effect.gen(function*() {
    const stored = yield* loadRevision(projectRoot, pageId)
    if (Option.isNone(stored) || stored.value !== fingerprint) return Option.none<number>()
    const table = yield* runtime.store.openTable(join(projectRoot, LANCEDB_DIR))
    if (Option.isNone(table)) return Option.none<number>()
    const count = yield* table.value.countPage(pageId)
    return count > 0 ? Option.some(count) : Option.none<number>()
  })

const upsertChunks = (
  runtime: EmbeddingRuntime,
  projectRoot: string,
  pageId: string,
  rows: ReadonlyArray<ChunkRow>,
): Effect.Effect<void, Errors.EmbedError> =>
  Effect.gen(function*() {
    const dbDir = join(projectRoot, LANCEDB_DIR)
    const existing = yield* runtime.store.openTable(dbDir)
    if (Option.isSome(existing)) {
      yield* existing.value.checkoutLatest
      yield* existing.value.deletePage(pageId)
      yield* existing.value.addChunks(rows)
      return
    }
    yield* runtime.store.createTable(dbDir, rows)
  })

const readPage = (path: string): Effect.Effect<string, Errors.EmbedError> =>
  Effect.tryPromise({
    try: () => readFile(path, 'utf8'),
    catch: (error) =>
      embedError(
        hasErrorCode(error, 'ENOENT') ? 'NotFound' : 'InvalidRequest',
        `Failed to read wiki page as UTF-8 text: ${describeError(error)}`,
      ),
  })

const embedPageAtRoot = (
  runtime: EmbeddingRuntime,
  projectRoot: string,
  relativePath: string,
  force: boolean,
): Effect.Effect<
  Domain.PageEmbeddingResult,
  Errors.EmbedError | Errors.NotFound | Errors.InvalidRequest
> =>
  Effect.gen(function*() {
    const values = yield* runtime.config.values
    const spec = embeddingSpecFrom(values)
    if (!spec.enabled) return yield* Effect.fail(embeddingDisabled())
    const target = yield* resolveWikiMarkdownPath(projectRoot, relativePath)
    const metadata = yield* Effect.tryPromise({
      try: () => stat(target.pagePath),
      catch: (error) => embedError('NotFound', `Failed to inspect wiki page: ${describeError(error)}`),
    })
    if (metadata.size > MAX_PAGE_BYTES) {
      return yield* Effect.fail(
        embedError(
          'InvalidRequest',
          `Wiki page exceeds the ${MAX_PAGE_BYTES / 1024 / 1024} MiB indexing limit`,
        ),
      )
    }
    const content = yield* readPage(target.pagePath)
    const pageId = stemOf(basename(target.pagePath))
    if (pageId === '') {
      return yield* Effect.fail(embedError('InvalidRequest', 'Invalid wiki page name'))
    }
    const invalidId = validatePageId(pageId)
    if (invalidId !== undefined) return yield* Effect.fail(embedError('InvalidRequest', invalidId))
    if (AGGREGATE_PAGE_STEMS.includes(pageId.toLowerCase())) {
      return yield* Effect.fail(
        embedError(
          'InvalidRequest',
          'Aggregate wiki pages index.md, log.md, and overview.md are maintained by the app and are not vector-indexed',
        ),
      )
    }
    yield* ensureUniquePageStem(projectRoot, target.pagePath, pageId)
    const revision = contentRevision(content)
    const fingerprint = embeddingFingerprint(revision, spec)
    if (!force) {
      const existing = yield* revisionMatch(runtime, projectRoot, pageId, fingerprint)
      if (Option.isSome(existing)) {
        return new Domain.PageEmbeddingResult({
          path: target.normalizedPath,
          pageId,
          revision,
          chunks: existing.value,
          vectorsWritten: 0,
          status: 'unchanged',
        })
      }
    }
    const title = extractTitle(content, pageId)
    const chunkChars = clampChunkChars(spec.maxChunkChars)
    const overlapChars = clampOverlapChars(spec.overlapChunkChars, chunkChars)
    const chunks = chunkMarkdown(content, chunkChars, overlapChars)
    if (chunks.length === 0) {
      return yield* Effect.fail(embedError('InvalidRequest', 'Wiki page has no indexable content'))
    }
    if (chunks.length > MAX_PAGE_CHUNKS) {
      return yield* Effect.fail(
        embedError(
          'InvalidRequest',
          `Wiki page produces ${chunks.length} chunks, exceeding the ${MAX_PAGE_CHUNKS} chunk limit; increase maxChunkChars or split the page`,
        ),
      )
    }
    const prepared = yield* Effect.timeoutOption(
      prepareEmbeddingRows(runtime, spec, pageId, title, chunks),
      runtime.timeouts.providerPhase,
    )
    if (Option.isNone(prepared)) {
      return yield* Effect.fail(
        embedError(
          'Timeout',
          `Embedding provider timed out after ${Duration.toSeconds(runtime.timeouts.providerPhase)} seconds`,
        ),
      )
    }
    const rows = prepared.value
    const dimensionError = validateEmbeddingRows(rows)
    if (dimensionError !== undefined) return yield* Effect.fail(dimensionError)
    yield* upsertChunks(runtime, projectRoot, pageId, rows)
    const saved = yield* saveRevision(projectRoot, pageId, fingerprint)
    if (!saved) {
      yield* invalidateRevision(projectRoot, pageId)
    }
    return new Domain.PageEmbeddingResult({
      path: target.normalizedPath,
      pageId,
      revision,
      chunks: chunks.length,
      vectorsWritten: chunks.length,
      status: 'indexed',
    })
  })

export class Embeddings extends Context.Service<Embeddings, EmbeddingsShape>()(
  'llm-wiki-api-server/Embeddings',
) {
  static readonly make = (dependencies: EmbeddingsDependencies): EmbeddingsShape => {
    const runtime: EmbeddingRuntime = {
      config: dependencies.config,
      transport: dependencies.transport,
      store: dependencies.store,
      timeouts: dependencies.timeouts ?? DEFAULT_EMBEDDING_TIMEOUTS,
    }
    return {
      embedPage: (projectId, path, force = false) =>
        Effect.gen(function*() {
          const projectRoot = yield* dependencies.registry.resolveRoot(projectId)
          return yield* embedPageAtRoot(runtime, projectRoot, path, force)
        }),
    }
  }

  static readonly layer = (
    dependencies: Omit<EmbeddingsDependencies, 'config' | 'registry'>,
  ): Layer.Layer<Embeddings, never, Config | ProjectRegistry> =>
    Layer.effect(
      Embeddings,
      Effect.gen(function*() {
        const config = yield* Config
        const registry = yield* ProjectRegistry
        return Embeddings.make({ ...dependencies, config, registry })
      }),
    )
}
