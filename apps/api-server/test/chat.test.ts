import { Deferred, Effect, Layer, Stream } from 'effect'
import { Domain, Errors } from 'llm-wiki-protocol'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Redactor } from '../src/agent/redaction/index.js'
import { AgentRuntime, agentRuntimeLayer } from '../src/agent/runtime/index.js'
import type { AgentTurnRequest } from '../src/agent/runtime/index.js'
import { CancelRegistry, makeCancelRegistry, SessionStore } from '../src/agent/sessions/index.js'
import type { CancelRegistryShape } from '../src/agent/sessions/index.js'
import type { ToolExecutors } from '../src/agent/tools/index.js'
import { ChatService } from '../src/chat/index.js'
import type { ChatRequest, ChatServiceShape } from '../src/chat/index.js'
import { Config } from '../src/config/index.js'
import { ProjectRegistry } from '../src/projects/index.js'
import { ProviderClient } from '../src/provider/index.js'
import type { ProviderCompletionRequest, ProviderStreamEvent } from '../src/provider/index.js'

const createdProjects: Array<string> = []

afterEach(async () => {
  await Promise.all(
    createdProjects.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

const finalAction = (answer: string): string => JSON.stringify({ action: 'final', answer })
const toolAction = (tool: string, extra: Readonly<Record<string, unknown>>): string =>
  JSON.stringify({ action: 'tool', tool, ...extra })

const encode = (value: unknown): unknown => JSON.parse(JSON.stringify(value))

const makeProject = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'llm-wiki-chat-'))
  createdProjects.push(root)
  await mkdir(join(root, '.llm-wiki'), { recursive: true })
  await writeFile(join(root, '.llm-wiki', 'project.json'), JSON.stringify({ id: 'p1' }), 'utf8')
  return root
}

const writeConfig = async (root: string): Promise<Layer.Layer<Config, Errors.InvalidRequest>> => {
  const configPath = join(root, 'server-config.json')
  await writeFile(
    configPath,
    JSON.stringify({
      projects: [{ path: root }],
      currentProject: root,
      chat: { maxTokens: 2_048, maxTurns: 8 },
      providerCredentials: { openai: { apiKey: 'test-key', baseUrl: 'https://example.test' } },
    }),
    'utf8',
  )
  return Config.layer({ mode: 'standalone', configPath, env: {} })
}

interface ChatHarness {
  readonly root: string
  readonly layer: Layer.Layer<ChatService, Errors.InvalidRequest>
  readonly providerCalls: Array<ProviderCompletionRequest>
  readonly cancelRegistry: CancelRegistryShape
}

interface ChatHarnessOptions {
  readonly responses: ReadonlyArray<ReadonlyArray<string>>
  readonly executors?: ToolExecutors | undefined
  readonly runtime?: Layer.Layer<AgentRuntime, Errors.InvalidRequest> | undefined
}

const projectRegistryLayer = (
  config: Layer.Layer<Config, Errors.InvalidRequest>,
): Layer.Layer<ProjectRegistry, Errors.InvalidRequest> =>
  Layer.effect(
    ProjectRegistry,
    Effect.gen(function*() {
      const configShape = yield* Config
      return yield* ProjectRegistry.make(configShape, {})
    }),
  ).pipe(Layer.provide(config))

const chatServiceLayer = (
  config: Layer.Layer<Config, Errors.InvalidRequest>,
  runtime: Layer.Layer<AgentRuntime, Errors.InvalidRequest>,
  cancelRegistry: CancelRegistryShape,
): Layer.Layer<ChatService, Errors.InvalidRequest> =>
  ChatService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        projectRegistryLayer(config),
        SessionStore.layer,
        Layer.succeed(CancelRegistry, cancelRegistry),
        runtime,
        Redactor.layer,
      ),
    ),
  )

const runtimeLayer = (
  config: Layer.Layer<Config, Errors.InvalidRequest>,
  cancelRegistry: CancelRegistryShape,
  provider: Layer.Layer<ProviderClient>,
  executors?: ToolExecutors,
): Layer.Layer<AgentRuntime, Errors.InvalidRequest> =>
  agentRuntimeLayer({
    provider: 'openai',
    model: 'gpt-4o',
    ...(executors === undefined ? {} : { executors }),
  }).pipe(
    Layer.provide(
      Layer.mergeAll(
        provider,
        config,
        Layer.succeed(CancelRegistry, cancelRegistry),
        SessionStore.layer,
      ),
    ),
  )

