import { Effect, Exit, Layer } from 'effect'
import {
  array,
  assert,
  asyncProperty,
  boolean,
  constantFrom,
  integer,
  nat,
  property,
  record,
  uniqueArray,
} from 'fast-check'
import { Domain } from 'llm-wiki-protocol'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ProjectRegistry, type ProjectRegistryShape } from '../src/projects/Registry.js'
import {
  normalizeReviewTitle,
  reviewIdFor,
  ReviewsStore,
  type ReviewsStoreShape,
  stableReviewId,
} from '../src/reviews/index.js'

const PROJECT_ID = 'project-1'

const createdProjects: Array<string> = []

const makeProject = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'llm-wiki-reviews-'))
  createdProjects.push(root)
  return root
}

const stateFilePath = (root: string): string => join(root, '.llm-wiki', 'review.json')

const writeState = async (root: string, value: unknown): Promise<void> => {
  await mkdir(join(root, '.llm-wiki'), { recursive: true })
  await writeFile(stateFilePath(root), JSON.stringify(value))
}

const readState = async (root: string): Promise<Array<Record<string, unknown>>> => {
  const raw: unknown = JSON.parse(await readFile(stateFilePath(root), 'utf8'))
  if (!Array.isArray(raw)) {
    throw new Error(`expected the review state to be an array, received ${typeof raw}`)
  }
  return raw.map((entry) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`expected a review state entry to be an object, received ${typeof entry}`)
    }
    const parsed: Record<string, unknown> = entry
    return parsed
  })
}

