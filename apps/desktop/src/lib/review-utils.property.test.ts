/**
 * Tier 6 — property tests for review-utils.
 */
import { assert, constantFrom, property, string } from 'fast-check'
import { describe, expect, it } from 'vitest'
import { normalizeReviewTitle } from './review-utils'

describe('normalizeReviewTitle — properties', () => {
  it('is idempotent: normalize(normalize(x)) === normalize(x)', () => {
    assert(
      property(string(), (input) => {
        const once = normalizeReviewTitle(input)
        const twice = normalizeReviewTitle(once)
        expect(twice).toBe(once)
      }),
    )
  })

  it('is lowercase: result never contains uppercase ASCII letters', () => {
    assert(
      property(string(), (input) => {
        const out = normalizeReviewTitle(input)
        expect(out).toBe(out.toLowerCase())
      }),
    )
  })

  it('collapses any run of whitespace to a single space', () => {
    assert(
      property(string({ minLength: 1 }), (input) => {
        const out = normalizeReviewTitle(input)
        // Property: no double-space anywhere in output
        expect(out).not.toMatch(/ {2,}/)
      }),
    )
  })

  it('is monotonic in prefix-stripping: stripping a recognized prefix yields same result as no prefix', () => {
    assert(
      property(
        constantFrom('Missing page: ', '缺失页面：', '重复页面：', 'Duplicate page: '),
        string({ minLength: 1 }).filter((s) => !/[:：]/.test(s)),
        (prefix, body) => {
          const withPrefix = normalizeReviewTitle(prefix + body)
          const bare = normalizeReviewTitle(body)
          expect(withPrefix).toBe(bare)
        },
      ),
    )
  })

  it('merges variant-prefix titles to the same key', () => {
    assert(
      property(
        string({ minLength: 1 }).filter((s) => !/[:：]/.test(s) && s.trim().length > 0),
        (body) => {
          const a = normalizeReviewTitle(`Missing page: ${body}`)
          const b = normalizeReviewTitle(`缺失页面: ${body}`)
          const c = normalizeReviewTitle(`Missing-Page: ${body}`)
          expect(a).toBe(b)
          expect(a).toBe(c)
        },
      ),
    )
  })
})
