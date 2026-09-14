import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockInvoke = vi.fn<(...args: unknown[]) => Promise<unknown>>()

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}))

import { searchWiki } from './search'

const searchResponse = {
  projectId: '/tmp/project',
  mode: 'keyword',
  note: '',
  tokenHits: 1,
  vectorHits: 0,
  graphHits: 0,
  results: [
    {
      path: 'wiki/concepts/attention.md',
      title: 'Attention',
      snippet: 'body',
      titleMatch: true,
      score: 1 / 61,
      images: [],
    },
  ],
}

beforeEach(() => {
  mockInvoke.mockReset()
})

describe('searchWiki worker contract', () => {
  it('asks the worker for ranked results and maps relative wiki paths to absolute paths', async () => {
    mockInvoke.mockResolvedValueOnce({ ok: true, value: searchResponse })

    const results = await searchWiki('/tmp/project', 'attention')

    expect(mockInvoke).toHaveBeenCalledWith('api_rpc', {
      op: 'search',
      payload: {
        projectId: '/tmp/project',
        query: 'attention',
        topK: 20,
        includeContent: false,
      },
    })
    expect(results[0]?.path).toBe('/tmp/project/wiki/concepts/attention.md')
    expect(results[0]?.titleMatch).toBe(true)
  })

  it('returns no results without calling the worker for a blank query', async () => {
    const results = await searchWiki('/tmp/project', '   ')

    expect(results).toEqual([])
    expect(mockInvoke).not.toHaveBeenCalled()
  })
})
