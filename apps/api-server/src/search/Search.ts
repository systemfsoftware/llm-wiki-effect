/**
 * Hybrid keyword / vector / graph search over a project wiki.
 *
 * Ported from `search_project_inner` in
 * apps/desktop/src-tauri/src/commands/search.rs. The wiki walk is capped at
 * 10_000 markdown files (deterministically ordered by project-relative path),
 * keyword hits are ranked with the Rust weights, optional LanceDB chunk hits
 * are fused with reciprocal-rank fusion (k = 60), and up to 15-30% of the
 * result window is reserved for one-hop knowledge-graph neighbours. The `mode`
 * field is exactly the Rust `search_mode` output (`keyword` / `vector` /
 * `hybrid`).
 */
import { Context, Effect, Exit, Layer, Option } from 'effect'
import { Domain, Errors } from 'llm-wiki-protocol'
import type { Dirent } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import type { ConfigShape, EmbeddingConfig } from '../config/Config.js'
import { extractTitle, extractWikilinks } from '../graph/index.js'
import type { ProjectRegistryShape } from '../projects/Registry.js'
import {
  applyRrfScores,
  blendGraphResults,
  buildVectorSnippet,
  type GraphPage,
  type PageVectorResult,
  rankVectorPages,
  searchMode,
} from './fusion.js'
import { chunkDbPath, fileStem, normalizePath } from './paths.js'
import { compareCodePoints, tokenizeQuery } from './query.js'
import {
  DEFAULT_TOP_K,
  extractImageRefs,
  MAX_RESULTS,
  MAX_SEARCH_FILES,
  scoreFile,
  trimQueryPunctuation,
} from './scoring.js'
import { makeVectorStore, type VectorStoreShape } from './vector.js'

export const SEARCH_NOTE =
  'Search uses the shared backend hybrid retrieval service, combining keyword, vector, and one-hop knowledge-graph candidates. When embeddingConfig is enabled, the API automatically includes LanceDB vector results; clients may also pass queryEmbedding explicitly.'

export interface EmbedQueryInput {
  readonly text: string
  readonly embedding: EmbeddingConfig
}

export type EmbedQuery = (
  input: EmbedQueryInput,
) => Effect.Effect<ReadonlyArray<number>, Errors.EmbedError>

export interface SearchInput {
  readonly projectId: string
  readonly query: string
  readonly topK?: number
  readonly includeContent?: boolean
  readonly queryEmbedding?: ReadonlyArray<number>
}

export interface SearchOptions {
  readonly vector?: VectorStoreShape
  readonly embedQuery?: EmbedQuery
}

export type SearchError = Errors.InvalidRequest | Errors.NotFound | Errors.EmbedError

export interface SearchShape {
  readonly search: (input: SearchInput) => Effect.Effect<Domain.SearchResponse, SearchError>
  readonly optimizeIndex: (projectId: string) => Effect.Effect<void, Errors.InvalidRequest | Errors.NotFound>
}

interface WikiFile {
  readonly absolutePath: string
  readonly relativePath: string
}

const relativePathOf = (root: string, absolute: string): string => {
  const rel = relative(root, absolute)
  return normalizePath(rel.startsWith('..') ? absolute : rel)
}

const collectWikiFiles = (root: string): Effect.Effect<ReadonlyArray<WikiFile>> =>
  Effect.promise(async () => {
    const wikiRoot = join(root, 'wiki')
    try {
      if (!(await stat(wikiRoot)).isDirectory()) return []
    } catch {
      return []
    }
    const files: Array<WikiFile> = []
    const walk = async (dir: string): Promise<void> => {
      let entries: ReadonlyArray<Dirent>
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const absolutePath = join(dir, entry.name)
        if (entry.isDirectory()) await walk(absolutePath)
        else if (entry.isFile() && entry.name.endsWith('.md')) {
          files.push({ absolutePath, relativePath: relativePathOf(root, absolutePath) })
        }
      }
    }
    await walk(wikiRoot)
    return files.sort((left, right) => compareCodePoints(left.relativePath, right.relativePath))
  })

