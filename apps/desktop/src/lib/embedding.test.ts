import type { EmbeddingConfig } from '@/stores/wiki-store'
import type { FileNode } from '@/types/wiki'
import { Domain } from 'llm-wiki-protocol'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockListDirectory = vi.fn<(path: string) => Promise<FileNode[]>>()
const mockEmbedPage = vi.fn<RelayClient['embedPage']>()
const mockEmbedTexts = vi.fn<RelayClient['embedTexts']>()
const mockVectorStats = vi.fn<RelayClient['vectorStats']>()
const mockVectorOptimize = vi.fn<RelayClient['vectorOptimize']>()
const mockVectorClear = vi.fn<RelayClient['vectorClear']>()
const mockVectorDeletePage = vi.fn<RelayClient['vectorDeletePage']>()
const mockVectorDropLegacy = vi.fn<RelayClient['vectorDropLegacy']>()

vi.mock('@/commands/fs', () => ({
  listDirectory: (path: string) => mockListDirectory(path),
}))

import { apiRelayClient, type RelayClient, setRelayClient } from './api-relay'
import {
  clearChunkVectorTable,
  dropLegacyVectorTable,
  embedAllPages,
  embedPage,
  fetchEmbedding,
  getEmbeddingCount,
  getEmbeddingReindexState,
  getLastEmbeddingError,
  legacyVectorRowCount,
  removePageEmbedding,
  resetEmbeddingStateForTests,
} from './embedding'

const projectPath = '/tmp/project'

const cfg: EmbeddingConfig = {
  enabled: true,
  endpoint: 'http://localhost:1234/v1/embeddings',
  apiKey: '',
  model: 'test-embed',
}

const ok = <A>(value: A) => Promise.resolve(value)

const pageResult = (pageId: string): Domain.EmbedPageResponse =>
  new Domain.EmbedPageResponse({
    projectId: projectPath,
    result: new Domain.PageEmbeddingResult({
      path: `wiki/${pageId}.md`,
      pageId,
      revision: 'rev',
      chunks: 2,
      vectorsWritten: 2,
      status: 'ok',
    }),
  })

const wikiTree = (): FileNode[] => [
  { name: 'alpha.md', path: '/tmp/project/wiki/alpha.md', is_dir: false },
  { name: 'index.md', path: '/tmp/project/wiki/index.md', is_dir: false },
  {
    name: 'concepts',
    path: '/tmp/project/wiki/concepts',
    is_dir: true,
    children: [{ name: 'beta.md', path: '/tmp/project/wiki/concepts/beta.md', is_dir: false }],
  },
]

const relayStub: RelayClient = {
  ...apiRelayClient,
  embedPage: mockEmbedPage,
  embedTexts: mockEmbedTexts,
  vectorStats: mockVectorStats,
  vectorOptimize: mockVectorOptimize,
  vectorClear: mockVectorClear,
  vectorDeletePage: mockVectorDeletePage,
  vectorDropLegacy: mockVectorDropLegacy,
}

beforeEach(() => {
  for (
    const mock of [
      mockListDirectory,
      mockEmbedPage,
      mockEmbedTexts,
      mockVectorStats,
      mockVectorOptimize,
      mockVectorClear,
      mockVectorDeletePage,
      mockVectorDropLegacy,
    ]
  ) {
    mock.mockReset()
  }
  mockListDirectory.mockResolvedValue(wikiTree())
  mockVectorOptimize.mockResolvedValue(new Domain.VectorOptimizeResponse({ ok: true }))
  mockVectorClear.mockResolvedValue(new Domain.VectorDeletedResponse({ ok: true, deleted: 4 }))
  mockVectorDropLegacy.mockResolvedValue(new Domain.VectorDropLegacyResponse({ ok: true, dropped: true }))
  resetEmbeddingStateForTests()
  setRelayClient(relayStub)
})

