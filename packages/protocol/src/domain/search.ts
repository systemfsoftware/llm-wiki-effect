import { Schema } from 'effect'

export class SearchImageRef extends Schema.Class<SearchImageRef>('SearchImageRef')({
  url: Schema.String,
  alt: Schema.String,
}) {}

export class SearchResult extends Schema.Class<SearchResult>('SearchResult')({
  path: Schema.String,
  title: Schema.String,
  snippet: Schema.String,
  titleMatch: Schema.Boolean,
  score: Schema.Number,
  vectorScore: Schema.optional(Schema.Number),
  images: Schema.Array(SearchImageRef),
  content: Schema.optional(Schema.String),
  graphRelatedTo: Schema.optional(Schema.Array(Schema.String)),
}) {}

export class SearchResponse extends Schema.Class<SearchResponse>('SearchResponse')({
  projectId: Schema.String,
  mode: Schema.String,
  note: Schema.String,
  tokenHits: Schema.Number,
  vectorHits: Schema.Number,
  graphHits: Schema.Number,
  results: Schema.Array(SearchResult),
}) {}
