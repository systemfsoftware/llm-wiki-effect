/**
 * Fusion and graph blending for the search service.
 *
 * Ported from `apply_rrf_scores` / `graph_result_quota` / `blend_graph_results`
 * / `search_mode` / `normalize_graph_alias` / `search_by_embedding` (the pure
 * grouping half) and `build_vector_snippet` in
 * apps/desktop/src-tauri/src/commands/search.rs.
 */
import { Domain } from 'llm-wiki-protocol'
import { fileStem, normalizePath } from './paths.js'
import { compareCodePoints } from './query.js'
import { extractImageRefs, RRF_K, SNIPPET_CONTEXT } from './scoring.js'

export const MIN_GRAPH_RESULT_RATIO = 0.15
export const MAX_GRAPH_RESULT_RATIO = 0.30
export const MAX_GRAPH_SEEDS = 20

export interface ChunkRow {
  readonly chunkId: string
  readonly pageId: string
  readonly chunkIndex: number
  readonly chunkText: string
  readonly headingPath: string
  readonly score: number
}

export interface PageVectorResult {
  readonly id: string
  readonly score: number
  readonly chunkText: string
  readonly headingPath: string
}

export interface GraphPage {
  readonly path: string
  readonly title: string
  readonly content: string
  readonly links: ReadonlyArray<string>
}

export interface BlendResult {
  readonly results: ReadonlyArray<Domain.SearchResult>
  readonly graphHits: number
}

export const searchMode = (
  tokenRankEmpty: boolean,
  vectorHits: number,
  graphHits: number,
): string => {
  if (graphHits > 0) return 'hybrid'
  if (vectorHits === 0) return 'keyword'
  return tokenRankEmpty ? 'vector' : 'hybrid'
}

export const graphResultQuota = (limit: number, vectorHits: number): number => {
  if (limit < 2) return 0
  const vectorCoverage = Math.min(vectorHits, limit) / limit
  const ratio = MAX_GRAPH_RESULT_RATIO - (MAX_GRAPH_RESULT_RATIO - MIN_GRAPH_RESULT_RATIO) * vectorCoverage
  return Math.min(Math.max(Math.ceil(limit * ratio), 1), limit - 1)
}

export const normalizeGraphAlias = (value: string): string => {
  const head = value.split('#')[0] ?? ''
  return head
    .trim()
    .replace(/(?:\.md)+$/, '')
    .replace(/\\/g, '/')
    .replace(/ /g, '-')
    .toLowerCase()
}

export const applyRrfScores = (
  results: ReadonlyArray<Domain.SearchResult>,
  tokenRank: ReadonlyMap<string, number>,
  vectorRank: ReadonlyMap<string, number>,
  vectorScore: ReadonlyMap<string, number>,
): ReadonlyArray<Domain.SearchResult> =>
  results.map((result) => {
    const token = tokenRank.get(normalizePath(result.path))
    const vector = vectorRank.get(fileStem(result.path))
    let rrf = 0
    if (token !== undefined) rrf += 1 / (RRF_K + token)
    if (vector !== undefined) rrf += 1 / (RRF_K + vector)
    const score = vectorScore.get(fileStem(result.path)) ?? result.vectorScore
    return new Domain.SearchResult({
      path: result.path,
      title: result.title,
      snippet: result.snippet,
      titleMatch: result.titleMatch,
      score: rrf,
      images: result.images,
      ...(score !== undefined ? { vectorScore: score } : {}),
      ...(result.content !== undefined ? { content: result.content } : {}),
      ...(result.graphRelatedTo !== undefined ? { graphRelatedTo: result.graphRelatedTo } : {}),
    })
  })

export const buildVectorSnippet = (result: PageVectorResult): string => {
  const chars = Array.from(result.chunkText.trim().replace(/\n/g, ' '))
  if (chars.length === 0) return ''
  let text = chars.length > SNIPPET_CONTEXT * 2
    ? `${chars.slice(0, SNIPPET_CONTEXT * 2).join('')}...`
    : chars.join('')
  const heading = result.headingPath.trim()
  if (heading !== '') text = `${heading}: ${text}`
  return text
}

export const rankVectorPages = (
  chunks: ReadonlyArray<ChunkRow>,
  topK: number,
): ReadonlyArray<PageVectorResult> => {
  if (chunks.length === 0) return []
  const byPage = new Map<string, Array<ChunkRow>>()
  for (const chunk of chunks) {
    const group = byPage.get(chunk.pageId)
    if (group === undefined) byPage.set(chunk.pageId, [chunk])
    else group.push(chunk)
  }
  const ranked: Array<PageVectorResult> = []
  for (const [id, group] of byPage) {
    const sorted = [...group].sort((left, right) => right.score - left.score || left.chunkIndex - right.chunkIndex)
    const top = sorted[0]
    if (top === undefined) continue
    const tail = sorted.slice(1).reduce((sum, chunk) => sum + chunk.score, 0)
    const blended = top.score + Math.min(tail * 0.3, Math.max(1 - top.score, 0))
    ranked.push({
      id,
      score: blended,
      chunkText: top.chunkText,
      headingPath: top.headingPath,
    })
  }
  ranked.sort((left, right) => right.score - left.score || compareCodePoints(left.id, right.id))
  return ranked.slice(0, topK)
}