afterEach(async () => {
  await Promise.all(
    createdProjects.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

const registryFor = (root: string): Layer.Layer<ProjectRegistry> =>
  Layer.succeed(
    ProjectRegistry,
    {
      list: Effect.succeed([] as ReadonlyArray<Domain.Project>),
      setCurrent: () => Effect.die(new Error('setCurrent is not exercised by the reviews suite')),
      resolveRoot: () => Effect.succeed(root),
    } satisfies ProjectRegistryShape,
  )

const call = <A, E>(
  root: string,
  f: (store: ReviewsStoreShape) => Effect.Effect<A, E>,
): Promise<A> =>
  Effect.runPromise(
    Effect.provide(
      Effect.flatMap(ReviewsStore, f),
      Layer.provide(ReviewsStore.layer, registryFor(root)),
    ),
  )

const callExit = <A, E>(
  root: string,
  f: (store: ReviewsStoreShape) => Effect.Effect<A, E>,
): Promise<Exit.Exit<A, E>> =>
  Effect.runPromise(
    Effect.exit(
      Effect.provide(
        Effect.flatMap(ReviewsStore, f),
        Layer.provide(ReviewsStore.layer, registryFor(root)),
      ),
    ),
  )

const errorTags = (exit: Exit.Exit<unknown, { readonly _tag: string }>): ReadonlyArray<string> =>
  Exit.isSuccess(exit)
    ? []
    : exit.cause.reasons.map((reason) => (reason._tag === 'Fail' ? reason.error._tag : reason._tag))

describe('review ids', () => {
  const ledgerFromRustNormalizer: ReadonlyArray<[string, string, string]> = [
    ['missing-page', 'Missing page: Attention', 'review-dbdcf949'],
    ['missing-page', ' Missing page: Attention', 'review-dbdcf949'],
    ['missing-page', 'MissingPage:Attention', 'review-dbdcf949'],
    ['missing-page', 'Missing page Attention', 'review-fa5d9960'],
    ['missing-page', '疑似重复 注意力', 'review-d2dacda0'],
    ['duplicate', 'Duplicate page: Transformer', 'review-4c3904f5'],
    ['contradiction', 'Contradiction: alpha vs beta', 'review-49591dcc'],
    ['confirm', 'Confirm: alpha', 'review-1ee00e0d'],
    ['suggestion', 'Suggestion: alpha', 'review-9ab404b9'],
  ]

  it.each(ledgerFromRustNormalizer)('derives %s + %s as %s', (itemType, title, expected) => {
    expect(reviewIdFor(itemType, title)).toBe(expected)
  })

  it('derives the same id for the prefix, case, and whitespace variants it strips', () => {
    const titleWords = array(
      constantFrom('attention', 'transformer', 'vector', 'db', 'alpha'),
      { minLength: 1, maxLength: 3 },
    )
    assert(
      property(titleWords, (words) => {
        const title = words.join(' ')
        const expected = reviewIdFor('missing-page', title)
        expect(expected).toMatch(/^review-[0-9a-f]{8}$/)
        for (
          const variant of [
            `Missing page: ${title}`,
            ` missing-page:${title}`,
            `MISSINGPAGE：${title}`,
            `缺失页面:${title}`,
          ]
        ) {
          expect(reviewIdFor('missing-page', variant)).toBe(expected)
        }
      }),
      { numRuns: 200 },
    )
  })

  it('does not strip a prefix without a delimiter', () => {
    expect(reviewIdFor('missing-page', 'Missing page Attention')).not.toBe(
      reviewIdFor('missing-page', 'Attention'),
    )
  })

  it('collapses case and whitespace differences onto one id', () => {
    expect(reviewIdFor('missing-page', 'Attention ')).toBe(reviewIdFor('missing-page', 'Attention'))
    expect(reviewIdFor('missing-page', 'Attention  Notes')).toBe(
      reviewIdFor('missing-page', 'attention notes'),
    )
    expect(normalizeReviewTitle('  Attention   Notes  ')).toBe('attention notes')
    expect(normalizeReviewTitle('Missing page:  Attention  Notes ')).toBe('attention notes')
  })

  it('requires both the type and the title to be strings', () => {
    expect(stableReviewId({ type: 'missing-page', title: 'Attention' })).toBe(
      reviewIdFor('missing-page', 'Attention'),
    )
    expect(stableReviewId({ type: 42, title: 'Attention' })).toBeUndefined()
    expect(stableReviewId({ type: 'missing-page', title: 42 })).toBeUndefined()
    expect(stableReviewId({ type: 'missing-page' })).toBeUndefined()
    expect(stableReviewId({ title: 'Attention' })).toBeUndefined()
    expect(stableReviewId({ type: null, title: null })).toBeUndefined()
  })
})

describe('ReviewsStore.list', () => {
  it('defaults to unresolved items and drops fields outside the review shape', async () => {
    const root = await makeProject()
    await writeState(root, [
      {
        id: 'r1',
        type: 'missing-page',
        title: 'Missing page: Attention',
        description: 'Add Attention',
        options: [],
        resolved: false,
        createdAt: 1,
        internalSecret: 'do-not-expose',
      },
      {
        id: 'r2',
        type: 'duplicate',
        title: 'Duplicate: LLM',
        options: [],
        resolved: true,
        createdAt: 2,
      },
    ])

    const response = await call(root, (store) => store.list(PROJECT_ID))

    expect(response).toBeInstanceOf(Domain.ReviewsResponse)
    expect(response.projectId).toBe(PROJECT_ID)
    expect(response.status).toBe('unresolved')
    expect(response.count).toBe(1)
    expect(response.reviews.map((review) => review.id)).toEqual([
      reviewIdFor('missing-page', 'Missing page: Attention'),
    ])
    expect(response.reviews[0]).not.toHaveProperty('internalSecret')
  })

  it('returns an empty list when no review state exists', async () => {
    const root = await makeProject()
    const response = await call(root, (store) => store.list(PROJECT_ID, { status: 'all' }))
    expect(response.status).toBe('all')
    expect(response.count).toBe(0)
    expect(response.reviews).toEqual([])
  })

  it('filters by status, type, and limit, truncating after filtering', async () => {
    const root = await makeProject()
    await writeState(root, [
      { id: 'r1', type: 'missing-page', title: 'r1', resolved: false, createdAt: 1 },
      { id: 'r2', type: 'missing-page', title: 'r2', resolved: false, createdAt: 2 },
      { id: 'r3', type: 'duplicate', title: 'r3', resolved: false, createdAt: 3 },
      { id: 'r4', type: 'missing-page', title: 'r4', resolved: true, createdAt: 4 },
    ])

    const allMissing = await call(
      root,
      (store) => store.list(PROJECT_ID, { status: 'all', type: 'missing-page', limit: 2 }),
    )
    expect(allMissing.status).toBe('all')
    expect(allMissing.reviews.map((review) => review.id)).toEqual([
      reviewIdFor('missing-page', 'r1'),
      reviewIdFor('missing-page', 'r2'),
    ])

    const resolved = await call(root, (store) => store.list(PROJECT_ID, { status: 'resolved' }))
    expect(resolved.reviews.map((review) => review.id)).toEqual([
      reviewIdFor('missing-page', 'r4'),
    ])

    const limited = await call(root, (store) => store.list(PROJECT_ID, { limit: 0 }))
    expect(limited.count).toBe(1)

    const unclamped = await call(root, (store) => store.list(PROJECT_ID, { limit: 5_000 }))
    expect(unclamped.count).toBe(3)
  })

  it('collapses legacy counter ids onto the stable id and merges the duplicates', async () => {
    const root = await makeProject()
    await writeState(root, [
      {
        id: 'review-1',
        type: 'missing-page',
        title: 'Attention',
        description: '',
        affectedPages: ['a.md'],
        resolved: false,
        createdAt: 5,
      },
      {
        id: 'review-2',
        type: 'missing-page',
        title: 'Missing page: Attention',
        description: 'resolved copy',
        affectedPages: ['b.md'],
        resolved: true,
        resolvedAction: 'user-resolved',
        createdAt: 2,
      },
    ])

    const response = await call(root, (store) => store.list(PROJECT_ID, { status: 'all' }))

    expect(response.count).toBe(1)
    const [merged] = response.reviews
    expect(merged?.id).toBe(reviewIdFor('missing-page', 'Attention'))
    expect(merged?.resolved).toBe(true)
    expect(merged?.resolvedAction).toBe('user-resolved')
    expect(merged?.affectedPages).toEqual(['a.md', 'b.md'])
    expect(merged?.description).toBe('resolved copy')
    expect(merged?.createdAt).toBe(2)
  })

  it('applies the status filter after the stable-id merge', async () => {
    const root = await makeProject()
    await writeState(root, [
      {
        id: 'review-old-unresolved',
        type: 'missing-page',
        title: 'Attention',
        resolved: false,
        createdAt: 5,
      },
      {
        id: 'review-old-resolved',
        type: 'missing-page',
        title: 'Missing page: Attention',
        resolved: true,
        resolvedAction: 'Done',
        createdAt: 6,
      },
    ])

    const unresolved = await call(root, (store) => store.list(PROJECT_ID))
    expect(unresolved.reviews).toEqual([])

    const all = await call(root, (store) => store.list(PROJECT_ID, { status: 'all' }))
    expect(all.reviews).toHaveLength(1)
    expect(all.reviews[0]?.resolved).toBe(true)
  })

  it('keeps a partial review option as an option with a blank half', async () => {
    const root = await makeProject()
    await writeState(root, [
      {
        id: 'r1',
        type: 'missing-page',
        title: 'Attention',
        options: [{ label: 'Skip' }, { action: 'open' }],
      },
    ])

    const response = await call(root, (store) => store.list(PROJECT_ID, { status: 'all' }))

    expect(response.reviews[0]?.options).toEqual([
      new Domain.ReviewOption({ label: 'Skip', action: '' }),
      new Domain.ReviewOption({ label: '', action: 'open' }),
    ])
  })

  it('fails as a defect when the review state is not valid JSON', async () => {
    const root = await makeProject()
    await mkdir(join(root, '.llm-wiki'), { recursive: true })
    await writeFile(stateFilePath(root), '{not valid json')

    const exit = await callExit(root, (store) => store.list(PROJECT_ID))
    expect(errorTags(exit)).toEqual(['Die'])
  })

  it('fails as a defect when the review state is not an array', async () => {
    const root = await makeProject()
    await writeState(root, { reviews: [] })

    const exit = await callExit(root, (store) => store.list(PROJECT_ID))
    expect(errorTags(exit)).toEqual(['Die'])
  })
})

describe('ReviewsStore.patch', () => {
  it('marks one item resolved, preserves raw-only fields, and leaves siblings untouched', async () => {
    const root = await makeProject()
    await writeState(root, [
      { id: 'r1', type: 'missing-page', resolved: false, createdAt: 1, internalSecret: 'keep-me' },
      { id: 'r2', type: 'duplicate', resolved: false, createdAt: 2 },
    ])

    const response = await call(root, (store) => store.patch(PROJECT_ID, 'r1', { action: 'Skip' }))

    expect(response).toBeInstanceOf(Domain.PatchReviewResponse)
    expect(response.resolved).toBe(true)

    const items = await readState(root)
    expect(items[0]).toMatchObject({
      id: 'r1',
      resolved: true,
      resolvedAction: 'Skip',
      internalSecret: 'keep-me',
    })
    expect(items[1]).toMatchObject({ id: 'r2', resolved: false })
    expect(items[1]).not.toHaveProperty('resolvedAction')
  })

  it('accepts the stable id of a legacy counter item and rewrites the stored id', async () => {
    const root = await makeProject()
    await writeState(root, [
      {
        id: 'review-1',
        type: 'missing-page',
        title: 'Missing page: Attention',
        resolved: false,
      },
    ])

    const stableId = reviewIdFor('missing-page', 'Attention')
    const response = await call(root, (store) => store.patch(PROJECT_ID, stableId, { action: 'API' }))

    expect(response.reviewId).toBe(stableId)
    const items = await readState(root)
    expect(items[0]).toMatchObject({ id: stableId, resolved: true, resolvedAction: 'API' })
  })

  it('reopens a resolved item and drops the action label', async () => {
    const root = await makeProject()
    await writeState(root, [{ id: 'r1', resolved: true, resolvedAction: 'Skip' }])

    await call(root, (store) => store.patch(PROJECT_ID, 'r1', { resolved: false }))

    const items = await readState(root)
    expect(items[0]).toMatchObject({ id: 'r1', resolved: false })
    expect(items[0]).not.toHaveProperty('resolvedAction')
  })

  it('reports NotFound for an unknown id and for a missing state file', async () => {
    const root = await makeProject()
    await writeState(root, [{ id: 'r1', resolved: false }])

    const unknown = await callExit(root, (store) => store.patch(PROJECT_ID, 'nope', { resolved: true }))
    expect(errorTags(unknown)).toEqual(['NotFound'])

    const empty = await makeProject()
    const missing = await callExit(empty, (store) => store.patch(PROJECT_ID, 'r1', { resolved: true }))
    expect(errorTags(missing)).toEqual(['NotFound'])
    await expect(readState(empty)).rejects.toThrow('ENOENT')
  })
})

describe('ReviewsStore.resolve', () => {
  it('resolves the matching ids in input order and reports the rest as notFound', async () => {
    const root = await makeProject()
    await writeState(root, [
      { id: 'r1', resolved: false, internalSecret: 'a' },
      { id: 'r2', resolved: false },
      { id: 'r3', resolved: false },
    ])

    const response = await call(root, (store) => store.resolve(PROJECT_ID, ['r1', 'r3', 'missing'], 'Bulk'))

    expect(response).toBeInstanceOf(Domain.ResolveReviewsResponse)
    expect(response.resolved).toEqual(['r1', 'r3'])
    expect(response.notFound).toEqual(['missing'])
    expect(response.count).toBe(2)

    const items = await readState(root)
    expect(items[0]).toMatchObject({ resolved: true, resolvedAction: 'Bulk', internalSecret: 'a' })
    expect(items[1]).toMatchObject({ id: 'r2', resolved: false })
    expect(items[2]).toMatchObject({ id: 'r3', resolved: true })
  })

  it('accepts stable ids for legacy counter items and rewrites only those items', async () => {
    const root = await makeProject()
    await writeState(root, [
      {
        id: 'review-1',
        type: 'missing-page',
        title: 'Missing page: Attention',
        resolved: false,
      },
      {
        id: 'review-2',
        type: 'duplicate',
        title: 'Duplicate page: Transformer',
        resolved: false,
      },
    ])

    const stableId = reviewIdFor('missing-page', 'Attention')
    const response = await call(root, (store) => store.resolve(PROJECT_ID, [stableId, 'missing']))

    expect(response.resolved).toEqual([stableId])
    expect(response.notFound).toEqual(['missing'])
    const items = await readState(root)
    expect(items[0]).toMatchObject({ id: stableId, resolved: true })
    expect(items[1]).toMatchObject({ id: 'review-2', resolved: false })
    expect(items[1]).not.toHaveProperty('resolvedAction')
  })

  it('reports every requested id as notFound when no state file exists', async () => {
    const root = await makeProject()
    const response = await call(root, (store) => store.resolve(PROJECT_ID, ['r1', 'r2']))
    expect(response.resolved).toEqual([])
    expect(response.notFound).toEqual(['r1', 'r2'])
    expect(response.count).toBe(0)
    await expect(readState(root)).rejects.toThrow('ENOENT')
  })

  it('reports a requested id as notFound when an earlier id already claimed the only matching item', async () => {
    const root = await makeProject()
    await writeState(root, [
      { id: 'review-1', type: 'missing-page', title: 'Attention', resolved: false },
    ])

    const stableId = reviewIdFor('missing-page', 'Attention')
    const response = await call(root, (store) => store.resolve(PROJECT_ID, [stableId, 'review-1'], 'Bulk'))

    expect(response.resolved).toEqual([stableId])
    expect(response.notFound).toEqual(['review-1'])
    expect(response.count).toBe(1)
  })

  it('rejects an empty id list', async () => {
    const root = await makeProject()
    const exit = await callExit(root, (store) => store.resolve(PROJECT_ID, []))
    expect(errorTags(exit)).toEqual(['InvalidRequest'])
  })

  it('resolves exactly the requested ids that exist, leaving the rest untouched', async () => {
    const item = record({
      id: integer({ min: 1, max: 90 }).map((value) => `r-${value}`),
      type: constantFrom('missing-page', 'duplicate', 'contradiction'),
      title: array(constantFrom('attention', 'transformer', 'vector', 'db'), {
        minLength: 1,
        maxLength: 3,
      }).map((words) => words.join(' ')),
      resolved: boolean(),
      createdAt: integer({ min: 0, max: 100 }),
    })

    await assert(
      asyncProperty(
        uniqueArray(item, { minLength: 1, maxLength: 4, selector: (entry) => entry.id }),
        array(nat({ max: 40 }), { minLength: 1, maxLength: 6 }),
        async (items, picks) => {
          const root = await makeProject()
          await writeState(root, items)
          const pool = [
            ...items.map((entry) => entry.id),
            ...items
              .map((entry) => stableReviewId(entry))
              .filter((id): id is string => id !== undefined),
            'ghost',
          ]
          const requested = picks.map((pick) => pool[pick % pool.length] ?? 'ghost')
          const matches = (entry: (typeof items)[number], id: string): boolean =>
            entry.id === id || stableReviewId(entry) === id
          const claimed = new Set<string>()
          for (const entry of items) {
            const claim = requested.find((id) => matches(entry, id))
            if (claim !== undefined) claimed.add(claim)
          }
          const expectedResolved = requested.filter((id) => claimed.has(id))
          const expectedNotFound = requested.filter((id) => !claimed.has(id))

          const response = await call(root, (store) => store.resolve(PROJECT_ID, requested, 'Bulk'))

          expect(response.resolved).toEqual(expectedResolved)
          expect(response.notFound).toEqual(expectedNotFound)
          expect(response.count).toBe(expectedResolved.length)

          const persisted = await readState(root)
          items.forEach((entry, index) => {
            const stored = persisted[index]
            const wasRequested = requested.some((id) => matches(entry, id))
            expect(stored).toMatchObject({ type: entry.type, title: entry.title })
            expect(stored?.['resolved']).toBe(wasRequested ? true : entry.resolved)
            expect(stored?.['resolvedAction']).toBe(wasRequested ? 'Bulk' : undefined)
          })
        },
      ),
      { numRuns: 100 },
    )
  })
})
