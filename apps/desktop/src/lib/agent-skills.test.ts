import type { FileNode } from '@/types/wiki'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type ListDirectoryArgs = { maxDepth?: number }

const mockListDirectory = vi.fn<(path: string, options?: ListDirectoryArgs) => Promise<FileNode[]>>()
const mockReadFile = vi.fn<(path: string) => Promise<string>>()
const mockHomeDir = vi.fn<() => Promise<string>>()

vi.mock('@/commands/fs', () => ({
  listDirectory: (path: string, options?: ListDirectoryArgs) => mockListDirectory(path, options),
  readFile: (path: string) => mockReadFile(path),
}))

vi.mock('@tauri-apps/api/path', () => ({
  homeDir: () => mockHomeDir(),
}))

import { listAvailableAgentSkills } from './agent-skills'

const skillFile = (path: string): FileNode => ({ name: 'SKILL.md', path, is_dir: false })
const dir = (path: string, name: string, children: FileNode[]): FileNode => ({
  name,
  path,
  is_dir: true,
  children,
})

beforeEach(() => {
  mockListDirectory.mockReset()
  mockReadFile.mockReset()
  mockHomeDir.mockReset()
  mockHomeDir.mockResolvedValue('/home/me')
  mockListDirectory.mockRejectedValue(new Error('Path does not exist'))
})

describe('listAvailableAgentSkills', () => {
  it('derives ids from SKILL.md folders and flat markdown files', async () => {
    mockListDirectory.mockImplementation(async (path) => {
      if (path === '/project/.llm-wiki/skills') {
        return [
          dir('/project/.llm-wiki/skills/pdf', 'pdf', [
            skillFile('/project/.llm-wiki/skills/pdf/SKILL.md'),
          ]),
          { name: 'notes.md', path: '/project/.llm-wiki/skills/notes.md', is_dir: false },
        ]
      }
      return []
    })
    mockReadFile.mockImplementation(async (path) => {
      if (path.endsWith('/pdf/SKILL.md')) {
        return '---\nname: PDF Tools\ndescription: Handle PDFs\n---\nDo the thing.\n'
      }
      return '---\ndescription: Loose notes\n---\nBody.\n'
    })

    const skills = await listAvailableAgentSkills('/project')

    expect(skills).toEqual([
      { id: 'notes', name: 'notes', description: 'Loose notes', source: 'project' },
      { id: 'pdf', name: 'PDF Tools', description: 'Handle PDFs', source: 'project' },
    ])
  })

  it('requires a description and non-empty instructions', async () => {
    mockListDirectory.mockImplementation(async (path) =>
      path === '/project/.llm-wiki/skills'
        ? [
          { name: 'no-desc.md', path: '/project/.llm-wiki/skills/no-desc.md', is_dir: false },
          { name: 'no-body.md', path: '/project/.llm-wiki/skills/no-body.md', is_dir: false },
        ]
        : []
    )
    mockReadFile.mockImplementation(async (path) =>
      path.endsWith('no-desc.md')
        ? '---\nname: x\n---\nBody.\n'
        : '---\ndescription: described\n---\n\n'
    )

    expect(await listAvailableAgentSkills('/project')).toEqual([])
  })

  it('skips ids that are not portable file names', async () => {
    mockListDirectory.mockImplementation(async (path) =>
      path === '/project/.llm-wiki/skills'
        ? [{ name: 'CON.md', path: '/project/.llm-wiki/skills/CON.md', is_dir: false }]
        : []
    )
    mockReadFile.mockResolvedValue('---\ndescription: reserved\n---\nBody.\n')

    expect(await listAvailableAgentSkills('/project')).toEqual([])
  })

  it('keeps the project skill when a user root defines the same id', async () => {
    mockListDirectory.mockImplementation(async (path) => {
      if (path === '/project/.llm-wiki/skills') {
        return [{ name: 'shared.md', path: '/project/.llm-wiki/skills/shared.md', is_dir: false }]
      }
      if (path === '/home/me/.claude/skills') {
        return [{ name: 'shared.md', path: '/home/me/.claude/skills/shared.md', is_dir: false }]
      }
      return []
    })
    mockReadFile.mockImplementation(async (path) =>
      path.startsWith('/project')
        ? '---\ndescription: project copy\n---\nBody.\n'
        : '---\ndescription: user copy\n---\nBody.\n'
    )

    const skills = await listAvailableAgentSkills('/project')

    expect(skills).toEqual([
      { id: 'shared', name: 'shared', description: 'project copy', source: 'project' },
    ])
  })

  it('lists only the project root when the home directory is unavailable', async () => {
    mockHomeDir.mockRejectedValue(new Error('no home'))
    mockListDirectory.mockImplementation(async (path) =>
      path === '/project/.llm-wiki/skills'
        ? [{ name: 'only.md', path: '/project/.llm-wiki/skills/only.md', is_dir: false }]
        : []
    )
    mockReadFile.mockResolvedValue('---\ndescription: only\n---\nBody.\n')

    const skills = await listAvailableAgentSkills('/project')

    expect(skills.map((skill) => skill.source)).toEqual(['project'])
    expect(mockListDirectory).toHaveBeenCalledTimes(1)
  })
})