const makeChatHarness = async (options: ChatHarnessOptions): Promise<ChatHarness> => {
  const root = await makeProject()
  const config = await writeConfig(root)
  const providerCalls: Array<ProviderCompletionRequest> = []
  let call = 0
  const provider = Layer.succeed(ProviderClient, {
    complete: () => Effect.succeed({ text: '' }),
    stream: (request) => {
      providerCalls.push(request)
      const chunks = options.responses[Math.min(call, options.responses.length - 1)] ?? []
      call += 1
      return Stream.fromIterable<ProviderStreamEvent>([
        ...chunks.map((text): ProviderStreamEvent => ({ type: 'delta', text })),
        { type: 'complete', text: chunks.join('') },
      ])
    },
  })
  const cancelRegistry = makeCancelRegistry()
  const runtime = options.runtime ??
    runtimeLayer(config, cancelRegistry, provider, options.executors)
  return {
    root,
    layer: chatServiceLayer(config, runtime, cancelRegistry),
    providerCalls,
    cancelRegistry,
  }
}

const makeStreamingLayer = async (
  stream: () => Stream.Stream<ProviderStreamEvent, Errors.AgentError>,
): Promise<{ readonly root: string; readonly layer: Layer.Layer<ChatService, Errors.InvalidRequest> }> => {
  const root = await makeProject()
  const config = await writeConfig(root)
  const provider = Layer.succeed(ProviderClient, {
    complete: () => Effect.succeed({ text: '' }),
    stream,
  })
  const cancelRegistry = makeCancelRegistry()
  return { root, layer: chatServiceLayer(config, runtimeLayer(config, cancelRegistry, provider), cancelRegistry) }
}

const isTagged = <T extends Errors.ApiError['_tag']>(
  error: unknown,
  tag: T,
): error is Extract<Errors.ApiError, { readonly _tag: T }> =>
  typeof error === 'object' && error !== null && '_tag' in error && error._tag === tag

const expectTag = <T extends Errors.ApiError['_tag']>(
  error: unknown,
  tag: T,
): Extract<Errors.ApiError, { readonly _tag: T }> => {
  if (!isTagged(error, tag)) throw new Error(`expected a ${tag} error`)
  return error
}

const chat = <A, E>(
  layer: Layer.Layer<ChatService, Errors.InvalidRequest>,
  f: (service: ChatServiceShape) => Effect.Effect<A, E>,
) =>
  Effect.provide(
    Effect.gen(function*() {
      const service = yield* ChatService
      return yield* f(service)
    }),
    layer,
  )

const collectStream = (
  layer: Layer.Layer<ChatService, Errors.InvalidRequest>,
  request: ChatRequest,
): Promise<ReadonlyArray<Domain.ChatStreamEvent>> =>
  Effect.runPromise(chat(layer, (service) => Stream.runCollect(service.chatStream(request)))).then(
    (chunk) => [...chunk],
  )

