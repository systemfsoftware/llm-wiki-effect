import { Effect, Option, Result, Schema } from 'effect'
import { array, constantFrom, sample } from 'fast-check'
import { Domain } from 'llm-wiki-protocol'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, normalize } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Files, makeFiles } from '../src/files/Files.js'
import type { FileContent, ReadError } from '../src/files/Files.js'
import { guardRelativePath, isWithinRoot, MAX_FILE_CONTENT_BYTES } from '../src/files/paths.js'

let tempRoot: string
let project: string

const REL_PARTS = [
  '..',
  '.',
  '..\\',
  'wiki',
  'raw',
  'sources',
  'concepts',
  'nested',
  'index.md',
  'a.md',
  'image.png',
  'C:',
  '/etc',
  '\\u0000',
  '%2e%2e',
  '',
]

const generatedRels = (): string[] =>
  sample(
    array(constantFrom(...REL_PARTS), { minLength: 1, maxLength: 5 }).map((parts) => parts.join('/')),
    { numRuns: 200 },
  )

const collectNames = (nodes: ReadonlyArray<Domain.FileNode>): ReadonlyArray<string> =>
  nodes.flatMap((node) => [node.name, ...collectNames(node.children ?? [])])

const outcomeName = (outcome: Result.Result<FileContent, ReadError>): string =>
  Result.isSuccess(outcome) ? 'success' : outcome.failure.name

const readContent = (rel: string) => Effect.runPromise(Effect.result(makeFiles().readContent(project, rel)))

beforeAll(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), 'llm-wiki-files-'))
  project = join(tempRoot, 'proj')
  const outside = join(tempRoot, 'outside')
  const sibling = join(tempRoot, 'proj-evil')

  await mkdir(join(project, 'wiki', 'concepts'), { recursive: true })
  await mkdir(join(project, 'wiki', 'media'), { recursive: true })
  await mkdir(join(project, 'wiki', 'folder.md'), { recursive: true })
  await mkdir(join(project, 'raw', 'sources'), { recursive: true })
  await mkdir(join(project, 'empty-project'), { recursive: true })
  await mkdir(outside, { recursive: true })
  await mkdir(sibling, { recursive: true })

  await writeFile(join(project, 'purpose.md'), '# Purpose\n', 'utf8')
  await writeFile(join(project, 'schema.md'), '# Schema\n', 'utf8')
  await writeFile(join(project, 'secret.md'), 'not-public\n', 'utf8')
  await writeFile(join(project, 'wiki', 'index.md'), '# Index\n', 'utf8')
  await writeFile(join(project, 'wiki', 'concepts', 'attention.md'), '# Attention\n', 'utf8')
  await writeFile(join(project, 'wiki', '.hidden.md'), '# Hidden\n', 'utf8')
  await writeFile(join(project, 'wiki', 'media', 'image.png'), Buffer.from([0x89, 0x50]))
  await writeFile(join(project, 'wiki', 'binary.md'), Buffer.from([0xff, 0xfe, 0x00, 0x81]))
  await writeFile(join(project, 'wiki', 'big.md'), 'x'.repeat(MAX_FILE_CONTENT_BYTES + 1), 'utf8')
  await writeFile(join(project, 'raw', 'sources', 'a.md'), '# Source A\n', 'utf8')
  await writeFile(join(project, 'raw', 'sources', '.keep'), '', 'utf8')
  await writeFile(join(outside, 'secret.md'), 'outside-secret\n', 'utf8')
  await writeFile(join(sibling, 'secret.md'), 'sibling-secret\n', 'utf8')
  await symlink(join(outside, 'secret.md'), join(project, 'raw', 'sources', 'link-out.md'))
  await symlink(join(sibling, 'secret.md'), join(project, 'wiki', 'link-sibling.md'))
})

afterAll(async () => {
  await rm(tempRoot, { recursive: true, force: true })
})

