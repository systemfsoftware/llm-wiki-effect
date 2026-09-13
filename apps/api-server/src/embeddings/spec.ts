import { Duration } from 'effect'
import { Errors } from 'llm-wiki-protocol'
import type { ConfigValues } from '../config/Config.js'
import { isGoogleEmbeddingEndpoint } from '../config/Config.js'

export const DEFAULT_CHUNK_CHARS = 1_000
export const DEFAULT_OVERLAP_CHARS = 200
export const MIN_CHUNK_CHARS = 64
export const MAX_CHUNK_CHARS = 32_000
export const MAX_PAGE_BYTES = 2 * 1024 * 1024
export const MAX_PAGE_CHUNKS = 512
export const EMBEDDING_BATCH_SIZE = 64
export const MAX_PAGE_ID_CHARS = 256

export const CHUNK_TABLE = 'wiki_chunks_v2'
export const LANCEDB_DIR = '.llm-wiki/lancedb'
export const REVISION_DIR = '.llm-wiki/embedding-revisions'
export const AGGREGATE_PAGE_STEMS: ReadonlyArray<string> = ['index', 'log', 'overview']

export interface EmbeddingTimeouts {
  readonly request: Duration.Duration
  readonly providerPhase: Duration.Duration
}

export const DEFAULT_EMBEDDING_TIMEOUTS: EmbeddingTimeouts = {
  request: Duration.seconds(8),
  providerPhase: Duration.seconds(300),
}

const PROVIDER_ENDPOINTS: Readonly<Record<string, string>> = {
  openai: 'https://api.openai.com/v1/embeddings',
  google: 'https://generativelanguage.googleapis.com/v1beta',
}

export interface EmbeddingSpec {
  readonly provider: string
  readonly model: string
  readonly endpoint: string
  readonly apiKey: string
  readonly outputDimensionality: number | undefined
  readonly extraHeaders: Readonly<Record<string, string>>
  readonly maxChunkChars: number
  readonly overlapChunkChars: number
  readonly enabled: boolean
}

export const embeddingSpecFrom = (values: ConfigValues): EmbeddingSpec => {
  const provider = values.embedding.provider.trim()
  const credential = values.providerCredentials[provider]
  const configured = (credential?.baseUrl ?? '').trim()
  const endpoint = configured !== '' ? configured : PROVIDER_ENDPOINTS[provider.toLowerCase()] ?? ''
  const model = values.embedding.model.trim()
  return {
    provider,
    model,
    endpoint,
    apiKey: (credential?.apiKey ?? '').trim(),
    outputDimensionality: values.embedding.dimensions,
    extraHeaders: {},
    maxChunkChars: DEFAULT_CHUNK_CHARS,
    overlapChunkChars: DEFAULT_OVERLAP_CHARS,
    enabled: model !== '' && endpoint !== '',
  }
}

export const embeddingDisabled = (): Errors.EmbedError =>
  new Errors.EmbedError({
    kind: 'InvalidRequest',
    message: 'Embedding is not enabled or no embedding model is configured',
  })

export const isGoogleEndpoint = (endpoint: string): boolean => isGoogleEmbeddingEndpoint(endpoint)

export const clampChunkChars = (value: number): number =>
  Math.min(Math.max(Math.trunc(value), MIN_CHUNK_CHARS), MAX_CHUNK_CHARS)

export const clampOverlapChars = (overlap: number, chunkChars: number): number =>
  Math.min(Math.trunc(overlap), Math.trunc(chunkChars / 2))
