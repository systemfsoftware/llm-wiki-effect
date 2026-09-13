import { Schema } from 'effect'

export class PageEmbeddingResult extends Schema.Class<PageEmbeddingResult>('PageEmbeddingResult')({
  path: Schema.String,
  pageId: Schema.String,
  revision: Schema.String,
  chunks: Schema.Number,
  vectorsWritten: Schema.Number,
  status: Schema.String,
}) {}

export class EmbedPageResponse extends Schema.Class<EmbedPageResponse>('EmbedPageResponse')({
  projectId: Schema.String,
  result: PageEmbeddingResult,
}) {}
