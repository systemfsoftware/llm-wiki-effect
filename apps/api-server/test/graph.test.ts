import { Effect, Layer } from 'effect'
import { array, assert, asyncProperty, constantFrom, property, string } from 'fast-check'
import { Domain } from 'llm-wiki-protocol'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { extractWikilinks, GraphBuilder, type GraphBuilderShape } from '../src/graph/index.js'
import { ProjectRegistry, type ProjectRegistryShape } from '../src/projects/Registry.js'

const PROJECT_ID = 'project-1'

const createdProjects: Array<string> = []

const makeProject = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'llm-wiki-graph-'))
  createdProjects.push(root)
  return root
}

const writeWiki = async (root: string, files: Record<string, string>): Promise<void> => {
  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = join(root, relativePath)
    await mkdir(dirname(absolutePath), { recursive: true })
    await writeFile(absolutePath, content)
  }
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
      setCurrent: () => Effect.die(new Error('setCurrent is not exercised by the graph suite')),
      resolveRoot: () => Effect.succeed(root),
    } satisfies ProjectRegistryShape,
  )

const call = <A, E>(
  root: string,
  f: (builder: GraphBuilderShape) => Effect.Effect<A, E>,
): Promise<A> =>
  Effect.runPromise(
    Effect.provide(
      Effect.flatMap(GraphBuilder, f),
      Layer.provide(GraphBuilder.layer, registryFor(root)),
    ),
  )

const wikiFixture: Record<string, string> = {
  'wiki/index.md': '---\ntitle: Home\ntype: overview\n---\n\n# Ignored Heading\n\nSee [[vector-db]] and [[hinton]].\n',
  'wiki/concepts/vector-db.md': '# Vector DB\n\ntype: concept\n\nLinks: [[hinton]] and [[vector-db]].\n',
  'wiki/entities/hinton.md': 'type: Entity\n\nSee [[index]].\n',
  'wiki/other/plain-note.md': 'Plain text with no links.\n',
  'wiki/queries/answer.md': 'type: query\n\nSee [[hinton]].\n',
}

