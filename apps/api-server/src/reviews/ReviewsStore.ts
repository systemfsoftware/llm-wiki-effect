// Ported from the review store in apps/desktop/src-tauri/src/api_server.rs.

import { Context, Effect, Layer } from 'effect'
import { Domain, Errors } from 'llm-wiki-protocol'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { asString, hasErrorCode, isRecord } from '../json.js'
import { ProjectRegistry } from '../projects/Registry.js'
import { stableReviewId } from './reviewIds.js'

const REVIEW_STATE_SEGMENTS = ['.llm-wiki', 'review.json'] as const
const DEFAULT_MAX_REVIEWS = 200
const HARD_MAX_REVIEWS = 1_000

interface SanitizedOption {
  readonly label?: string
  readonly action?: string
}

interface SanitizedReview {
  id?: string
  type?: string
  title?: string
  description?: string
  sourcePath?: string
  affectedPages?: ReadonlyArray<string>
  searchQueries?: ReadonlyArray<string>
  options?: ReadonlyArray<SanitizedOption>
  resolved?: boolean
  resolvedAction?: string
  createdAt?: number
}

export interface ReviewsQuery {
  readonly status?: Domain.ReviewStatus
  readonly type?: string
  readonly limit?: number
}

export interface ReviewPatch {
  readonly resolved?: boolean
  readonly action?: string
}

export interface ReviewsStoreShape {
  readonly list: (
    projectId: string,
    query?: ReviewsQuery,
  ) => Effect.Effect<Domain.ReviewsResponse, Errors.InvalidRequest | Errors.NotFound>
  readonly patch: (
    projectId: string,
    reviewId: string,
    patch?: ReviewPatch,
  ) => Effect.Effect<Domain.PatchReviewResponse, Errors.InvalidRequest | Errors.NotFound>
  readonly resolve: (
    projectId: string,
    ids: ReadonlyArray<string>,
    action?: string,
  ) => Effect.Effect<Domain.ResolveReviewsResponse, Errors.InvalidRequest | Errors.NotFound>
}

const asBoolean = (value: unknown): boolean | undefined => typeof value === 'boolean' ? value : undefined

const asFiniteNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

const asStringArray = (value: unknown): ReadonlyArray<string> | undefined =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : undefined

const sanitizeOption = (value: unknown): SanitizedOption | undefined => {
  const option = isRecord(value) ? value : undefined
  if (option === undefined) return undefined
  const label = asString(option['label'])
  const action = asString(option['action'])
  if (label === undefined && action === undefined) return undefined
  return { ...(label === undefined ? {} : { label }), ...(action === undefined ? {} : { action }) }
}

const sanitizeOptions = (value: unknown): ReadonlyArray<SanitizedOption> | undefined =>
  Array.isArray(value)
    ? value
      .map(sanitizeOption)
      .filter((option): option is SanitizedOption => option !== undefined)
    : undefined

const sanitizeReviewItem = (value: unknown): SanitizedReview => {
  const item = isRecord(value) ? value : {}
  const id = stableReviewId(item) ?? asString(item['id'])
  const type = asString(item['type'])
  const title = asString(item['title'])
  const description = asString(item['description'])
  const sourcePath = asString(item['sourcePath'])
  const affectedPages = asStringArray(item['affectedPages'])
  const searchQueries = asStringArray(item['searchQueries'])
  const options = sanitizeOptions(item['options'])
  const resolved = asBoolean(item['resolved'])
  const resolvedAction = asString(item['resolvedAction'])
  const createdAt = asFiniteNumber(item['createdAt'])
  return {
    ...(id === undefined ? {} : { id }),
    ...(type === undefined ? {} : { type }),
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
    ...(sourcePath === undefined ? {} : { sourcePath }),
    ...(affectedPages === undefined ? {} : { affectedPages }),
    ...(searchQueries === undefined ? {} : { searchQueries }),
    ...(options === undefined ? {} : { options }),
    ...(resolved === undefined ? {} : { resolved }),
    ...(resolvedAction === undefined ? {} : { resolvedAction }),
    ...(createdAt === undefined ? {} : { createdAt }),
  }
}

const mergeStringArrayField = (
  existing: SanitizedReview,
  incoming: SanitizedReview,
  key: 'affectedPages' | 'searchQueries',
): void => {
  const current = existing[key]
  const values = current === undefined ? [] : [...current]
  for (const value of incoming[key] ?? []) {
    if (!values.includes(value)) values.push(value)
  }
  if (values.length > 0) existing[key] = values
}

const mergeOptionsField = (existing: SanitizedReview, incoming: SanitizedReview): void => {
  const options: Array<SanitizedOption> = existing.options === undefined
    ? []
    : existing.options.map((option) => ({ ...option }))
  for (const option of incoming.options ?? []) {
    const action = option.action
    const alreadyPresent = action !== undefined && options.some((candidate) => candidate.action === action)
    if (!alreadyPresent) options.push(option)
  }
  if (options.length > 0) existing.options = options
}

