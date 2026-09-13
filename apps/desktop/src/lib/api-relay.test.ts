import { beforeEach, describe, expect, it, vi } from 'vitest'

type InvokeFn = (command: string, args?: Record<string, unknown>) => Promise<unknown>
type ListenCallback = (event: { payload: unknown }) => void

const mockInvoke = vi.fn<InvokeFn>()
const mockUnlisten = vi.fn<() => void>()
const mockListen = vi.fn<(event: string, handler: ListenCallback) => Promise<() => void>>()

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (command: string, args?: Record<string, unknown>) => mockInvoke(command, args),
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: (event: string, handler: ListenCallback) => mockListen(event, handler),
}))

import {
  apiRelayClient,
  cancelChatTurnBestEffort,
  isRelayUnavailable,
  relay,
  RelayError,
  RelayUnavailableError,
  setRelayClient,
  subscribeAgentEvents,
} from './api-relay'

const healthValue = {
  ok: true,
  status: 'running',
  version: '0.6.11',
  authRequired: true,
  authConfigured: true,
  tokenSource: 'store',
  enabled: true,
  mcpEnabled: true,
  allowUnauthenticated: false,
  allowLanAccess: false,
  agent: { chat: true, streaming: true, streamProtocol: 'ndjson' },
}

beforeEach(() => {
  mockInvoke.mockReset()
  mockListen.mockReset()
  mockListen.mockResolvedValue(mockUnlisten)
  setRelayClient(null)
})

describe('apiRelayClient wire contract', () => {
  it('sends one api_rpc call per operation and unwraps the envelope', async () => {
    mockInvoke.mockResolvedValueOnce({ ok: true, value: healthValue })

    const health = await apiRelayClient.health()

    expect(mockInvoke).toHaveBeenCalledWith('api_rpc', { op: 'health', payload: {} })
    expect(health.status).toBe('running')
    expect(health.mcpEnabled).toBe(true)
  })

  it('omits absent optional payload fields instead of sending undefined', async () => {
    mockInvoke.mockResolvedValueOnce({
      ok: true,
      value: {
        projectId: '/tmp/p',
        mode: 'keyword',
        note: '',
        tokenHits: 0,
        vectorHits: 0,
        graphHits: 0,
        results: [],
      },
    })

    await apiRelayClient.search({ projectId: '/tmp/p', query: 'q' })

    expect(mockInvoke).toHaveBeenCalledWith('api_rpc', {
      op: 'search',
      payload: { projectId: '/tmp/p', query: 'q' },
    })
  })

  it('translates the WorkerNotRunning tag into a typed offline error', async () => {
    mockInvoke.mockResolvedValueOnce({
      ok: false,
      error: { _tag: 'WorkerNotRunning', message: 'The API worker is not running.' },
    })

    const failure = await apiRelayClient.health().catch((error: unknown) => error)

    expect(isRelayUnavailable(failure)).toBe(true)
    expect(failure).toBeInstanceOf(RelayUnavailableError)
  })

  it('keeps the protocol error tag on typed worker failures', async () => {
    mockInvoke.mockResolvedValueOnce({
      ok: false,
      error: { _tag: 'NotFound', message: 'Unknown project: nope' },
    })

    const failure = await apiRelayClient.health().catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(RelayError)
    expect(failure).toMatchObject({ _tag: 'NotFound', message: 'Unknown project: nope' })
  })

  it('rejects a malformed envelope rather than trusting it', async () => {
    mockInvoke.mockResolvedValueOnce({ value: healthValue })

    await expect(apiRelayClient.health()).rejects.toMatchObject({ _tag: 'ProtocolViolation' })
  })

  it('rejects a response that does not satisfy the protocol schema', async () => {
    mockInvoke.mockResolvedValueOnce({ ok: true, value: { status: 'running' } })

    await expect(apiRelayClient.health()).rejects.toMatchObject({ _tag: 'ProtocolViolation' })
  })

  it('reports a transport failure from invoke as a transport error', async () => {
    mockInvoke.mockRejectedValueOnce(new Error('ipc closed'))

    await expect(apiRelayClient.health()).rejects.toMatchObject({
      _tag: 'Transport',
      message: 'health failed: ipc closed',
    })
  })

  it('exposes the injected client to callers', () => {
    const injected = { ...apiRelayClient }
    setRelayClient(injected)

    expect(relay()).toBe(injected)
  })
})

