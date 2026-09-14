import { relay } from '@/lib/api-relay'
import { normalizePath } from '@/lib/path-utils'

export interface ImageRef {
  url: string
  alt: string
}

export interface SearchResult {
  path: string
  title: string
  snippet: string
  titleMatch: boolean
  score: number
  vectorScore?: number | undefined
  images: ImageRef[]
}

const STOP_WORDS: Record<string, true> = {
  的: true,
  是: true,
  了: true,
  什么: true,
  在: true,
  有: true,
  和: true,
  与: true,
  对: true,
  从: true,
  the: true,
  is: true,
  a: true,
  an: true,
  what: true,
  how: true,
  are: true,
  was: true,
  were: true,
  do: true,
  does: true,
  did: true,
  be: true,
  been: true,
  being: true,
  have: true,
  has: true,
  had: true,
  it: true,
  its: true,
  in: true,
  on: true,
  at: true,
  to: true,
  for: true,
  of: true,
  with: true,
  by: true,
  this: true,
  that: true,
  these: true,
  those: true,
}

export function tokenizeQuery(query: string): string[] {
  const rawTokens = query
    .toLowerCase()
    .split(/[\s,，。！？、；：""''（）()\-_/\\·~～…]+/)
    .filter((t) => t.length > 1)
    .filter((t) => STOP_WORDS[t] !== true)

  const tokens: string[] = []
  for (const token of rawTokens) {
    const hasCJK = /[\u4e00-\u9fff\u3400-\u4dbf]/.test(token)
    if (hasCJK && token.length > 2) {
      const chars = Array.from(token)
      for (let i = 0; i < chars.length - 1; i++) {
        const first = chars[i]
        const second = chars[i + 1]
        if (first === undefined || second === undefined) continue
        tokens.push(first + second)
      }
      for (const ch of chars) {
        if (STOP_WORDS[ch] !== true) tokens.push(ch)
      }
      tokens.push(token)
    } else {
      tokens.push(token)
    }
  }
  return [...new Set(tokens)]
}

export async function searchWiki(
  projectPath: string,
  query: string,
): Promise<SearchResult[]> {
  if (!query.trim()) return []
  const pp = normalizePath(projectPath)
  const response = await relay().search({
    projectId: pp,
    query,
    topK: 20,
    includeContent: false,
  })

  return response.results.map((result) => ({
    path: `${pp}/${normalizePath(result.path).replace(/^\/+/, '')}`,
    title: result.title,
    snippet: result.snippet,
    titleMatch: result.titleMatch,
    score: result.score,
    ...(result.vectorScore === undefined ? {} : { vectorScore: result.vectorScore }),
    images: result.images.map((image) => ({ url: image.url, alt: image.alt })),
  }))
}