const mergeSanitizedReview = (existing: SanitizedReview, incoming: SanitizedReview): void => {
  const resolved = existing.resolved === true || incoming.resolved === true
  existing.resolved = resolved
  if (resolved && existing.resolvedAction === undefined) {
    if (incoming.resolvedAction !== undefined) existing.resolvedAction = incoming.resolvedAction
  }
  for (const key of ['description', 'sourcePath'] as const) {
    const current = existing[key]
    if (current === undefined || current === '') {
      const value = incoming[key]
      if (value !== undefined) existing[key] = value
    }
  }
  mergeStringArrayField(existing, incoming, 'affectedPages')
  mergeStringArrayField(existing, incoming, 'searchQueries')
  mergeOptionsField(existing, incoming)
  const incomingCreated = incoming.createdAt
  if (incomingCreated !== undefined) {
    const existingCreated = existing.createdAt ?? incomingCreated
    existing.createdAt = Math.min(existingCreated, incomingCreated)
  }
}

const collapseDuplicates = (items: ReadonlyArray<SanitizedReview>): Array<SanitizedReview> => {
  const normalized: Array<SanitizedReview> = []
  const indexById = new Map<string, number>()
  for (const item of items) {
    const id = item.id
    if (id === undefined) {
      normalized.push(item)
      continue
    }
    const existingIndex = indexById.get(id)
    if (existingIndex === undefined) {
      indexById.set(id, normalized.length)
      normalized.push(item)
      continue
    }
    const existing = normalized[existingIndex]
    if (existing !== undefined) mergeSanitizedReview(existing, item)
  }
  return normalized
}

const statusMatches = (status: Domain.ReviewStatus, resolved: boolean): boolean => {
  if (status === 'all') return true
  return status === 'resolved' ? resolved : !resolved
}

const reviewLimit = (limit: number | undefined): number =>
  limit === undefined || !Number.isInteger(limit)
    ? DEFAULT_MAX_REVIEWS
    : Math.min(Math.max(limit, 1), HARD_MAX_REVIEWS)

const toReviewOption = (option: SanitizedOption): Domain.ReviewOption =>
  new Domain.ReviewOption({ label: option.label ?? '', action: option.action ?? '' })

const toReviewItem = (item: SanitizedReview): Domain.ReviewItem =>
  new Domain.ReviewItem({
    id: item.id ?? '',
    options: (item.options ?? []).map(toReviewOption),
    ...(item.type === undefined ? {} : { type: item.type }),
    ...(item.title === undefined ? {} : { title: item.title }),
    ...(item.description === undefined ? {} : { description: item.description }),
    ...(item.sourcePath === undefined ? {} : { sourcePath: item.sourcePath }),
    ...(item.affectedPages === undefined ? {} : { affectedPages: [...item.affectedPages] }),
    ...(item.searchQueries === undefined ? {} : { searchQueries: [...item.searchQueries] }),
    ...(item.resolved === undefined ? {} : { resolved: item.resolved }),
    ...(item.resolvedAction === undefined ? {} : { resolvedAction: item.resolvedAction }),
    ...(item.createdAt === undefined ? {} : { createdAt: item.createdAt }),
  })

const selectReviews = (
  items: ReadonlyArray<SanitizedReview>,
  status: Domain.ReviewStatus,
  itemType: string | undefined,
  limit: number,
): Array<Domain.ReviewItem> => {
  const reviews: Array<Domain.ReviewItem> = []
  for (const item of items) {
    if (!statusMatches(status, item.resolved ?? false)) continue
    if (itemType !== undefined && item.type !== itemType) continue
    if (reviews.length >= limit) break
    reviews.push(toReviewItem(item))
  }
  return reviews
}

const errorMessage = (cause: unknown): string => cause instanceof Error ? cause.message : String(cause)

const readReviewState = (path: string): Effect.Effect<unknown> =>
  Effect.gen(function*() {
    const raw = yield* Effect.tryPromise({
      try: async () => {
        try {
          return await readFile(path, 'utf8')
        } catch (cause) {
          if (hasErrorCode(cause, 'ENOENT')) return undefined
          throw cause
        }
      },
      catch: (cause) => new Error(`Failed to read review state: ${errorMessage(cause)}`),
    })
    if (raw === undefined) return undefined
    return yield* Effect.try({
      try: () => JSON.parse(raw) as unknown,
      catch: (cause) => new Error(`Invalid review state JSON: ${errorMessage(cause)}`),
    })
  }).pipe(Effect.orDie)

