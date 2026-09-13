import { Result } from 'effect'
import { isRecord } from '../json.js'
import { isGoogleEndpoint } from './spec.js'
import type { EmbeddingSpec } from './spec.js'

export interface EmbeddingHttpRequest {
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: string
}

export interface EmbeddingHttpResponse {
  readonly status: number
  readonly body: string
}

const RESERVED_HEADERS: Readonly<Record<string, true>> = {
  authorization: true,
  'content-type': true,
  host: true,
  'content-length': true,
  origin: true,
  'x-goog-api-key': true,
}

const SAFE_HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

const OVERSIZE_MARKERS: ReadonlyArray<string> = [
  'too long',
  'maximum context',
  'max_tokens',
  'max tokens',
  'context length',
  'token limit',
  'exceeds',
  'input length',
]

export const isSafeExtraHeaderName = (name: string): boolean => SAFE_HEADER_NAME.test(name)

export const isReservedExtraHeaderName = (name: string): boolean => RESERVED_HEADERS[name.trim().toLowerCase()] === true

export const looksLikeOversizeError = (status: number, body: string): boolean => {
  if (status === 413) return true
  const lower = body.toLowerCase()
  return OVERSIZE_MARKERS.some((marker) => lower.includes(marker))
}

const splitOnce = (text: string, separator: string): readonly [string, string | undefined] => {
  const index = text.indexOf(separator)
  return index === -1
    ? [text, undefined]
    : [text.slice(0, index), text.slice(index + separator.length)]
}