describe('chat relay', () => {
  const chatResponse = {
    projectId: '/tmp/p',
    sessionId: 's1',
    mode: 'standard',
    message: { role: 'assistant', content: 'hi' },
    references: [],
    toolEvents: [],
    events: [],
  }

  it('builds the wire payload from the caller message', async () => {
    mockInvoke.mockResolvedValueOnce({ ok: true, value: chatResponse })

    await apiRelayClient.chat({
      message: 'summarize',
      sessionId: 's1',
      runId: 'run-1',
      mode: 'deep',
      tools: { wiki: true, web: false, anytxt: false },
      topK: 8,
      includeContent: true,
      historyExplicit: true,
      skills: ['pdf'],
      contextFiles: ['wiki/a.md'],
      persistSession: false,
      history: [{ role: 'user', content: 'earlier' }],
    })

    const [command, args] = mockInvoke.mock.calls[0] ?? []
    expect(command).toBe('api_rpc')
    expect(args).toEqual({
      op: 'chat',
      payload: {
        message: 'summarize',
        sessionId: 's1',
        runId: 'run-1',
        mode: 'deep',
        tools: { wiki: true, web: false, anytxt: false },
        topK: 8,
        includeContent: true,
        historyExplicit: true,
        skills: ['pdf'],
        contextFiles: ['wiki/a.md'],
        persistSession: false,
        history: [{ role: 'user', content: 'earlier' }],
      },
    })
  })

  it('awaits the streamed turn so events can arrive on agent-event', async () => {
    mockInvoke.mockResolvedValueOnce({ ok: true, value: null })

    await expect(apiRelayClient.chatStream({ message: 'hi', sessionId: 's1' })).resolves.toBeUndefined()

    expect(mockInvoke).toHaveBeenCalledWith('api_rpc', {
      op: 'chatStream',
      payload: { message: 'hi', sessionId: 's1' },
    })
  })

  it('surfaces a cancelled turn as a typed error', async () => {
    mockInvoke.mockResolvedValueOnce({
      ok: false,
      error: { _tag: 'ChatCancelled', message: 'Chat run was cancelled' },
    })

    await expect(apiRelayClient.chatStream({ message: 'hi' })).rejects.toMatchObject({
      _tag: 'ChatCancelled',
    })
  })
})

describe('agent event relay', () => {
  it('forwards decodable agent events and drops undecodable payloads', async () => {
    const received: string[] = []
    await subscribeAgentEvents((payload) => {
      received.push(`${payload.sessionId}:${payload.runId ?? ''}:${payload.event.type}`)
    })

    expect(mockListen).toHaveBeenCalledWith('agent-event', expect.any(Function))
    const handler = mockListen.mock.calls[0]?.[1]
    expect(handler).toBeDefined()
    handler?.({ payload: { sessionId: 's1', runId: 'r1', event: { type: 'done', sessionId: 's1' } } })
    handler?.({ payload: { sessionId: 's1', event: { type: 'nonsense' } } })
    handler?.({ payload: 'garbage' })

    expect(received).toEqual(['s1:r1:done'])
  })

  it('cancels through the supervisor command and tolerates a missing worker', async () => {
    mockInvoke.mockResolvedValueOnce(undefined)
    await cancelChatTurnBestEffort('/tmp/p', 's1')
    expect(mockInvoke).toHaveBeenCalledWith('api_chat_cancel', {
      projectId: '/tmp/p',
      sessionId: 's1',
    })

    mockInvoke.mockRejectedValueOnce(new Error('worker down'))
    await expect(cancelChatTurnBestEffort('/tmp/p', 's1')).resolves.toBeUndefined()
  })
})