const readText = (path: string): Effect.Effect<string | undefined> =>
  Effect.promise(async () => {
    try {
      return await readFile(path, 'utf8')
    } catch {
      return undefined
    }
  })

const validateEmbedding = (
  embedding: ReadonlyArray<number>,
): Effect.Effect<ReadonlyArray<number>, Errors.EmbedError> => {
  if (embedding.length === 0) {
    return Effect.fail(
      new Errors.EmbedError({ kind: 'InvalidRequest', message: 'queryEmbedding must not be empty' }),
    )
  }
  if (embedding.some((value) => !Number.isFinite(value))) {
    return Effect.fail(
      new Errors.EmbedError({
        kind: 'InvalidRequest',
        message: 'queryEmbedding must contain only finite numbers',
      }),
    )
  }
  return Effect.succeed(embedding)
}

const resolveEmbedding = (
  input: SearchInput,
  config: ConfigShape,
  embedQuery: EmbedQuery | undefined,
): Effect.Effect<Option.Option<ReadonlyArray<number>>, Errors.EmbedError> => {
  if (input.queryEmbedding !== undefined) {
    return Effect.map(validateEmbedding(input.queryEmbedding), Option.some)
  }
  if (embedQuery === undefined) return Effect.succeed(Option.none())
  return Effect.gen(function*() {
    const outcome = yield* Effect.exit(
      embedQuery({ text: input.query, embedding: config.embedding }),
    )
    if (Exit.isFailure(outcome)) return Option.none<ReadonlyArray<number>>()
    return Option.some(yield* validateEmbedding(outcome.value))
  })
}

