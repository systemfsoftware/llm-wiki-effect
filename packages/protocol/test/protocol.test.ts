import { Effect, Exit, Schema, Stream } from 'effect'
import { RpcTest } from 'effect/unstable/rpc'
import { describe, expect, it } from 'vitest'
import { Api, Catalog, Domain, Errors } from '../src/index.js'

const decodeOrThrow = <A>(
  schema: Schema.Codec<A, unknown>,
  input: unknown,
): A => {
  const exit = Schema.decodeUnknownExit(schema)(input)
  if (Exit.isFailure(exit)) {
    throw new Error(`unexpected decode failure for ${String(schema)}`)
  }
  return exit.value
}

const failureOf = <A, E extends { readonly _tag: string }>(
  exit: Exit.Exit<A, E>,
): { readonly reasons: ReadonlyArray<string>; readonly errors: ReadonlyArray<string> } => {
  if (Exit.isSuccess(exit)) {
    throw new Error('expected a failed exit')
  }
  return {
    reasons: exit.cause.reasons.map((reason) => reason._tag),
    errors: exit.cause.reasons.flatMap((reason) => reason._tag === 'Fail' ? [reason.error._tag] : []),
  }
}

const healthFixture = new Domain.Health({
  ok: true,
  status: 'running',
  version: '1.2.3',
  authRequired: false,
  authConfigured: false,
  tokenSource: 'none',
  enabled: true,
  mcpEnabled: true,
  allowUnauthenticated: false,
  allowLanAccess: false,
  agent: new Domain.HealthAgent({ chat: true, streaming: true, streamProtocol: 'ndjson' }),
})

const projectFixture = new Domain.Project({
  id: 'p1',
  name: 'Demo',
  path: '/tmp/demo',
  current: true,
})
const projectsFixture = new Domain.ProjectsResponse({
  projects: [projectFixture],
  currentProject: projectFixture,
})

const fileNodeFixture = new Domain.FileNode({
  name: 'wiki',
  path: 'wiki',
  isDir: true,
  size: null,
  children: [
    new Domain.FileNode({ name: 'a.md', path: 'wiki/a.md', isDir: false, size: 12, children: null }),
  ],
})
const filesFixture = new Domain.FilesResponse({
  projectId: 'p1',
  root: 'wiki',
  files: [fileNodeFixture],
  truncated: false,
})
const fileContentFixture = new Domain.FileContentResponse({
  projectId: 'p1',
  path: 'wiki/a.md',
  content: '# A',
})

const reviewItemFixture = new Domain.ReviewItem({
  id: 'review-1',
  type: 'missing-page',
  title: 'A',
  description: 'd',
  options: [new Domain.ReviewOption({ label: 'Create', action: 'create' })],
  resolved: false,
  createdAt: 1,
})
const reviewsFixture = new Domain.ReviewsResponse({
  projectId: 'p1',
  status: 'unresolved',
  count: 1,
  reviews: [reviewItemFixture],
})
const patchReviewFixture = new Domain.PatchReviewResponse({
  projectId: 'p1',
  reviewId: 'review-1',
  resolved: true,
})
const resolveReviewsFixture = new Domain.ResolveReviewsResponse({
  projectId: 'p1',
  resolved: ['review-1'],
  notFound: ['review-nope'],
  count: 1,
})

const searchFixture = new Domain.SearchResponse({
  projectId: 'p1',
  mode: 'hybrid',
  note: 'hybrid retrieval',
  tokenHits: 3,
  vectorHits: 1,
  graphHits: 0,
  results: [
    new Domain.SearchResult({
      path: 'wiki/a.md',
      title: 'A',
      snippet: 'a snippet',
      titleMatch: true,
      score: 1.5,
      images: [],
    }),
  ],
})
const graphFixture = new Domain.GraphResponse({
  projectId: 'p1',
  nodes: [
    new Domain.GraphNode({
      id: 'a',
      label: 'A',
      nodeType: 'concept',
      path: 'wiki/a.md',
      linkCount: 2,
    }),
  ],
  edges: [new Domain.GraphEdge({ source: 'a', target: 'b', weight: 1 })],
})
const embedPageFixture = new Domain.EmbedPageResponse({
  projectId: 'p1',
  result: new Domain.PageEmbeddingResult({
    path: 'wiki/a.md',
    pageId: 'a',
    revision: 'abcdef',
    chunks: 2,
    vectorsWritten: 2,
    status: 'indexed',
  }),
})
const rescanFixture = new Domain.RescanSourcesResponse({
  projectId: 'p1',
  result: new Domain.RescanResult({
    queue: new Domain.FileChangeQueue({ version: 1, tasks: [] }),
    changedTasks: [],
  }),
})

