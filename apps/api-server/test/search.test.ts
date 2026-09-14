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
  blendGraphResults,
  buildSnippet,
  buildVectorSnippet,
  chunkDbPath,
  type ChunkRow,
  compareCodePoints,
  countOccurrences,
  extractImageRefs,
  fileStem,
  type GraphPage,
  graphResultQuota,
  isQuerySeparator,
  isStopWord,
  type LanceConnect,
  makeVectorStore,
  MAX_RESULTS,
  normalizeGraphAlias,
  rankVectorPages,
  RRF_K,
  scoreFile,
  Search,
  type SearchInput,
  searchMode,
  type SearchOptions,
  type SearchShape,
  SNIPPET_CONTEXT,
  tokenizeQuery,
  tokenMatchScore,
  trimQueryPunctuation,
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

const CJK_SEPARATORS = [
  '，',
  '。',
  '！',
  '？',
  '、',
  '；',
  '：',
  '“',
  '”',
  '‘',
  '’',
  '（',
  '）',
  '·',
  '～',
  '…',
] as const

const STOP_WORDS = [
  '的',
  '是',
  '了',
  '什么',
  '在',
  '有',
  '和',
  '与',
  '对',
  '从',
  'the',
  'is',
  'a',
  'an',
  'what',
  'how',
  'are',
  'was',
  'were',
  'do',
  'does',
  'did',
  'be',
  'been',
  'being',
  'have',
  'has',
  'had',
  'it',
  'its',
  'in',
  'on',
  'at',
  'to',
  'for',
  'of',
  'with',
  'by',
  'this',
  'that',
  'these',
  'those',
] as const

describe('query core: separators, stop words and CJK expansion', () => {
  it.each(CJK_SEPARATORS)('treats %s as a query separator', (separator) => {
    expect(isQuerySeparator(separator)).toBe(true)
    expect(tokenizeQuery(`alpha${separator}beta`)).toEqual(['alpha', 'beta'])
  })

  it.each(STOP_WORDS)('drops the stop word %s', (word) => {
    expect(isStopWord(word)).toBe(true)
    expect(tokenizeQuery(`${word} widget`)).toEqual(['widget'])
  })

  it.each(
    [
      ['!', true],
      ['/', true],
      ['0', false],
      ['9', false],
      [':', true],
      ['@', true],
      ['A', false],
      ['Z', false],
      ['[', true],
      ['`', true],
      ['a', false],
      ['z', false],
      ['{', true],
      ['~', true],
      ['\u007f', false],
      ['\u00e9', false],
      ['\u0000', false],
      ['\u001f', false],
      ['\u0085', false],
    ] as const,
  )('classifies the code point %j as a separator=%s', (char, expected) => {
    expect(isQuerySeparator(char)).toBe(expected)
  })

  it.each([' ', '\t', '\n', '\v', '\f', '\r', '\u00a0', '\u3000'])(
    'treats %j as whitespace',
    (whitespace) => {
      expect(isQuerySeparator(whitespace)).toBe(true)
    },
  )

  it('expands a long CJK token into bigrams, characters and the token itself', () => {
    expect(tokenizeQuery('默会知识')).toEqual([
      '会',
      '会知',
      '知',
      '知识',
      '识',
      '默',
      '默会',
      '默会知识',
    ])
    expect(tokenizeQuery('默的会知')).toEqual([
      '会',
      '会知',
      '的会',
      '知',
      '默',
      '默的',
      '默的会知',
    ])
  })

  it('expands a mixed token that only partially covers the CJK range', () => {
    expect(tokenizeQuery('a默会')).toEqual(['a默', 'a默会', '会', '默', '默会'])
  })

  it('expands tokens whose characters sit on the 0x3400 and 0x9fff boundaries', () => {
    expect(tokenizeQuery('㐀㐀㐀')).toEqual(['㐀', '㐀㐀', '㐀㐀㐀'])
    expect(tokenizeQuery('鿿鿿鿿')).toEqual(['鿿', '鿿鿿', '鿿鿿鿿'])
  })

  it('leaves tokens outside the CJK block unexpanded', () => {
    expect(tokenizeQuery('㏿㏿㏿')).toEqual(['㏿㏿㏿'])
    expect(tokenizeQuery('ꀀꀀꀀ')).toEqual(['ꀀꀀꀀ'])
  })

  it('orders strings by code point with length as the tie break', () => {
    expect(compareCodePoints('a', 'a')).toBe(0)
    expect(compareCodePoints('a', 'b')).toBe(-1)
    expect(compareCodePoints('b', 'a')).toBe(1)
    expect(compareCodePoints('a', 'aa')).toBe(-1)
    expect(compareCodePoints('aa', 'a')).toBe(1)
    expect(compareCodePoints('b', 'aa')).toBe(1)
    expect(compareCodePoints('aa', 'b')).toBe(-1)
    expect(compareCodePoints('ab', 'aa')).toBe(1)
    expect(compareCodePoints('aa', 'ab')).toBe(-1)
    expect(compareCodePoints('会', '默')).toBe(-1)
    expect(compareCodePoints('默', '会')).toBe(1)
    expect(compareCodePoints('', 'a')).toBe(-1)
    expect(compareCodePoints('a', '')).toBe(1)
    expect(compareCodePoints('', '')).toBe(0)
  })
})

