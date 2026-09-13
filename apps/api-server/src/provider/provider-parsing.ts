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
    return JSON.parse(data) as unknown
  } catch {
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

const isAllAsciiWhitespace = (bytes: Uint8Array): boolean => {
  for (const byte of bytes) {
    const isWhitespace = byte === 0x09 || byte === 0x0a || byte === 0x0b || byte === 0x0c || byte === 0x0d ||
      byte === 0x20
    if (!isWhitespace) {
      return false
    }
  }
  return true
}

const decodeLine = (bytes: Uint8Array, parseDelta: DeltaParser): ReadonlyArray<string> => {
  let line = textDecoder.decode(bytes)
  if (line.endsWith('\n')) {
    line = line.slice(0, -1)
  }
  if (line.endsWith('\r')) {
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
      if (buffer.length === 0 || isAllAsciiWhitespace(buffer)) {
        return []
      }
      const remaining = buffer
      buffer = new Uint8Array(0)
      return decodeLine(remaining, parseDelta)
    },
  }
}
