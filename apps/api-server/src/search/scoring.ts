/**
 * Token scoring, snippets and image refs for the search service.
 *
 * Ported from `score_file` / `build_snippet` / `extract_image_refs` and the
 * weighting constants in apps/desktop/src-tauri/src/commands/search.rs. Snippet
 * windowing reproduces the Rust byte-index arithmetic (the match offset is
 * found in the lowercased content as a UTF-8 byte offset, then mapped back to
 * the first original code point at or after it) so mixed-width scripts cut on
 * the same boundaries.
 */
import { Domain } from 'llm-wiki-protocol'
import { extractTitle } from '../graph/index.js'
import { isQuerySeparator } from './query.js'

export const DEFAULT_TOP_K = 10
export const MAX_RESULTS = 50
export const RRF_K = 60
export const FILENAME_EXACT_BONUS = 200
export const PHRASE_IN_TITLE_BONUS = 50
export const PHRASE_IN_CONTENT_PER_OCC = 20
export const MAX_PHRASE_OCC_COUNTED = 10
export const TITLE_TOKEN_WEIGHT = 5
export const CONTENT_TOKEN_WEIGHT = 1
export const SNIPPET_CONTEXT = 80
export const MAX_SEARCH_FILES = 10_000

const utf8Length = (codePoint: number): number =>
  // Stryker disable next-line ConditionalExpression,EqualityOperator
  codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4

const utf8ByteOffsetAt = (text: string, utf16Index: number): number => {
  let utf16 = 0
  let bytes = 0
  for (const char of text) {
    if (utf16 >= utf16Index) break
    utf16 += char.length
    bytes += utf8Length(char.codePointAt(0) ?? 0)
  }
  return bytes
}

export const trimQueryPunctuation = (value: string): string => {
  let start = 0
  let end = value.length
  // Stryker disable next-line EqualityOperator
  while (start < end) {
    const head = value[start]
    // Stryker disable next-line ConditionalExpression
    if (head === undefined || !isQuerySeparator(head)) break
    start += 1
  }
  // Stryker disable next-line EqualityOperator
  while (end > start) {
    const tail = value[end - 1]
    // Stryker disable next-line ConditionalExpression
    if (tail === undefined || !isQuerySeparator(tail)) break
    end -= 1
  }
  return value.slice(start, end)
}

export const countOccurrences = (haystack: string, needle: string): number => {
  if (needle === '') return 0
  let count = 0
  let index = haystack.indexOf(needle)
  while (index !== -1) {
    count += 1
    index = haystack.indexOf(needle, index + needle.length)
  }
  return count
}

export const tokenMatchScore = (text: string, tokens: ReadonlyArray<string>): number => {
  const lower = text.toLowerCase()
  return tokens.filter((token) => lower.includes(token)).length
}

export const extractImageRefs = (content: string): ReadonlyArray<Domain.SearchImageRef> => {
  const out: Array<Domain.SearchImageRef> = []
  const seen = new Set<string>()
  let rest = content
  for (;;) {
    const start = rest.indexOf('![')
    if (start === -1) break
    rest = rest.slice(start + 2)
    const altEnd = rest.indexOf('](')
    if (altEnd === -1) break
    const alt = rest.slice(0, altEnd)
    rest = rest.slice(altEnd + 2)
    const urlEnd = rest.indexOf(')')
    if (urlEnd === -1) break
    const url = rest.slice(0, urlEnd)
    // Stryker disable next-line MethodExpression
    if (url.trim() !== '' && !/\s/.test(url) && !seen.has(url)) {
      seen.add(url)
      out.push(new Domain.SearchImageRef({ url, alt }))
    }
    // Stryker disable next-line ArithmeticOperator,MethodExpression
    rest = rest.slice(urlEnd + 1)
  }
  return out
}