const scoreInput = (
  over: Partial<{
    path: string
    content: string
    tokens: ReadonlyArray<string>
    queryPhrase: string
    query: string
    includeContent: boolean
  }> = {},
): Parameters<typeof scoreFile>[0] => ({
  path: 'wiki/concepts/attention.md',
  content: '# Attention\n\nthe attention mechanism',
  tokens: ['attention'],
  queryPhrase: 'attention',
  query: 'attention',
  includeContent: false,
  ...over,
})

describe('scoring core: punctuation, occurrences, image refs and snippets', () => {
  it('trims separator runs from both ends only', () => {
    expect(trimQueryPunctuation('  hello, world!  ')).toBe('hello, world')
    expect(trimQueryPunctuation('，默会。')).toBe('默会')
    expect(trimQueryPunctuation('abc')).toBe('abc')
    expect(trimQueryPunctuation('')).toBe('')
    expect(trimQueryPunctuation('，,!')).toBe('')
    expect(trimQueryPunctuation('!')).toBe('')
    expect(trimQueryPunctuation('a!')).toBe('a')
  })

  it('counts non-overlapping occurrences and ignores an empty needle', () => {
    expect(countOccurrences('aaaa', 'aa')).toBe(2)
    expect(countOccurrences('banana', 'an')).toBe(2)
    expect(countOccurrences('a.a.a', '.')).toBe(2)
    expect(countOccurrences('', 'a')).toBe(0)
  })

  it('scores token matches case-insensitively', () => {
    expect(tokenMatchScore('Attention Mechanism', ['attention', 'absent'])).toBe(1)
    expect(tokenMatchScore('a b c', ['a', 'b'])).toBe(2)
    expect(tokenMatchScore('', ['a'])).toBe(0)
  })

  it('extracts markdown image refs in document order', () => {
    const refs = extractImageRefs('before ![alt text](https://x/y.png) between ![other](img.gif) after')
    expect(refs.map((ref) => [ref.alt, ref.url])).toEqual([
      ['alt text', 'https://x/y.png'],
      ['other', 'img.gif'],
    ])
  })

  it('drops duplicate, blank and whitespace-bearing image urls', () => {
    expect(extractImageRefs('![a](u) ![b](u)').map((ref) => ref.alt)).toEqual(['a'])
    expect(extractImageRefs('![](   )').length).toBe(0)
    expect(extractImageRefs('![](has space)').length).toBe(0)
    expect(extractImageRefs('![](  spaced  )').length).toBe(0)
  })

  it('stops cleanly on malformed image syntax', () => {
    expect(extractImageRefs('![alt](closed) then ![alt2](unterminated').map((ref) => ref.url)).toEqual([
      'closed',
    ])
    expect(extractImageRefs('![alt only').length).toBe(0)
    expect(extractImageRefs('no images here').length).toBe(0)
  })

  it('windows a snippet around the match with byte-accurate boundaries', () => {
    expect(buildSnippet('', 'anything')).toBe('')
    expect(buildSnippet('short content', 'content')).toBe('short content')
    expect(buildSnippet('short content', 'SHORT')).toBe('short content')
    expect(buildSnippet(`${'x'.repeat(200)}needle${'y'.repeat(200)}`, 'needle')).toBe(
      `...${'x'.repeat(SNIPPET_CONTEXT)}needle${'y'.repeat(SNIPPET_CONTEXT)}...`,
    )
    expect(buildSnippet(`${'默'.repeat(200)}知识${'会'.repeat(200)}`, '知识')).toBe(
      `...${'默'.repeat(SNIPPET_CONTEXT)}知识${'会'.repeat(SNIPPET_CONTEXT)}...`,
    )
    expect(buildSnippet('a\nb\nc needle', 'needle')).toBe('a b c needle')
  })

  it('windows the snippet around a match that starts at the first character', () => {
    expect(buildSnippet(`aAB${'z'.repeat(200)}`, 'AB')).toBe(`aAB${'z'.repeat(SNIPPET_CONTEXT)}...`)
  })
})

