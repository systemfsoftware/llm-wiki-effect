import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js'
import type { CallToolResult, CompatibilityCallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { Effect } from 'effect'
import { Errors } from 'llm-wiki-protocol'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { type LlmWikiApi, LlmWikiApiClient } from '../src/api-client.js'
import { McpProjectBinding } from '../src/project-binding.js'
import { createMcpServer } from '../src/server.js'
import {
  chatFixture,
  embedFixture,
  fileContentFixture,
  filesFixture,
  graphFixture,
  healthFixture,
  rescanFixture,
  reviewsFixture,
  searchFixture,
  startStub,
} from './api-stub.js'

interface Harness {
  readonly mcp: Client
  readonly calls: ReadonlyArray<{ readonly tag: string; readonly request: unknown }>
  readonly binding: McpProjectBinding
}

const startToolServer = async (overrides: Partial<LlmWikiApi> = {}): Promise<Harness> => {
  const stub = startStub(overrides)
  const binding = new McpProjectBinding()
  const server = createMcpServer({ client: new LlmWikiApiClient({ api: stub.api }), binding })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const mcp = new Client({ name: 'llm-wiki-test', version: '0' })
  await mcp.connect(clientTransport)
  return { mcp, calls: stub.calls, binding }
}

type CallToolOutcome = CallToolResult | CompatibilityCallToolResult

const textBlock = (value: unknown): string | null => {
  if (typeof value !== 'object' || value === null) return null
  if (!('type' in value) || value.type !== 'text') return null
  if (!('text' in value) || typeof value.text !== 'string') return null
  return value.text
}

const toolText = (result: CallToolOutcome): string => {
  const content: unknown = Reflect.get(result, 'content')
  const first: unknown = Array.isArray(content) ? content[0] : undefined
  const text = textBlock(first)
  if (text === null) throw new Error('tool result carried no text content')
  return text
}

const call = async (harness: Harness, name: string, args: Record<string, unknown> = {}): Promise<string> =>
  toolText(await harness.mcp.callTool({ name, arguments: args }))

const mcpError = (predicate: (error: McpError) => void) => (error: unknown): boolean => {
  assert.ok(error instanceof McpError, `expected McpError, got ${String(error)}`)
  predicate(error)
  return true
}

const projectPayload = { id: 'p1', name: 'Demo', path: '/wiki/demo', current: true }

void test('the tool surface is unchanged', async () => {
  const harness = await startToolServer()
  const { tools } = await harness.mcp.listTools()

  const expected: ReadonlyArray<{
    readonly name: string
    readonly required: ReadonlyArray<string>
    readonly properties: ReadonlyArray<string>
  }> = [
    { name: 'llm_wiki_status', required: [], properties: [] },
    { name: 'llm_wiki_projects', required: [], properties: [] },
    { name: 'llm_wiki_set_project', required: ['project_id'], properties: ['project_id'] },
    { name: 'llm_wiki_files', required: [], properties: ['max_files', 'project_id', 'recursive', 'root'] },
    { name: 'llm_wiki_read_file', required: ['path'], properties: ['path', 'project_id'] },
    {
      name: 'llm_wiki_reviews',
      required: [],
      properties: ['limit', 'project_id', 'status', 'type'],
    },
    {
      name: 'llm_wiki_search',
      required: ['query'],
      properties: ['include_content', 'project_id', 'query', 'top_k'],
    },
    {
      name: 'llm_wiki_chat',
      required: ['message'],
      properties: [
        'anytxt',
        'include_content',
        'message',
        'mode',
        'project_id',
        'session_id',
        'skills',
        'top_k',
        'web',
        'wiki',
      ],
    },
    { name: 'llm_wiki_graph', required: [], properties: ['limit', 'node_type', 'project_id', 'q'] },
    { name: 'llm_wiki_rescan_sources', required: [], properties: ['project_id'] },
    { name: 'llm_wiki_embed_page', required: ['path'], properties: ['force', 'path', 'project_id'] },
  ]

  assert.deepEqual(
    tools.map((tool) => tool.name),
    expected.map((tool) => tool.name),
  )
  for (const tool of tools) {
    const match = expected.find((entry) => entry.name === tool.name)
    assert.ok(match !== undefined, `unexpected tool ${tool.name}`)
    assert.equal(tool.inputSchema['additionalProperties'], false)
    assert.deepEqual(tool.inputSchema.required ?? [], match.required)
    assert.deepEqual(Object.keys(tool.inputSchema.properties ?? {}).sort(), match.properties)
  }

  const enumValues = (name: string, property: string): ReadonlyArray<unknown> | undefined => {
    const schema = tools.find((tool) => tool.name === name)?.inputSchema.properties?.[property]
    if (typeof schema !== 'object' || schema === null) return undefined
    const values = Reflect.get(schema, 'enum')
    return Array.isArray(values) ? values : undefined
  }

  assert.deepEqual(enumValues('llm_wiki_files', 'root'), ['wiki', 'sources', 'all'])
  assert.deepEqual(enumValues('llm_wiki_reviews', 'status'), ['unresolved', 'resolved', 'all'])
  assert.deepEqual(enumValues('llm_wiki_chat', 'mode'), ['fast', 'standard', 'deep', 'local_first'])
})

void test('llm_wiki_status reports health, projects, and the session project', async () => {
  const harness = await startToolServer()

  const payload = JSON.parse(await call(harness, 'llm_wiki_status'))

  assert.equal(payload.mcpEnabled, true)
  assert.equal(payload.status, 'running')
  assert.equal(payload.agent.streamProtocol, 'ndjson')
  assert.deepEqual(payload.projects, [projectPayload])
  assert.deepEqual(payload.currentProject, projectPayload)
  assert.equal(payload.sessionProject, null)
})

void test('llm_wiki_status still answers when MCP access is disabled', async () => {
  const harness = await startToolServer({ health: () => Effect.succeed(healthFixture(false)) })

  const payload = JSON.parse(await call(harness, 'llm_wiki_status'))

  assert.equal(payload.mcpEnabled, false)
  assert.deepEqual(payload.projects, [projectPayload])
})

void test('llm_wiki_projects lists projects with the session project', async () => {
  const harness = await startToolServer()

  const payload = JSON.parse(await call(harness, 'llm_wiki_projects'))

  assert.deepEqual(payload, {
    projects: [projectPayload],
    currentProject: projectPayload,
    sessionProject: null,
  })
})

void test('llm_wiki_set_project pins the session and rejects cross-project overrides', async () => {
  const harness = await startToolServer()

  const payload = JSON.parse(await call(harness, 'llm_wiki_set_project', { project_id: 'p1' }))

  assert.deepEqual(payload, { activeProject: projectPayload, pinned: true })
  assert.equal(harness.binding.project?.id, 'p1')
  assert.deepEqual(harness.calls.map((entry) => entry.tag), ['health', 'projects'])

  await assert.rejects(
    () => harness.mcp.callTool({ name: 'llm_wiki_files', arguments: { project_id: 'p2' } }),
    mcpError((error) => {
      assert.equal(error.code, ErrorCode.InvalidParams)
      assert.match(error.message, /\[activeProject: Demo \(p1\)\]/)
      assert.match(error.message, /override p2 was rejected/)
    }),
  )
})

void test('llm_wiki_set_project rejects an unknown project', async () => {
  const harness = await startToolServer()

  await assert.rejects(
    () => harness.mcp.callTool({ name: 'llm_wiki_set_project', arguments: { project_id: 'nope' } }),
    mcpError((error) => {
      assert.equal(error.code, ErrorCode.InvalidParams)
      assert.match(error.message, /Unknown LLM Wiki project: nope$/)
    }),
  )
})

void test('llm_wiki_files lists the tree with the documented defaults', async () => {
  const harness = await startToolServer({ files: () => Effect.succeed(filesFixture()) })

  const text = await call(harness, 'llm_wiki_files', { recursive: true })

  assert.equal(text, '[activeProject: Demo (p1)]\n\n📁 wiki\n  📄 wiki/index.md')
  assert.deepEqual(harness.calls.at(-1), {
    tag: 'files',
    request: { projectId: 'current', root: 'wiki', recursive: true },
  })

  await call(harness, 'llm_wiki_files', { root: 'sources', recursive: false, max_files: 10 })
  assert.deepEqual(harness.calls.at(-1), {
    tag: 'files',
    request: { projectId: 'current', root: 'sources', recursive: false, maxFiles: 10 },
  })
})

void test('llm_wiki_read_file returns the file body', async () => {
  const harness = await startToolServer({
    fileContent: () => Effect.succeed(fileContentFixture()),
  })

  const text = await call(harness, 'llm_wiki_read_file', { path: 'wiki/index.md' })

  assert.equal(text, '[activeProject: Demo (p1)]\n\n# wiki/index.md\n\n# Index\n\nHello.')
  assert.deepEqual(harness.calls.at(-1), {
    tag: 'fileContent',
    request: { projectId: 'current', path: 'wiki/index.md' },
  })
})

void test('llm_wiki_reviews defaults to unresolved and forwards filters', async () => {
  const harness = await startToolServer({ reviews: () => Effect.succeed(reviewsFixture()) })

  const text = await call(harness, 'llm_wiki_reviews')

  assert.equal(
    text,
    '[activeProject: Demo (p1)]\n\n' +
      [
        '# Review items',
        '',
        'Status: unresolved',
        'Count: 1',
        '',
        '## 1. Missing page: Attention',
        'ID: r1',
        'Type: missing-page',
        'Resolved: no',
        'Description: Add the Attention page',
        'Options: Create (create)',
        '',
      ].join('\n'),
  )
  assert.deepEqual(harness.calls.at(-1), {
    tag: 'reviews',
    request: { projectId: 'current', status: 'unresolved' },
  })

  await call(harness, 'llm_wiki_reviews', { status: 'all', type: 'missing-page', limit: 5 })
  assert.deepEqual(harness.calls.at(-1), {
    tag: 'reviews',
    request: { projectId: 'current', status: 'all', type: 'missing-page', limit: 5 },
  })
})

void test('llm_wiki_search formats results and forwards retrieval options', async () => {
  const harness = await startToolServer({ search: () => Effect.succeed(searchFixture()) })

  const text = await call(harness, 'llm_wiki_search', { query: 'query' })

  assert.equal(
    text,
    '[activeProject: Demo (p1)]\n\n' +
      [
        '# Search results for "query"',
        'Mode: hybrid | Token hits: 2 | Vector hits: 1',
        '',
        '## 1. A',
        'Path: wiki/a.md',
        'Score: 0.500000 | Vector score: 0.900000',
        'Snippet: a snippet',
        '',
      ].join('\n'),
  )
  assert.deepEqual(harness.calls.at(-1), {
    tag: 'search',
    request: { projectId: 'current', query: 'query', includeContent: false },
  })

  await call(harness, 'llm_wiki_search', { query: 'query', top_k: 3, include_content: true })
  assert.deepEqual(harness.calls.at(-1), {
    tag: 'search',
    request: { projectId: 'current', query: 'query', topK: 3, includeContent: true },
  })
})

void test('llm_wiki_chat formats the agent turn and forwards agent options', async () => {
  const harness = await startToolServer({ chat: () => Effect.succeed(chatFixture()) })

  const text = await call(harness, 'llm_wiki_chat', {
    message: 'question',
    mode: 'deep',
    session_id: 's1',
    top_k: 4,
    include_content: true,
    wiki: true,
    web: false,
    anytxt: true,
    skills: ['reviewer'],
  })

  assert.equal(
    text,
    '[activeProject: Demo (p1)]\n\n' +
      [
        '# LLM Wiki Agent response',
        '',
        'Session: s1',
        'Mode: standard',
        'Project: p1',
        'Usage: promptChars=100, completionChars=6, references=1',
        '',
        'answer',
        '',
        '## References',
        '1. A',
        '   Kind: wiki',
        '   Path: wiki/a.md',
        '   Score: 0.500000',
        '   Snippet: hit',
        '',
        '## Tool events',
        '- wiki.search: completed (1 result)',
      ].join('\n'),
  )
  assert.deepEqual(harness.calls.at(-1), {
    tag: 'chat',
    request: {
      message: 'question',
      sessionId: 's1',
      persistSession: true,
      mode: 'deep',
      topK: 4,
      includeContent: true,
      tools: { wiki: true, web: false, anytxt: true },
      skills: ['reviewer'],
    },
  })
})

void test('llm_wiki_graph summarizes nodes and edges', async () => {
  const harness = await startToolServer({ graph: () => Effect.succeed(graphFixture()) })

  const text = await call(harness, 'llm_wiki_graph', { q: 'att', node_type: 'concept', limit: 2 })

  assert.equal(
    text,
    '[activeProject: Demo (p1)]\n\n' +
      [
        '# Knowledge graph',
        '',
        'Nodes: 1',
        'Edges: 1',
        '',
        '## Node types',
        '- concept: 1',
        '',
        '## Top nodes',
        '- Attention (concept, 4 links) — wiki/concepts/attention.md',
      ].join('\n'),
  )
  assert.deepEqual(harness.calls.at(-1), {
    tag: 'graph',
    request: { projectId: 'current', q: 'att', nodeType: 'concept', limit: 2 },
  })
})

void test('llm_wiki_rescan_sources returns the rescan result', async () => {
  const harness = await startToolServer({
    rescanSources: () => Effect.succeed(rescanFixture()),
  })

  const text = await call(harness, 'llm_wiki_rescan_sources')

  assert.equal(text, `[activeProject: Demo (p1)]\n\n${JSON.stringify(rescanFixture(), null, 2)}`)
  assert.deepEqual(harness.calls.at(-1), { tag: 'rescanSources', request: { projectId: 'current' } })
})

void test('llm_wiki_embed_page returns the page embedding result', async () => {
  const harness = await startToolServer({ embedPage: () => Effect.succeed(embedFixture()) })

  const text = await call(harness, 'llm_wiki_embed_page', { path: 'wiki/ideas/example.md', force: true })

  assert.equal(text, `[activeProject: Demo (p1)]\n\n${JSON.stringify(embedFixture().result, null, 2)}`)
  assert.deepEqual(harness.calls.at(-1), {
    tag: 'embedPage',
    request: { projectId: 'current', path: 'wiki/ideas/example.md', force: true },
  })
})

void test('server-side McpDisabled maps to InvalidRequest with the desktop message', async () => {
  const harness = await startToolServer({
    projects: () => Effect.fail(new Errors.McpDisabled({ message: 'server-side gate' })),
  })

  await assert.rejects(
    () => harness.mcp.callTool({ name: 'llm_wiki_projects', arguments: {} }),
    mcpError((error) => {
      assert.equal(error.code, ErrorCode.InvalidRequest)
      assert.match(
        error.message,
        /LLM Wiki MCP access is disabled\. Enable Settings -> API \+ MCP -> Enable MCP access in the desktop app\.$/,
      )
    }),
  )
})

void test('the health pre-check reports the same disabled message', async () => {
  const harness = await startToolServer({ health: () => Effect.succeed(healthFixture(false)) })

  await assert.rejects(
    () => harness.mcp.callTool({ name: 'llm_wiki_projects', arguments: {} }),
    mcpError((error) => {
      assert.equal(error.code, ErrorCode.InvalidRequest)
      assert.match(error.message, /Enable Settings -> API \+ MCP -> Enable MCP access/)
    }),
  )
})

void test('client-side argument failures map to InvalidParams', async () => {
  const harness = await startToolServer({
    search: () => Effect.fail(new Errors.NotFound({ message: 'Project not found: missing' })),
  })

  await assert.rejects(
    () => harness.mcp.callTool({ name: 'llm_wiki_search', arguments: { query: 'attention' } }),
    mcpError((error) => {
      assert.equal(error.code, ErrorCode.InvalidParams)
      assert.match(error.message, /LLM Wiki API NotFound: Project not found: missing$/)
    }),
  )

  await assert.rejects(
    () => harness.mcp.callTool({ name: 'llm_wiki_search', arguments: {} }),
    mcpError((error) => {
      assert.equal(error.code, ErrorCode.InvalidParams)
      assert.match(error.message, /query is required$/)
    }),
  )
})

void test('agent failures map to InternalError', async () => {
  const harness = await startToolServer({
    chat: () => Effect.fail(new Errors.AgentError({ message: 'agent runtime failed' })),
  })

  await assert.rejects(
    () => harness.mcp.callTool({ name: 'llm_wiki_chat', arguments: { message: 'question' } }),
    mcpError((error) => {
      assert.equal(error.code, ErrorCode.InternalError)
      assert.match(error.message, /LLM Wiki API AgentError: agent runtime failed$/)
    }),
  )
})

void test('unknown tools are rejected with MethodNotFound', async () => {
  const harness = await startToolServer()

  await assert.rejects(
    () => harness.mcp.callTool({ name: 'llm_wiki_nope', arguments: {} }),
    mcpError((error) => {
      assert.equal(error.code, ErrorCode.MethodNotFound)
      assert.match(error.message, /Unknown tool: llm_wiki_nope$/)
    }),
  )
})
