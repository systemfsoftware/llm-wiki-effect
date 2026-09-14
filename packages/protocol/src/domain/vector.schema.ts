import { Schema } from 'effect'

export class VectorStatsResponse extends Schema.Class<VectorStatsResponse>('VectorStatsResponse')({
  chunks: Schema.Number,
  legacyRows: Schema.Number,
}) {}

export class VectorOptimizeResponse extends Schema.Class<VectorOptimizeResponse>(
  'VectorOptimizeResponse',
)({
  ok: Schema.Literals([true]),
}) {}

export class VectorDeletedResponse extends Schema.Class<VectorDeletedResponse>(
  'VectorDeletedResponse',
)({
  ok: Schema.Literals([true]),
  deleted: Schema.Number,
}) {}

export class VectorDropLegacyResponse extends Schema.Class<VectorDropLegacyResponse>(
  'VectorDropLegacyResponse',
)({
  ok: Schema.Literals([true]),
  dropped: Schema.Boolean,
}) {}
