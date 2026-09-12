import { describe, expect, it } from 'vitest'
import { FALLBACK_TYPE_STYLE, getWikiTypeStyle, WIKI_TYPE_STYLES } from './wiki-type-style'

describe('getWikiTypeStyle', () => {
  it("returns the entity style for 'entity'", () => {
    expect(getWikiTypeStyle('entity')).toBe(WIKI_TYPE_STYLES.entity)
  })

  it('is case-insensitive', () => {
    expect(getWikiTypeStyle('ENTITY')).toBe(WIKI_TYPE_STYLES.entity)
    expect(getWikiTypeStyle('Concept')).toBe(WIKI_TYPE_STYLES.concept)
  })

  it('trims surrounding whitespace', () => {
    expect(getWikiTypeStyle('  query  ')).toBe(WIKI_TYPE_STYLES.query)
  })

  it('returns fallback for null', () => {
    expect(getWikiTypeStyle(null)).toBe(FALLBACK_TYPE_STYLE)
  })

  it('returns fallback for undefined', () => {
    expect(getWikiTypeStyle(undefined)).toBe(FALLBACK_TYPE_STYLE)
  })

  it('returns fallback for empty string', () => {
    expect(getWikiTypeStyle('')).toBe(FALLBACK_TYPE_STYLE)
  })

  it('returns fallback for an unknown type', () => {
    expect(getWikiTypeStyle('zorbax')).toBe(FALLBACK_TYPE_STYLE)
  })

  it('covers every documented page type', () => {
    const expected = [
      'entity',
      'concept',
      'query',
      'source',
      'thesis',
      'finding',
      'methodology',
      'event',
      'overview',
    ]
    for (const t of expected) {
      const style = getWikiTypeStyle(t)
      expect(style).not.toBe(FALLBACK_TYPE_STYLE)
      expect(style.label.length).toBeGreaterThan(0)
      expect(style.chipClass).toContain('bg-')
      expect(style.dotClass).toContain('bg-')
    }
  })
})