const addEdge = (adjacency: Map<string, Set<string>>, from: string, to: string): void => {
  const neighbors = adjacency.get(from)
  if (neighbors === undefined) adjacency.set(from, new Set([to]))
  else neighbors.add(to)
}

const withRelated = (
  result: Domain.SearchResult,
  relatedTitles: ReadonlyArray<string>,
): Domain.SearchResult =>
  new Domain.SearchResult({
    path: result.path,
    title: result.title,
    snippet: result.snippet,
    titleMatch: result.titleMatch,
    score: result.score,
    images: result.images,
    ...(result.vectorScore !== undefined ? { vectorScore: result.vectorScore } : {}),
    ...(result.content !== undefined ? { content: result.content } : {}),
    ...(relatedTitles.length > 0 ? { graphRelatedTo: relatedTitles } : {}),
  })

export const blendGraphResults = (
  rankedResults: ReadonlyArray<Domain.SearchResult>,
  pages: ReadonlyMap<string, GraphPage>,
  limit: number,
  vectorHits: number,
  includeContent: boolean,
): BlendResult => {
  if (rankedResults.length === 0 || pages.size === 0) {
    return { results: rankedResults.slice(0, limit), graphHits: 0 }
  }

  const sortedPages = [...pages.entries()].sort(([left], [right]) => compareCodePoints(left, right))

  const aliases = new Map<string, string>()
  for (const [normalizedPath, page] of sortedPages) {
    const wikiRelative = page.path.startsWith('wiki/') ? page.path.slice('wiki/'.length) : page.path
    const stem = fileStem(page.path)
    for (const alias of [page.path, wikiRelative, stem, page.title]) {
      aliases.set(normalizeGraphAlias(alias), normalizedPath)
    }
  }

  const adjacency = new Map<string, Set<string>>()
  for (const [source, page] of sortedPages) {
    for (const link of page.links) {
      const target = aliases.get(normalizeGraphAlias(link))
      if (target === undefined || target === source) continue
      addEdge(adjacency, source, target)
      addEdge(adjacency, target, source)
    }
  }

  const seedPaths = rankedResults
    .slice(0, Math.min(limit, MAX_GRAPH_SEEDS))
    .map((result) => normalizePath(result.path))
  const seedSet = new Set(seedPaths)
  const candidateScores = new Map<string, number>()
  const candidateSeeds = new Map<string, Set<string>>()
  for (let rank = 0; rank < seedPaths.length; rank += 1) {
    const seed = seedPaths[rank]
    if (seed === undefined) continue
    const neighbors = adjacency.get(seed)
    if (neighbors === undefined) continue
    const seedPage = pages.get(seed)
    for (const neighbor of [...neighbors].sort(compareCodePoints)) {
      if (seedSet.has(neighbor)) continue
      candidateScores.set(neighbor, (candidateScores.get(neighbor) ?? 0) + 1 / (rank + 1))
      if (seedPage !== undefined) {
        const seeds = candidateSeeds.get(neighbor)
        if (seeds === undefined) candidateSeeds.set(neighbor, new Set([seedPage.title]))
        else seeds.add(seedPage.title)
      }
    }
  }

  const candidates = [...candidateScores.entries()]
    .sort(([pathA, scoreA], [pathB, scoreB]) => scoreB - scoreA || compareCodePoints(pathA, pathB))
    .slice(0, graphResultQuota(limit, vectorHits))
  if (candidates.length === 0) {
    return { results: rankedResults.slice(0, limit), graphHits: 0 }
  }

  const selected = new Set(candidates.map(([path]) => path))
  const existing = new Map<string, Domain.SearchResult>()
  const rankedPaths: Array<string> = []
  for (const result of rankedResults) {
    const path = normalizePath(result.path)
    rankedPaths.push(path)
    existing.set(path, result)
  }

  const graphCount = candidates.length
  const baseLimit = Math.max(limit - graphCount, 0)
  const baseResults: Array<Domain.SearchResult> = rankedPaths
    .filter((path) => !selected.has(path))
    .flatMap((path) => {
      const result = existing.get(path)
      return result === undefined ? [] : [result]
    })
    .slice(0, baseLimit)

  for (const [path, graphScore] of candidates) {
    const relatedTitles = [...(candidateSeeds.get(path) ?? new Set<string>())].sort(compareCodePoints)
    const existingResult = existing.get(path)
    if (existingResult !== undefined) {
      baseResults.push(withRelated(existingResult, relatedTitles))
      continue
    }
    const page = pages.get(path)
    if (page === undefined) continue
    baseResults.push(
      new Domain.SearchResult({
        path: page.path,
        title: page.title,
        snippet: `Graph neighbor of ${relatedTitles.join(', ')}`,
        titleMatch: false,
        score: graphScore / (RRF_K + 1),
        images: extractImageRefs(page.content),
        ...(includeContent ? { content: page.content } : {}),
        ...(relatedTitles.length > 0 ? { graphRelatedTo: relatedTitles } : {}),
      }),
    )
  }

  return { results: baseResults, graphHits: graphCount }
}
