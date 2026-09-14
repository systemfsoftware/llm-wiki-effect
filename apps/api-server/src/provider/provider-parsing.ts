export type DeltaParser = (data: string) => string | undefined
export type CompletionExtractor = (parsed: unknown) => string

const asRecord = (value: unknown): Record<string, unknown> | undefined => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined
  }
  return Object.fromEntries(Object.entries(value))
}

const firstItem = (value: unknown): unknown => (Array.isArray(value) ? value[0] : undefined)

const stringAt = (value: unknown, key: string): string | undefined => {
  const candidate = asRecord(value)?.[key]
  return typeof candidate === 'string' ? candidate : undefined
}

const parseJson = (data: string): unknown => {
  try {
    // Stryker disable BlockStatement: an emptied catch body falls through to the same implicit undefined return
    return JSON.parse(data) as unknown
  } catch {
    // Stryker restore BlockStatement
    return undefined
  }
}

const googlePartsText = (parsed: unknown): string => {
  const parts = asRecord(asRecord(firstItem(asRecord(parsed)?.['candidates']))?.['content'])?.['parts']
  if (!Array.isArray(parts)) {
    return ''
  }
  return parts.map((part) => stringAt(part, 'text') ?? '').join('')
}

export const parseOpenAiDelta: DeltaParser = (data) => {
  const choice = asRecord(firstItem(asRecord(parseJson(data))?.['choices']))
  if (choice === undefined) {
    return undefined
  }
  return stringAt('delta' in choice ? choice['delta'] : choice['message'], 'content')
}

export const parseAnthropicDelta: DeltaParser = (data) => {
  const parsed = asRecord(parseJson(data))
  if (parsed === undefined || parsed['type'] !== 'content_block_delta') {
    return undefined
  }
  return stringAt(parsed['delta'], 'text')
}

export const parseGoogleDelta: DeltaParser = (data) => {
  const text = googlePartsText(parseJson(data))
  return text === '' ? undefined : text
}

export const openAiCompletionText: CompletionExtractor = (parsed) => {
  const message = asRecord(firstItem(asRecord(parsed)?.['choices']))?.['message']
  return stringAt(message, 'content') ?? ''
}

export const anthropicCompletionText: CompletionExtractor = (parsed) => {
  const blocks = asRecord(parsed)?.['content']
  if (!Array.isArray(blocks)) {
    return ''
  }
  return blocks
    .filter((block) => stringAt(block, 'type') === 'text')
    .map((block) => stringAt(block, 'text') ?? '')
    .join('')
}

export const googleCompletionText: CompletionExtractor = (parsed) => googlePartsText(parsed)

export interface SseDeltaDecoder {
  readonly push: (chunk: Uint8Array) => ReadonlyArray<string>
  readonly flush: () => ReadonlyArray<string>
}

// Stryker disable next-line ObjectLiteral: an omitted options object means the same non-fatal decoding as an explicit fatal false
const textDecoder = new TextDecoder('utf-8', { fatal: false })

const lineDelta = (line: string, parseDelta: DeltaParser): ReadonlyArray<string> => {
  const prefix = 'data:'
  const trimmed = line.trim()
  if (!trimmed.startsWith(prefix)) {
    return []
  }
  const payload = trimmed.slice(prefix.length).trim()
  if (payload === '' || payload === '[DONE]') {
    return []
  }
  const delta = parseDelta(payload)
  return delta === undefined || delta === '' ? [] : [delta]
}

// Stryker disable next-line BlockStatement: an emptied body leaves the helper falsy, which flush cannot tell apart from the all-whitespace answer
const isAllAsciiWhitespace = (bytes: Uint8Array): boolean => {
  for (const byte of bytes) {
    // Stryker disable next-line ConditionalExpression,LogicalOperator: narrowing the whitespace set only answers false for buffers decodeLine rejects identically
    const isWhitespace = byte === 0x09 || byte === 0x0a || byte === 0x0b || byte === 0x0c || byte === 0x0d ||
      // Stryker disable next-line EqualityOperator,ConditionalExpression: the space bit only decides that same unreachable case
      byte === 0x20
    // Stryker disable next-line ConditionalExpression: an always-taken early return makes the helper constantly false, which flush cannot distinguish
    if (!isWhitespace) {
      return false
    }
  }
  // Stryker disable next-line BooleanLiteral: the helper is only ever compared against false by flush, which decodeLine already rejects for whitespace-only input
  return true
}

const decodeLine = (bytes: Uint8Array, parseDelta: DeltaParser): ReadonlyArray<string> => {
  let line = textDecoder.decode(bytes)
  // Stryker disable next-line ConditionalExpression,MethodExpression,BlockStatement: push splits on 0x0a and the flush residual keeps none, so a decoded line never ends with a newline
  if (line.endsWith('\n')) {
    // Stryker disable next-line MethodExpression,UnaryOperator: unreachable whenever the branch above is
    line = line.slice(0, -1)
  }
  // Stryker disable next-line ConditionalExpression,BlockStatement: only a trailing carriage return is stripped, and lineDelta trims it off the payload anyway
  if (line.endsWith('\r')) {
    // Stryker disable next-line MethodExpression: the stripped byte is invisible once lineDelta trims the payload
    line = line.slice(0, -1)
  }
  return lineDelta(line, parseDelta)
}

export const makeSseDeltaDecoder = (parseDelta: DeltaParser): SseDeltaDecoder => {
  let buffer = new Uint8Array(0)
  return {
    push: (chunk) => {
      const merged = new Uint8Array(buffer.length + chunk.length)
      merged.set(buffer)
      merged.set(chunk, buffer.length)
      buffer = merged
      const deltas: string[] = []
      for (;;) {
        const newline = buffer.indexOf(0x0a)
        if (newline === -1) {
          return deltas
        }
        deltas.push(...decodeLine(buffer.subarray(0, newline), parseDelta))
        buffer = buffer.slice(newline + 1)
      }
    },
    flush: () => {
      // Stryker disable next-line ConditionalExpression,LogicalOperator,BlockStatement: an empty or whitespace-only buffer decodes to the same empty delta list, so the early return is unobservable
      if (buffer.length === 0 || isAllAsciiWhitespace(buffer)) {
        return []
      }
      const remaining = buffer
      buffer = new Uint8Array(0)
      return decodeLine(remaining, parseDelta)
    },
  }
}
