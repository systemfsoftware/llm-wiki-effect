// Ported from the graph builder in apps/desktop/src-tauri/src/api_server.rs.

import { Context, Effect, Layer } from 'effect'
import { Domain, Errors } from 'llm-wiki-protocol'
import { type Dirent } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { extname, join, relative, sep } from 'node:path'
import { ProjectRegistry } from '../projects/Registry.js'
import { extractTitle, extractType, extractWikilinks } from './markdown.js'

const DEFAULT_MAX_NODES = 200
const HARD_MAX_NODES = 1_000

interface MarkdownFile {
  readonly id: string
  readonly absolutePath: string
  readonly fileName: string
}

interface WikiPage {
  readonly id: string
  readonly path: string
  readonly label: string
  readonly nodeType: string
  readonly links: ReadonlyArray<string>
}

export interface GraphQuery {
  readonly q?: string
  readonly nodeType?: string
  readonly limit?: number
}

export interface GraphBuilderShape {
  readonly build: (
    projectId: string,
    query?: GraphQuery,
  ) => Effect.Effect<Domain.GraphResponse, Errors.InvalidRequest | Errors.NotFound>
}

const compareCodePoints = (left: string, right: string): number => {
  let leftIndex = 0
  let rightIndex = 0
  while (leftIndex < left.length && rightIndex < right.length) {
    const leftCode = left.codePointAt(leftIndex)
    const rightCode = right.codePointAt(rightIndex)
    if (leftCode === undefined || rightCode === undefined) break
    if (leftCode !== rightCode) return leftCode < rightCode ? -1 : 1
    leftIndex += leftCode > 0xffff ? 2 : 1
    rightIndex += rightCode > 0xffff ? 2 : 1
  }
  return left.length - leftIndex - (right.length - rightIndex)
}

const collectMarkdownFiles = (directory: string): Effect.Effect<Array<MarkdownFile>> =>
  Effect.gen(function*() {
    const entries = yield* Effect.promise(async () => {
      try {
        return await readdir(directory, { withFileTypes: true })
      } catch {
        return [] as Array<Dirent>
      }
    })
    const files: Array<MarkdownFile> = []
    for (const entry of entries) {
      const absolutePath = join(directory, entry.name)
      if (entry.isFile()) {
        if (extname(entry.name) !== '.md') continue
        const id = entry.name.slice(0, entry.name.length - '.md'.length)
        if (id === '') continue
        files.push({ id, absolutePath, fileName: entry.name })
      } else if (entry.isDirectory()) {
        files.push(...(yield* collectMarkdownFiles(absolutePath)))
      }
    }
    return files
  })

const readMarkdown = (path: string): Effect.Effect<string | undefined> =>
  Effect.promise(async () => {
    try {
      return await readFile(path, 'utf8')
    } catch {
      return undefined
    }
  })

const relativeToProject = (root: string, path: string): string => {
  const projectRelative = relative(root, path)
  return (projectRelative.startsWith('..') ? path : projectRelative).split(sep).join('/')
}

const resolveLink = (
  raw: string,
  ids: ReadonlySet<string>,
  orderedIds: ReadonlyArray<string>,
): string | undefined => {
  if (ids.has(raw)) return raw
  const normalized = raw.toLowerCase().replaceAll(' ', '-')
  const lowerRaw = raw.toLowerCase()
  for (const id of orderedIds) {
    const lowerId = id.toLowerCase()
    if (lowerId === normalized || lowerId === lowerRaw) return id
  }
  return undefined
}

const buildGraph = (
  root: string,
): Effect.Effect<{
  readonly nodes: ReadonlyArray<Domain.GraphNode>
  readonly edges: ReadonlyArray<Domain.GraphEdge>
}> =>
  Effect.gen(function*() {
    const files = yield* collectMarkdownFiles(join(root, 'wiki'))
    const byId = new Map<string, WikiPage>()
    for (const file of files) {
      const content = yield* readMarkdown(file.absolutePath)
      if (content === undefined) continue
      byId.set(file.id, {
        id: file.id,
        path: relativeToProject(root, file.absolutePath),
        label: extractTitle(content, file.fileName),
        nodeType: extractType(content),
        links: extractWikilinks(content),
      })
    }

    const ordered = [...byId.values()].sort((left, right) => compareCodePoints(left.id, right.id))
    const orderedIds = ordered.map((page) => page.id)
    const ids = new Set(orderedIds)
    const linkCounts = new Map<string, number>()
    for (const id of orderedIds) linkCounts.set(id, 0)

    const seenEdges = new Set<string>()
    const edges: Array<Domain.GraphEdge> = []
    for (const source of ordered) {
      for (const link of source.links) {
        const target = resolveLink(link, ids, orderedIds)
        if (target === undefined || target === source.id) continue
        const key = compareCodePoints(source.id, target) < 0
          ? `${source.id}::${target}`
          : `${target}::${source.id}`
        if (seenEdges.has(key)) continue
        seenEdges.add(key)
        linkCounts.set(source.id, (linkCounts.get(source.id) ?? 0) + 1)
        linkCounts.set(target, (linkCounts.get(target) ?? 0) + 1)
        edges.push(new Domain.GraphEdge({ source: source.id, target, weight: 1 }))
      }
    }

    const nodes = ordered
      .filter((page) => page.nodeType !== 'query')
      .map(
        (page) =>
          new Domain.GraphNode({
            id: page.id,
            label: page.label,
            nodeType: page.nodeType,
            path: page.path,
            linkCount: linkCounts.get(page.id) ?? 0,
          }),
      )
    return { nodes, edges }
  })

const graphLimit = (limit: number | undefined): number =>
  limit === undefined || !Number.isInteger(limit)
    ? DEFAULT_MAX_NODES
    : Math.min(Math.max(limit, 1), HARD_MAX_NODES)

export class GraphBuilder extends Context.Service<GraphBuilder, GraphBuilderShape>()(
  'llm-wiki-api-server/GraphBuilder',
  {
    make: Effect.gen(function*() {
      const registry = yield* ProjectRegistry

      const build: GraphBuilderShape['build'] = (projectId, query = {}) =>
        Effect.gen(function*() {
          const root = yield* registry.resolveRoot(projectId)
          const graph = yield* buildGraph(root)
          const needle = query.q?.toLowerCase()
          const nodeType = query.nodeType?.toLowerCase()
          let nodes = graph.nodes
          if (needle !== undefined) {
            nodes = nodes.filter(
              (node) =>
                node.id.toLowerCase().includes(needle) ||
                node.label.toLowerCase().includes(needle),
            )
          }
          if (nodeType !== undefined) {
            nodes = nodes.filter((node) => node.nodeType === nodeType)
          }
          nodes = nodes.slice(0, graphLimit(query.limit))
          const keptIds = new Set(nodes.map((node) => node.id))
          return new Domain.GraphResponse({
            projectId,
            nodes,
            edges: graph.edges.filter(
              (edge) => keptIds.has(edge.source) && keptIds.has(edge.target),
            ),
          })
        })

      return { build }
    }),
  },
) {
  static readonly layer: Layer.Layer<GraphBuilder, never, ProjectRegistry> = Layer.effect(
    GraphBuilder,
    GraphBuilder.make,
  )
}
