import { Schema } from 'effect'

export const ReviewStatus = Schema.Literals(['unresolved', 'resolved', 'all'])

export type ReviewStatus = Schema.Schema.Type<typeof ReviewStatus>

export class ReviewOption extends Schema.Class<ReviewOption>('ReviewOption')({
  label: Schema.String,
  action: Schema.String,
}) {}

export class ReviewItem extends Schema.Class<ReviewItem>('ReviewItem')({
  id: Schema.String,
  type: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  sourcePath: Schema.optional(Schema.String),
  affectedPages: Schema.optional(Schema.Array(Schema.String)),
  searchQueries: Schema.optional(Schema.Array(Schema.String)),
  options: Schema.Array(ReviewOption),
  resolved: Schema.optional(Schema.Boolean),
  resolvedAction: Schema.optional(Schema.String),
  createdAt: Schema.optional(Schema.Number),
}) {}

export class ReviewsResponse extends Schema.Class<ReviewsResponse>('ReviewsResponse')({
  projectId: Schema.String,
  status: ReviewStatus,
  count: Schema.Number,
  reviews: Schema.Array(ReviewItem),
}) {}

export class PatchReviewResponse extends Schema.Class<PatchReviewResponse>('PatchReviewResponse')({
  projectId: Schema.String,
  reviewId: Schema.String,
  resolved: Schema.Boolean,
}) {}

export class ResolveReviewsResponse extends Schema.Class<ResolveReviewsResponse>(
  'ResolveReviewsResponse',
)({
  projectId: Schema.String,
  resolved: Schema.Array(Schema.String),
  notFound: Schema.Array(Schema.String),
  count: Schema.Number,
}) {}
