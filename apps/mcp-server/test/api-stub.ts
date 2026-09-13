import { Effect } from 'effect'
import { Domain } from 'llm-wiki-protocol'
import type { LlmWikiApi } from '../src/api-client.js'

export interface StubCall {
  readonly tag: string
  readonly request: unknown
}

export interface StubApi {
  readonly api: LlmWikiApi
  readonly calls: ReadonlyArray<StubCall>
}

export const healthFixture = (mcpEnabled = true): Domain.Health =>
  new Domain.Health({
    ok: true,
    status: 'running',
    version: '0.4.26',
    authRequired: false,
    authConfigured: false,
    tokenSource: 'none',
    enabled: true,
    mcpEnabled,
    allowUnauthenticated: false,
    allowLanAccess: false,
    agent: new Domain.HealthAgent({ chat: true, streaming: true, streamProtocol: 'ndjson' }),
  })

export const projectFixture = new Domain.Project({
  id: 'p1',
  name: 'Demo',
  path: '/wiki/demo',
  current: true,
})

export const projectsFixture = (): Domain.ProjectsResponse =>
  new Domain.ProjectsResponse({ projects: [projectFixture], currentProject: projectFixture })

export const filesFixture = (): Domain.FilesResponse =>
  new Domain.FilesResponse({
    projectId: 'p1',
    root: 'wiki',
    truncated: false,
    files: [
      new Domain.FileNode({
        name: 'wiki',
        path: 'wiki',
        isDir: true,
        size: null,
        children: [
          new Domain.FileNode({ name: 'index.md', path: 'wiki/index.md', isDir: false, size: 16, children: null }),
        ],
      }),
    ],
  })

export const fileContentFixture = (): Domain.FileContentResponse =>
  new Domain.FileContentResponse({ projectId: 'p1', path: 'wiki/index.md', content: '# Index\n\nHello.' })

export const reviewsFixture = (): Domain.ReviewsResponse =>
  new Domain.ReviewsResponse({
    projectId: 'p1',
    status: 'unresolved',
    count: 1,
    reviews: [
      new Domain.ReviewItem({
        id: 'r1',
        type: 'missing-page',
        title: 'Missing page: Attention',
        description: 'Add the Attention page',
        options: [new Domain.ReviewOption({ label: 'Create', action: 'create' })],
        resolved: false,
        createdAt: 1,
      }),
    ],
  })

export const searchFixture = (): Domain.SearchResponse =>
  new Domain.SearchResponse({
    projectId: 'p1',
    mode: 'hybrid',
    note: 'hybrid retrieval',
    tokenHits: 2,
    vectorHits: 1,
    graphHits: 0,
    results: [
      new Domain.SearchResult({
        path: 'wiki/a.md',
        title: 'A',
        snippet: 'a snippet',
        titleMatch: true,
        score: 0.5,
        vectorScore: 0.9,
        images: [],
      }),
    ],
  })

export const chatFixture = (): Domain.ChatResponse =>
  new Domain.ChatResponse({
    projectId: 'p1',
    sessionId: 's1',
    mode: 'standard',
    message: new Domain.ChatMessage({ role: 'assistant', content: 'answer' }),
    references: [
      new Domain.ChatReference({ title: 'A', path: 'wiki/a.md', kind: 'wiki', snippet: 'hit', score: 0.5 }),
    ],
    toolEvents: [new Domain.ChatToolEvent({ tool: 'wiki.search', status: 'completed', detail: '1 result' })],
    events: [new Domain.AgentMessageDeltaEvent({ type: 'messageDelta', text: 'answer' })],
    usage: new Domain.ChatUsage({
      promptChars: 100,
      completionChars: 6,
      referenceCount: 1,
      toolEventCount: 1,
    }),
  })

export const graphFixture = (): Domain.GraphResponse =>
  new Domain.GraphResponse({
    projectId: 'p1',
    nodes: [
      new Domain.GraphNode({
        id: 'n1',
        label: 'Attention',
        nodeType: 'concept',
        path: 'wiki/concepts/attention.md',
        linkCount: 4,
      }),
    ],
    edges: [new Domain.GraphEdge({ source: 'n1', target: 'n2', weight: 0.75 })],
  })

export const rescanFixture = (): Domain.RescanSourcesResponse =>
  new Domain.RescanSourcesResponse({
    projectId: 'p1',
    result: new Domain.RescanResult({
      queue: new Domain.FileChangeQueue({ version: 1, tasks: [] }),
      changedTasks: [],
    }),
  })

export const embedFixture = (): Domain.EmbedPageResponse =>
  new Domain.EmbedPageResponse({
    projectId: 'p1',
    result: new Domain.PageEmbeddingResult({
      path: 'wiki/ideas/example.md',
      pageId: 'page',
      revision: 'sha256:abc',
      chunks: 2,
      vectorsWritten: 2,
      status: 'indexed',
    }),
  })

const notStubbed = (tag: string) => () => Effect.die(new Error(`${tag} was not stubbed`))

const defaultApi: LlmWikiApi = {
  health: () => Effect.succeed(healthFixture()),
  projects: () => Effect.succeed(projectsFixture()),
  files: notStubbed('files'),
  fileContent: notStubbed('fileContent'),
  reviews: notStubbed('reviews'),
  search: notStubbed('search'),
  chat: notStubbed('chat'),
  chatCancel: notStubbed('chatCancel'),
  graph: notStubbed('graph'),
  rescanSources: notStubbed('rescanSources'),
  embedPage: notStubbed('embedPage'),
}

const recording = (api: LlmWikiApi, calls: Array<StubCall>): LlmWikiApi =>
  new Proxy(api, {
    get: (target, property, receiver) => {
      const operation = Reflect.get(target, property, receiver)
      if (typeof property !== 'string' || typeof operation !== 'function') return operation
      return (request: unknown) => {
        calls.push({ tag: property, request })
        return operation.call(target, request)
      }
    },
  })

export const startStub = (overrides: Partial<LlmWikiApi> = {}): StubApi => {
  const calls: Array<StubCall> = []
  const api = Object.assign({}, defaultApi, overrides)
  return { api: recording(api, calls), calls }
}
