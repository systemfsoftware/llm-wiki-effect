import { describe, expect, it } from 'vitest'

import { API_RPC_PATH, API_RPC_STREAM_URL, API_SERVER_BASE_URL } from '@/lib/api-server-constants'
import {
  buildMcpConfig,
  buildRpcCurl,
  buildStreamSample,
  normalizeWorkerStatus,
  WORKER_STATUSES,
} from './api-server-section'

const rpcUrl = `${API_SERVER_BASE_URL}${API_RPC_PATH}`

describe('worker status vocabulary', () => {
  it('maps every supervisor lifecycle state', () => {
    expect(WORKER_STATUSES.map(normalizeWorkerStatus)).toEqual([
      'starting',
      'running',
      'restarting',
      'failed',
      'missing-runtime',
    ])
  })

  it('reports the retired REST-era states as unknown', () => {
    expect(normalizeWorkerStatus('port_conflict')).toBe('unknown')
    expect(normalizeWorkerStatus('')).toBe('unknown')
  })
})

describe('RPC request samples', () => {
  it('posts the standalone frame with a null payload for payload-less operations', () => {
    expect(buildRpcCurl({ url: rpcUrl, op: 'projects', payload: null, token: 'secret' })).toBe(
      `curl -X POST \\
  -H "Authorization: Bearer secret" \\
  -H 'Content-Type: application/ndjson' \\
  ${rpcUrl} \\
  --data-binary $'{"_tag":"Request","id":"1","tag":"projects","payload":null,"headers":[]}\\n'`,
    )
  })

  it('omits the Authorization header when no token is configured', () => {
    const sample = buildRpcCurl({ url: rpcUrl, op: 'projects', payload: null, token: null })
    expect(sample).not.toContain('Authorization')
    expect(sample).toContain('Content-Type: application/ndjson')
  })

  it('streams a chat turn over the WebSocket path', () => {
    expect(
      buildStreamSample({ url: API_RPC_STREAM_URL, token: 'secret', payload: { message: 'hi' } }),
    ).toBe(
      `echo '{"_tag":"Request","id":"1","tag":"chatStream","payload":{"message":"hi"},"headers":[]}' \\
  | websocat -H "Authorization: Bearer secret" ${API_RPC_STREAM_URL}`,
    )
  })

  it('carries no reference to the retired REST surface', () => {
    const samples = [
      buildRpcCurl({ url: rpcUrl, op: 'projects', payload: null, token: 'secret' }),
      buildRpcCurl({ url: rpcUrl, op: 'projects', payload: null, token: null }),
      buildStreamSample({ url: API_RPC_STREAM_URL, token: 'secret', payload: { message: 'hi' } }),
    ]
    for (const sample of samples) expect(sample).not.toContain('/api/v1')
  })
})

describe('generated MCP config', () => {
  const entryPath = '/repo/apps/mcp-server/dist/index.js'

  it('injects the worker socket path in local mode', () => {
    const config = buildMcpConfig({
      mode: 'local',
      entryPath,
      socketPath: '/run/llm-wiki/api-server.sock',
      baseUrl: 'http://<host>:19828',
      token: 'secret',
    })
    expect(JSON.parse(config)).toEqual({
      mcpServers: {
        'llm-wiki': {
          command: 'node',
          args: [entryPath],
          env: { LLM_WIKI_SOCKET_PATH: '/run/llm-wiki/api-server.sock' },
        },
      },
    })
  })

  it('injects the base URL and token in remote mode', () => {
    const config = buildMcpConfig({
      mode: 'remote',
      entryPath,
      socketPath: '/run/llm-wiki/api-server.sock',
      baseUrl: 'http://<host>:19828',
      token: 'secret',
    })
    expect(JSON.parse(config)).toEqual({
      mcpServers: {
        'llm-wiki': {
          command: 'node',
          args: [entryPath],
          env: { LLM_WIKI_API_TOKEN: 'secret', LLM_WIKI_BASE_URL: 'http://<host>:19828' },
        },
      },
    })
  })

  it('keeps a placeholder socket path until the worker reports one', () => {
    const config = buildMcpConfig({
      mode: 'local',
      entryPath,
      socketPath: '',
      baseUrl: 'http://<host>:19828',
      token: 'secret',
    })
    const env = JSON.parse(config).mcpServers['llm-wiki'].env
    expect(env.LLM_WIKI_SOCKET_PATH).toBe('<socket path>')
    expect(env.LLM_WIKI_SOCKET_PATH).not.toBe('')
  })
})