const chatFixture = new Domain.ChatResponse({
  projectId: 'p1',
  sessionId: 's1',
  mode: 'standard',
  message: new Domain.ChatMessage({ role: 'assistant', content: 'hi' }),
  references: [],
  toolEvents: [],
  events: [new Domain.AgentMessageDeltaEvent({ type: 'messageDelta', text: 'hi' })],
  usage: new Domain.ChatUsage({
    promptChars: 4,
    completionChars: 2,
    referenceCount: 0,
    toolEventCount: 0,
  }),
})
const chatCancelFixture = new Domain.ChatCancelResponse({ sessionId: 's1', cancelled: true })
const setCurrentProjectFixture = new Domain.SetCurrentProjectResponse({ project: projectFixture })
const reloadConfigFixture = new Domain.ReloadConfigResponse({ reloaded: true })

const chatPayload = { message: 'hi' }

const streamFrames = (): ReadonlyArray<
  Domain.ChatStreamMeta | Domain.ChatStreamAgentEvent | Domain.ChatStreamDone
> => [
  new Domain.ChatStreamMeta({ type: 'meta', projectId: 'p1', sessionId: 's1', runId: 'r1' }),
  new Domain.ChatStreamAgentEvent({
    type: 'agentEvent',
    event: new Domain.AgentMessageDeltaEvent({ type: 'messageDelta', text: 'hi' }),
  }),
  new Domain.ChatStreamDone({ type: 'done', response: chatFixture }),
]

const handlers = {
  health: () => Effect.succeed(healthFixture),
  projects: () => Effect.succeed(projectsFixture),
  files: () => Effect.succeed(filesFixture),
  fileContent: () => Effect.succeed(fileContentFixture),
  reviews: () => Effect.succeed(reviewsFixture),
  patchReview: () => Effect.succeed(patchReviewFixture),
  resolveReviews: () => Effect.succeed(resolveReviewsFixture),
  search: () => Effect.succeed(searchFixture),
  graph: () => Effect.succeed(graphFixture),
  rescanSources: () => Effect.succeed(rescanFixture),
  embedPage: () => Effect.succeed(embedPageFixture),
  chat: () => Effect.succeed(chatFixture),
  chatStream: () => Stream.fromIterable(streamFrames()),
  chatCancel: () => Effect.succeed(chatCancelFixture),
  setCurrentProject: () => Effect.succeed(setCurrentProjectFixture),
  reloadConfig: () => Effect.succeed(reloadConfigFixture),
}

const handlersLayer = Api.ApiProtocol.toLayer(handlers)

const clientProgram = <A, E>(f: (client: Api.ApiClient) => Effect.Effect<A, E>) =>
  Effect.gen(function*() {
    const client = yield* RpcTest.makeClient(Api.ApiProtocol)
    return yield* f(client)
  })

const withClient = <A, E>(f: (client: Api.ApiClient) => Effect.Effect<A, E>) =>
  clientProgram(f).pipe(Effect.scoped, Effect.provide(handlersLayer))

const withDisabledSearch = <A, E>(f: (client: Api.ApiClient) => Effect.Effect<A, E>) =>
  clientProgram(f).pipe(
    Effect.scoped,
    Effect.provide(
      Api.ApiProtocol.toLayer({
        ...handlers,
        search: () => Effect.fail(new Errors.McpDisabled({ message: 'MCP access is disabled' })),
      }),
    ),
  )

const roundtrips: ReadonlyArray<
  readonly [string, (client: Api.ApiClient) => Effect.Effect<unknown, unknown>, unknown]