describe('scoring core: scoreFile weighting', () => {
  it('scores an exact filename match with every bonus applied', () => {
    const result = required(scoreFile(scoreInput()), 'scored file')

    expect(result.score).toBe(296)
    expect(result.title).toBe('Attention')
    expect(result.titleMatch).toBe(true)
    expect(result.snippet).toBe('# Attention  the attention mechanism')
    expect(result.images).toEqual([])
    expect(result.content).toBeUndefined()
  })

  it('scores a content-only phrase match without the filename or title bonuses', () => {
    const result = required(
      scoreFile(
        scoreInput({
          path: 'wiki/concepts/other.md',
          content: '# Other\n\nattention appears here and attention again',
        }),
      ),
      'scored file',
    )

    expect(result.score).toBe(41)
    expect(result.title).toBe('Other')
    expect(result.titleMatch).toBe(false)
    expect(result.snippet).toBe('# Other  attention appears here and attention again')
  })

  it('caps the counted phrase occurrences at ten', () => {
    const result = required(
      scoreFile(
        scoreInput({
          path: 'wiki/concepts/other.md',
          content: `# Other\n\n${'needle '.repeat(12)}`,
          tokens: ['needle'],
          queryPhrase: 'needle',
          query: 'needle',
        }),
      ),
      'scored file',
    )

    expect(result.score).toBe(201)
  })

  it('keeps the caller content when includeContent is requested', () => {
    const content = '# Attention\n\nthe attention mechanism'
    const result = required(scoreFile(scoreInput({ includeContent: true })), 'scored file')

    expect(result.content).toBe(content)
  })

  it('returns undefined when nothing matches', () => {
    expect(
      scoreFile(
        scoreInput({
          path: 'wiki/concepts/other.md',
          content: '# Other\n\nnothing relevant here',
          tokens: ['absent'],
          queryPhrase: 'absent',
          query: 'absent',
        }),
      ),
    ).toBeUndefined()
  })

  it('combines the exact-filename and title-phrase bonuses', () => {
    const result = required(
      scoreFile(
        scoreInput({
          path: 'wiki/concepts/attention.md',
          content: 'no heading and no phrase here',
          tokens: [],
          queryPhrase: 'attention',
          query: 'attention',
        }),
      ),
      'scored file',
    )

    expect(result.title).toBe('attention')
    expect(result.score).toBe(250)
    expect(result.titleMatch).toBe(true)
  })

  it('anchors the snippet on the first matching token when the name only matches the title', () => {
    const result = required(
      scoreFile(
        scoreInput({
          path: 'wiki/concepts/attention-notes.md',
          content: `# Foo\n\n${'zebra '.repeat(30)}`,
          tokens: ['zebra'],
          queryPhrase: 'attention',
          query: 'ab',
        }),
      ),
      'scored file',
    )

    expect(result.score).toBe(51)
    expect(result.snippet).toBe(`# Foo  ${'zebra '.repeat(30).slice(0, 85)}...`)
  })

  it('falls back to the raw query for the snippet when no token matches the content', () => {
    const result = required(
      scoreFile(
        scoreInput({
          path: 'wiki/concepts/attention-notes.md',
          content: `# Foo\n\n${'z'.repeat(200)}`,
          tokens: ['q'],
          queryPhrase: 'attention',
          query: 'ab',
        }),
      ),
      'scored file',
    )

    expect(result.score).toBe(50)
    expect(result.snippet).toBe(`# Foo  ${'z'.repeat(75)}...`)
  })

  it('measures snippet offsets in utf8 bytes across code point widths', () => {
    const content = `${'İ'.repeat(10)}needle${'x'.repeat(200)}`

    expect(buildSnippet(content, 'needle')).toBe(`İİİİİİİİİİneedle${'x'.repeat(90)}...`)
  })

  it('windows a snippet whose byte offsets outrun the content', () => {
    expect(buildSnippet(`${'İ'.repeat(100)}x`, 'x')).toBe(`...${'İ'.repeat(80)}x`)
  })

  it('returns no snippet for an empty needle on short content', () => {
    expect(buildSnippet('abcdefgh', '')).toBe('abcdefgh')
  })

  it('counts an empty needle as zero', () => {
    expect(countOccurrences('abc', '')).toBe(0)
  })

  it('skips blank, malformed and unterminated image refs', () => {
    expect(extractImageRefs('![]()').length).toBe(0)
    expect(extractImageRefs('no images ](here)').length).toBe(0)
    expect(extractImageRefs('![XY)Z').length).toBe(0)
    expect(extractImageRefs('![a](xy').length).toBe(0)
    expect(extractImageRefs('x![a](b)').map((ref) => ref.url)).toEqual(['b'])
    expect(
      extractImageRefs('![one](u1) mid ![two](u2) ![three](u3)').map((ref) => [ref.alt, ref.url]),
    ).toEqual([
      ['one', 'u1'],
      ['two', 'u2'],
      ['three', 'u3'],
    ])
  })

  it('strips repeated and non-terminal markdown suffixes from the file stem', () => {
    const repeated = required(
      scoreFile(
        scoreInput({
          path: 'wiki/concepts/x.md.md',
          content: '# X\n\nbody',
          tokens: [],
          queryPhrase: 'x',
          query: 'x',
        }),
      ),
      'scored file',
    )
    const nonTerminal = required(
      scoreFile(
        scoreInput({
          path: 'wiki/concepts/a.md.b',
          content: '# A\n\nbody',
          tokens: [],
          queryPhrase: 'a.md.b',
          query: 'a.md.b',
        }),
      ),
      'scored file',
    )

    expect(repeated.score).toBe(270)
    expect(nonTerminal.score).toBe(250)
  })

  it('returns undefined for an empty query phrase', () => {
    expect(
      scoreFile(scoreInput({ content: '# Foo\n\nbody text', tokens: [], queryPhrase: '', query: '' })),
    ).toBeUndefined()
    expect(
      scoreFile(
        scoreInput({ path: 'wiki/.md', content: 'no heading', tokens: [], queryPhrase: '', query: '' }),
      ),
    ).toBeUndefined()
  })

  it('scores a phrase that only the content carries', () => {
    const result = required(
      scoreFile(
        scoreInput({
          path: 'wiki/concepts/other.md',
          content: '# Foo\n\nxattentiony',
          tokens: [],
          queryPhrase: 'attention',
          query: 'attention',
        }),
      ),
      'scored file',
    )

    expect(result.score).toBe(20)
  })

  it('scores a filename token that never appears in the content', () => {
    const result = required(
      scoreFile(
        scoreInput({
          path: 'wiki/concepts/other.md',
          content: '# Foo\n\nzzz',
          tokens: ['other'],
          queryPhrase: 'absent',
          query: 'absent',
        }),
      ),
      'scored file',
    )

    expect(result.score).toBe(5)
    expect(result.titleMatch).toBe(true)
  })

  it('scores a content token that never appears in the title', () => {
    const result = required(
      scoreFile(
        scoreInput({
          path: 'wiki/concepts/other.md',
          content: '# Foo\n\nzzz',
          tokens: ['zzz'],
          queryPhrase: 'absent',
          query: 'absent',
        }),
      ),
      'scored file',
    )

    expect(result.score).toBe(1)
    expect(result.titleMatch).toBe(false)
  })

  it('weights every matching content token once', () => {
    const result = required(
      scoreFile(
        scoreInput({
          path: 'wiki/concepts/other.md',
          content: '# Foo\n\nalpha beta',
          tokens: ['alpha', 'beta'],
          queryPhrase: 'absent',
          query: 'absent',
        }),
      ),
      'scored file',
    )

    expect(result.score).toBe(2)
  })

  it('anchors the snippet on the query phrase even when another token matches first', () => {
    const content = `# Attention\n\n${'z'.repeat(100)} zebra and attention`
    const result = required(
      scoreFile(
        scoreInput({
          path: 'wiki/concepts/other.md',
          content,
          tokens: ['zebra'],
        }),
      ),
      'scored file',
    )

    expect(result.score).toBe(91)
    expect(result.snippet).toBe(`${content.slice(0, 91).replace(/\n/g, ' ')}...`)
  })
})