describe('GraphBuilder', () => {
  it('builds nodes from wiki markdown and edges from wikilinks', async () => {
    const root = await makeProject()
    await writeWiki(root, wikiFixture)

    const response = await call(root, (builder) => builder.build(PROJECT_ID))

    expect(response).toBeInstanceOf(Domain.GraphResponse)
    expect(response.projectId).toBe(PROJECT_ID)
    expect(response.nodes).toEqual([
      { id: 'hinton', label: 'hinton', nodeType: 'entity', path: 'wiki/entities/hinton.md', linkCount: 3 },
      { id: 'index', label: 'Home', nodeType: 'overview', path: 'wiki/index.md', linkCount: 2 },
      {
        id: 'plain-note',
        label: 'plain note',
        nodeType: 'other',
        path: 'wiki/other/plain-note.md',
        linkCount: 0,
      },
      {
        id: 'vector-db',
        label: 'Vector DB',
        nodeType: 'concept',
        path: 'wiki/concepts/vector-db.md',
        linkCount: 2,
      },
    ])
    expect(response.nodes.every((node) => node instanceof Domain.GraphNode)).toBe(true)
    expect(response.edges).toEqual([
      new Domain.GraphEdge({ source: 'hinton', target: 'index', weight: 1 }),
      new Domain.GraphEdge({ source: 'index', target: 'vector-db', weight: 1 }),
      new Domain.GraphEdge({ source: 'vector-db', target: 'hinton', weight: 1 }),
    ])
  })

  it('counts links from excluded query nodes while dropping their edges', async () => {
    const root = await makeProject()
    await writeWiki(root, {
      'wiki/entities/hinton.md': 'type: entity\n',
      'wiki/queries/answer.md': 'type: query\n\nSee [[hinton]].\n',
    })

    const response = await call(root, (builder) => builder.build(PROJECT_ID))

    expect(response.nodes).toHaveLength(1)
    expect(response.nodes[0]?.linkCount).toBe(1)
    expect(response.edges).toEqual([])
  })

  it('filters by query text against the id and the label', async () => {
    const root = await makeProject()
    await writeWiki(root, wikiFixture)

    const byId = await call(root, (builder) => builder.build(PROJECT_ID, { q: 'VECTOR' }))
    expect(byId.nodes.map((node) => node.id)).toEqual(['vector-db'])
    expect(byId.edges).toEqual([])

    const byLabel = await call(root, (builder) => builder.build(PROJECT_ID, { q: 'home' }))
    expect(byLabel.nodes.map((node) => node.id)).toEqual(['index'])
    expect(byLabel.edges).toEqual([])
  })

  it('filters by node type and prunes edges to the surviving nodes', async () => {
    const root = await makeProject()
    await writeWiki(root, wikiFixture)

    const filtered = await call(root, (builder) => builder.build(PROJECT_ID, { nodeType: 'ENTITY' }))

    expect(filtered.nodes.map((node) => node.id)).toEqual(['hinton'])
    expect(filtered.edges).toEqual([])
  })

  it('truncates after filtering and keeps only edges inside the truncated node set', async () => {
    const root = await makeProject()
    await writeWiki(root, wikiFixture)

    const one = await call(root, (builder) => builder.build(PROJECT_ID, { limit: 1 }))
    expect(one.nodes.map((node) => node.id)).toEqual(['hinton'])
    expect(one.edges).toEqual([])

    const two = await call(root, (builder) => builder.build(PROJECT_ID, { limit: 2 }))
    expect(two.nodes.map((node) => node.id)).toEqual(['hinton', 'index'])
    expect(two.edges).toEqual([
      new Domain.GraphEdge({ source: 'hinton', target: 'index', weight: 1 }),
    ])
  })

  it('returns an empty graph when the project has no wiki tree', async () => {
    const root = await makeProject()
    const response = await call(root, (builder) => builder.build(PROJECT_ID))
    expect(response.nodes).toEqual([])
    expect(response.edges).toEqual([])
  })

  it('ignores files outside the markdown allow-list', async () => {
    const root = await makeProject()
    await writeWiki(root, {
      'wiki/index.md': 'type: overview\n\n[[notes]]\n',
      'wiki/notes.txt': 'notes',
      'wiki/notes.md.bak': 'notes',
      'wiki/nested/deeper/concept.md': 'type: concept\n\n[[index]]\n',
    })

    const response = await call(root, (builder) => builder.build(PROJECT_ID))

    expect(response.nodes.map((node) => node.id)).toEqual(['concept', 'index'])
    expect(response.edges).toEqual([
      new Domain.GraphEdge({ source: 'concept', target: 'index', weight: 1 }),
    ])
  })

  it('derives each node linkCount from its incident edges', async () => {
    const target = constantFrom('a', 'b', 'c', 'missing')
    const pageLinks = array(target, { maxLength: 4 })

    await assert(
      asyncProperty(pageLinks, pageLinks, pageLinks, async (linksA, linksB, linksC) => {
        const root = await makeProject()
        const page = (links: ReadonlyArray<string>): string =>
          `type: concept\n\n${links.map((link) => `[[${link}]]`).join(' ')}\n`
        await writeWiki(root, {
          'wiki/a.md': page(linksA),
          'wiki/b.md': page(linksB),
          'wiki/c.md': page(linksC),
        })

        const response = await call(root, (builder) => builder.build(PROJECT_ID))
        const ids = response.nodes.map((node) => node.id)

        expect(ids).toEqual([...ids].sort())
        const pairs = new Set(
          response.edges.map((edge) => [edge.source, edge.target].sort().join('::')),
        )
        expect(pairs.size).toBe(response.edges.length)
        for (const node of response.nodes) {
          const incident = response.edges.filter(
            (edge) => edge.source === node.id || edge.target === node.id,
          )
          expect(node.linkCount).toBe(incident.length)
        }
        for (const edge of response.edges) {
          expect(edge.weight).toBe(1)
          expect(edge.source).not.toBe(edge.target)
          expect(ids).toContain(edge.source)
          expect(ids).toContain(edge.target)
        }
      }),
      { numRuns: 100 },
    )
  })
})

describe('extractWikilinks', () => {
  it('takes the target of an aliased link and stops at an unterminated opener', () => {
    expect(extractWikilinks('[[target|alias]] and [[unterminated')).toEqual(['target'])
    expect(extractWikilinks('[[]] [[  spaced  ]]')).toEqual(['spaced'])
  })

  it('roundtrips plain links in order', () => {
    const target = string({ minLength: 1, maxLength: 10 })
      .map((value) => value.replaceAll('[', '').replaceAll(']', '').replaceAll('|', ''))
      .filter((value) => value.trim() !== '')

    assert(
      property(array(target, { maxLength: 6 }), (targets) => {
        expect(extractWikilinks(targets.map((value) => `[[${value}]]`).join(' '))).toEqual(
          targets.map((value) => value.trim()),
        )
      }),
      { numRuns: 200 },
    )
  })
})