> = [
  ['health', (client) => client.health(undefined), healthFixture],
  ['projects', (client) => client.projects(undefined), projectsFixture],
  ['files', (client) => client.files({ projectId: 'p1', root: 'wiki' }), filesFixture],
  [
    'fileContent',
    (client) => client.fileContent({ projectId: 'p1', path: 'wiki/a.md' }),
    fileContentFixture,
  ],
  ['reviews', (client) => client.reviews({ projectId: 'p1' }), reviewsFixture],
  [
    'patchReview',
    (client) => client.patchReview({ projectId: 'p1', reviewId: 'review-1', resolved: true }),
    patchReviewFixture,
  ],
  [
    'resolveReviews',
    (client) => client.resolveReviews({ projectId: 'p1', ids: ['review-1'] }),
    resolveReviewsFixture,
  ],
  ['search', (client) => client.search({ projectId: 'p1', query: 'a', topK: 10 }), searchFixture],
  ['graph', (client) => client.graph({ projectId: 'p1' }), graphFixture],
  ['rescanSources', (client) => client.rescanSources({ projectId: 'p1' }), rescanFixture],
  [
    'embedPage',
    (client) => client.embedPage({ projectId: 'p1', path: 'wiki/a.md' }),
    embedPageFixture,
  ],
  ['chat', (client) => client.chat(chatPayload), chatFixture],
  [
    'chatCancel',
    (client) => client.chatCancel({ projectId: 'p1', sessionId: 's1' }),
    chatCancelFixture,
  ],
  [
    'setCurrentProject',
    (client) => client.setCurrentProject({ projectId: 'p1' }),
    setCurrentProjectFixture,
  ],
  ['reloadConfig', (client) => client.reloadConfig(undefined), reloadConfigFixture],
]

const EXPECTED_OPERATIONS: ReadonlyArray<Api.ApiOperationName> = [
  'health',
  'projects',
  'files',
  'fileContent',
  'reviews',
  'patchReview',
  'resolveReviews',
  'search',
  'graph',
  'rescanSources',
  'embedPage',
  'chat',
  'chatStream',
  'chatCancel',
  'setCurrentProject',
  'reloadConfig',
]

const EXPECTED_MCP_MAPPED: ReadonlyArray<Api.ApiOperationName> = [
  'health',
  'projects',
  'files',
  'fileContent',
  'reviews',
  'search',
  'graph',
  'rescanSources',
  'embedPage',
  'chat',
]

describe('operation catalog', () => {
  it('declares the full operation surface, each mapped to its retired route', () => {
    expect(Catalog.ApiCatalog.map((entry) => entry.name)).toEqual(EXPECTED_OPERATIONS)
    for (const entry of Catalog.ApiCatalog) {
      expect(entry.restRoute.length).toBeGreaterThan(0)
      expect(entry.summary.length).toBeGreaterThan(0)
    }
    for (const entry of Catalog.ApiCatalog) {
      if (!entry.isMcpMapped) continue
      expect(entry.restRoute.startsWith('/api/v1/')).toBe(true)
    }
  })

  it('marks exactly the operations the MCP adapter dispatches', () => {
    expect(Catalog.McpMappedOperations).toEqual(EXPECTED_MCP_MAPPED)
  })

  it('publishes the live payload schema of each operation', () => {
    for (const entry of Catalog.ApiCatalog) {
      expect(Api.ApiProtocol.requests.get(entry.name)?.payloadSchema).toBe(entry.payload)
    }
  })

  it('exposes every catalogued operation in the RPC group', () => {
    for (const name of Catalog.ApiCatalogNames) {
      expect(Api.ApiProtocol.requests.has(name)).toBe(true)
    }
  })
})

