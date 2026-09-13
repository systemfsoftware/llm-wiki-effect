import lancedbPkg from '@lancedb/lancedb'
import { Effect } from 'effect'
import { array, assert, integer, property, stringMatching } from 'fast-check'
import { Domain, Errors } from 'llm-wiki-protocol'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Config } from '../src/config/Config.js'
import type { ConfigShape } from '../src/config/Config.js'
import type { ProjectRegistryShape } from '../src/projects/Registry.js'
import {
  applyRrfScores,
  buildSnippet,
  chunkDbPath,
  type ChunkRow,
  compareCodePoints,
  fileStem,
  graphResultQuota,
  type LanceConnect,
  makeVectorStore,
  MAX_RESULTS,
  normalizeGraphAlias,
  Search,
  type SearchInput,
  searchMode,
  type SearchOptions,
  type SearchShape,
  tokenizeQuery,
  VECTOR_CHUNKS_TABLE,
  type VectorStoreShape,
} from '../src/search/index.js'

const PROJECT_ID = 'project-1'

const required = <T>(value: T | null | undefined, label: string): T => {
  if (value === null || value === undefined) throw new Error(`expected ${label} to be defined`)
  return value
}

const createdRoots: Array<string> = []

const makeProject = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'llm-wiki-search-'))
  createdRoots.push(root)
  return root
}

const writeWiki = async (root: string, files: Record<string, string>): Promise<void> => {
  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = join(root, relativePath)
    await mkdir(dirname(absolutePath), { recursive: true })
    await writeFile(absolutePath, content, 'utf8')
  }
}