describe('chat service', () => {
  it('runs an aggregate turn with defaulted session ids', async () => {
    const harness = await makeChatHarness({ responses: [[finalAction('Hi.')]] })

    const response = await Effect.runPromise(
      chat(harness.layer, (service) => service.chat({ message: 'hello' })),
    )

    expect(response.projectId).toBe('p1')
    expect(response.sessionId.startsWith('api_')).toBe(true)
    expect(response.mode).toBe('standard')
    expect(response.message).toEqual({ role: 'assistant', content: 'Hi.' })
    expect(response.usage?.completionChars).toBe(3)
  })

  it('rejects an empty message with InvalidRequest', async () => {
    const harness = await makeChatHarness({ responses: [[finalAction('Hi.')]] })

    const error = await Effect.runPromise(
      chat(harness.layer, (service) => Effect.flip(service.chat({ message: '  ' }))),
    )

    expect(error).toBeInstanceOf(Errors.InvalidRequest)
    expect(expectTag(error, 'InvalidRequest').message).toBe('message is required')
    expect(harness.providerCalls).toHaveLength(0)
  })

  it('backfills the persisted history for a resent session id', async () => {
    const harness = await makeChatHarness({
      responses: [
        [finalAction('first answer')],
        [finalAction('second answer')],
        [finalAction('third answer')],
      ],
    })

    const first = await Effect.runPromise(
      chat(harness.layer, (service) => service.chat({ message: 'first question', sessionId: 's1' })),
    )
    expect(first.sessionId).toBe('s1')

    await Effect.runPromise(
      chat(harness.layer, (service) => service.chat({ message: 'second question', sessionId: 's1' })),
    )
    const second = harness.providerCalls[1]?.user ?? ''
    expect(second).toContain('Recent conversation history:')
    expect(second).toContain('user: first question')
    expect(second).toContain('assistant: first answer')

    await Effect.runPromise(
      chat(
        harness.layer,
        (service) => service.chat({ message: 'third question', sessionId: 's1', historyExplicit: true }),
      ),
    )
    expect(harness.providerCalls[2]?.user).not.toContain('Recent conversation history:')
  })

  it('streams meta, agent events, and a terminal aggregate in order', async () => {
    const harness = await makeChatHarness({ responses: [[finalAction('Streamed answer.')]] })

    const events = await collectStream(harness.layer, { message: 'hello', sessionId: 's1', runId: 'r1' })

    expect(events.map((event) => event.type)).toEqual([
      'meta',
      'agentEvent',
      'agentEvent',
      'agentEvent',
      'agentEvent',
      'done',
    ])
    const meta = events[0]
    expect(meta?.type === 'meta' ? meta.runId : '').toBe('r1')
    expect(
      events
        .filter((event) => event.type === 'agentEvent')
        .map((event) => (event.type === 'agentEvent' ? event.event.type : '')),
    ).toEqual(['agentStart', 'turnStart', 'messageDelta', 'done'])
    const done = events[events.length - 1]
    expect(done?.type === 'done' ? done.response.message.content : '').toBe('Streamed answer.')
  })

  it('redacts the streamed agent events but keeps the aggregate rollback snapshot', async () => {
    const write = toolAction('workspace.write_file', {
      path: 'deck/index.html',
      content: '<html>',
    })
    const harness = await makeChatHarness({
      responses: [[write], [finalAction('Wrote the deck.')], [write], [finalAction('Wrote it again.')]],
      executors: {
        'workspace.write_file': () =>
          Effect.succeed({
            path: 'deck/index.html',
            bytes: 6,
            existedBefore: true,
            previousContent: 'private previous body',
          }),
      },
    })

    const streamed = await collectStream(harness.layer, { message: 'hello', sessionId: 's1' })
    const streamedEvents = streamed
      .filter((event) => event.type === 'agentEvent')
      .map((event) => (event.type === 'agentEvent' ? event.event : undefined))

    const streamedFileChanged = streamedEvents.find((event) => event?.type === 'fileChanged')
    expect(streamedFileChanged).toBeDefined()
    expect(encode(streamedFileChanged)).toEqual({
      type: 'fileChanged',
      path: 'deck/index.html',
      tool: 'workspace.write_file',
      existedBefore: true,
    })
    for (const event of streamedEvents) {
      expect(event).toBeDefined()
      expect(encode(event)).not.toHaveProperty('previousContent')
    }

    const aggregate = await Effect.runPromise(
      chat(harness.layer, (service) => service.chat({ message: 'hello', sessionId: 's2' })),
    )
    const aggregateChange = aggregate.events.find((event) => event.type === 'fileChanged')
    expect(encode(aggregateChange)).toEqual({
      type: 'fileChanged',
      path: 'deck/index.html',
      tool: 'workspace.write_file',
      existedBefore: true,
      previousContent: 'private previous body',
    })
  })

  it('fails a concurrent turn for the same project session with Busy', async () => {
    const gate = await Effect.runPromise(Deferred.make<void>())
    const { layer } = await makeStreamingLayer(() =>
      Stream.concat(
        Stream.fromIterable<ProviderStreamEvent>([{ type: 'delta', text: 'holding' }]),
        Stream.fromEffect(Deferred.await(gate)).pipe(
          Stream.map((): ProviderStreamEvent => ({ type: 'delta', text: finalAction('late') })),
        ),
      )
    )

    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function*() {
          const service = yield* ChatService
          const busy: Array<unknown> = []
          const seen: Array<string> = []
          yield* Stream.runForEach(
            service.chatStream({ message: 'hello', sessionId: 'busy' }),
            (event) =>
              Effect.gen(function*() {
                seen.push(event.type)
                if (event.type !== 'meta') return
                busy.push(
                  yield* Effect.flip(service.chat({ message: 'hello', sessionId: 'busy' })),
                )
                yield* Deferred.succeed(gate, undefined)
              }),
          )
          const other = yield* service.chat({ message: 'hello', sessionId: 'other' })
          return { busy, seen, other }
        }),
        layer,
      ),
    )

    expect(result.busy).toHaveLength(1)
    expect(result.busy[0]).toBeInstanceOf(Errors.Busy)
    expect(expectTag(result.busy[0], 'Busy').message).toContain('already in flight')
    expect(result.seen[0]).toBe('meta')
    expect(result.seen[result.seen.length - 1]).toBe('done')
    expect(result.other.message.content).toBe('late')
  })

  it('propagates chatCancel to the running turn as ChatCancelled', async () => {
    const gate = await Effect.runPromise(Deferred.make<void>())
    const { root, layer } = await makeStreamingLayer(() =>
      Stream.concat(
        Stream.fromIterable<ProviderStreamEvent>([{ type: 'delta', text: 'waiting' }]),
        Stream.fromEffect(Deferred.await(gate)).pipe(
          Stream.map((): ProviderStreamEvent => ({ type: 'delta', text: 'late' })),
        ),
      )
    )

    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function*() {
          const service = yield* ChatService
          let cancelled: Domain.ChatCancelResponse | undefined
          const failure = yield* Effect.flip(
            Stream.runForEach(
              service.chatStream({ message: 'hello', sessionId: 's1', runId: 'r1' }),
              (event) =>
                Effect.gen(function*() {
                  if (event.type !== 'meta') return
                  cancelled = yield* service.chatCancel({ projectId: root, sessionId: 's1' })
                  yield* Deferred.succeed(gate, undefined)
                }),
            ),
          )
          const unknown = yield* service.chatCancel({ projectId: root, sessionId: 'missing' })
          return { cancelled, failure, unknown }
        }),
        layer,
      ),
    )

    expect(result.cancelled?.cancelled).toBe(true)
    expect(result.cancelled?.sessionId).toBe('s1')
    expect(result.failure).toBeInstanceOf(Errors.ChatCancelled)
    expect(expectTag(result.failure, 'ChatCancelled').message).toBe('Agent turn cancelled')
    expect(result.unknown.cancelled).toBe(false)
  })

  it('rejects chatCancel for an unknown project', async () => {
    const harness = await makeChatHarness({ responses: [[finalAction('Hi.')]] })

    const error = await Effect.runPromise(
      chat(harness.layer, (service) => Effect.flip(service.chatCancel({ projectId: 'nope', sessionId: 's1' }))),
    )

    expect(error).toBeInstanceOf(Errors.NotFound)
  })

  it('fails the stream with the typed turn error when the runtime fails', async () => {
    const failing = Layer.succeed(AgentRuntime, {
      runTurn: (_request: AgentTurnRequest) => Effect.fail(new Errors.AgentError({ message: 'provider exploded' })),
    })
    const harness = await makeChatHarness({
      responses: [[finalAction('unused')]],
      runtime: failing,
    })

    const error = await Effect.runPromise(
      chat(
        harness.layer,
        (service) => Effect.flip(Stream.runCollect(service.chatStream({ message: 'hello', sessionId: 's1' }))),
      ),
    )

    expect(error).toBeInstanceOf(Errors.AgentError)
    expect(expectTag(error, 'AgentError').message).toBe('provider exploded')
  })
})