const expectReviewArray = (value: unknown): Effect.Effect<ReadonlyArray<unknown>> =>
  Array.isArray(value)
    ? Effect.succeed(value)
    : Effect.die(new Error('Invalid review state JSON: expected an array'))

const writeReviewState = (path: string, value: unknown): Effect.Effect<void> =>
  Effect.tryPromise({
    try: () => writeFile(path, JSON.stringify(value, null, 2)),
    catch: (cause) => new Error(`Failed to write review state: ${errorMessage(cause)}`),
  }).pipe(Effect.orDie)

const applyResolution = (
  item: Record<string, unknown>,
  resolved: boolean,
  action: string | undefined,
): void => {
  item['resolved'] = resolved
  if (!resolved) {
    delete item['resolvedAction']
  } else if (action !== undefined) {
    item['resolvedAction'] = action
  }
}

const matchesReviewId = (item: Record<string, unknown>, requestedId: string): boolean =>
  item['id'] === requestedId || stableReviewId(item) === requestedId

const reviewNotFound = (reviewId: string): Errors.NotFound =>
  new Errors.NotFound({ message: `Review item '${reviewId}' not found` })

export class ReviewsStore extends Context.Service<ReviewsStore, ReviewsStoreShape>()(
  'llm-wiki-api-server/ReviewsStore',
  {
    make: Effect.gen(function*() {
      const registry = yield* ProjectRegistry

      const statePath = (projectId: string) =>
        registry.resolveRoot(projectId).pipe(
          Effect.map((root) => join(root, ...REVIEW_STATE_SEGMENTS)),
        )

      const list: ReviewsStoreShape['list'] = (projectId, query = {}) =>
        Effect.gen(function*() {
          const status = query.status ?? 'unresolved'
          const path = yield* statePath(projectId)
          const state = yield* readReviewState(path)
          const rawItems = state === undefined ? [] : yield* expectReviewArray(state)
          const sanitized = collapseDuplicates(rawItems.map(sanitizeReviewItem))
          const requestedType = query.type?.trim()
          const reviews = selectReviews(
            sanitized,
            status,
            requestedType === undefined || requestedType === '' ? undefined : requestedType,
            reviewLimit(query.limit),
          )
          return new Domain.ReviewsResponse({
            projectId,
            status,
            count: reviews.length,
            reviews,
          })
        })

      const patch: ReviewsStoreShape['patch'] = (projectId, reviewId, patchBody = {}) =>
        Effect.gen(function*() {
          const resolved = patchBody.resolved ?? true
          const path = yield* statePath(projectId)
          const state = yield* readReviewState(path)
          if (state === undefined) return yield* reviewNotFound(reviewId)
          const items = yield* expectReviewArray(state)
          let found = false
          for (const entry of items) {
            const item = isRecord(entry) ? entry : undefined
            if (item === undefined || !matchesReviewId(item, reviewId)) continue
            applyResolution(item, resolved, patchBody.action)
            const stableId = stableReviewId(item)
            if (stableId !== undefined) item['id'] = stableId
            found = true
          }
          if (!found) return yield* reviewNotFound(reviewId)
          yield* writeReviewState(path, items)
          return new Domain.PatchReviewResponse({ projectId, reviewId, resolved })
        })

      const resolve: ReviewsStoreShape['resolve'] = (projectId, ids, action) =>
        Effect.gen(function*() {
          if (ids.length === 0) {
            return yield* new Errors.InvalidRequest({
              message: 'ids must be a non-empty array',
            })
          }
          const path = yield* statePath(projectId)
          const state = yield* readReviewState(path)
          if (state === undefined) {
            return new Domain.ResolveReviewsResponse({
              projectId,
              resolved: [],
              notFound: [...ids],
              count: 0,
            })
          }
          const items = yield* expectReviewArray(state)
          const found = new Set<string>()
          for (const entry of items) {
            const item = isRecord(entry) ? entry : undefined
            if (item === undefined) continue
            const rawId = asString(item['id'])
            const stableId = stableReviewId(item)
            const requestedId = ids.find((id) => rawId === id || stableId === id)
            if (requestedId === undefined) continue
            applyResolution(item, true, action)
            if (stableId !== undefined) item['id'] = stableId
            found.add(requestedId)
          }
          if (found.size > 0) yield* writeReviewState(path, items)
          const resolved = ids.filter((id) => found.has(id))
          const notFound = ids.filter((id) => !found.has(id))
          return new Domain.ResolveReviewsResponse({
            projectId,
            resolved,
            notFound,
            count: resolved.length,
          })
        })

      return { list, patch, resolve }
    }),
  },
) {
  static readonly layer: Layer.Layer<ReviewsStore, never, ProjectRegistry> = Layer.effect(
    ReviewsStore,
    ReviewsStore.make,
  )
}
