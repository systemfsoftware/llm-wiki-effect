import { DEFAULT_OVERLAP_CHARS, MAX_CHUNK_CHARS } from './spec.js'

export interface MarkdownChunk {
  readonly text: string
  readonly headingPath: string
}

const BOUNDARY = /[\s。！？.!?;；]/

export const charCount = (text: string): number => Array.from(text).length

const lines = (text: string): ReadonlyArray<string> => {
  if (text === '') return []
  const body = text.endsWith('\n') ? text.slice(0, -1) : text
  return body.split('\n')
}

const splitInclusive = (text: string, separator: string): ReadonlyArray<string> => {
  if (text === '') return []
  const parts = text.split(separator)
  return parts.map((part, index) => (index === parts.length - 1 ? part : `${part}${separator}`))
}

const fenceMarker = (line: string): readonly [string, number] | undefined => {
  const trimmed = line.trimStart()
  const marker = trimmed[0]
  if (marker !== '`' && marker !== '~') return undefined
  let width = 0
  while (trimmed[width] === marker) width += 1
  return width >= 3 ? [marker, width] : undefined
}

const parseHeading = (line: string): readonly [number, string] | undefined => {
  let hashes = 0
  while (line[hashes] === '#') hashes += 1
  if (hashes < 1 || hashes > 6) return undefined
  if (line[hashes] !== ' ') return undefined
  const title = line.slice(hashes + 1).trim()
  return title === '' ? undefined : [hashes, title]
}

const findFrontmatterClose = (rest: string): readonly [number, number] | undefined => {
  let offset = 0
  for (const line of splitInclusive(rest, '\n')) {
    if (line.replace(/[\r\n]+$/, '').trim() === '---') return [offset, line.length]
    offset += line.length
  }
  return rest.trim() === '---' ? [0, rest.length] : undefined
}

const leadingFrontmatter = (content: string): string | undefined => {
  if (!content.startsWith('---\n')) return undefined
  const rest = content.slice(4)
  const close = findFrontmatterClose(rest)
  return close === undefined ? undefined : rest.slice(0, close[0])
}

export const stripFrontmatter = (content: string): string => {
  if (!content.startsWith('---\n')) return content
  const rest = content.slice(4)
  const close = findFrontmatterClose(rest)
  if (close === undefined) return content
  const after = rest.slice(close[0] + close[1])
  return after.startsWith('\n') ? after.slice(1) : after
}

export const extractTitle = (content: string, fallback: string): string => {
  const normalized = content.replace(/\r\n/g, '\n')
  const frontmatter = leadingFrontmatter(normalized)
  if (frontmatter !== undefined) {
    for (const line of lines(frontmatter)) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('title:')) continue
      const title = trimmed
        .slice('title:'.length)
        .trim()
        .replace(/^['"]+/, '')
        .replace(/['"]+$/, '')
      if (title !== '') return title
    }
  }
  for (const line of lines(normalized)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('# ')) continue
    const title = trimmed.slice(2).trim()
    return title !== '' ? title : fallback
  }
  return fallback
}

const splitWithOverlap = (
  text: string,
  targetChars: number,
  overlapChars: number,
): ReadonlyArray<string> => {
  const chars = Array.from(text)
  if (chars.length <= targetChars) return [text]
  const out: Array<string> = []
  let start = 0
  while (start < chars.length) {
    const hardEnd = Math.min(start + targetChars, chars.length)
    let end = hardEnd
    if (hardEnd < chars.length) {
      const floor = start + Math.trunc(targetChars / 2)
      for (let index = hardEnd - 1; index >= floor; index -= 1) {
        const char = chars[index]
        if (char !== undefined && BOUNDARY.test(char)) {
          end = index + 1
          break
        }
      }
    }
    const piece = chars.slice(start, end).join('')
    if (piece.trim() !== '') out.push(piece.trim())
    if (end === chars.length) break
    start = Math.max(end - overlapChars, start + 1)
  }
  return out
}

const pushAtomicChunk = (out: Array<string>, chunk: string): void => {
  if (charCount(chunk) <= MAX_CHUNK_CHARS) out.push(chunk)
  else out.push(...splitWithOverlap(chunk, MAX_CHUNK_CHARS, DEFAULT_OVERLAP_CHARS))
}

const splitPreservingAtomicBlocks = (
  text: string,
  targetChars: number,
  overlapChars: number,
): ReadonlyArray<string> => {
  const source = lines(text)
  const out: Array<string> = []
  let normal: Array<string> = []
  let index = 0

  const flushNormal = (): void => {
    if (normal.length === 0) return
    out.push(...splitWithOverlap(normal.join('\n'), targetChars, overlapChars))
    normal = []
  }

  while (index < source.length) {
    const line = source[index] ?? ''
    const fence = fenceMarker(line)
    if (fence !== undefined) {
      flushNormal()
      const start = index
      index += 1
      while (index < source.length) {
        const close = fenceMarker(source[index] ?? '')
        const isClose = close !== undefined && close[0] === fence[0] && close[1] >= fence[1]
        index += 1
        if (isClose) break
      }
      pushAtomicChunk(out, source.slice(start, index).join('\n'))
      continue
    }
    if (line.trimStart().startsWith('|')) {
      flushNormal()
      const start = index
      while (index < source.length && (source[index] ?? '').trimStart().startsWith('|')) {
        index += 1
      }
      pushAtomicChunk(out, source.slice(start, index).join('\n'))
      continue
    }
    normal.push(line)
    index += 1
  }
  flushNormal()
  return out.filter((chunk) => chunk.trim() !== '')
}

export const chunkMarkdown = (
  content: string,
  targetChars: number,
  overlapChars: number,
): ReadonlyArray<MarkdownChunk> => {
  const normalized = content.replace(/\r\n/g, '\n')
  const body = stripFrontmatter(normalized)
  const chunks: Array<MarkdownChunk> = []
  let headingStack: ReadonlyArray<readonly [number, string]> = []
  let headingPath = ''
  let section: Array<string> = []
  let openFence: readonly [string, number] | undefined

  const flush = (): void => {
    const text = section.join('\n').trim()
    if (text !== '') {
      for (const piece of splitPreservingAtomicBlocks(text, targetChars, overlapChars)) {
        chunks.push({ text: piece, headingPath })
      }
    }
    section = []
  }

  for (const line of lines(body)) {
    const fence = fenceMarker(line)
    if (fence !== undefined) {
      if (openFence === undefined) openFence = fence
      else if (openFence[0] === fence[0] && fence[1] >= openFence[1]) openFence = undefined
    }
    const heading = openFence === undefined ? parseHeading(line) : undefined
    if (heading !== undefined) {
      flush()
      const [level, title] = heading
      headingStack = headingStack.filter(([existing]) => existing < level)
      headingStack = [...headingStack, [level, title] as const]
      headingPath = headingStack.map(([lvl, text]) => `${'#'.repeat(lvl)} ${text}`).join(' > ')
    }
    section.push(line)
  }
  flush()
  return chunks
}

export const enrichChunk = (title: string, chunk: MarkdownChunk): string =>
  [title.trim(), chunk.headingPath.trim(), chunk.text.trim()]
    .filter((part) => part !== '')
    .join('\n\n')