describe('file listing', () => {
  it('builds the public root tree in handler order with decodable protocol nodes', async () => {
    const nodes = await Effect.runPromise(makeFiles().list(project))

    expect(nodes.map((node) => node.name)).toEqual(['purpose.md', 'schema.md', 'wiki', 'sources'])
    for (const node of nodes) {
      expect(Option.isSome(Schema.decodeUnknownOption(Domain.FileNode)(node))).toBe(true)
    }
    expect(nodes[0]).toMatchObject({ path: 'purpose.md', isDir: false, size: 10, children: null })
    expect(nodes[2]).toMatchObject({ path: 'wiki', isDir: true, size: null })
    expect(nodes[2]?.children?.map((child) => child.name)).toEqual([
      'concepts',
      'folder.md',
      'media',
      'big.md',
      'binary.md',
      'index.md',
    ])
    expect(nodes[2]?.children?.[2]).toMatchObject({ path: 'wiki/media', isDir: true })
    expect(nodes[3]?.children?.map((child) => child.name)).toEqual(['a.md'])
  })

  it('lists only the requested root and skips hidden entries and symlinks', async () => {
    const nodes = await Effect.runPromise(makeFiles().list(project, 'wiki'))

    expect(nodes.map((node) => node.name)).toEqual([
      'concepts',
      'folder.md',
      'media',
      'big.md',
      'binary.md',
      'index.md',
    ])
    expect(nodes[0]?.children?.map((child) => child.name)).toEqual(['attention.md'])
    expect(nodes[1]?.children).toEqual([])
    expect(nodes[2]?.children?.map((child) => child.name)).toEqual(['image.png'])
    const names = collectNames(nodes)
    expect(names).not.toContain('.hidden.md')
    expect(names).not.toContain('link-sibling.md')
  })

  it('lists sources without children when recursion is off', async () => {
    const nodes = await Effect.runPromise(
      makeFiles().list(project, 'sources', { recursive: false }),
    )

    expect(nodes.map((node) => node.name)).toEqual(['a.md'])
    expect(nodes[0]?.children).toBeNull()
  })

  it('raises TooLarge when the listing exceeds maxFiles', async () => {
    const error = await Effect.runPromise(
      Effect.flip(makeFiles().list(project, undefined, { maxFiles: 2 })),
    )

    expect(error.name).toBe('TooLarge')
    expect(error.message).toBe('File listing exceeds maxFiles limit (2)')
  })

  it('rejects an unknown root selector and reports a missing directory', async () => {
    const invalid = await Effect.runPromise(Effect.flip(makeFiles().list(project, 'nope')))
    const missing = await Effect.runPromise(
      Effect.flip(makeFiles().list(join(project, 'empty-project'), 'wiki')),
    )

    expect(invalid.name).toBe('InvalidRequest')
    expect(invalid.message).toBe('root must be wiki, sources, or all')
    expect(missing.name).toBe('NotFound')
    expect(missing.message).toContain('Directory not found')
  })
})

