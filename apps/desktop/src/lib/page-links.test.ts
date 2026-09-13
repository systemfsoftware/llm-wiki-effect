import type { FileNode } from '@/types/wiki'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockListDirectory = vi.fn<(path: string) => Promise<FileNode[]>>()
const mockReadFile = vi.fn<(path: string) => Promise<string>>()

vi.mock('@/commands/fs', () => ({
  listDirectory: (path: string) => mockListDirectory(path),
  readFile: (path: string) => mockReadFile(path),
}))

import { getPageLinks } from './page-links'

const file = (name: string): FileNode => ({
  name,
  path: `/p/wiki/${name}`,
  is_dir: false,
})

const nested = (dir: string, names: string[]): FileNode => ({
  name: dir,
  path: `/p/wiki/${dir}`,
  is_dir: true,
  children: names.map((name) => ({
    name,
    path: `/p/wiki/${dir}/${name}`,
    is_dir: false,
  })),
})

beforeEach(() => {
  mockListDirectory.mockReset()
  mockReadFile.mockReset()
})

describe('getPageLinks', () => {
  it('separates resolved outgoing links from missing ones', async () => {
    mockListDirectory.mockResolvedValue([file('attention.md'), file('transformers.md')])
    mockReadFile.mockImplementation(async (path) => {
      if (path.endsWith('attention.md')) {
        return '---\ntitle: Attention\n---\nSee [[transformers]] and [[Missing Page]].'
      }
      return '# Transformers\n\nbody'
    })

    const links = await getPageLinks('/p', '/p/wiki/attention.md')

    expect(links.outgoing).toEqual([{ title: 'Transformers', path: 'wiki/transformers.md' }])
    expect(links.missing).toEqual([{ title: 'Missing Page' }])
    expect(links.backlinks).toEqual([])
  })

  it('collects backlinks with a snippet around the referenced title', async () => {
    mockListDirectory.mockResolvedValue([file('attention.md'), file('transformers.md')])
    mockReadFile.mockImplementation(async (path) => {
      if (path.endsWith('attention.md')) return '# Attention\n\nbody'
      return '# Transformers\n\nSee [[attention]] — Attention is all you need, and then some more text follows here.'
    })

    const links = await getPageLinks('/p', '/p/wiki/attention.md')

    expect(links.backlinks).toHaveLength(1)
    expect(links.backlinks[0]?.path).toBe('wiki/transformers.md')
    expect(links.backlinks[0]?.snippet).toContain('Attention is all you need')
  })

  it('resolves path-shaped links exactly and nested bare links by filename', async () => {
    mockListDirectory.mockResolvedValue([file('index.md'), nested('concepts', ['beta.md'])])
    mockReadFile.mockImplementation(async (path) => {
      if (path.endsWith('index.md')) return '[[wiki/concepts/beta.md]] and [[beta]]'
      return '# Beta\n\nbody'
    })

    const links = await getPageLinks('/p', '/p/wiki/index.md')

    expect(links.outgoing).toEqual([{ title: 'Beta', path: 'wiki/concepts/beta.md' }])
  })

  it('deduplicates repeated links to the same page', async () => {
    mockListDirectory.mockResolvedValue([file('index.md'), file('beta.md')])
    mockReadFile.mockImplementation(async (path) =>
      path.endsWith('index.md') ? '[[beta]] [[beta]] [[beta|alias]]' : '# Beta\n\nbody'
    )

    const links = await getPageLinks('/p', '/p/wiki/index.md')

    expect(links.outgoing).toEqual([{ title: 'Beta', path: 'wiki/beta.md' }])
  })

  it('falls back to the file name when no frontmatter title or heading exists', async () => {
    mockListDirectory.mockResolvedValue([file('attention.md'), file('index.md')])
    mockReadFile.mockImplementation(async (path) => path.endsWith('index.md') ? '[[attention]]' : 'no heading here')

    const links = await getPageLinks('/p', '/p/wiki/index.md')

    expect(links.outgoing).toEqual([{ title: 'attention', path: 'wiki/attention.md' }])
  })

  it('rejects a target outside the project wiki', async () => {
    await expect(getPageLinks('/p', '/p/raw/sources/note.md')).rejects.toThrow(
      'Markdown file under wiki/',
    )
    expect(mockListDirectory).not.toHaveBeenCalled()
  })

  it('rejects a page that is not in the wiki index', async () => {
    mockListDirectory.mockResolvedValue([file('index.md')])
    mockReadFile.mockResolvedValue('# Index')

    await expect(getPageLinks('/p', '/p/wiki/gone.md')).rejects.toThrow(
      'not available in the current wiki index',
    )
  })
})