const makeSearch = (
  registry: ProjectRegistryShape,
  config: ConfigShape,
  options: SearchOptions | undefined,
): SearchShape => {
  const vector = options?.vector ?? makeVectorStore()
  const embedQuery = options?.embedQuery

  const materialize = (input: {
    readonly results: ReadonlyArray<Domain.SearchResult>
    readonly pages: ReadonlyArray<PageVectorResult>
    readonly pagePathsByStem: ReadonlyMap<string, string>
    readonly root: string
    readonly includeContent: boolean
  }): Effect.Effect<ReadonlyArray<Domain.SearchResult>> =>
    Effect.gen(function*() {
      const { results, pages, pagePathsByStem, root, includeContent } = input
      const known = new Set(results.map((result) => fileStem(result.path)))
      const out = [...results]
      for (const page of pages) {
        if (known.has(page.id)) continue
        const rel = pagePathsByStem.get(page.id)
        if (rel === undefined) continue
        const content = yield* readText(join(root, rel))
        if (content === undefined) continue
        const fileName = rel.slice(rel.lastIndexOf('/') + 1)
        out.push(
          new Domain.SearchResult({
            path: rel,
            title: extractTitle(content, fileName),
            snippet: buildVectorSnippet(page),
            titleMatch: false,
            score: 0,
            vectorScore: page.score,
            images: extractImageRefs(content),
            ...(includeContent ? { content } : {}),
          }),
        )
        known.add(page.id)
      }
      return out
    })

  const search: SearchShape['search'] = (input) =>
    Effect.gen(function*() {
      if (input.query.trim() === '') {
        return yield* Effect.fail(new Errors.InvalidRequest({ message: 'query is required' }))
      }
      const limit = Math.min(Math.max(input.topK ?? DEFAULT_TOP_K, 1), MAX_RESULTS)
      const includeContent = input.includeContent ?? false
      const tokens = tokenizeQuery(input.query)
      const effectiveTokens = tokens.length === 0 ? [input.query.trim().toLowerCase()] : tokens
      const queryPhrase = trimQueryPunctuation(input.query.toLowerCase())

      const root = yield* registry.resolveRoot(input.projectId)
      const projects = yield* registry.list
      const projectId = projects.find((project) => project.path === root)?.id ?? input.projectId
      const allFiles = yield* collectWikiFiles(root)

      const results: Array<Domain.SearchResult> = []
      const pagePathsByStem = new Map<string, string>()
      const graphPages = new Map<string, GraphPage>()

      let searched = 0
      for (const file of allFiles) {
        searched += 1
        if (searched > MAX_SEARCH_FILES) break
        const content = yield* readText(file.absolutePath)
        if (content === undefined) continue
        const fileName = file.relativePath.slice(file.relativePath.lastIndexOf('/') + 1)
        pagePathsByStem.set(fileStem(file.relativePath), file.relativePath)
        graphPages.set(normalizePath(file.relativePath), {
          path: file.relativePath,
          title: extractTitle(content, fileName),
          content,
          links: extractWikilinks(content),
        })
        const hit = scoreFile({
          path: file.relativePath,
          content,
          tokens: effectiveTokens,
          queryPhrase,
          query: input.query,
          includeContent,
        })
        if (hit !== undefined) results.push(hit)
      }

      const tokenRank = new Map<string, number>()
      const orderedForRank = [...results].sort((left, right) =>
        right.score - left.score || compareCodePoints(left.path, right.path)
      )
      orderedForRank.forEach((result, rank) => tokenRank.set(normalizePath(result.path), rank + 1))

      const embedding = yield* resolveEmbedding(input, config, embedQuery)
      const vectorRank = new Map<string, number>()
      const vectorScore = new Map<string, number>()
      let vectorHits = 0
      let fused: ReadonlyArray<Domain.SearchResult> = results

      if (Option.isSome(embedding) && embedding.value.length > 0) {
        const chunkLimit = Math.max(Math.max(limit, 10) * 3, 30)
        const outcome = yield* Effect.exit(
          vector.searchChunks(chunkDbPath(root), embedding.value, chunkLimit),
        )
        if (Exit.isSuccess(outcome)) {
          const pages = rankVectorPages(outcome.value, Math.max(limit, 10))
          vectorHits = pages.length
          pages.forEach((page, index) => {
            vectorRank.set(page.id, index + 1)
            vectorScore.set(page.id, page.score)
          })
          fused = yield* materialize({ results, pages, pagePathsByStem, root, includeContent })
        }
      }

      if (vectorHits > 0) fused = applyRrfScores(fused, tokenRank, vectorRank, vectorScore)

      const ranked = [...fused].sort((left, right) =>
        right.score - left.score || compareCodePoints(left.path, right.path)
      )
      const blended = blendGraphResults(ranked, graphPages, limit, vectorHits, includeContent)

      return new Domain.SearchResponse({
        projectId,
        mode: searchMode(tokenRank.size === 0, vectorHits, blended.graphHits),
        note: SEARCH_NOTE,
        tokenHits: tokenRank.size,
        vectorHits,
        graphHits: blended.graphHits,
        results: blended.results,
      })
    })

  const optimizeIndex: SearchShape['optimizeIndex'] = (projectId) =>
    Effect.gen(function*() {
      const root = yield* registry.resolveRoot(projectId)
      yield* vector.optimizeIndex(chunkDbPath(root))
    })

  return { search, optimizeIndex }
}

export class Search extends Context.Service<Search, SearchShape>()('llm-wiki-api-server/Search') {
  static readonly make = (
    registry: ProjectRegistryShape,
    config: ConfigShape,
    options?: SearchOptions,
  ): Effect.Effect<SearchShape> => Effect.sync(() => makeSearch(registry, config, options))
  static readonly layer = (
    registry: ProjectRegistryShape,
    config: ConfigShape,
    options?: SearchOptions,
  ): Layer.Layer<Search> => Layer.effect(Search, Search.make(registry, config, options))
}
