import { Effect, Layer, Stream } from 'effect'
import { array, assert, asyncProperty, nat, string } from 'fast-check'
import { Domain, Errors } from 'llm-wiki-protocol'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentRuntime, agentRuntimeLayer, DEFAULT_CHAT_SEARCH_RESULTS } from '../src/agent/runtime/index.js'
import type { AgentTurnRequest } from '../src/agent/runtime/index.js'
import { CancelRegistry, makeCancelRegistry, makeSessionStore, SessionStore } from '../src/agent/sessions/index.js'
import type { AgentSessionMessage, CancelRegistryShape } from '../src/agent/sessions/index.js'
import type { Approver, ToolExecutors } from '../src/agent/tools/index.js'
import { APPROVAL_REQUIRED_OBSERVATION } from '../src/agent/tools/index.js'
import { Config } from '../src/config/index.js'
import { ProviderClient } from '../src/provider/index.js'
import type { ProviderCompletionRequest, ProviderStreamEvent } from '../src/provider/index.js'

const createdProjects: Array<string> = []

afterEach(async () => {
  await Promise.all(
    createdProjects.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

interface HarnessOptions {
  readonly files?: Readonly<Record<string, string>>
  readonly responses: ReadonlyArray<ReadonlyArray<string>>
  readonly executors?: ToolExecutors
  readonly approver?: Approver
  readonly chatTurns?: number
  readonly chatTokens?: number
  readonly registry?: CancelRegistryShape
  readonly streamOverride?: (
    request: ProviderCompletionRequest,
  ) => Stream.Stream<ProviderStreamEvent, Errors.AgentError>
}

interface Harness {
  readonly root: string
  readonly layer: Layer.Layer<AgentRuntime, Errors.InvalidRequest>
  readonly providerCalls: Array<ProviderCompletionRequest>
  readonly cancelRegistry: CancelRegistryShape
  readonly turn: (overrides?: Partial<AgentTurnRequest>) => AgentTurnRequest
  readonly setNextChunks: (chunks: ReadonlyArray<string>) => void
  readonly readRecent: (sessionId: string) => Promise<ReadonlyArray<AgentSessionMessage>>
}

const makeProject = async (files: Readonly<Record<string, string>>): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'llm-wiki-agent-runtime-'))
  createdProjects.push(root)
  await mkdir(join(root, '.llm-wiki'), { recursive: true })
  await writeFile(join(root, '.llm-wiki', 'project.json'), JSON.stringify({ id: 'p1' }), 'utf8')
  for (const [relative, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, relative)), { recursive: true })
    await writeFile(join(root, relative), content, 'utf8')
  }
  return root
}