describe('fetchEmbedding', () => {
  it('returns the worker vector for the text', async () => {
    mockEmbedTexts.mockResolvedValueOnce(new Domain.EmbedTextsResponse({ vectors: [[0.5, 0.25]] }))

    await expect(fetchEmbedding('hello', cfg)).resolves.toEqual([0.5, 0.25])
    expect(mockEmbedTexts).toHaveBeenCalledWith({ texts: ['hello'] })
    expect(getLastEmbeddingError()).toBeNull()
  })

  it('skips the worker when embedding is disabled', async () => {
    await expect(fetchEmbedding('hello', { ...cfg, enabled: false })).resolves.toBeNull()
    await expect(fetchEmbedding('hello', { ...cfg, model: '' })).resolves.toBeNull()
    expect(mockEmbedTexts).not.toHaveBeenCalled()
  })

  it('surfaces a worker failure through getLastEmbeddingError', async () => {
    mockEmbedTexts.mockRejectedValueOnce(new Error('Embedding API HTTP 401'))

    await expect(fetchEmbedding('hello', cfg)).resolves.toBeNull()
    expect(getLastEmbeddingError()).toBe('Embedding API HTTP 401')
  })
})

describe('embedPage', () => {
  it('indexes the wiki page through the worker', async () => {
    mockEmbedPage.mockResolvedValueOnce(pageResult('alpha'))

    await expect(embedPage(projectPath, 'wiki/alpha.md')).resolves.toBe(true)
    expect(mockEmbedPage).toHaveBeenCalledWith({
      projectId: projectPath,
      path: 'wiki/alpha.md',
      force: true,
    })
  })

  it('reports a failed page without throwing', async () => {
    mockEmbedPage.mockRejectedValueOnce(new Error('Embedding provider unavailable'))

    await expect(embedPage(projectPath, 'wiki/alpha.md')).resolves.toBe(false)
    expect(getLastEmbeddingError()).toBe('Embedding provider unavailable')
  })
})