afterEach(async () => {
  await Promise.all(
    createdRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

const registryFor = (root: string): ProjectRegistryShape => ({
  list: Effect.succeed([] as ReadonlyArray<Domain.Project>),
  setCurrent: () => Effect.die(new Error('setCurrent is not exercised by the search suite')),
  resolveRoot: () => Effect.succeed(root),
})

const makeSearch = async (root: string, options?: SearchOptions): Promise<SearchShape> => {
  const config: ConfigShape = await Effect.runPromise(Config.make({ mode: 'standalone', env: {} }))
  return Effect.runPromise(Search.make(registryFor(root), config, options))
}

const runSearch = async (
  root: string,
  options: SearchOptions | undefined,
  input: SearchInput,
): Promise<Domain.SearchResponse> => Effect.runPromise((await makeSearch(root, options)).search(input))

const searchFailure = async (
  root: string,
  input: SearchInput,
): Promise<{ readonly name: string; readonly message: string }> =>
  Effect.runPromise(Effect.flip((await makeSearch(root)).search(input)))

const vectorSeam = (rows: ReadonlyArray<ChunkRow>): VectorStoreShape => ({
  searchChunks: () => Effect.succeed(rows),
  optimizeIndex: () => Effect.void,
})

const vec = (seed: number): ReadonlyArray<number> =>
  Array.from({ length: 8 }, (_, dimension) => Math.sin(seed * 0.1 + dimension) * 0.01)

const writeChunkTable = async (
  root: string,
  rows: ReadonlyArray<Record<string, unknown>>,
): Promise<void> => {
  const db = await lancedbPkg.connect(chunkDbPath(root))
  await db.createTable(VECTOR_CHUNKS_TABLE, [...rows])
}

describe('tokenizeQuery', () => {
  it.each([
    ['默会', ['默会']],
    ['The vector database', ['database', 'vector']],
    ['vector, database!', ['database', 'vector']],
    ['C++', []],
    ['   ', []],
  ])('parses %j to %j', (query, expected) => {
    expect(tokenizeQuery(query)).toEqual(expected)
  })

  it('expands a long CJK token into bigrams, characters and the token', () => {
    expect(tokenizeQuery('默会知识')).toEqual(
      expect.arrayContaining(['默会', '会知', '知识', '默', '会', '知', '识', '默会知识']),
    )
  })

  it('returns lowercased, deduplicated tokens in code-point order (property)', () => {
    assert(
      property(stringMatching(/^[\p{L}\p{N}.,，。!? 的]{0,40}$/u), (query) => {
        const tokens = tokenizeQuery(query)
        const lowercased = tokens.every((token) => token === token.toLowerCase())
        const strictlySorted = tokens.every((token, index) => {
          if (index === 0) return true
          const previous = tokens[index - 1]
          return previous !== undefined && compareCodePoints(previous, token) < 0
        })
        return lowercased && strictlySorted
      }),
      { numRuns: 150 },
    )
  })
})

describe('buildSnippet', () => {
  it('windows around the match and marks both truncation edges', () => {
    const snippet = buildSnippet(`${'x'.repeat(200)}needle${'y'.repeat(200)}`, 'needle')
    expect(snippet).toContain('needle')
    expect(snippet.startsWith('...')).toBe(true)
    expect(snippet.endsWith('...')).toBe(true)
  })

  it('returns empty for empty content', () => {
    expect(buildSnippet('', 'anything')).toBe('')
  })

  it('always contains the query wherever it occurs (property)', () => {
    assert(
      property(
        stringMatching(/^[a-z]{1,6}$/),
        stringMatching(/^[a-zA-Z \u4e00-\u9fff]{0,40}$/),
        stringMatching(/^[a-zA-Z \u4e00-\u9fff]{0,40}$/),
        (needle, prefix, suffix) => buildSnippet(`${prefix}${needle}${suffix}`, needle).includes(needle),
      ),
      { numRuns: 150 },
    )
  })
})

describe('searchMode', () => {
  it.each(
    [
      [false, 0, 0, 'keyword'],
      [true, 3, 0, 'vector'],
      [false, 3, 0, 'hybrid'],
      [false, 0, 1, 'hybrid'],
    ] as const,
  )(
    'maps tokenEmpty=%s vectorHits=%s graphHits=%s to %s',
    (tokenEmpty, vectorHits, graphHits, mode) => {
      expect(searchMode(tokenEmpty, vectorHits, graphHits)).toBe(mode)
    },
  )
})

describe('graph blending constants', () => {
  it('scales the graph share from thirty to fifteen percent', () => {
    expect(graphResultQuota(1, 0)).toBe(0)
    expect(graphResultQuota(20, 0)).toBe(6)
    expect(graphResultQuota(20, 10)).toBe(5)
    expect(graphResultQuota(20, 20)).toBe(3)
    expect(graphResultQuota(10, 100)).toBe(2)
  })

  it('normalizes aliases by stripping anchors, extensions and spaces', () => {
    expect(normalizeGraphAlias('Title#Section')).toBe('title')
    expect(normalizeGraphAlias(' tool registry.md ')).toBe('tool-registry')
    expect(normalizeGraphAlias('a\\b\\c.md')).toBe('a/b/c')
  })
})

describe('applyRrfScores', () => {
  it('sums reciprocal ranks with k=60 and keeps the vector score (property)', () => {
    assert(
      property(
        array(integer({ min: 1, max: 100 }), { minLength: 1, maxLength: 10 }),
        array(integer({ min: 1, max: 100 }), { minLength: 1, maxLength: 10 }),
        (tokenRanks, vectorRanks) => {
          const count = Math.min(tokenRanks.length, vectorRanks.length)
          const paths = Array.from({ length: count }, (_, index) => `wiki/p${index}.md`)
          const results = paths.map(
            (path) =>
              new Domain.SearchResult({
                path,
                title: path,
                snippet: path,
                titleMatch: false,
                score: 0,
                images: [],
              }),
          )
          const tokenRankAt = (index: number): number => required(tokenRanks[index], 'token rank')
          const vectorRankAt = (index: number): number => required(vectorRanks[index], 'vector rank')
          const tokenRank = new Map(
            paths.map((path, index): [string, number] => [path, tokenRankAt(index)]),
          )
          const vectorRank = new Map(
            paths.map((path, index): [string, number] => [fileStem(path), vectorRankAt(index)]),
          )
          const vectorScore = new Map(
            paths.map((path, index): [string, number] => [
              fileStem(path),
              1 / (60 + vectorRankAt(index)),
            ]),
          )
          const scored = applyRrfScores(results, tokenRank, vectorRank, vectorScore)
          const scoredAt = (index: number): Domain.SearchResult => required(scored[index], 'scored result')
          const again = applyRrfScores(results, tokenRank, vectorRank, vectorScore)
          const deterministic = scored.every(
            (result, index) => result.score === required(again[index], 'repeated result').score,
          )
          const expected = scored.every(
            (result, index) =>
              Math.abs(
                result.score - (1 / (60 + tokenRankAt(index)) + 1 / (60 + vectorRankAt(index))),
              ) < 1e-9,
          )
          let monotone = true
          for (let left = 0; left < count; left += 1) {
            for (let right = 0; right < count; right += 1) {
              if (left === right) continue
              if (
                tokenRankAt(left) <= tokenRankAt(right) &&
                vectorRankAt(left) <= vectorRankAt(right)
              ) {
                const leftScore = scoredAt(left).score
                const rightScore = scoredAt(right).score
                if (leftScore < rightScore - 1e-9) monotone = false
                const strictlyBetter = tokenRankAt(left) < tokenRankAt(right) ||
                  vectorRankAt(left) < vectorRankAt(right)
                if (strictlyBetter && !(leftScore > rightScore)) monotone = false
              }
            }
          }
          return deterministic && expected && monotone
        },
      ),
      { numRuns: 150 },
    )
  })
})

describe('vector search over a real LanceDB directory', () => {
  it('returns nearest chunks ordered by _distance', async () => {
    const root = await makeProject()
    const queryVector = vec(3)
    await writeChunkTable(root, [
      {
        chunk_id: 'attention#0',
        page_id: 'attention',
        chunk_index: 0,
        chunk_text: 'Attention mechanism details.',
        heading_path: 'Model > Attention',
        vector: queryVector,
      },
      {
        chunk_id: 'decoy#0',
        page_id: 'decoy',
        chunk_index: 0,
        chunk_text: 'Unrelated.',
        heading_path: 'Other',
        vector: vec(9),
      },
    ])

    const db = await lancedbPkg.connect(chunkDbPath(root))
    const table = await db.openTable(VECTOR_CHUNKS_TABLE)
    const hits = (await table.query().nearestTo([...queryVector]).limit(5).toArray()) as ReadonlyArray<
      Record<string, unknown>
    >

    expect(required(hits[0], 'first hit')['page_id']).toBe('attention')
    const distances = hits.map((hit) => Number(hit['_distance']))
    expect(distances).toEqual([...distances].sort((left, right) => left - right))
  })

  it('optimizes a real chunk table without losing rows', async () => {
    const root = await makeProject()
    const queryVector = vec(3)
    await writeChunkTable(root, [
      {
        chunk_id: 'attention#0',
        page_id: 'attention',
        chunk_index: 0,
        chunk_text: 'Attention mechanism details.',
        heading_path: 'Model > Attention',
        vector: queryVector,
      },
    ])

    await Effect.runPromise(makeVectorStore().optimizeIndex(chunkDbPath(root)))

    const db = await lancedbPkg.connect(chunkDbPath(root))
    const table = await db.openTable(VECTOR_CHUNKS_TABLE)
    expect(await table.countRows()).toBe(1)
  })

  it('fuses keyword and vector hits and materializes a vector-only page', async () => {
    const root = await makeProject()
    const queryVector = vec(3)
    await writeWiki(root, {
      'wiki/concepts/attention.md': '---\ntitle: Attention\n---\n\n# Attention\n\nthe attention mechanism body.',
      'wiki/concepts/semantic.md': '---\ntitle: Semantic\n---\n\n# Semantic\n\nthis page has no keyword match at all.',
    })
    await writeChunkTable(root, [
      {
        chunk_id: 'attention#0',
        page_id: 'attention',
        chunk_index: 0,
        chunk_text: 'Attention chunk.',
        heading_path: 'Model',
        vector: queryVector,
      },
      {
        chunk_id: 'semantic#0',
        page_id: 'semantic',
        chunk_index: 0,
        chunk_text: 'A semantic chunk explains retrieval.',
        heading_path: 'Section > Detail',
        vector: queryVector,
      },
    ])

    const response = await runSearch(root, undefined, {
      projectId: PROJECT_ID,
      query: 'attention',
      topK: 10,
      queryEmbedding: queryVector,
    })

    expect(response.mode).toBe('hybrid')
    expect(response.vectorHits).toBe(2)
    expect(required(response.results[0], 'first result').path).toBe('wiki/concepts/attention.md')

    const attention = required(
      response.results.find((result) => result.path === 'wiki/concepts/attention.md'),
      'attention result',
    )
    expect(required(attention.vectorScore, 'attention vector score')).toBeCloseTo(1, 6)

    const semantic = response.results.find((result) => result.path === 'wiki/concepts/semantic.md')
    expect(semantic).toBeDefined()
    const semanticResult = required(semantic, 'semantic result')
    expect(required(semanticResult.vectorScore, 'semantic vector score')).toBeCloseTo(1, 6)
    expect(semanticResult.snippet).toContain('A semantic chunk')
    expect(semanticResult.snippet).toContain('Section > Detail')
  })
})

describe('KTD7 manifest checkout', () => {
  const recording = (tables: ReadonlyArray<string>, calls: Array<string>): LanceConnect => async () => ({
    tableNames: async () => {
      calls.push('tableNames')
      return tables
    },
    openTable: async () => {
      calls.push('openTable')
      return {
        nearest: async () => {
          calls.push('nearest')
          return []
        },
        checkoutLatest: async () => {
          calls.push('checkoutLatest')
        },
        optimize: async () => {
          calls.push('optimize')
        },
      }
    },
  })

  it('checks out the latest manifest before optimizing and never on reads', async () => {
    const calls: Array<string> = []
    const store = makeVectorStore({ connect: recording([VECTOR_CHUNKS_TABLE], calls) })

    await Effect.runPromise(store.optimizeIndex('/tmp/ignored'))
    expect(calls).toEqual(['tableNames', 'openTable', 'checkoutLatest', 'optimize'])

    calls.length = 0
    await Effect.runPromise(store.searchChunks('/tmp/ignored', [0], 5))
    expect(calls).toEqual(['tableNames', 'openTable', 'nearest'])
  })

  it('does nothing when the chunk table is absent', async () => {
    const calls: Array<string> = []
    const store = makeVectorStore({ connect: recording([], calls) })
    await Effect.runPromise(store.optimizeIndex('/tmp/ignored'))
    expect(calls).toEqual(['tableNames'])
  })
})

describe('Search service', () => {
  it('prefers an exact filename match and reports keyword mode', async () => {
    const root = await makeProject()
    await writeWiki(root, {
      'wiki/concepts/attention.md': '---\ntitle: Attention\n---\n\n# Attention\n\nbody about attention.',
      'wiki/concepts/random.md': '---\ntitle: Random\n---\n\n# Random\n\nattention is mentioned briefly.',
    })

    const response = await runSearch(root, undefined, {
      projectId: PROJECT_ID,
      query: 'attention',
      topK: 20,
    })

    expect(response.mode).toBe('keyword')
    expect(response.tokenHits).toBe(2)
    const top = required(response.results[0], 'top result')
    expect(top.title).toBe('Attention')
    expect(top.titleMatch).toBe(true)
    expect(top.score).toBeGreaterThan(100)
  })

  it('blends one-hop graph neighbours into the window', async () => {
    const root = await makeProject()
    await writeWiki(root, {
      'wiki/concepts/agent.md':
        '---\ntitle: Agent Runtime\n---\n\n# Agent Runtime\n\nagent runtime details. [[Tool Registry]]',
      'wiki/concepts/tool-registry.md': '---\ntitle: Tool Registry\n---\n\n# Tool Registry\n\nDefines callable tools.',
      'wiki/concepts/unrelated.md': '---\ntitle: Unrelated\n---\n\n# Unrelated\n\nNo graph connection.',
    })

    const response = await runSearch(root, undefined, {
      projectId: PROJECT_ID,
      query: 'agent runtime',
      topK: 10,
    })

    expect(response.mode).toBe('hybrid')
    expect(response.graphHits).toBe(1)
    const neighbour = response.results.find((result) => result.title === 'Tool Registry')
    expect(neighbour).toBeDefined()
    const neighbourResult = required(neighbour, 'graph neighbour')
    expect(neighbourResult.snippet).toContain('Graph neighbor')
    expect(neighbourResult.graphRelatedTo).toEqual(['Agent Runtime'])
    expect(response.results.some((result) => result.title === 'Unrelated')).toBe(false)
  })

  it('reports vector mode when only the embedding matches', async () => {
    const root = await makeProject()
    await writeWiki(root, {
      'wiki/concepts/only.md': '---\ntitle: Only\n---\n\n# Only\n\nnothing relevant here at all.',
    })

    const response = await runSearch(
      root,
      {
        vector: vectorSeam([
          {
            chunkId: 'only#0',
            pageId: 'only',
            chunkIndex: 0,
            chunkText: 'a chunk about the topic',
            headingPath: 'Heading',
            score: 0.9,
          },
        ]),
      },
      { projectId: PROJECT_ID, query: 'absent-term', topK: 10, queryEmbedding: [1, 0, 0] },
    )

    expect(response.mode).toBe('vector')
    expect(response.tokenHits).toBe(0)
    expect(response.vectorHits).toBe(1)
    const top = required(response.results[0], 'top result')
    expect(top.path).toBe('wiki/concepts/only.md')
    expect(required(top.vectorScore, 'vector score')).toBeCloseTo(0.9, 6)
  })

  it('rejects an empty query', async () => {
    const root = await makeProject()
    const error = await searchFailure(root, { projectId: PROJECT_ID, query: '   ' })
    expect(error.name).toBe('InvalidRequest')
    expect(error.message).toBe('query is required')
  })

  it('rejects a query embedding with non-finite values', async () => {
    const root = await makeProject()
    const error = await Effect.runPromise(
      Effect.flip(
        (await makeSearch(root)).search({
          projectId: PROJECT_ID,
          query: 'anything',
          queryEmbedding: [1, Number.NaN],
        }),
      ),
    )
    expect(error.name).toBe('EmbedError')
    expect('kind' in error ? error.kind : undefined).toBe('InvalidRequest')
  })

  it('clamps an oversized topK to the result cap', async () => {
    const root = await makeProject()
    const pages: Record<string, string> = {}
    for (let index = 0; index < 60; index += 1) {
      pages[`wiki/pages/p${index}.md`] = `widget body number ${index}`
    }
    await writeWiki(root, pages)

    const response = await runSearch(root, undefined, {
      projectId: PROJECT_ID,
      query: 'widget',
      topK: 1_000,
    })

    expect(response.results).toHaveLength(MAX_RESULTS)
    expect(response.tokenHits).toBe(60)
  })

  it('reports the resolved project id, not the requested selector', async () => {
    const root = await makeProject()
    await writeWiki(root, { 'wiki/index.md': '# Index\n\nwidget body' })
    const config = await Effect.runPromise(Config.make({ mode: 'standalone', env: {} }))
    const registry: ProjectRegistryShape = {
      list: Effect.succeed([
        new Domain.Project({ id: 'alpha-id', name: 'Alpha', path: root, current: true }),
      ]),
      setCurrent: () => Effect.die(new Error('setCurrent is not exercised by the search suite')),
      resolveRoot: () => Effect.succeed(root),
    }
    const search = await Effect.runPromise(Search.make(registry, config))

    const response = await Effect.runPromise(
      search.search({ projectId: root, query: 'widget', topK: 5 }),
    )

    expect(response.projectId).toBe('alpha-id')
  })

  it('derives the query embedding from config through the embed seam', async () => {
    const root = await makeProject()
    await writeWiki(root, { 'wiki/concepts/x.md': '# X\n\nnothing relevant here.' })
    const seenModels: Array<string> = []

    const response = await runSearch(
      root,
      {
        vector: vectorSeam([
          {
            chunkId: 'x#0',
            pageId: 'x',
            chunkIndex: 0,
            chunkText: 'a chunk',
            headingPath: 'H',
            score: 0.5,
          },
        ]),
        embedQuery: (input) => {
          seenModels.push(input.embedding.model)
          return Effect.succeed([0.1, 0.2, 0.3])
        },
      },
      { projectId: PROJECT_ID, query: 'absent-term', topK: 5 },
    )

    expect(seenModels).toEqual(['text-embedding-3-small'])
    expect(response.mode).toBe('vector')
    expect(response.vectorHits).toBe(1)
  })

  it('falls back to keyword results when the embed seam fails', async () => {
    const root = await makeProject()
    await writeWiki(root, { 'wiki/concepts/x.md': '# X\n\nwidget body.' })

    const response = await runSearch(
      root,
      {
        embedQuery: () => Effect.fail(new Errors.EmbedError({ kind: 'Provider', message: 'embedding down' })),
      },
      { projectId: PROJECT_ID, query: 'widget', topK: 5 },
    )

    expect(response.mode).toBe('keyword')
    expect(response.vectorHits).toBe(0)
    expect(required(response.results[0], 'fallback result').path).toBe('wiki/concepts/x.md')
  })

  it('times a full search call end to end through the layer', async () => {
    const root = await makeProject()
    await writeWiki(root, {
      'wiki/concepts/timing.md': '---\ntitle: Timing\n---\n\n# Timing\n\ntiming body.',
    })
    const config = await Effect.runPromise(Config.make({ mode: 'standalone', env: {} }))
    const started = performance.now()
    const response = await Effect.runPromise(
      Effect.provide(
        Search.use((search) => search.search({ projectId: PROJECT_ID, query: 'timing', topK: 5 })),
        Search.layer(registryFor(root), config),
      ),
    )
    const elapsed = performance.now() - started

    expect(required(response.results[0], 'timed result').path).toBe('wiki/concepts/timing.md')
    expect(elapsed).toBeGreaterThanOrEqual(0)
  })
})