const resultOf = (
  path: string,
  over: Partial<{
    vectorScore: number
    content: string
    graphRelatedTo: ReadonlyArray<string>
  }> = {},
): Domain.SearchResult =>
  new Domain.SearchResult({
    path,
    title: path,
    snippet: 's',
    titleMatch: false,
    score: 1,
    images: [],
    ...over,
  })

const pageOf = (
  path: string,
  title: string,
  content: string,
  links: ReadonlyArray<string>,
): GraphPage => ({ path, title, content, links })

describe('fusion core: quotas, aliases and rrf scores', () => {
  it('scales the graph quota with the vector coverage', () => {
    expect(graphResultQuota(0, 0)).toBe(0)
    expect(graphResultQuota(1, 0)).toBe(0)
    expect(graphResultQuota(2, 0)).toBe(1)
    expect(graphResultQuota(7, 0)).toBe(3)
    expect(graphResultQuota(7, 7)).toBe(2)
    expect(graphResultQuota(100, 0)).toBe(30)
    expect(graphResultQuota(100, 50)).toBe(23)
    expect(graphResultQuota(100, 100)).toBe(15)
    expect(graphResultQuota(100, 500)).toBe(15)
  })

  it('normalizes aliases by stripping anchors, extensions and separators', () => {
    expect(normalizeGraphAlias('Title#Section')).toBe('title')
    expect(normalizeGraphAlias(' tool registry.md ')).toBe('tool-registry')
    expect(normalizeGraphAlias('a\\b\\c.md')).toBe('a/b/c')
    expect(normalizeGraphAlias('#Section')).toBe('')
    expect(normalizeGraphAlias('x.md.md')).toBe('x')
    expect(normalizeGraphAlias('A B.md')).toBe('a-b')
    expect(normalizeGraphAlias('a.md.b')).toBe('a.md.b')
  })

  it('sums reciprocal ranks and carries the vector score', () => {
    const scored = applyRrfScores(
      [resultOf('wiki/a.md')],
      new Map([['wiki/a.md', 2]]),
      new Map([['a', 3]]),
      new Map([['a', 0.75]]),
    )

    expect(required(scored[0], 'scored').score).toBe(1 / (RRF_K + 2) + 1 / (RRF_K + 3))
    expect(required(scored[0], 'scored').vectorScore).toBe(0.75)
  })

  it('leaves an unranked result at zero without inventing vector or related fields', () => {
    const scored = applyRrfScores([resultOf('wiki/b.md')], new Map(), new Map(), new Map())
    const only = required(scored[0], 'scored')

    expect(only.score).toBe(0)
    expect(only.vectorScore).toBeUndefined()
    expect(Object.hasOwn(only, 'vectorScore')).toBe(false)
    expect(Object.hasOwn(only, 'graphRelatedTo')).toBe(false)
    expect(Object.hasOwn(only, 'content')).toBe(false)
  })

  it('keeps the result vector score when the fusion map has none', () => {
    const scored = applyRrfScores(
      [resultOf('wiki/c.md', { vectorScore: 0.4, content: 'body', graphRelatedTo: ['x'] })],
      new Map(),
      new Map(),
      new Map(),
    )
    const only = required(scored[0], 'scored')

    expect(only.score).toBe(0)
    expect(only.vectorScore).toBe(0.4)
    expect(only.content).toBe('body')
    expect(only.graphRelatedTo).toEqual(['x'])
  })
})