const hostOf = (endpoint: string): string => {
  try {
    return new URL(endpoint).hostname.replace(/^\[/, '').replace(/\]$/, '').toLowerCase()
  } catch {
    const trimmed = endpoint.trim()
    const afterScheme = trimmed.includes('://') ? splitOnce(trimmed, '://')[1] ?? '' : trimmed
    return (splitOnce(afterScheme, '/')[0] ?? '').split(/[?#]/)[0]?.toLowerCase() ?? ''
  }
}

export const isVolcengineEndpoint = (endpoint: string): boolean => {
  const host = hostOf(endpoint)
  return host === 'volces.com' || host.endsWith('.volces.com') || host.includes('volcengine')
}

export const isDoubaoMultimodal = (spec: EmbeddingSpec): boolean =>
  spec.model.trim().toLowerCase().includes('doubao-embedding-vision')

export const supportsBatch = (spec: EmbeddingSpec): boolean =>
  !isGoogleEndpoint(spec.endpoint) && !isDoubaoMultimodal(spec)

export const isLocalOrPrivateHttpEndpoint = (endpoint: string): boolean => {
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  const host = url.hostname.replace(/^\[/, '').replace(/\]$/, '').toLowerCase()
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true
  const parts = host.split('.')
  if (parts.length !== 4) return false
  const octets: Array<number> = []
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return false
    const octet = Number(part)
    if (octet > 255) return false
    octets.push(octet)
  }
  const first = octets[0] ?? 0
  const second = octets[1] ?? 0
  return (
    first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    first === 127
  )
}

export const appendEndpointPath = (endpoint: string, targetSuffix: string): string => {
  const suffix = targetSuffix.replace(/^\/+/, '')
  try {
    const url = new URL(endpoint)
    const path = url.pathname.replace(/\/+$/, '')
    const lowerPath = path.toLowerCase()
    const lowerSuffix = `/${suffix.toLowerCase()}`
    if (lowerPath.endsWith(lowerSuffix)) {
      url.pathname = path === '' ? '/' : path
      return url.toString()
    }
    if (lowerPath.endsWith('/embeddings/multimodal') && lowerSuffix === '/embeddings') {
      const base = path.replace(/\/multimodal$/, '')
      url.pathname = base === '' ? '/' : base
      return url.toString()
    }
    if (lowerPath.endsWith('/embeddings') && lowerSuffix === '/embeddings/multimodal') {
      url.pathname = `${path}/multimodal`
      return url.toString()
    }
    url.pathname = `${path}/${suffix}`.replace(/\/{2,}/g, '/')
    return url.toString()
  } catch {
    const [base, query] = splitOnce(endpoint, '?')
    const trimmed = base.replace(/\/+$/, '')
    const lower = trimmed.toLowerCase()
    const lowerSuffix = `/${suffix.toLowerCase()}`
    const next = lower.endsWith(lowerSuffix)
      ? trimmed
      : lower.endsWith('/embeddings/multimodal') && lowerSuffix === '/embeddings'
      ? trimmed.replace(/\/multimodal$/, '')
      : lower.endsWith('/embeddings') && lowerSuffix === '/embeddings/multimodal'
      ? `${trimmed}/multimodal`
      : `${trimmed}/${suffix}`
    return query === undefined ? next : `${next}?${query}`
  }
}

export const stripGoogleApiKeyQuery = (endpoint: string): string => {
  if (!endpoint.includes('?')) return endpoint
  try {
    const url = new URL(endpoint)
    for (const key of [...url.searchParams.keys()]) {
      if (key.toLowerCase() === 'key') url.searchParams.delete(key)
    }
    return url.toString().replace(/\?$/, '')
  } catch {
    const [base, query] = splitOnce(endpoint, '?')
    if (query === undefined) return endpoint
    const kept = query.split('&').filter((pair) => (splitOnce(pair, '=')[0] ?? pair).toLowerCase() !== 'key')
    return kept.length === 0 ? base : `${base}?${kept.join('&')}`
  }
}

export const googleEmbeddingEndpoint = (spec: EmbeddingSpec): string => {
  const raw = stripGoogleApiKeyQuery(spec.endpoint.trim()).replace(/\/+$/, '')
  const lower = raw.toLowerCase()
  if (lower.includes(':batchembedcontents')) {
    return raw
      .replace(/:batchEmbedContents/g, ':embedContent')
      .replace(/:batchembedcontents/g, ':embedContent')
  }
  if (lower.includes(':embedcontent')) return raw
  const model = spec.model.trim().replace(/^(?:models\/)+/, '')
  return lower.includes('/models/') ? `${raw}:embedContent` : `${raw}/models/${model}:embedContent`
}

export const volcengineEmbeddingEndpoint = (spec: EmbeddingSpec): string => {
  const raw = spec.endpoint.trim()
  if (!isVolcengineEndpoint(raw)) return raw
  return appendEndpointPath(raw, isDoubaoMultimodal(spec) ? '/embeddings/multimodal' : '/embeddings')
}

const googleBody = (spec: EmbeddingSpec, text: string): Record<string, unknown> => {
  const model = spec.model.trim()
  const body: Record<string, unknown> = {
    model: model.startsWith('models/') ? model : `models/${model}`,
    content: { parts: [{ text }] },
  }
  const dimension = spec.outputDimensionality
  if (dimension !== undefined && Number.isFinite(dimension) && dimension >= 1) {
    body['output_dimensionality'] = Math.floor(dimension)
  }
  return body
}

const doubaoBody = (spec: EmbeddingSpec, text: string): Record<string, unknown> => ({
  model: spec.model,
  encoding_format: 'float',
  input: [{ type: 'text', text }],
})

const buildHeaders = (
  url: string,
  spec: EmbeddingSpec,
  google: boolean,
): Record<string, string> => {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (isLocalOrPrivateHttpEndpoint(url)) headers['Origin'] = 'http://localhost'
  const apiKey = spec.apiKey.trim()
  if (apiKey !== '') {
    if (google) headers['x-goog-api-key'] = apiKey
    else headers['Authorization'] = `Bearer ${apiKey}`
  }
  for (const [name, value] of Object.entries(spec.extraHeaders)) {
    const header = name.trim()
    const trimmed = value.trim()
    if (header === '' || trimmed === '') continue
    if (!isSafeExtraHeaderName(header) || isReservedExtraHeaderName(header)) continue
    headers[header] = trimmed
  }
  return headers
}

export const singleEmbeddingRequest = (
  spec: EmbeddingSpec,
  text: string,
): EmbeddingHttpRequest => {
  const google = isGoogleEndpoint(spec.endpoint)
  const url = google ? googleEmbeddingEndpoint(spec) : volcengineEmbeddingEndpoint(spec)
  const body = google
    ? googleBody(spec, text)
    : isDoubaoMultimodal(spec)
    ? doubaoBody(spec, text)
    : { model: spec.model, input: text }
  return { url, headers: buildHeaders(url, spec, google), body: JSON.stringify(body) }
}

export const batchEmbeddingRequest = (
  spec: EmbeddingSpec,
  texts: ReadonlyArray<string>,
): EmbeddingHttpRequest => {
  const url = volcengineEmbeddingEndpoint(spec)
  return {
    url,
    headers: buildHeaders(url, spec, false),
    body: JSON.stringify({ model: spec.model, input: texts }),
  }
}

const vectorOf = (
  value: unknown,
  label: string,
): Result.Result<ReadonlyArray<number>, string> => {
  if (!Array.isArray(value)) return Result.fail(`${label} missing vector`)
  const out: Array<number> = []
  for (const entry of value) {
    if (typeof entry !== 'number' || !Number.isFinite(entry)) {
      return Result.fail(`${label} contains non-number values`)
    }
    out.push(entry)
  }
  if (out.length === 0) return Result.fail(`${label} vector is empty`)
  return Result.succeed(out)
}

export const parseEmbeddingValues = (
  data: unknown,
  google: boolean,
  doubaoMultimodal: boolean,
): Result.Result<ReadonlyArray<number>, string> => {
  const record = isRecord(data) ? data : {}
  const value = google
    ? isRecord(record['embedding'])
      ? record['embedding']['values']
      : undefined
    : doubaoMultimodal
    ? isRecord(record['data'])
      ? record['data']['embedding']
      : undefined
    : Array.isArray(record['data'])
    ? isRecord(record['data'][0])
      ? record['data'][0]['embedding']
      : undefined
    : undefined
  return vectorOf(value, 'Embedding response')
}

export const parseEmbeddingBatchValues = (
  data: unknown,
  expected: number,
): Result.Result<ReadonlyArray<ReadonlyArray<number>>, string> => {
  const entries = isRecord(data) && Array.isArray(data['data']) ? data['data'] : undefined
  if (entries === undefined) return Result.fail('Embedding batch response missing data array')
  if (entries.length !== expected) {
    return Result.fail(`Embedding batch returned ${entries.length} vectors for ${expected} inputs`)
  }
  const indexed: Array<readonly [number, ReadonlyArray<number>]> = []
  for (let position = 0; position < entries.length; position += 1) {
    const entry = entries[position]
    if (!isRecord(entry)) return Result.fail('Embedding batch response missing vector')
    const rawIndex = entry['index']
    const index = typeof rawIndex === 'number' && Number.isInteger(rawIndex) ? rawIndex : position
    if (index < 0 || index >= expected) {
      return Result.fail('Embedding batch response contains an out-of-range index')
    }
    const vector = vectorOf(entry['embedding'], 'Embedding batch response')
    if (Result.isFailure(vector)) return Result.fail(vector.failure)
    indexed.push([index, vector.success])
  }
  indexed.sort(([left], [right]) => left - right)
  for (let position = 1; position < indexed.length; position += 1) {
    const previous = indexed[position - 1]
    const current = indexed[position]
    if (previous !== undefined && current !== undefined && previous[0] === current[0]) {
      return Result.fail('Embedding batch response contains duplicate indexes')
    }
  }
  const dimension = indexed[0]?.[1].length ?? 0
  if (indexed.some(([, vector]) => vector.length !== dimension)) {
    return Result.fail('Embedding batch response contains inconsistent vector dimensions')
  }
  return Result.succeed(indexed.map(([, vector]) => vector))
}

export const halveText = (text: string): string | undefined => {
  const chars = Array.from(text)
  if (chars.length <= 1) return undefined
  return chars.slice(0, Math.max(Math.trunc(chars.length / 2), 1)).join('')
}
