import { Effect } from 'effect'
import { Domain, Errors } from 'llm-wiki-protocol'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  BASE_URL_ENV,
  LlmWikiApiClient,
  LlmWikiApiError,
  resolveTransport,
  SOCKET_PATH_ENV,
} from '../src/api-client.js'
import { embedFixture, graphFixture, startStub } from './api-stub.js'

const withEndpointEnv = async (
  env: { readonly socketPath?: string; readonly baseUrl?: string },
  run: () => Promise<void>,
): Promise<void> => {
  const savedSocket = process.env[SOCKET_PATH_ENV]
  const savedBase = process.env[BASE_URL_ENV]
  const restore = (name: string, value: string | undefined) => {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  restore(SOCKET_PATH_ENV, env.socketPath)
  restore(BASE_URL_ENV, env.baseUrl)
  try {
    await run()
  } finally {
    restore(SOCKET_PATH_ENV, savedSocket)
    restore(BASE_URL_ENV, savedBase)
  }
}

const apiError = (predicate: (error: LlmWikiApiError) => void) => (error: unknown): boolean => {
  assert.ok(error instanceof LlmWikiApiError, `expected LlmWikiApiError, got ${String(error)}`)
  assert.ok(error instanceof Error)
  predicate(error)
  return true
}

void test('resolveTransport prefers the socket path, then normalizes the base URL', () => {
  assert.equal(resolveTransport({}), null)
  assert.equal(resolveTransport({ socketPath: '   ', baseUrl: '  ' }), null)
  assert.deepEqual(resolveTransport({ socketPath: ' /run/llm-wiki.sock ' }), {
    mode: 'socket',
    path: '/run/llm-wiki.sock',
  })
  assert.deepEqual(resolveTransport({ socketPath: '/run/llm-wiki.sock', baseUrl: 'http://127.0.0.1:19828' }), {
    mode: 'socket',
    path: '/run/llm-wiki.sock',
  })
  assert.deepEqual(resolveTransport({ baseUrl: 'http://127.0.0.1:19828//' }), {
    mode: 'http',
    url: 'http://127.0.0.1:19828/rpc',
    token: undefined,
  })
  assert.deepEqual(resolveTransport({ baseUrl: 'http://127.0.0.1:19828/rpc' }), {
    mode: 'http',
    url: 'http://127.0.0.1:19828/rpc',
    token: undefined,
  })
  assert.deepEqual(resolveTransport({ baseUrl: 'http://other-host:8080/rpc/', token: ' s3cret ' }), {
    mode: 'http',
    url: 'http://other-host:8080/rpc',
    token: 's3cret',
  })
})

void test('endpoint names the transport the client will dial', () => {
  assert.equal(new LlmWikiApiClient({ socketPath: '/tmp/llm-wiki.sock' }).endpoint, 'unix socket /tmp/llm-wiki.sock')
  assert.equal(new LlmWikiApiClient({ baseUrl: 'http://127.0.0.1:19828' }).endpoint, 'http://127.0.0.1:19828/rpc')
  assert.match(
    new LlmWikiApiClient({ socketPath: '', baseUrl: '' }).endpoint,
    /set LLM_WIKI_SOCKET_PATH or LLM_WIKI_BASE_URL/,
  )
})

void test('the environment supplies the endpoint', async () => {
  await withEndpointEnv({ socketPath: '/run/env.sock' }, async () => {
    assert.equal(new LlmWikiApiClient().endpoint, 'unix socket /run/env.sock')
  })
  await withEndpointEnv({ baseUrl: 'http://127.0.0.1:19828' }, async () => {
    assert.equal(new LlmWikiApiClient().endpoint, 'http://127.0.0.1:19828/rpc')
  })
})

void test('a misconfigured client fails every tool with remediation', async () => {
  await withEndpointEnv({}, async () => {
    const client = new LlmWikiApiClient()
    await assert.rejects(
      () => client.health(),
      apiError((error) => {
        assert.equal(error.tag, null)
        assert.match(error.message, /No LLM Wiki API endpoint is configured/)
        assert.match(error.message, /LLM_WIKI_SOCKET_PATH/)
        assert.match(error.message, /LLM_WIKI_BASE_URL/)
      }),
    )
  })
})

void test('protocol typed errors keep their tag and message', async () => {
  const stub = startStub({
    search: () => Effect.fail(new Errors.NotFound({ message: 'Project not found: nope' })),
  })
  const client = new LlmWikiApiClient({ api: stub.api })

  await assert.rejects(
    () => client.search('nope', 'attention'),
    apiError((error) => {
      assert.equal(error.tag, 'NotFound')
      assert.equal(error.message, 'LLM Wiki API NotFound: Project not found: nope')
    }),
  )
})

void test('McpDisabled surfaces as a typed McpDisabled error', async () => {
  const stub = startStub({
    projects: () => Effect.fail(new Errors.McpDisabled({ message: 'MCP access is disabled' })),
  })
  const client = new LlmWikiApiClient({ api: stub.api })

  await assert.rejects(
    () => client.projects(),
    apiError((error) => {
      assert.equal(error.tag, 'McpDisabled')
      assert.equal(error.message, 'LLM Wiki API McpDisabled: MCP access is disabled')
    }),
  )
})

void test('embed failures keep the EmbedError taxonomy in the message', async () => {
  const stub = startStub({
    embedPage: () => Effect.fail(new Errors.EmbedError({ kind: 'Provider', message: 'provider is not configured' })),
  })
  const client = new LlmWikiApiClient({ api: stub.api })

  await assert.rejects(
    () => client.embedPage('wiki/a.md'),
    apiError((error) => {
      assert.equal(error.tag, 'EmbedError')
      assert.equal(error.message, 'LLM Wiki API EmbedError: provider is not configured')
    }),
  )
})

void test('transport failures keep the desktop-app hint', async () => {
  const stub = startStub({
    projects: () => Effect.die(new Error('ECONNREFUSED')),
  })
  const client = new LlmWikiApiClient({ api: stub.api })

  await assert.rejects(
    () => client.projects(),
    apiError((error) => {
      assert.equal(error.tag, null)
      assert.match(error.message, /Is the desktop app running\? ECONNREFUSED/)
    }),
  )
})

void test('embedPage returns the inner page embedding result', async () => {
  const stub = startStub({ embedPage: () => Effect.succeed(embedFixture()) })
  const client = new LlmWikiApiClient({ api: stub.api })

  const result = await client.embedPage('wiki/ideas/example.md', 'p1', true)

  assert.deepEqual({
    path: result.path,
    pageId: result.pageId,
    revision: result.revision,
    chunks: result.chunks,
    vectorsWritten: result.vectorsWritten,
    status: result.status,
  }, {
    path: 'wiki/ideas/example.md',
    pageId: 'page',
    revision: 'sha256:abc',
    chunks: 2,
    vectorsWritten: 2,
    status: 'indexed',
  })
  assert.deepEqual(stub.calls, [
    { tag: 'embedPage', request: { projectId: 'p1', path: 'wiki/ideas/example.md', force: true } },
  ])
})

void test('cancelChat dispatches the chatCancel operation', async () => {
  const stub = startStub({
    chatCancel: () => Effect.succeed(new Domain.ChatCancelResponse({ sessionId: 's1', cancelled: true })),
  })
  const client = new LlmWikiApiClient({ api: stub.api })

  const result = await client.cancelChat('p1', 's1')

  assert.equal(result.cancelled, true)
  assert.deepEqual(stub.calls, [{ tag: 'chatCancel', request: { projectId: 'p1', sessionId: 's1' } }])
})

void test('graph forwards only the filters that were provided', async () => {
  const stub = startStub({ graph: () => Effect.succeed(graphFixture()) })
  const client = new LlmWikiApiClient({ api: stub.api })

  await client.graph('p1', { q: '', nodeType: 'concept', limit: 5 })

  assert.deepEqual(stub.calls, [{ tag: 'graph', request: { projectId: 'p1', nodeType: 'concept', limit: 5 } }])
})