describe('RpcTest roundtrips', () => {
  it.each(roundtrips)('%s returns the handler value', async (_name, run, expected) => {
    await expect(Effect.runPromise(withClient(run))).resolves.toEqual(expected)
  })

  it('streams chatStream chunks and terminates in the aggregate', async () => {
    const frames = await Effect.runPromise(
      withClient((client) => Stream.runCollect(client.chatStream(chatPayload))),
    )
    expect([...frames].map((frame) => frame.type)).toEqual(['meta', 'agentEvent', 'done'])
    expect([...frames][2]).toEqual(
      new Domain.ChatStreamDone({ type: 'done', response: chatFixture }),
    )
  })

  it('surfaces McpDisabled as a typed failure, never a defect', async () => {
    const search = { projectId: 'p1', query: 'a' }
    const exit = await Effect.runPromise(
      withDisabledSearch((client) => Effect.exit(client.search(search))),
    )
    const failure = failureOf(exit)
    expect(failure.reasons).toEqual(['Fail'])
    expect(failure.errors).toEqual(['McpDisabled'])
  })

  it('rejects a malformed payload at the schema boundary', () => {
    const decode = Schema.decodeUnknownExit(Api.SearchPayload)
    expect(Exit.isFailure(decode({ projectId: 'p1' }))).toBe(true)
    expect(Exit.isFailure(decode({ projectId: 'p1', query: 'a', topK: 'ten' }))).toBe(true)
    expect(Exit.isFailure(decode({ projectId: 'p1', query: 'a', topK: 10 }))).toBe(false)
  })

  it('drops an approval field injected into the chat payload', () => {
    const decoded = decodeOrThrow(Api.ChatPayload, {
      message: 'hi',
      approvedShellCommands: ['rm -rf /'],
    })
    expect('approvedShellCommands' in decoded).toBe(false)
    expect(decoded.message).toBe('hi')
  })
})

describe('wire decode', () => {
  it('decodes the REST health body', () => {
    const decoded = decodeOrThrow(Domain.Health, {
      ok: true,
      status: 'running',
      version: '0.1.0',
      authRequired: true,
      authConfigured: true,
      tokenSource: 'store',
      enabled: true,
      mcpEnabled: false,
      allowUnauthenticated: false,
      allowLanAccess: true,
      agent: { chat: true, streaming: true, streamProtocol: 'sse' },
    })
    expect(decoded.mcpEnabled).toBe(false)
    expect(decoded.agent.streamProtocol).toBe('sse')
  })

  it('decodes nested file nodes with null size and children', () => {
    const decoded = decodeOrThrow(Domain.FileNode, {
      name: 'wiki',
      path: 'wiki',
      isDir: true,
      size: null,
      children: [{ name: 'a.md', path: 'wiki/a.md', isDir: false, size: 7, children: null }],
    })
    expect(decoded.children?.[0]?.path).toBe('wiki/a.md')
    expect(decoded.children?.[0]?.children).toBeNull()
    expect(decoded.size).toBeNull()
  })

  it('decodes a minimal review item', () => {
    const decoded = decodeOrThrow(Domain.ReviewItem, {
      id: 'review-1',
      options: [{ label: 'Create', action: 'create' }],
    })
    expect(decoded.id).toBe('review-1')
    expect(decoded.resolved).toBeUndefined()
  })

  it('decodes the search body with graph hits and per-result content', () => {
    const decoded = decodeOrThrow(Domain.SearchResponse, {
      projectId: 'p1',
      mode: 'hybrid',
      note: 'note',
      tokenHits: 2,
      vectorHits: 1,
      graphHits: 1,
      results: [
        {
          path: 'wiki/a.md',
          title: 'A',
          snippet: 's',
          titleMatch: false,
          score: 0.5,
          vectorScore: 0.9,
          images: [{ url: 'u', alt: 'a' }],
          content: 'body',
          graphRelatedTo: ['B'],
        },
      ],
    })
    expect(decoded.results[0]?.graphRelatedTo).toEqual(['B'])
    expect(decoded.results[0]?.vectorScore).toBe(0.9)
    expect(decoded.results[0]?.content).toBe('body')
  })

  it('decodes the graph node type field', () => {
    const decoded = decodeOrThrow(Domain.GraphNode, {
      id: 'a',
      label: 'A',
      nodeType: 'concept',
      path: 'wiki/a.md',
      linkCount: 3,
    })
    expect(decoded.nodeType).toBe('concept')
    expect(decoded.linkCount).toBe(3)
  })

  it('decodes the external chat body including usage and events', () => {
    const decoded = decodeOrThrow(Domain.ChatResponse, {
      projectId: 'p1',
      sessionId: 's1',
      mode: 'standard',
      message: { role: 'assistant', content: 'hi' },
      references: [{ title: 'A', path: 'wiki/a.md', kind: 'wiki', score: 1 }],
      toolEvents: [{ tool: 'wiki.search', status: 'done' }],
      events: [{ type: 'toolStart', tool: 'wiki.search', input: 'q' }],
      usage: { promptChars: 1, completionChars: 2, referenceCount: 1, toolEventCount: 1 },
    })
    expect(decoded.events[0]?.type).toBe('toolStart')
    expect(decoded.usage?.toolEventCount).toBe(1)
    expect(decoded.references[0]?.score).toBe(1)
  })

  it('decodes the redacted fileChanged event without rollback content', () => {
    const decoded = decodeOrThrow(Domain.ChatResponse, {
      projectId: 'p1',
      sessionId: 's1',
      mode: 'standard',
      message: { role: 'assistant', content: '' },
      references: [],
      toolEvents: [],
      events: [
        {
          type: 'fileChanged',
          path: 'wiki/a.md',
          tool: 'workspace.write_file',
          existedBefore: true,
        },
      ],
    })
    const event = decoded.events[0]
    expect(event?.type).toBe('fileChanged')
    expect(event !== undefined && 'previousContent' in event).toBe(false)
  })

  it('rejects an unknown agent event variant', () => {
    const result = Schema.decodeUnknownExit(Domain.ChatResponse)({
      projectId: 'p1',
      sessionId: 's1',
      mode: 'standard',
      message: { role: 'assistant', content: '' },
      references: [],
      toolEvents: [],
      events: [{ type: 'someFutureEvent', payload: 1 }],
    })
    expect(Exit.isFailure(result)).toBe(true)
  })

  it('decodes the chat payload the REST server accepted', () => {
    const decoded = decodeOrThrow(Api.ChatPayload, {
      message: 'hi',
      sessionId: 'api_1',
      mode: 'deep',
      retrievalMode: 'faithful',
      tools: { wiki: true, web: false, anytxt: false },
      topK: 5,
      includeContent: true,
      skills: ['wiki'],
      persistSession: false,
    })
    expect(decoded.retrievalMode).toBe('faithful')
    expect(decoded.persistSession).toBe(false)
    expect(decoded.tools).toEqual(
      new Domain.AgentToolOptions({ wiki: true, web: false, anytxt: false }),
    )
  })
})

