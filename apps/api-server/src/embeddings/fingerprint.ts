import { createHash } from 'node:crypto'
import { isRecord } from '../json.js'
import type { EmbeddingSpec } from './spec.js'

// Stryker disable next-line StringLiteral
export const sha256Hex = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  // Stryker disable next-line ConditionalExpression,StringLiteral
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const entries = Object.entries(isRecord(value) ? value : {}).sort(([left], [right]) =>
    // Stryker disable next-line ConditionalExpression,EqualityOperator
    left < right ? -1 : left > right ? 1 : 0
  )
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`
}

export const contentRevision = (content: string): string => `sha256:${sha256Hex(content)}`

export const embeddingFingerprint = (revision: string, spec: EmbeddingSpec): string =>
  `sha256:${
    sha256Hex(
      canonicalJson({
        revision,
        endpoint: spec.endpoint.trim(),
        model: spec.model.trim(),
        outputDimensionality: spec.outputDimensionality ?? null,
        extraHeaders: Object.keys(spec.extraHeaders).length === 0 ? null : spec.extraHeaders,
        maxChunkChars: spec.maxChunkChars,
        overlapChunkChars: spec.overlapChunkChars,
      }),
    )
  }`
