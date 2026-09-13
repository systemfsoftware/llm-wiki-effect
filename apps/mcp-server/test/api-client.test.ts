import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LlmWikiApiClient, normalizeBaseUrl } from '../src/api-client.js'

function readRequestUrl(url: string | URL | Request): string {
  if (typeof url === 'string') return url
  if (url instanceof URL) return url.href
  return url.url
}

function readBodyText(body: RequestInit['body']): string {
  if (typeof body === 'string') return body
  if (body === null || body === undefined) return ''
  if (body instanceof URLSearchParams) return body.toString()
  return JSON.stringify(body) ?? ''
}

void test('normalizeBaseUrl trims trailing slashes and falls back to localhost', () => {
  assert.equal(normalizeBaseUrl('http://127.0.0.1:19828///'), 'http://127.0.0.1:19828')
  assert.equal(normalizeBaseUrl(''), 'http://127.0.0.1:19828')
})

void test('projects sends bearer token and parses current project', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: readRequestUrl(url), ...(init !== undefined ? { init } : {}) })
    return new Response(
      JSON.stringify({
        ok: true,
        projects: [{ id: 'p1', name: 'Demo', path: '/tmp/demo', current: true }],
        currentProject: { id: 'p1', name: 'Demo', path: '/tmp/demo', current: true },
      }),
      { status: 200 },
    )
  }

  const client = new LlmWikiApiClient({
    baseUrl: 'http://localhost:19828/',
    token: 'secret',
    fetchImpl,
  })
  const result = await client.projects()

  assert.equal(calls[0]?.url, 'http://localhost:19828/api/v1/projects')
  // An authenticated call always carries an init with headers.
  const headers = new Headers(calls[0]?.init?.headers)
  assert.equal(headers.get('Authorization'), 'Bearer secret')
  assert.equal(result.currentProject?.id, 'p1')
  assert.equal(result.projects[0]?.current, true)
})

void test('health does not send authorization', async () => {
  const calls: Array<RequestInit | undefined> = []
  const fetchImpl = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push(init)
    return new Response(JSON.stringify({ ok: true, status: 'running' }), { status: 200 })
  }

  const client = new LlmWikiApiClient({ token: 'secret', fetchImpl })
  await client.health()

  assert.equal(new Headers(calls[0]?.headers).get('Authorization'), null)
})

void test('search posts JSON body to current project', async () => {
  let body = ''
  const fetchImpl = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    body = readBodyText(init?.body)
    return new Response(
      JSON.stringify({
        ok: true,
        mode: 'hybrid',
        tokenHits: 2,
        vectorHits: 1,
        results: [{ path: 'wiki/a.md', title: 'A', snippet: 'hit', score: 0.5, vectorScore: 0.9 }],
      }),
      { status: 200 },
    )
  }

  const client = new LlmWikiApiClient({ fetchImpl })
  const results = await client.search('current', 'query', { topK: 3, includeContent: true })

  assert.deepEqual(JSON.parse(body), { query: 'query', topK: 3, includeContent: true })
  assert.equal(results.mode, 'hybrid')
  assert.equal(results.tokenHits, 2)
  assert.equal(results.vectorHits, 1)
  assert.equal(results.results[0]?.vectorScore, 0.9)
})