const makeHarness = async (options: HarnessOptions): Promise<Harness> => {
  const root = await makeProject(options.files ?? {})
  const configPath = join(root, 'server-config.json')
  await writeFile(
    configPath,
    JSON.stringify({
      projects: [{ path: root }],
      currentProject: root,
      chat: { maxTokens: options.chatTokens ?? 2_048, maxTurns: options.chatTurns ?? 8 },
      providerCredentials: { openai: { apiKey: 'test-key', baseUrl: 'https://example.test' } },
    }),
    'utf8',
  )

  const providerCalls: Array<ProviderCompletionRequest> = []
  let call = 0
  let nextChunks: ReadonlyArray<string> | undefined
  const providerLayer = Layer.succeed(ProviderClient, {
    complete: () => Effect.succeed({ text: '' }),
    stream: (request) => {
      providerCalls.push(request)
      if (options.streamOverride !== undefined) return options.streamOverride(request)
      const chunks = nextChunks ?? options.responses[Math.min(call, options.responses.length - 1)] ?? []
      call += 1
      return Stream.fromIterable<ProviderStreamEvent>([
        ...chunks.map((text): ProviderStreamEvent => ({ type: 'delta', text })),
        { type: 'complete', text: chunks.join('') },
      ])
    },
  })

  const cancelRegistry = options.registry ?? makeCancelRegistry()
  const sessionStore = makeSessionStore()
  const layer = agentRuntimeLayer({
    provider: 'openai',
    model: 'gpt-4o',
    ...(options.executors === undefined ? {} : { executors: options.executors }),
    ...(options.approver === undefined ? {} : { approver: options.approver }),
  }).pipe(
    Layer.provide(
      Layer.mergeAll(
        providerLayer,
        Config.layer({ mode: 'standalone', configPath, env: {} }),
        Layer.succeed(CancelRegistry, cancelRegistry),
        Layer.succeed(SessionStore, sessionStore),
      ),
    ),
  )

  return {
    root,
    layer,
    providerCalls,
    cancelRegistry,
    setNextChunks: (chunks) => {
      nextChunks = chunks
    },
    readRecent: (sessionId) => Effect.runPromise(sessionStore.recentMessages(root, sessionId, 10)),
    turn: (overrides = {}): AgentTurnRequest => ({
      projectId: 'p1',
      projectRoot: root,
      message: 'hello',
      sessionId: 's1',
      runId: 'r1',
      mode: 'standard',
      retrievalMode: 'standard',
      skillMode: 'auto',
      tools: new Domain.AgentToolOptions({ wiki: true, web: false, anytxt: false }),
      history: [],
      skills: [],
      contextFiles: [],
      images: [],
      persistSession: true,
      token: cancelRegistry.start('p1', 's1', 'r1'),
      ...overrides,
    }),
  }
}

const runTurn = (
  harness: Harness,
  overrides: Partial<AgentTurnRequest> = {},
): Promise<Domain.ChatResponse> =>
  Effect.runPromise(
    Effect.provide(
      Effect.gen(function*() {
        const runtime = yield* AgentRuntime
        return yield* runtime.runTurn(harness.turn(overrides))
      }),
      harness.layer,
    ),
  )

const flipTurn = (harness: Harness, overrides: Partial<AgentTurnRequest> = {}): Promise<unknown> =>
  Effect.runPromise(
    Effect.provide(
      Effect.gen(function*() {
        const runtime = yield* AgentRuntime
        return yield* Effect.flip(runtime.runTurn(harness.turn(overrides)))
      }),
      harness.layer,
    ),
  )

const finalAction = (answer: string): string => JSON.stringify({ action: 'final', answer })
const toolAction = (tool: string, extra: Readonly<Record<string, unknown>>): string =>
  JSON.stringify({ action: 'tool', tool, ...extra })

const eventTypes = (response: Domain.ChatResponse): ReadonlyArray<string> => response.events.map((event) => event.type)

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