describe('fusion core: vector snippets and page ranking', () => {
  it('prefixes the heading and collapses newlines in a vector snippet', () => {
    expect(
      buildVectorSnippet({
        id: 'a',
        score: 1,
        chunkText: '  hello   world \n next ',
        headingPath: ' H ',
      }),
    ).toBe('H: hello   world   next')
    expect(
      buildVectorSnippet({ id: 'a', score: 1, chunkText: '   ', headingPath: 'H' }),
    ).toBe('')
    expect(buildVectorSnippet({ id: 'a', score: 1, chunkText: 'x', headingPath: '  ' })).toBe('x')
    expect(buildVectorSnippet({ id: 'a', score: 1, chunkText: 'b', headingPath: 'A' })).toBe('A: b')
  })

  it('truncates a vector snippet at twice the context width', () => {
    const long = 'q'.repeat(SNIPPET_CONTEXT * 2 + 5)

    expect(buildVectorSnippet({ id: 'a', score: 1, chunkText: long, headingPath: '' })).toBe(
      `${'q'.repeat(SNIPPET_CONTEXT * 2)}...`,
    )
    const exact = 'q'.repeat(SNIPPET_CONTEXT * 2)
    expect(buildVectorSnippet({ id: 'a', score: 1, chunkText: exact, headingPath: '' })).toBe(exact)
  })

  it('returns no ranked pages for no chunks', () => {
    expect(rankVectorPages([], 5)).toEqual([])
  })

  it('groups chunks by page and blends the tail score', () => {
    const ranked = rankVectorPages(
      [
        { chunkId: 'a#0', pageId: 'a', chunkIndex: 0, chunkText: 'top a', headingPath: 'H1', score: 0.5 },
        { chunkId: 'a#1', pageId: 'a', chunkIndex: 1, chunkText: 'tail a', headingPath: 'H2', score: 0.4 },
        { chunkId: 'b#0', pageId: 'b', chunkIndex: 0, chunkText: 'only b', headingPath: 'H3', score: 0.3 },
      ],
      10,
    )

    expect(ranked.map((entry) => entry.id)).toEqual(['a', 'b'])
    expect(required(ranked[0], 'a').score).toBeCloseTo(0.62, 12)
    expect(required(ranked[0], 'a').chunkText).toBe('top a')
    expect(required(ranked[0], 'a').headingPath).toBe('H1')
    expect(required(ranked[1], 'b').score).toBeCloseTo(0.3, 12)
  })

  it('caps the tail blend at the remaining headroom', () => {
    const ranked = rankVectorPages(
      [
        { chunkId: 'a#0', pageId: 'a', chunkIndex: 0, chunkText: 'top', headingPath: '', score: 0.95 },
        { chunkId: 'a#1', pageId: 'a', chunkIndex: 1, chunkText: 'tail', headingPath: '', score: 1 },
      ],
      10,
    )

    expect(required(ranked[0], 'a').score).toBeCloseTo(1, 12)
  })

  it('orders equal scores by chunk index and then by page id', () => {
    const ranked = rankVectorPages(
      [
        { chunkId: 'b#0', pageId: 'b', chunkIndex: 0, chunkText: 'b', headingPath: '', score: 0.5 },
        { chunkId: 'a#1', pageId: 'a', chunkIndex: 1, chunkText: 'a tail', headingPath: '', score: 0.5 },
        { chunkId: 'a#0', pageId: 'a', chunkIndex: 0, chunkText: 'a top', headingPath: '', score: 0.5 },
      ],
      10,
    )

    expect(ranked.map((entry) => [entry.id, entry.chunkText])).toEqual([
      ['a', 'a top'],
      ['b', 'b'],
    ])
  })

  it('orders equal page scores by page id', () => {
    const ranked = rankVectorPages(
      [
        { chunkId: 'b#0', pageId: 'b', chunkIndex: 0, chunkText: 'b', headingPath: '', score: 0.5 },
        { chunkId: 'a#0', pageId: 'a', chunkIndex: 0, chunkText: 'a', headingPath: '', score: 0.5 },
      ],
      10,
    )

    expect(ranked.map((entry) => entry.id)).toEqual(['a', 'b'])
  })

  it('slices the ranked pages to the requested topK', () => {
    const ranked = rankVectorPages(
      [
        { chunkId: 'a#0', pageId: 'a', chunkIndex: 0, chunkText: 'a', headingPath: '', score: 0.9 },
        { chunkId: 'b#0', pageId: 'b', chunkIndex: 0, chunkText: 'b', headingPath: '', score: 0.8 },
      ],
      1,
    )

    expect(ranked.map((entry) => entry.id)).toEqual(['a'])
  })
})