describe('embedAllPages', () => {
  it('embeds content pages, skipping aggregate stems, and reports progress', async () => {
    mockEmbedPage.mockImplementation((input) => ok(pageResult(input.path.replace(/^wiki\/|\.md$/g, ''))))
    const progress: Array<[number, number]> = []

    const count = await embedAllPages(projectPath, cfg, (done, total) => progress.push([done, total]))

    expect(count).toBe(2)
    expect(mockEmbedPage.mock.calls.map(([input]) => input.path)).toEqual([
      'wiki/alpha.md',
      'wiki/concepts/beta.md',
    ])
    expect(progress).toEqual([[1, 2], [2, 2]])
    expect(getEmbeddingReindexState()).toEqual({ kind: 'done', projectPath, count: 2 })
  })

  it('clears the index before a forced rebuild and then re-embeds every page', async () => {
    mockEmbedPage.mockImplementation((input) => ok(pageResult(input.path.replace(/^wiki\/|\.md$/g, ''))))

    await embedAllPages(projectPath, cfg, undefined, { clearExisting: true })

    expect(mockVectorClear).toHaveBeenCalledWith({ projectId: projectPath })
    expect(mockEmbedPage.mock.calls.every(([input]) => input.force === true)).toBe(true)
    expect(mockVectorOptimize).toHaveBeenCalledWith({ projectId: projectPath })
  })

  it('drops the obsolete legacy table once the forced rebuild re-indexed every page', async () => {
    mockEmbedPage.mockImplementation((input) => ok(pageResult(input.path.replace(/^wiki\/|\.md$/g, ''))))

    await embedAllPages(projectPath, cfg, undefined, { clearExisting: true })

    expect(mockVectorDropLegacy).toHaveBeenCalledWith({ projectId: projectPath })
  })

  it('keeps the legacy table when a forced rebuild left a page unindexed', async () => {
    mockEmbedPage.mockImplementation((input) =>
      input.path.endsWith('beta.md')
        ? Promise.reject(new Error('provider down'))
        : ok(pageResult('alpha'))
    )

    await expect(embedAllPages(projectPath, cfg, undefined, { clearExisting: true })).resolves.toBe(1)

    expect(mockVectorDropLegacy).not.toHaveBeenCalled()
  })

  it('keeps the legacy table during an incremental embed', async () => {
    mockEmbedPage.mockImplementation((input) => ok(pageResult(input.path.replace(/^wiki\/|\.md$/g, ''))))

    await embedAllPages(projectPath, cfg)

    expect(mockVectorDropLegacy).not.toHaveBeenCalled()
  })

  it('does not fail the forced rebuild when the legacy drop fails', async () => {
    mockEmbedPage.mockImplementation((input) => ok(pageResult(input.path.replace(/^wiki\/|\.md$/g, ''))))
    mockVectorDropLegacy.mockRejectedValueOnce(new Error('worker unreachable'))

    await expect(embedAllPages(projectPath, cfg, undefined, { clearExisting: true })).resolves.toBe(2)
    expect(getEmbeddingReindexState()).toEqual({ kind: 'done', projectPath, count: 2 })
  })

  it('leaves the existing index alone when the wiki tree has no content pages', async () => {
    mockListDirectory.mockResolvedValueOnce([])
    mockVectorStats.mockResolvedValueOnce(new Domain.VectorStatsResponse({ chunks: 12, legacyRows: 0 }))

    await expect(embedAllPages(projectPath, cfg, undefined, { clearExisting: true }))
      .rejects.toThrow('Existing index was left unchanged')

    expect(mockVectorClear).not.toHaveBeenCalled()
    expect(getEmbeddingReindexState()).toMatchObject({ kind: 'error' })
  })

  it('reports an error state when no page could be embedded', async () => {
    mockEmbedPage.mockRejectedValue(new Error('provider down'))

    await expect(embedAllPages(projectPath, cfg)).rejects.toThrow('None of the 2 pages could be embedded')

    expect(getEmbeddingReindexState()).toMatchObject({ kind: 'error' })
  })

  it('returns zero without touching the worker when embedding is disabled', async () => {
    await expect(embedAllPages(projectPath, { ...cfg, enabled: false })).resolves.toBe(0)
    expect(mockListDirectory).not.toHaveBeenCalled()
  })
})

describe('vector maintenance', () => {
  it('reads chunk and legacy counts from the worker', async () => {
    mockVectorStats.mockResolvedValue(new Domain.VectorStatsResponse({ chunks: 7, legacyRows: 3 }))

    await expect(getEmbeddingCount(projectPath)).resolves.toBe(7)
    await expect(legacyVectorRowCount(projectPath)).resolves.toBe(3)
  })

  it('reports zero when the worker cannot answer', async () => {
    mockVectorStats.mockRejectedValue(new Error('worker not running'))

    await expect(getEmbeddingCount(projectPath)).resolves.toBe(0)
    await expect(legacyVectorRowCount(projectPath)).resolves.toBe(0)
  })

  it('clears, deletes and drops through the worker', async () => {
    mockVectorDeletePage.mockResolvedValue(new Domain.VectorDeletedResponse({ ok: true, deleted: 1 }))

    await clearChunkVectorTable(projectPath)
    await removePageEmbedding(projectPath, 'alpha')
    await expect(dropLegacyVectorTable(projectPath)).resolves.toBe(true)

    expect(mockVectorClear).toHaveBeenCalledWith({ projectId: projectPath })
    expect(mockVectorDeletePage).toHaveBeenCalledWith({ projectId: projectPath, pageId: 'alpha' })
    expect(mockVectorDropLegacy).toHaveBeenCalledWith({ projectId: projectPath })
  })

  it('swallows a failed page-vector delete after the page is already gone', async () => {
    mockVectorDeletePage.mockRejectedValue(new Error('busy'))

    await expect(removePageEmbedding(projectPath, 'alpha')).resolves.toBeUndefined()
  })
})