describe('agent runtime turn loop', () => {
  it('rejects a blank message before any provider call', async () => {
    const harness = await makeHarness({ responses: [[finalAction('never')]] })

    const error = await flipTurn(harness, { message: '   ' })

    expect(error).toBeInstanceOf(Errors.InvalidRequest)
    expect(expectTag(error, 'InvalidRequest').message).toBe('message is required')
    expect(harness.providerCalls).toHaveLength(0)
  })

  it('runs tool calls then the final answer, emitting events in loop order', async () => {
    const harness = await makeHarness({
      responses: [
        [toolAction('wiki.search', { query: 'alpha' })],
        [finalAction('Alpha is documented.')],
      ],
      executors: {
        'wiki.search': () =>
          Effect.succeed({
            references: [
              { title: 'Alpha', path: 'wiki/alpha.md', kind: 'wiki', snippet: 'Alpha body' },
            ],
            mode: 'hybrid',
            tokenHits: 2,
            vectorHits: 1,
            graphHits: 0,
          }),
      },
    })

    const emitted: Array<string> = []
    const response = await runTurn(harness, {
      onEvent: (event) => Effect.sync(() => void emitted.push(event.type)),
    })

    expect(response.message.content).toBe('Alpha is documented.')
    expect(response.references.map((reference) => reference.path)).toEqual(['wiki/alpha.md'])
    expect(eventTypes(response)).toEqual([
      'agentStart',
      'turnStart',
      'toolStart',
      'referenceAdded',
      'toolEnd',
      'messageDelta',
      'done',
    ])
    expect(emitted).toEqual(eventTypes(response))
    const searchEvent = response.events.find((event) => event.type === 'toolStart')
    expect(searchEvent?.tool).toBe('wiki.search')
    expect(response.toolEvents.map((event) => `${event.tool}:${event.status}`)).toEqual([
      'llm.generate:started',
      'llm.generate:completed',
      'wiki.search:started',
      'wiki.search:completed',
      'llm.generate:started',
      'llm.generate:completed',
    ])
    expect(harness.providerCalls).toHaveLength(2)
    expect(response.usage?.toolEventCount).toBe(6)
  })

  it('stops at the configured maxTurns and reports the iteration limit', async () => {
    const harness = await makeHarness({
      chatTurns: 2,
      responses: [
        [toolAction('wiki.search', { query: 'one' })],
        [toolAction('wiki.search', { query: 'two' })],
        [toolAction('wiki.search', { query: 'three' })],
      ],
      executors: { 'wiki.search': () => Effect.succeed({ references: [] }) },
    })

    const response = await runTurn(harness)

    expect(response.message.content).toContain('reached the tool-iteration limit after 2 step(s)')
    expect(response.message.content).toContain('did not produce a final answer')
    expect(harness.providerCalls).toHaveLength(2)
    expect(eventTypes(response).at(-1)).toBe('done')
    expect(eventTypes(response)).not.toContain('messageDelta')
    expect(response.usage?.toolEventCount).toBe(8)
  })

  it('reports confirmed workspace files when the iteration budget runs out', async () => {
    const harness = await makeHarness({
      chatTurns: 1,
      responses: [[toolAction('workspace.write_file', { path: 'deck/index.html', content: '<html>' })]],
      executors: {
        'workspace.write_file': () =>
          Effect.succeed({
            path: 'deck/index.html',
            bytes: 12,
            existedBefore: false,
          }),
      },
    })

    const response = await runTurn(harness)

    expect(response.message.content).toContain('did generate file(s)')
    expect(response.message.content).toContain('- deck/index.html')
    expect(response.references.map((reference) => reference.kind)).toEqual(['workspace'])
  })

  it('pauses the turn at an approval-required tool and resumes when approved', async () => {
    const denied = await makeHarness({
      responses: [
        [toolAction('shell.exec', { command: 'node build.js' })],
        [finalAction('should not run')],
      ],
    })

    const paused = await runTurn(denied)

    expect(paused.message.content).toContain('The Agent needs approval before it can run this command')
    expect(paused.message.content).toContain('`node build.js`')
    expect(denied.providerCalls).toHaveLength(1)
    expect(
      paused.toolEvents.find((event) => event.tool === 'shell.exec' && event.status === 'available')
        ?.detail,
    ).toContain('node build.js')
    expect(paused.events.find((event) => event.type === 'toolEnd')?.output).toContain(
      'node build.js',
    )

    const approved = await makeHarness({
      responses: [
        [toolAction('shell.exec', { command: 'node build.js' })],
        [finalAction('Built the deck.')],
      ],
      approver: { approve: () => Effect.succeed(true) },
      executors: {
        'shell.exec': () =>
          Effect.succeed({
            command: 'node build.js',
            exitCode: 0,
            timedOut: false,
            stdout: 'ok',
            stderr: '',
            generatedFiles: [{ path: 'deck/index.html', bytes: 42 }],
          }),
      },
    })

    const continued = await runTurn(approved)

    expect(continued.message.content).toBe('Built the deck.')
    expect(continued.toolEvents.map((event) => `${event.tool}:${event.status}`)).toEqual([
      'llm.generate:started',
      'llm.generate:completed',
      'shell.exec:started',
      'shell.exec:completed',
      'llm.generate:started',
      'llm.generate:completed',
    ])
    expect(continued.references.map((reference) => reference.path)).toEqual(['deck/index.html'])
    expect(approved.providerCalls).toHaveLength(2)
  })

  it('fails a run cancelled mid-stream with ChatCancelled', async () => {
    const root = await makeProject({})
    const cancelRegistry = makeCancelRegistry()
    const raw = finalAction('cancelled mid stream')
    const harness = await makeHarness({
      responses: [[finalAction('should not be reached')]],
      registry: cancelRegistry,
      streamOverride: () =>
        Stream.fromIterable([raw.slice(0, 5), raw.slice(5, 20), raw.slice(20)]).pipe(
          Stream.map((text, index): ProviderStreamEvent => {
            if (index === 1) cancelRegistry.cancel('p1', 's1', 'r1')
            return { type: 'delta', text }
          }),
        ),
    })

    const error = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function*() {
          const runtime = yield* AgentRuntime
          return yield* Effect.flip(
            runtime.runTurn({
              projectId: 'p1',
              projectRoot: root,
              message: 'hello',
              sessionId: 's1',
              runId: 'r1',
              mode: 'standard',
              retrievalMode: 'standard',
              skillMode: 'auto',
              tools: new Domain.AgentToolOptions({ wiki: true, web: false, anytxt: false }),
              history: [],
              skills: [],
              contextFiles: [],
              images: [],
              persistSession: true,
              token: cancelRegistry.start('p1', 's1', 'r1'),
            }),
          )
        }),
        harness.layer,
      ),
    )

    expect(error).toBeInstanceOf(Errors.ChatCancelled)
    expect(expectTag(error, 'ChatCancelled').message).toBe('Agent turn cancelled')
    expect(harness.providerCalls).toHaveLength(1)
  })

  it('persists the turn to the session store unless the caller opts out', async () => {
    const harness = await makeHarness({ responses: [[finalAction('Hi there.')]] })

    const persisted = await runTurn(harness, { sessionId: 'kept', message: 'ping' })

    expect(persisted.sessionId).toBe('kept')
    const messages = await harness.readRecent('kept')
    expect(messages.map((message) => message.content)).toEqual(['ping', 'Hi there.'])

    await runTurn(harness, { sessionId: 'skipped', message: 'ping', persistSession: false })
    expect(await harness.readRecent('skipped')).toEqual([])
  })

  it('assembles retrieval-mode specific context for the provider', async () => {
    const files = {
      'overview.md': 'Overview body',
      'schema.md': 'Schema body',
    }
    const faithful = await makeHarness({ responses: [[finalAction('ok')]], files })
    await runTurn(faithful, { retrievalMode: 'faithful' })
    const faithfulSystem = faithful.providerCalls[0]?.system ?? ''
    expect(faithfulSystem).toContain('Faithful-source mode is enabled')
    expect(faithfulSystem).not.toContain('Project overview:')
    expect(faithfulSystem).not.toContain('Project schema:')

    const smart = await makeHarness({ responses: [[finalAction('ok')]], files })
    await runTurn(smart, { retrievalMode: 'smart' })
    const smartSystem = smart.providerCalls[0]?.system ?? ''
    expect(smartSystem).toContain('Smart retrieval is enabled')
    expect(smartSystem).toContain('Project overview:')
    expect(smartSystem).toContain('Overview body')

    const standard = await makeHarness({ responses: [[finalAction('ok')]], files })
    await runTurn(standard, { retrievalMode: 'standard' })
    const standardSystem = standard.providerCalls[0]?.system ?? ''
    expect(standardSystem).not.toContain('Smart retrieval is enabled')
    expect(standardSystem).not.toContain('Faithful-source mode')
    expect(standardSystem).toContain('Project overview:')
  })

  it('passes chatLimits.maxTokens and the gathered context to the provider request', async () => {
    const harness = await makeHarness({
      responses: [[finalAction('ok')]],
      chatTokens: 4_096,
      files: { 'overview.md': 'Ledger overview' },
    })

    await runTurn(harness, {
      history: [
        { role: 'user', content: 'earlier question' },
        { role: 'assistant', content: 'earlier answer' },
      ],
    })

    const request = harness.providerCalls[0]
    expect(request?.maxTokens).toBe(4_096)
    expect(request?.provider).toBe('openai')
    expect(request?.model).toBe('gpt-4o')
    expect(request?.user).toContain('earlier question')
    expect(request?.user).toContain('earlier answer')
    expect(request?.user).toContain('Latest user request:\nhello')
  })

  it('repairs invalid tool JSON with a rejection observation instead of failing the turn', async () => {
    const harness = await makeHarness({
      responses: [
        ['{"action":"tool","tool":"wiki.search"'],
        [finalAction('Recovered.')],
      ],
    })

    const response = await runTurn(harness)

    expect(response.message.content).toBe('Recovered.')
    const rejection = response.toolEvents.find((event) => event.tool === 'agent.action')
    expect(rejection?.status).toBe('failed')
    expect(harness.providerCalls).toHaveLength(2)
  })

  it('clamps the search topK sent to the tool executor', async () => {
    const seen: Array<Readonly<Record<string, unknown>>> = []
    const harness = await makeHarness({
      responses: [
        [toolAction('wiki.search', { query: 'alpha' })],
        [finalAction('done')],
      ],
      executors: {
        'wiki.search': (call) => {
          seen.push(call.input)
          return Effect.succeed([])
        },
      },
    })

    await runTurn(harness, { topK: 99 })

    expect(seen[0]?.['topK']).toBe(10)
    expect(seen[0]?.['includeContent']).toBe(false)
    expect(DEFAULT_CHAT_SEARCH_RESULTS).toBe(5)
  })

  it('surfaces user.ask as a structured form event', async () => {
    const harness = await makeHarness({
      responses: [
        [
          JSON.stringify({
            action: 'tool',
            tool: 'user.ask',
            title: 'Pick a style',
            fields: [
              {
                id: 'style',
                type: 'single',
                label: 'Style',
                options: [{ label: 'Formal', value: 'formal' }],
              },
            ],
          }),
        ],
      ],
    })

    const response = await runTurn(harness)

    const form = response.events.find((event) => event.type === 'userInputRequired')
    expect(form?.request.title).toBe('Pick a style')
    expect(form?.request.fields).toHaveLength(1)
    expect(eventTypes(response).slice(-2)).toEqual(['userInputRequired', 'done'])
  })

  it('keeps provider chunk order in the assembled answer', async () => {
    const harness = await makeHarness({ responses: [[finalAction('unused')]] })
    await assert(
      asyncProperty(
        string({ minLength: 1, maxLength: 40 }),
        array(nat({ max: 80 }), { maxLength: 6 }),
        async (answer, splits) => {
          if (answer.trim() === '') return
          const raw = finalAction(answer)
          const boundaries = [...new Set(splits.map((split) => split % (raw.length + 1)))].sort(
            (left, right) => left - right,
          )
          const chunks: Array<string> = []
          let cursor = 0
          for (const boundary of boundaries) {
            chunks.push(raw.slice(cursor, boundary))
            cursor = boundary
          }
          chunks.push(raw.slice(cursor))
          harness.setNextChunks(chunks)
          const response = await runTurn(harness)
          expect(response.message.content).toBe(answer.trim())
        },
      ),
      { numRuns: 200 },
    )
  })

  it('reports the approval-required observation name the tool registry uses', () => {
    expect(APPROVAL_REQUIRED_OBSERVATION).toBe('shell.exec.approval_required')
  })
})