void test('embedPage posts a project-relative wiki path', async () => {
  const fetchImpl: typeof fetch = async (input, init) => {
    assert.equal(readRequestUrl(input), 'http://127.0.0.1:19828/api/v1/projects/project-a/pages/embed')
    assert.equal(init?.method, 'POST')
    assert.deepEqual(JSON.parse(readBodyText(init?.body)), { path: 'wiki/ideas/page.md', force: true })
    return new Response(
      JSON.stringify({
        ok: true,
        result: {
          path: 'wiki/ideas/page.md',
          pageId: 'page',
          revision: 'sha256:abc',
          chunks: 2,
          vectorsWritten: 2,
          status: 'indexed',
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  }
  const client = new LlmWikiApiClient({ fetchImpl })
  assert.deepEqual(await client.embedPage('wiki/ideas/page.md', 'project-a', true), {
    path: 'wiki/ideas/page.md',
    pageId: 'page',
    revision: 'sha256:abc',
    chunks: 2,
    vectorsWritten: 2,
    status: 'indexed',
  })
})

void test('embedPage rejects malformed success payloads', async () => {
  const fetchImpl: typeof fetch = async () =>
    new Response(
      JSON.stringify({
        ok: true,
        result: {
          path: 'wiki/page.md',
          pageId: 'page',
          revision: 'sha256:abc',
          chunks: '2',
          vectorsWritten: 2,
          status: 'indexed',
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  const client = new LlmWikiApiClient({ fetchImpl })

  await assert.rejects(
    () => client.embedPage('wiki/page.md'),
    /page embedding result\.chunks: expected finite number/,
  )
})

void test('chat posts agent request and parses references', async () => {
  let url = ''
  let body = ''
  const fetchImpl = async (requestUrl: string | URL | Request, init?: RequestInit): Promise<Response> => {
    url = readRequestUrl(requestUrl)
    body = readBodyText(init?.body)
    return new Response(
      JSON.stringify({
        ok: true,
        projectId: 'p1',
        sessionId: 's1',
        mode: 'standard',
        message: { role: 'assistant', content: 'answer' },
        references: [{ title: 'A', path: 'wiki/a.md', kind: 'wiki', snippet: 'hit', score: 0.5 }],
        toolEvents: [{ tool: 'wiki.search', status: 'completed', detail: '1 result' }],
        events: [{ type: 'toolEnd', tool: 'wiki.search' }],
        usage: { promptChars: 100, completionChars: 6, referenceCount: 1, toolEventCount: 1 },
      }),
      { status: 200 },
    )
  }

  const client = new LlmWikiApiClient({ baseUrl: 'http://localhost:19828', fetchImpl })
  const response = await client.chat('current', 'question', {
    sessionId: 's1',
    mode: 'standard',
    topK: 4,
    includeContent: true,
    wiki: true,
    web: false,
    anytxt: true,
    skills: ['reviewer'],
  })

  assert.equal(url, 'http://localhost:19828/api/v1/projects/current/chat')
  assert.deepEqual(JSON.parse(body), {
    message: 'question',
    sessionId: 's1',
    mode: 'standard',
    topK: 4,
    includeContent: true,
    tools: { wiki: true, web: false, anytxt: true },
    skills: ['reviewer'],
  })
  assert.equal(response.sessionId, 's1')
  assert.equal(response.message.content, 'answer')
  assert.equal(response.references[0]?.path, 'wiki/a.md')
  assert.equal(response.toolEvents[0]?.tool, 'wiki.search')
  assert.equal(response.events[0]?.type, 'toolEnd')
  assert.equal(response.usage?.promptChars, 100)
})

void test('cancelChat posts to the chat cancellation endpoint', async () => {
  let url = ''
  let method = ''
  const fetchImpl = async (requestUrl: string | URL | Request, init?: RequestInit): Promise<Response> => {
    url = readRequestUrl(requestUrl)
    method = init?.method ?? ''
    return new Response(
      JSON.stringify({
        ok: true,
        sessionId: 's1',
        cancelled: true,
      }),
      { status: 200 },
    )
  }

  const client = new LlmWikiApiClient({ baseUrl: 'http://localhost:19828', fetchImpl })
  const response = await client.cancelChat('current', 's1')

  assert.equal(url, 'http://localhost:19828/api/v1/projects/current/chat/s1/cancel')
  assert.equal(method, 'POST')
  assert.deepEqual(response, { sessionId: 's1', cancelled: true })
})

void test('graph parses nodeType from API graph nodes', async () => {
  const fetchImpl = async (): Promise<Response> => (
    new Response(
      JSON.stringify({
        ok: true,
        nodes: [{ id: 'n1', label: 'Node', nodeType: 'concept', path: 'wiki/concepts/n1.md', linkCount: 4 }],
        edges: [{ source: 'n1', target: 'n2', weight: 0.75 }],
      }),
      { status: 200 },
    )
  )

  const client = new LlmWikiApiClient({ fetchImpl })
  const graph = await client.graph('current')

  assert.equal(graph.nodes[0]?.type, 'concept')
  assert.equal(graph.nodes[0]?.linkCount, 4)
  assert.equal(graph.edges[0]?.weight, 0.75)
})

void test('files exposes truncated flag', async () => {
  const fetchImpl = async (): Promise<Response> => (
    new Response(
      JSON.stringify({
        ok: true,
        files: [{ name: 'index.md', path: 'wiki/index.md', isDir: false }],
        truncated: true,
      }),
      { status: 200 },
    )
  )

  const client = new LlmWikiApiClient({ fetchImpl })
  const files = await client.files('current')

  assert.equal(files.truncated, true)
  assert.equal(files.files[0]?.path, 'wiki/index.md')
})

void test('reviews requests unresolved review items with filters', async () => {
  const calls: string[] = []
  const fetchImpl = async (url: string | URL | Request): Promise<Response> => {
    calls.push(readRequestUrl(url))
    return new Response(
      JSON.stringify({
        ok: true,
        projectId: 'p1',
        status: 'unresolved',
        count: 1,
        reviews: [{
          id: 'r1',
          type: 'missing-page',
          title: 'Missing page: Attention',
          description: 'Add the Attention page',
          options: [],
          resolved: false,
          createdAt: 1,
        }],
      }),
      { status: 200 },
    )
  }

  const client = new LlmWikiApiClient({ baseUrl: 'http://localhost:19828', fetchImpl })
  const result = await client.reviews('current', {
    status: 'unresolved',
    type: 'missing-page',
    limit: 5,
  })

  assert.equal(
    calls[0],
    'http://localhost:19828/api/v1/projects/current/reviews?status=unresolved&type=missing-page&limit=5',
  )
  assert.equal(result.status, 'unresolved')
  assert.equal(result.count, 1)
  assert.equal(result.reviews[0]?.id, 'r1')
  assert.equal(result.reviews[0]?.resolved, false)
})

void test('network failures include desktop app hint', async () => {
  const fetchImpl = async (): Promise<Response> => {
    throw new Error('ECONNREFUSED')
  }

  const client = new LlmWikiApiClient({ fetchImpl })
  await assert.rejects(() => client.projects(), /Is the desktop app running\? ECONNREFUSED/)
})

void test('non-JSON responses include status and body preview', async () => {
  const fetchImpl = async (): Promise<Response> => (
    new Response('not json', { status: 502, statusText: 'Bad Gateway' })
  )

  const client = new LlmWikiApiClient({ fetchImpl })
  await assert.rejects(() => client.projects(), /non-JSON response \(502\): not json/)
})

void test('API errors include status and server message', async () => {
  const fetchImpl = async (): Promise<Response> => (
    new Response(JSON.stringify({ ok: false, error: 'Unauthorized' }), { status: 401 })
  )

  const client = new LlmWikiApiClient({ fetchImpl })
  await assert.rejects(() => client.projects(), /LLM Wiki API 401: Unauthorized/)
})
