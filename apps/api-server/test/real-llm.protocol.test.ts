import { NodeHttpClient } from '@effect/platform-node'
import { Effect, Stream } from 'effect'
import { Headers } from 'effect/unstable/http'
import { RpcClient } from 'effect/unstable/rpc'
import { Client, Domain } from 'llm-wiki-protocol'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { buildApp } from '../src/server/app.js'
import { serveSocket } from '../src/server/mount.js'

const PROVIDER = process.env['LLM_PROVIDER'] === 'minimax' ? 'minimax' : 'ollama'
const OLLAMA_URL = process.env['OLLAMA_URL'] ?? 'http://192.168.1.50:8080'
const OLLAMA_MODEL = process.env['OLLAMA_MODEL'] ?? 'Qwen3.6-35B-A3B-UD-Q4_K_M.gguf'
const MINIMAX_API_KEY = process.env['MINIMAX_API_KEY'] ?? ''
const MINIMAX_MODEL = process.env['MINIMAX_MODEL'] ?? 'MiniMax-M2.7-highspeed'
const MINIMAX_ENDPOINT = process.env['MINIMAX_ENDPOINT'] ?? 'https://api.minimaxi.com/v1'

const MODEL = PROVIDER === 'minimax' ? MINIMAX_MODEL : OLLAMA_MODEL
const CREDENTIAL = PROVIDER === 'minimax'
  ? { apiKey: MINIMAX_API_KEY, baseUrl: MINIMAX_ENDPOINT }
  : { apiKey: '', baseUrl: OLLAMA_URL }
const ENABLED = process.env['RUN_LLM_TESTS'] === '1' && (PROVIDER === 'ollama' || MINIMAX_API_KEY !== '')

const PROMPT = 'Reply with exactly the single word: pong'
const TEST_TIMEOUT_MS = 5 * 60 * 1000
const TOKEN = 'llm-wiki-real-llm-token'
const TOKEN_ENV = { LLM_WIKI_API_TOKEN: TOKEN }
const TOKEN_HEADERS = Headers.fromInput({ 'x-llm-wiki-token': TOKEN })
const TOOLS_OFF = new Domain.AgentToolOptions({ wiki: false, web: false, anytxt: false })

const createdRoots: Array<string> = []

afterAll(async () => {
  await Promise.all(createdRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const makeProjectRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'llm-wiki-real-llm-'))
  createdRoots.push(root)
  await mkdir(join(root, '.llm-wiki'), { recursive: true })
  await writeFile(join(root, '.llm-wiki', 'project.json'), JSON.stringify({ id: 'p1' }), 'utf8')
  await mkdir(join(root, 'wiki'), { recursive: true })
  await writeFile(join(root, 'wiki', 'a.md'), '# A\n\nAttention mechanism notes.\n', 'utf8')
  return root
}

const withSocketClient = <A, E>(
  body: (client: Client.ApiClient) => Effect.Effect<A, E>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function*() {
        const root = yield* Effect.promise(() => makeProjectRoot())
        const configPath = join(root, 'server-config.json')
        yield* Effect.promise(() =>
          writeFile(
            configPath,
            JSON.stringify({
              api: { enabled: true, mcpEnabled: true, allowUnauthenticated: true },
              projects: [{ path: root }],
              currentProject: root,
              chat: { maxTokens: 2_048, maxTurns: 4 },
              providerCredentials: { [PROVIDER]: CREDENTIAL },
            }),
            'utf8',
          )
        )
        const app = yield* buildApp({
          config: { mode: 'standalone', configPath, env: TOKEN_ENV },
          env: TOKEN_ENV,
          agent: { provider: PROVIDER, model: MODEL },
        })
        const path = join(tmpdir(), `llm-wiki-real-llm-${randomUUID()}.sock`)
        yield* serveSocket({ app, env: TOKEN_ENV, path })
        return yield* Effect.provide(
          Effect.gen(function*() {
            const client = yield* Client.SocketApiClient
            return yield* body(client)
          }).pipe(Effect.provideService(RpcClient.CurrentHeaders, TOKEN_HEADERS)),
          Client.SocketApiClient.layer({ path }),
        )
      }),
    ).pipe(Effect.provide(NodeHttpClient.layerNodeHttp)),
  )

describe.skipIf(!ENABLED)(`real ${PROVIDER} provider over the composed server`, () => {
  it('completes a chat turn', { timeout: TEST_TIMEOUT_MS }, async () => {
    const response = await withSocketClient((client) => client.chat({ message: PROMPT, tools: TOOLS_OFF }))

    expect(response.projectId).toBe('p1')
    expect(response.sessionId.length).toBeGreaterThan(0)
    expect(response.message.role).toBe('assistant')
    expect(response.message.content.trim().length).toBeGreaterThan(0)
    expect(response.usage?.completionChars ?? 0).toBeGreaterThan(0)
  })

  it('streams a chat turn', { timeout: TEST_TIMEOUT_MS }, async () => {
    const frames = await withSocketClient((client) =>
      Stream.runCollect(client.chatStream({ message: PROMPT, tools: TOOLS_OFF })).pipe(
        Effect.map((chunk) => [...chunk]),
      )
    )

    const first = frames[0]
    expect(first?.type).toBe('meta')
    const last = frames[frames.length - 1]
    expect(last?.type).toBe('done')
    if (last?.type !== 'done') throw new Error('the stream must end with a done frame')
    expect(last.response.sessionId.length).toBeGreaterThan(0)
    const streamed = frames.flatMap((frame) =>
      frame.type === 'agentEvent' && frame.event.type === 'messageDelta' ? [frame.event.text] : []
    )
    expect(streamed.join('').trim().length).toBeGreaterThan(0)
    expect(last.response.message.content.trim()).toBe(streamed.join('').trim())
  })
})
