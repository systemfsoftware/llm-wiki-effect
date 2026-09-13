import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockInvoke = vi.fn<(...args: unknown[]) => Promise<unknown>>()

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}))

import { searchWiki, tokenizeQuery } from './search'

beforeEach(() => {
  mockInvoke.mockReset()
})

describe('searchWiki worker wrapper', () => {
  it('absolutizes worker-relative result paths for the editor', async () => {
    mockInvoke.mockResolvedValueOnce({
      ok: true,
      value: {
        projectId: '/tmp/project',
        mode: 'hybrid',
        note: '',
        tokenHits: 1,
        vectorHits: 1,
        graphHits: 0,
        results: [
          {
            path: '/wiki/concepts/attention.md',
            title: 'Attention',
            snippet: 'Attention',
            titleMatch: true,
            score: 1 / 61,
            vectorScore: 0.5,
            images: [],
          },
        ],
      },
    })

    const out = await searchWiki('/tmp/project', 'attention')

    expect(out[0]?.path).toBe('/tmp/project/wiki/concepts/attention.md')
    expect(out[0]?.vectorScore).toBe(0.5)
  })

  it('keeps CJK tokenization behavior for image caption filtering', () => {
    const tokens = tokenizeQuery('默会知识')
    expect(tokens).toContain('默会')
    expect(tokens).toContain('知识')
    expect(tokens).toContain('默')
  })
})