describe('file content', () => {
  it('serves a public text file with the requested path echoed back', async () => {
    const files = makeFiles()
    const content = await Effect.runPromise(files.readContent(project, 'wiki/index.md'))
    const source = await Effect.runPromise(files.readContent(project, 'raw/sources/a.md'))

    expect(content).toEqual({ path: 'wiki/index.md', content: '# Index\n' })
    expect(source).toEqual({ path: 'raw/sources/a.md', content: '# Source A\n' })
  })

  it('rejects traversal, absolute, and non-public paths with PathViolation', async () => {
    const cases = [
      '../outside/secret.md',
      'wiki/../../outside/secret.md',
      '/etc/passwd',
      'secret.md',
      'wiki/./index.md',
      'wiki\\..\\secret.md',
    ]
    const verdicts: Array<string> = []
    for (const rel of cases) {
      const outcome = await readContent(rel)
      verdicts.push(Result.isSuccess(outcome) ? `read ${outcome.success.path}` : outcome.failure.name)
    }

    expect(verdicts).toEqual([
      'PathViolation',
      'PathViolation',
      'PathViolation',
      'PathViolation',
      'PathViolation',
      'PathViolation',
    ])
  })

  it('rejects symlinks that resolve outside the project', async () => {
    const escaping = await readContent('raw/sources/link-out.md')
    const sibling = await readContent('wiki/link-sibling.md')
    const safe = await readContent('wiki/index.md')

    expect(outcomeName(escaping)).toBe('PathViolation')
    expect(outcomeName(sibling)).toBe('PathViolation')
    expect(outcomeName(safe)).toBe('success')
  })

  it('gates binary media types and invalid UTF-8 with UnsupportedMediaType', async () => {
    const image = await readContent('wiki/media/image.png')
    const binary = await readContent('wiki/binary.md')

    expect(outcomeName(image)).toBe('UnsupportedMediaType')
    expect(outcomeName(binary)).toBe('UnsupportedMediaType')
  })

  it('gates oversized files with TooLarge and missing files with NotFound', async () => {
    const big = await readContent('wiki/big.md')
    const missing = await readContent('wiki/missing.md')
    const directory = await readContent('wiki/folder.md')
    const nonTextPath = await readContent('wiki/concepts')

    expect(outcomeName(big)).toBe('TooLarge')
    expect(outcomeName(missing)).toBe('NotFound')
    expect(outcomeName(directory)).toBe('NotFound')
    expect(outcomeName(nonTextPath)).toBe('UnsupportedMediaType')
  })
})

describe('path containment', () => {
  it('treats a sibling directory sharing a prefix as outside', () => {
    expect(isWithinRoot('/a/proj', '/a/proj/wiki/index.md')).toBe(true)
    expect(isWithinRoot('/a/proj', '/a/proj-evil/secret.md')).toBe(false)
    expect(isWithinRoot('/a/proj', '/a/proj')).toBe(true)
  })

  it('accepts only relative, dot-free segments', () => {
    expect(Result.isSuccess(guardRelativePath('wiki/index.md'))).toBe(true)
    expect(Result.isSuccess(guardRelativePath('/wiki/index.md'))).toBe(true)
    expect(Result.isFailure(guardRelativePath('../app-state.json'))).toBe(true)
    expect(Result.isFailure(guardRelativePath('C:\\app-state.json'))).toBe(true)
    expect(Result.isFailure(guardRelativePath('//server/share/x.md'))).toBe(true)
    expect(Result.isFailure(guardRelativePath('wiki\u0000.md'))).toBe(true)
  })

  it('never yields a path outside the root for any generated relative path', () => {
    const root = '/project/root'
    const escaping = generatedRels().filter((rel) => {
      const guarded = guardRelativePath(rel)
      if (Result.isFailure(guarded)) return false
      return (
        guarded.success.split('/').includes('..') ||
        !isWithinRoot(root, normalize(join(root, guarded.success)))
      )
    })

    expect(escaping).toEqual([])
  })

  it('keeps every readable path inside the project for any generated path', async () => {
    const rootReal = await realpath(project)
    const leaks: Array<string> = []
    for (const rel of generatedRels()) {
      const outcome = await readContent(rel)
      if (Result.isSuccess(outcome)) {
        const resolved = await realpath(join(project, outcome.success.path))
        if (!isWithinRoot(rootReal, resolved) || outcome.success.content === 'outside-secret\n') {
          leaks.push(`read ${outcome.success.path}`)
        }
        continue
      }
      const readable: Array<string> = [
        'PathViolation',
        'UnsupportedMediaType',
        'NotFound',
        'TooLarge',
        'InvalidRequest',
      ]
      if (!readable.includes(outcome.failure.name)) {
        leaks.push(`${rel}: ${outcome.failure.name}`)
      }
    }

    expect(leaks).toEqual([])
  })
})

describe('files service layer', () => {
  it('serves reads through the layer', async () => {
    const content = await Effect.runPromise(
      Effect.provide(
        Files.use((files) => files.readContent(project, 'purpose.md')),
        Files.layer,
      ),
    )

    expect(content.content).toBe('# Purpose\n')
  })
})