const ERROR_TAGS: ReadonlyArray<Errors.ApiErrorTag> = [
  'Unauthorized',
  'ApiDisabled',
  'NotFound',
  'InvalidRequest',
  'PathViolation',
  'UnsupportedMediaType',
  'TooLarge',
  'RateLimited',
  'Busy',
  'BindConflict',
  'McpDisabled',
  'ChatCancelled',
  'AgentError',
  'EmbedError',
]

const EXPECTED_EMBED_KINDS: ReadonlyArray<Errors.EmbedErrorKind> = [
  'InvalidRequest',
  'NotFound',
  'Provider',
  'Storage',
  'Conflict',
  'Timeout',
]

describe('retired status ledger', () => {
  it('maps every declared error tag to at least one retired site', () => {
    const sites = Errors.RETIRED_STATUS_SITES
    for (const site of sites) {
      if (site.error === null) continue
      expect(ERROR_TAGS).toContain(site.error)
    }
    for (const tag of ERROR_TAGS) {
      expect(sites.some((site) => site.error === tag)).toBe(true)
    }
  })

  it('records an embed kind for each EmbedError site, covering the kind enum', () => {
    const embedSites = Errors.RETIRED_STATUS_SITES.filter((site) => site.error === 'EmbedError')
    expect(embedSites).toHaveLength(8)
    for (const site of embedSites) {
      expect(site.embedKind).toBeDefined()
    }
    for (const kind of EXPECTED_EMBED_KINDS) {
      expect(embedSites.some((site) => site.embedKind === kind)).toBe(true)
    }
  })
})
