/**
 * Tier 6 — property tests for review-store dedupe invariants.
 */
import { normalizeReviewTitle } from '@/lib/review-utils'
import { array, assert, constant, constantFrom, option, property, record, string } from 'fast-check'
import { beforeEach, describe, expect, it } from 'vitest'
import { type ReviewItem, useReviewStore } from './review-store'

beforeEach(() => {
  useReviewStore.setState({ items: [] })
})

const typeArb = constantFrom<ReviewItem['type']>(
  'contradiction',
  'duplicate',
  'missing-page',
  'confirm',
  'suggestion',
)

const reviewInputArb = record({
  type: typeArb,
  title: string({ minLength: 1, maxLength: 60 }),
  description: string({ maxLength: 100 }),
  options: constant([]),
  affectedPages: option(array(string(), { maxLength: 4 })),
  searchQueries: option(array(string(), { maxLength: 4 })),
})

function key(type: string, title: string): string {
  return `${type}::${normalizeReviewTitle(title)}`
}

describe('review-store addItems — dedupe invariants', () => {
  it('after ANY sequence of addItems, pending items have unique (type, normalized title)', () => {
    assert(
      property(array(array(reviewInputArb, { maxLength: 8 }), { maxLength: 6 }), (batches) => {
        useReviewStore.setState({ items: [] })

        for (const batch of batches) {
          const input = batch.map((b) => ({
            type: b.type,
            title: b.title,
            description: b.description,
            options: [...b.options],
            affectedPages: b.affectedPages ? [...b.affectedPages] : undefined,
            searchQueries: b.searchQueries ? [...b.searchQueries] : undefined,
          }))
          useReviewStore.getState().addItems(input)
        }

        const pending = useReviewStore.getState().items.filter((i) => !i.resolved)
        const keys = pending.map((i) => key(i.type, i.title))
        const unique = new Set(keys)
        expect(unique.size).toBe(keys.length)
      }),
    )
  })

  it('merge preserves the union of affectedPages across duplicates', () => {
    assert(
      property(
        string({ minLength: 1, maxLength: 20 }).filter((s) => s.trim().length > 0),
        typeArb,
        array(array(string({ maxLength: 20 }), { maxLength: 5 }), { minLength: 2, maxLength: 5 }),
        (title, type, affectedBatches) => {
          useReviewStore.setState({ items: [] })

          for (const pages of affectedBatches) {
            useReviewStore.getState().addItems([
              {
                type,
                title,
                description: '',
                options: [],
                affectedPages: pages.length > 0 ? pages : undefined,
              },
            ])
          }

          const pending = useReviewStore.getState().items.filter((i) => !i.resolved)
          // Only one item for this (type, title)
          expect(pending.length).toBe(1)

          const allExpectedPages = new Set(affectedBatches.flat())
          const actualPages = new Set(pending[0].affectedPages ?? [])
          expect(actualPages).toEqual(allExpectedPages)
        },
      ),
    )
  })

  it('re-adding the same key after resolve preserves the resolved item (resolved wins)', () => {
    // Content-stable ids: re-surfacing a review during ingest must fold
    // into the resolved item (same id, stays resolved), not spawn a new
    // pending duplicate — that revival was the bug being fixed.
    assert(
      property(
        string({ minLength: 1, maxLength: 20 }).filter((s) => s.trim().length > 0),
        typeArb,
        (title, type) => {
          useReviewStore.setState({ items: [] })

          useReviewStore.getState().addItems([
            { type, title, description: '', options: [], affectedPages: ['first.md'] },
          ])
          const firstId = useReviewStore.getState().items[0].id
          useReviewStore.getState().resolveItem(firstId, 'auto-resolved')

          useReviewStore.getState().addItems([
            { type, title, description: '', options: [], affectedPages: ['second.md'] },
          ])

          const all = useReviewStore.getState().items
          expect(all.length).toBe(1)
          expect(all[0].id).toBe(firstId)
          expect(all[0].resolved).toBe(true)
          expect(all[0].resolvedAction).toBe('auto-resolved')
          expect(all[0].affectedPages).toEqual(expect.arrayContaining(['second.md']))
        },
      ),
    )
  })
})