export const buildSnippet = (content: string, query: string): string => {
  const chars = Array.from(content)
  const charCount = chars.length
  // Stryker disable next-line ConditionalExpression
  if (charCount === 0) return ''

  const byteOffsets: Array<number> = [0]
  for (const char of chars) {
    const previous = byteOffsets[byteOffsets.length - 1]
    byteOffsets.push((previous ?? 0) + utf8Length(char.codePointAt(0) ?? 0))
  }

  const lower = content.toLowerCase()
  const needle = query.toLowerCase()
  // Stryker disable next-line ConditionalExpression,StringLiteral
  const lowerIndex = needle === '' ? 0 : lower.indexOf(needle)
  // Stryker disable next-line ConditionalExpression,EqualityOperator
  const matchByte = lowerIndex <= 0 ? 0 : utf8ByteOffsetAt(lower, lowerIndex)

  let matchChar = -1
  // Stryker disable next-line EqualityOperator
  for (let index = 0; index < charCount; index += 1) {
    const offset = byteOffsets[index]
    // Stryker disable next-line ConditionalExpression
    if (offset !== undefined && offset >= matchByte) {
      matchChar = index
      break
    }
  }
  if (matchChar === -1) matchChar = Math.max(charCount - 1, 0)

  const queryChars = Math.max(Array.from(query).length, 1)
  const startChar = Math.max(matchChar - SNIPPET_CONTEXT, 0)
  const endChar = Math.min(matchChar + queryChars + SNIPPET_CONTEXT, charCount)

  let snippet = chars.slice(startChar, endChar).join('').replace(/\n/g, ' ')
  if (startChar > 0) snippet = `...${snippet}`
  if (endChar < charCount) snippet = `${snippet}...`
  return snippet
}

export interface ScoreFileInput {
  readonly path: string
  readonly content: string
  readonly tokens: ReadonlyArray<string>
  readonly queryPhrase: string
  readonly query: string
  readonly includeContent: boolean
}

export const scoreFile = (input: ScoreFileInput): Domain.SearchResult | undefined => {
  const { path, content, tokens, queryPhrase, query, includeContent } = input
  const fileName = path.slice(path.lastIndexOf('/') + 1)
  const title = extractTitle(content, fileName)
  const titleText = `${title} ${fileName}`
  const titleLower = titleText.toLowerCase()
  const contentLower = content.toLowerCase()
  const stem = fileName.replace(/(?:\.md)+$/, '').toLowerCase()

  const filenameExact = queryPhrase !== '' && stem === queryPhrase
  const titleHasPhrase = queryPhrase !== '' && titleLower.includes(queryPhrase)
  const contentPhraseOcc = Math.min(
    countOccurrences(contentLower, queryPhrase),
    MAX_PHRASE_OCC_COUNTED,
  )
  const titleTokenScore = tokenMatchScore(titleText, tokens)
  const contentTokenScore = tokenMatchScore(content, tokens)

  if (
    !filenameExact &&
    !titleHasPhrase &&
    contentPhraseOcc === 0 &&
    titleTokenScore === 0 &&
    contentTokenScore === 0
  ) {
    return undefined
  }

  const score = (filenameExact ? FILENAME_EXACT_BONUS : 0) +
    (titleHasPhrase ? PHRASE_IN_TITLE_BONUS : 0) +
    contentPhraseOcc * PHRASE_IN_CONTENT_PER_OCC +
    titleTokenScore * TITLE_TOKEN_WEIGHT +
    // Stryker disable next-line ArithmeticOperator
    contentTokenScore * CONTENT_TOKEN_WEIGHT

  const snippetAnchor = contentPhraseOcc > 0
    ? queryPhrase
    : tokens.find((token) => contentLower.includes(token)) ?? query

  return new Domain.SearchResult({
    path,
    title,
    snippet: buildSnippet(content, snippetAnchor),
    titleMatch: titleTokenScore > 0 || titleHasPhrase,
    score,
    images: extractImageRefs(content),
    ...(includeContent ? { content } : {}),
  })
}