describe('fusion core: graph blending', () => {
  const pages = new Map<string, GraphPage>([
    ['wiki/a.md', pageOf('wiki/a.md', 'A', '![i](u)', ['wiki/b.md'])],
    ['wiki/b.md', pageOf('wiki/b.md', 'B', 'body b', ['wiki/a.md'])],
  ])

  it('adds a one-hop neighbour with its relation and score', () => {
    const blended = blendGraphResults([resultOf('wiki/a.md')], pages, 10, 0, true)

    expect(blended.graphHits).toBe(1)
    expect(blended.results.map((entry) => entry.path)).toEqual(['wiki/a.md', 'wiki/b.md'])
    const neighbor = required(blended.results[1], 'neighbor')
    expect(neighbor.title).toBe('B')
    expect(neighbor.snippet).toBe('Graph neighbor of A')
    expect(neighbor.titleMatch).toBe(false)
    expect(neighbor.score).toBeCloseTo(1 / (RRF_K + 1), 12)
    expect(neighbor.graphRelatedTo).toEqual(['A'])
    expect(neighbor.images).toEqual([])
    expect(neighbor.content).toBe('body b')
  })

  it('omits page content when the caller did not ask for it', () => {
    const blended = blendGraphResults([resultOf('wiki/a.md')], pages, 10, 0, false)

    expect(required(blended.results[1], 'neighbor').content).toBeUndefined()
    expect(Object.hasOwn(required(blended.results[1], 'neighbor'), 'content')).toBe(false)
  })

  it('returns the ranked window untouched when there is nothing to blend', () => {
    const ranked = [resultOf('wiki/a.md'), resultOf('wiki/b.md')]

    expect(blendGraphResults([], pages, 5, 0, false)).toEqual({ results: [], graphHits: 0 })
    expect(blendGraphResults(ranked, new Map(), 1, 0, false)).toEqual({
      results: ranked.slice(0, 1),
      graphHits: 0,
    })
  })

  it('returns the ranked window when the quota leaves no room for candidates', () => {
    const blended = blendGraphResults([resultOf('wiki/a.md')], pages, 1, 0, false)

    expect(blended.graphHits).toBe(0)
    expect(blended.results.map((entry) => entry.path)).toEqual(['wiki/a.md'])
  })

  it('annotates a candidate that is already ranked but outside the seed window', () => {
    const graph = new Map<string, GraphPage>([
      ['wiki/a.md', pageOf('wiki/a.md', 'A', '', ['wiki/c.md'])],
      ['wiki/c.md', pageOf('wiki/c.md', 'C', '', ['wiki/a.md'])],
    ])
    const ranked = [
      resultOf('wiki/a.md'),
      resultOf('wiki/b.md'),
      resultOf('wiki/c.md', { vectorScore: 0.5, content: 'c body' }),
    ]

    const blended = blendGraphResults(ranked, graph, 2, 0, true)

    expect(blended.graphHits).toBe(1)
    expect(blended.results.map((entry) => entry.path)).toEqual(['wiki/a.md', 'wiki/c.md'])
    const annotated = required(blended.results[1], 'annotated')
    expect(annotated.graphRelatedTo).toEqual(['A'])
    expect(annotated.vectorScore).toBe(0.5)
    expect(annotated.content).toBe('c body')
    expect(annotated.score).toBe(1)
  })

  it('normalizes paths, skips self links and prefers the shortest alias', () => {
    const graph = new Map<string, GraphPage>([
      ['wiki/one.md', pageOf('wiki/one.md', 'One', '', ['two', 'wiki/one.md', 'missing'])],
      ['wiki/two.md', pageOf('wiki/two.md', 'Two', '', [])],
    ])

    const blended = blendGraphResults([resultOf('wiki/one.md')], graph, 5, 0, false)

    expect(blended.graphHits).toBe(1)
    expect(blended.results.map((entry) => entry.path)).toEqual(['wiki/one.md', 'wiki/two.md'])
    expect(required(blended.results[1], 'neighbor').graphRelatedTo).toEqual(['One'])
  })

  it('keeps one relation title per seed and sorts them', () => {
    const graph = new Map<string, GraphPage>([
      ['wiki/seed-b.md', pageOf('wiki/seed-b.md', 'Seed B', '', ['target'])],
      ['wiki/seed-a.md', pageOf('wiki/seed-a.md', 'Seed A', '', ['target'])],
      ['wiki/target.md', pageOf('wiki/target.md', 'Target', '', [])],
    ])

    const blended = blendGraphResults(
      [resultOf('wiki/seed-b.md'), resultOf('wiki/seed-a.md')],
      graph,
      10,
      0,
      false,
    )

    const neighbor = required(
      blended.results.find((entry) => entry.path === 'wiki/target.md'),
      'neighbor',
    )
    expect(neighbor.graphRelatedTo).toEqual(['Seed A', 'Seed B'])
    expect(neighbor.snippet).toBe('Graph neighbor of Seed A, Seed B')
  })

  it('keeps every outbound link and both directions of an edge', () => {
    const graph = new Map<string, GraphPage>([
      ['wiki/seed.md', pageOf('wiki/seed.md', 'Seed', '', ['wiki/l1.md', 'wiki/l2.md'])],
      ['wiki/l1.md', pageOf('wiki/l1.md', 'L1', '', [])],
      ['wiki/l2.md', pageOf('wiki/l2.md', 'L2', '', [])],
      ['wiki/inbound.md', pageOf('wiki/inbound.md', 'Inbound', '', ['wiki/seed.md'])],
    ])

    const blended = blendGraphResults([resultOf('wiki/seed.md')], graph, 10, 0, false)

    expect(blended.graphHits).toBe(3)
    expect(blended.results.map((entry) => entry.path)).toEqual([
      'wiki/seed.md',
      'wiki/inbound.md',
      'wiki/l1.md',
      'wiki/l2.md',
    ])
  })

  it('scores a candidate reached from the second seed by half a vote', () => {
    const graph = new Map<string, GraphPage>([
      ['wiki/s1.md', pageOf('wiki/s1.md', 'S1', '', [])],
      ['wiki/s2.md', pageOf('wiki/s2.md', 'S2', '', ['wiki/deep.md'])],
      ['wiki/deep.md', pageOf('wiki/deep.md', 'Deep', '', ['wiki/s2.md'])],
    ])

    const blended = blendGraphResults(
      [resultOf('wiki/s1.md'), resultOf('wiki/s2.md')],
      graph,
      10,
      0,
      false,
    )
    const deep = required(
      blended.results.find((entry) => entry.path === 'wiki/deep.md'),
      'deep neighbour',
    )

    expect(deep.score).toBeCloseTo(1 / 2 / (RRF_K + 1), 12)
    expect(deep.snippet).toBe('Graph neighbor of S2')
  })

  it('orders candidates by score and only keeps the quota', () => {
    const graph = new Map<string, GraphPage>([
      ['wiki/s1.md', pageOf('wiki/s1.md', 'S1', '', ['wiki/high.md'])],
      ['wiki/high.md', pageOf('wiki/high.md', 'High', '', ['wiki/s1.md'])],
      ['wiki/s2.md', pageOf('wiki/s2.md', 'S2', '', ['wiki/low.md'])],
      ['wiki/low.md', pageOf('wiki/low.md', 'Low', '', ['wiki/s2.md'])],
    ])

    const blended = blendGraphResults(
      [resultOf('wiki/s1.md'), resultOf('wiki/s2.md')],
      graph,
      10,
      0,
      false,
    )

    expect(blended.results.map((entry) => entry.path)).toEqual([
      'wiki/s1.md',
      'wiki/s2.md',
      'wiki/high.md',
      'wiki/low.md',
    ])
    expect(required(blended.results[2], 'high').score).toBeCloseTo(1 / (RRF_K + 1), 12)
    expect(required(blended.results[3], 'low').score).toBeCloseTo(0.5 / (RRF_K + 1), 12)
  })

  it('orders candidates by descending score regardless of discovery order', () => {
    const graph = new Map<string, GraphPage>([
      ['wiki/s1.md', pageOf('wiki/s1.md', 'S1', '', ['wiki/alpha.md', 'wiki/zeta.md'])],
      ['wiki/s2.md', pageOf('wiki/s2.md', 'S2', '', ['wiki/beta.md', 'wiki/zeta.md'])],
      ['wiki/alpha.md', pageOf('wiki/alpha.md', 'Alpha', '', [])],
      ['wiki/beta.md', pageOf('wiki/beta.md', 'Beta', '', [])],
      ['wiki/zeta.md', pageOf('wiki/zeta.md', 'Zeta', '', [])],
    ])

    const blended = blendGraphResults(
      [resultOf('wiki/s1.md'), resultOf('wiki/s2.md')],
      graph,
      10,
      0,
      false,
    )

    expect(blended.results.map((entry) => entry.path)).toEqual([
      'wiki/s1.md',
      'wiki/s2.md',
      'wiki/zeta.md',
      'wiki/alpha.md',
      'wiki/beta.md',
    ])
    expect(required(blended.results[2], 'zeta').score).toBeCloseTo(1.5 / (RRF_K + 1), 12)
    expect(required(blended.results[3], 'alpha').score).toBeCloseTo(1 / (RRF_K + 1), 12)
    expect(required(blended.results[4], 'beta').score).toBeCloseTo(0.5 / (RRF_K + 1), 12)
  })

  it('does not treat a ranked seed as a graph neighbour', () => {
    const graph = new Map<string, GraphPage>([
      ['wiki/s1.md', pageOf('wiki/s1.md', 'S1', '', ['wiki/s2.md'])],
      ['wiki/s2.md', pageOf('wiki/s2.md', 'S2', '', ['wiki/s1.md'])],
    ])

    const blended = blendGraphResults(
      [resultOf('wiki/s1.md'), resultOf('wiki/s2.md')],
      graph,
      10,
      0,
      false,
    )

    expect(blended.graphHits).toBe(0)
    expect(blended.results.map((entry) => entry.path)).toEqual(['wiki/s1.md', 'wiki/s2.md'])
    expect(blended.results.every((entry) => entry.graphRelatedTo === undefined)).toBe(true)
  })

  it('resolves a colliding alias in code-point order of the page paths', () => {
    const graph = new Map<string, GraphPage>([
      ['wiki/seed.md', pageOf('wiki/seed.md', 'Seed', '', ['wiki/a.md'])],
      ['wiki/a.md', pageOf('wiki/a.md', 'lower', '', [])],
      ['wiki/A.md', pageOf('wiki/A.md', 'upper', '', [])],
    ])

    const blended = blendGraphResults([resultOf('wiki/seed.md')], graph, 10, 0, false)
    const neighbor = required(
      blended.results.find((entry) => entry.path !== 'wiki/seed.md'),
      'neighbor',
    )

    expect(neighbor.path).toBe('wiki/a.md')
  })

  it('keeps only the best candidate when the quota is one', () => {
    const graph = new Map<string, GraphPage>([
      ['wiki/s0.md', pageOf('wiki/s0.md', 'S0', '', ['wiki/c0.md'])],
      ['wiki/c0.md', pageOf('wiki/c0.md', 'C0', '', [])],
      ['wiki/s1.md', pageOf('wiki/s1.md', 'S1', '', ['wiki/c1.md'])],
      ['wiki/c1.md', pageOf('wiki/c1.md', 'C1', '', [])],
      ['wiki/s2.md', pageOf('wiki/s2.md', 'S2', '', ['wiki/c2.md'])],
      ['wiki/c2.md', pageOf('wiki/c2.md', 'C2', '', [])],
    ])

    const blended = blendGraphResults(
      [resultOf('wiki/s0.md'), resultOf('wiki/s1.md'), resultOf('wiki/s2.md')],
      graph,
      2,
      0,
      false,
    )

    expect(blended.results.map((entry) => entry.path)).toEqual(['wiki/s0.md', 'wiki/c0.md'])
  })

  it('annotates a bare ranked candidate without inventing optional fields', () => {
    const graph = new Map<string, GraphPage>([
      ['wiki/a.md', pageOf('wiki/a.md', 'A', '', ['wiki/c.md'])],
      ['wiki/c.md', pageOf('wiki/c.md', 'C', '', ['wiki/a.md'])],
    ])
    const ranked = [
      resultOf('wiki/a.md'),
      resultOf('wiki/b.md'),
      resultOf('wiki/x.md'),
      resultOf('wiki/c.md'),
    ]

    const blended = blendGraphResults(ranked, graph, 3, 0, true)
    const annotated = required(
      blended.results.find((entry) => entry.path === 'wiki/c.md'),
      'annotated',
    )

    expect(annotated.graphRelatedTo).toEqual(['A'])
    expect(Object.hasOwn(annotated, 'vectorScore')).toBe(false)
    expect(Object.hasOwn(annotated, 'content')).toBe(false)
  })

  it('never repeats a candidate inside the ranked window', () => {
    const graph = new Map<string, GraphPage>([
      ['wiki/a.md', pageOf('wiki/a.md', 'A', '', ['wiki/c.md'])],
      ['wiki/c.md', pageOf('wiki/c.md', 'C', '', ['wiki/a.md'])],
    ])
    const ranked = [
      resultOf('wiki/a.md'),
      resultOf('wiki/b.md'),
      resultOf('wiki/x.md'),
      resultOf('wiki/c.md', { vectorScore: 0.5, content: 'c body' }),
    ]

    const blended = blendGraphResults(ranked, graph, 3, 0, true)

    expect(blended.graphHits).toBe(1)
    expect(blended.results.map((entry) => entry.path)).toEqual(['wiki/a.md', 'wiki/b.md', 'wiki/c.md'])
    const annotated = required(blended.results[2], 'annotated')
    expect(annotated.graphRelatedTo).toEqual(['A'])
    expect(annotated.vectorScore).toBe(0.5)
    expect(annotated.content).toBe('c body')
  })
})
