import { NodeHttpClient } from '@effect/platform-node'
import { Effect, Exit, Fiber, Option, Schema, Stream } from 'effect'
import { Headers } from 'effect/unstable/http'
import { RpcClient } from 'effect/unstable/rpc'
import { Api, Client } from 'llm-wiki-protocol'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { ToolCall, ToolExecutors } from '../src/agent/tools/types.js'
import type { RateLimiterOptions } from '../src/auth/limits.js'
import { parseWorkerSpawnArgs } from '../src/config/Config.js'
import type { ProviderClientShape } from '../src/provider/provider-client.js'
import type { ServerAppInput } from '../src/server/app.js'
import { buildApp } from '../src/server/app.js'
import {
  APPROVAL_RESULT_TYPE,
  APPROVAL_SOCKET_MODE,
  ApprovalRequestFrame,
  DEFAULT_APPROVAL_TIMEOUT_MILLIS,
} from '../src/server/approval.js'
import { SUPERVISOR_SURFACE, SURFACE_HEADER } from '../src/server/middleware.js'
import { serveSocket } from '../src/server/mount.js'

type ApiClient = Api.ApiClient
type ServerEnv = Readonly<Record<string, string | undefined>>

const createdRoots: Array<string> = []
const createdPaths: Array<string> = []

const tempPath = (prefix: string): string => {
  const path = join(tmpdir(), `llm-wiki-approval-${prefix}-${randomUUID()}.sock`)
  createdPaths.push(path)
  return path
}

afterAll(async () => {
  await Promise.all(createdRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  await Promise.all(createdPaths.splice(0).map((path) => rm(path, { force: true })))
})

const DEFAULT_FILES: Readonly<Record<string, string>> = {
  'wiki/a.md': '# A\n\nAttention mechanism notes.\n',
  'purpose.md': '# Purpose\n',
}

const makeProjectRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'llm-wiki-approval-'))
  createdRoots.push(root)
  await mkdir(join(root, '.llm-wiki'), { recursive: true })
  await writeFile(join(root, '.llm-wiki', 'project.json'), JSON.stringify({ id: 'p1' }), 'utf8')
  for (const [relative, content] of Object.entries(DEFAULT_FILES)) {
    await mkdir(dirname(join(root, relative)), { recursive: true })
    await writeFile(join(root, relative), content, 'utf8')
  }
  return root
}

const workerAppState = (root: string, api: Readonly<Record<string, unknown>>): unknown => ({
  apiConfig: { enabled: true, mcpEnabled: true, allowUnauthenticated: false, ...api },
  projectRegistry: { p1: { path: root } },
  currentProject: root,
})

const standaloneConfig = (root: string, api: Readonly<Record<string, unknown>>): unknown => ({
  api: { enabled: true, mcpEnabled: true, allowUnauthenticated: true, ...api },
  projects: [{ path: root }],
  currentProject: root,
})

type Mode = 'worker' | 'standalone'

interface HarnessSpec {
  readonly mode?: Mode | undefined
  readonly api?: Readonly<Record<string, unknown>> | undefined
  readonly env?: ServerEnv | undefined
  readonly rateLimit?: RateLimiterOptions | undefined
  readonly providerClient?: ProviderClientShape | undefined
  readonly executors?: ToolExecutors | undefined
  readonly approval?: ServerAppInput['approval']
}

interface Harness {
  readonly root: string
  readonly configPath: string
  readonly mode: Mode
  readonly env: ServerEnv
}

const prepare = (spec: HarnessSpec) =>
  Effect.gen(function*() {
    const mode: Mode = spec.mode ?? 'worker'
    const root = yield* Effect.promise(makeProjectRoot)
    const configPath = join(root, mode === 'worker' ? 'app-state.json' : 'server-config.json')
    const body = mode === 'worker'
      ? workerAppState(root, spec.api ?? {})
      : standaloneConfig(root, spec.api ?? {})
    yield* Effect.promise(() => writeFile(configPath, JSON.stringify(body), 'utf8'))
    return { root, configPath, mode, env: spec.env ?? {} } satisfies Harness
  })

const appInput = (spec: HarnessSpec, harness: Harness): ServerAppInput => ({
  config: harness.mode === 'worker'
    ? { mode: 'worker', appStatePath: harness.configPath, env: harness.env }
    : { mode: 'standalone', configPath: harness.configPath, env: harness.env },
  env: harness.env,
  agent: {
    provider: 'openai',
    model: 'gpt-4o',
    ...(spec.executors === undefined ? {} : { executors: spec.executors }),
  },
  ...(spec.approval === undefined ? {} : { approval: spec.approval }),
  ...(spec.providerClient === undefined ? {} : { providerClient: spec.providerClient }),
  ...(spec.rateLimit === undefined ? {} : { rateLimit: spec.rateLimit }),
})

const openApp = (spec: HarnessSpec, harness: Harness) =>
  buildApp(appInput(spec, harness)).pipe(Effect.provide(NodeHttpClient.layerNodeHttp))

const identity = <A>(value: A): A => value

const withSocket = <A, E = never>(
  spec: HarnessSpec,
  body: (harness: Harness, client: ApiClient) => Effect.Effect<A, E>,
  headers?: Readonly<Record<string, string>>,
): Promise<A> => {
  const path = tempPath('rpc')
  const program = Effect.gen(function*() {
    const harness = yield* prepare(spec)
    const app = yield* openApp(spec, harness)
    yield* serveSocket({ app, env: harness.env, path, mode: harness.mode })
    const session = Effect.gen(function*() {
      const client = yield* Client.SocketApiClient
      return yield* body(harness, client)
    })
    return yield* Effect.provide(
      session.pipe(
        headers === undefined
          ? identity
          : Effect.provideService(RpcClient.CurrentHeaders, Headers.fromInput(headers)),
      ),
      Client.SocketApiClient.layer({ path }),
    )
  })
  return Effect.runPromise(Effect.scoped(program))
}

const withRawSocket = <A>(
  spec: HarnessSpec,
  body: (socketPath: string) => Promise<A>,
): Promise<A> => {
  const path = tempPath('raw')
  const program = Effect.gen(function*() {
    const harness = yield* prepare(spec)
    const app = yield* openApp(spec, harness)
    yield* serveSocket({ app, env: harness.env, path, mode: harness.mode })
    return yield* Effect.promise(() => body(path))
  })
  return Effect.runPromise(Effect.scoped(program))
}

const failureOf = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<string, never, R> =>
  Effect.gen(function*() {
    const exit = yield* Effect.exit(effect)
    if (Exit.isSuccess(exit)) throw new Error('expected the RPC call to fail')
    for (const reason of exit.cause.reasons) {
      if (reason._tag === 'Fail') return reason.error._tag
    }
    throw new Error(`expected a typed failure, saw ${JSON.stringify(exit.cause)}`)
  })

const rawNdjsonCall = (socketPath: string, frame: string): Promise<string> => {
  const { promise, resolve, reject } = Promise.withResolvers<string>()
  const socket = connect({ path: socketPath })
  let buffer = ''
  socket.setEncoding('utf8')
  socket.on('connect', () => socket.write(frame))
  socket.on('data', (chunk: string) => {
    buffer += chunk
    if (!buffer.includes('\n')) return
    socket.destroy()
    resolve(buffer)
  })
  socket.on('error', reject)
  socket.on('close', () => resolve(buffer))
  return promise
}

const rpcFrame = (tag: string): string =>
  `${JSON.stringify({ _tag: 'Request', id: '1', tag, payload: null, headers: [] })}\n`

const chatFrameWithWireApproval = (message: string, approvedShellCommands: ReadonlyArray<string>): string =>
  `${
    JSON.stringify({
      _tag: 'Request',
      id: '1',
      tag: 'chat',
      payload: { message, sessionId: 's1', runId: 'r1', approvedShellCommands },
      headers: [],
    })
  }\n`

type SupervisorAction = 'approve' | 'deny' | 'drop' | 'ignore'

interface Supervisor {
  readonly frames: ReadonlyArray<ApprovalRequestFrame>
  readonly malformed: ReadonlyArray<string>
  readonly firstFrame: Promise<ApprovalRequestFrame>
  readonly close: () => void
}

const decodeRequestFrame = Schema.decodeUnknownOption(ApprovalRequestFrame)

const openSupervisor = (
  path: string,
  respond: (frame: ApprovalRequestFrame) => SupervisorAction,
): Promise<Supervisor> => {
  const { promise, resolve, reject } = Promise.withResolvers<Supervisor>()
  const first = Promise.withResolvers<ApprovalRequestFrame>()
  const socket = connect({ path })
  const frames: Array<ApprovalRequestFrame> = []
  const malformed: Array<string> = []
  let buffer = ''
  let announced = false

  const handleLine = (line: string): void => {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      malformed.push(line)
      return
    }
    const decoded = decodeRequestFrame(parsed)
    if (Option.isNone(decoded)) {
      malformed.push(line)
      return
    }
    const frame = decoded.value
    frames.push(frame)
    if (!announced) {
      announced = true
      first.resolve(frame)
    }
    const action = respond(frame)
    if (action === 'ignore') return
    if (action === 'drop') {
      socket.destroy()
      return
    }
    socket.write(
      `${
        JSON.stringify({
          type: APPROVAL_RESULT_TYPE,
          id: frame.id,
          approved: action === 'approve',
        })
      }\n`,
    )
  }

  socket.setEncoding('utf8')
  socket.on('error', reject)
  socket.on('connect', () => resolve({ frames, malformed, firstFrame: first.promise, close: () => socket.destroy() }))
  socket.on('data', (chunk: string) => {
    buffer += chunk
    let newline = buffer.indexOf('\n')
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      newline = buffer.indexOf('\n')
      if (line !== '') handleLine(line)
    }
  })
  return promise
}

const scriptedShellProvider = (
  command: string,
  turns: { count: number },
): ProviderClientShape => {
  const actions = [
    JSON.stringify({ action: 'tool', tool: 'shell.exec', command }),
    JSON.stringify({ action: 'final', answer: 'finished' }),
  ]
  const next = (): string => {
    const text = actions[Math.min(turns.count, actions.length - 1)] ?? ''
    turns.count += 1
    return text
  }
  return {
    complete: () => Effect.succeed({ text: next() }),
    stream: () => {
      const text = next()
      return Stream.fromIterable([{ type: 'delta', text }, { type: 'complete', text }])
    },
  }
}

const recordingShellExecutor = (calls: Array<ToolCall>): ToolExecutors => ({
  'shell.exec': (call) =>
    Effect.sync(() => {
      calls.push(call)
      return {
        command: typeof call.input['command'] === 'string' ? call.input['command'] : '',
        stdout: 'approved-output',
        stderr: '',
        exitCode: 0,
        timedOut: false,
        generatedFiles: [],
      }
    }),
})

const workerShellSpec = (input: {
  readonly approval?: ServerAppInput['approval']
  readonly providerClient: ProviderClientShape
  readonly executors: ToolExecutors
}): HarnessSpec => ({
  mode: 'worker',
  providerClient: input.providerClient,
  executors: input.executors,
  ...(input.approval === undefined ? {} : { approval: input.approval }),
})

const chatTurn = (client: ApiClient) => client.chat({ message: 'run the command', sessionId: 's1', runId: 'r1' })

describe('worker spawn args', () => {
  it('parses --approval-socket and leaves it undefined when absent', async () => {
    const parsed = await Effect.runPromise(
      parseWorkerSpawnArgs([
        '--app-state',
        '/tmp/app-state.json',
        '--approval-socket',
        '/tmp/a.sock',
      ]),
    )
    expect(parsed).toEqual({
      mode: 'worker',
      appStatePath: '/tmp/app-state.json',
      projectRoots: [],
      approvalSocket: '/tmp/a.sock',
    })

    const absent = await Effect.runPromise(
      parseWorkerSpawnArgs(['--app-state', '/tmp/app-state.json']),
    )
    expect(absent.approvalSocket).toBeUndefined()
  })
})

describe('worker-mode trust', () => {
  it('serves operations with no token on the worker socket', async () => {
    const spec: HarnessSpec = { mode: 'worker', api: { allowUnauthenticated: false } }
    const listed = await withSocket(spec, (_harness, client) => client.projects())
    expect(listed.projects.map((project) => project.id)).toEqual(['p1'])

    const health = await withSocket(spec, (_harness, client) => client.health())
    expect(health.authRequired).toBe(true)
  })

  it('keeps the api kill switch and the rate limiter in worker mode', async () => {
    const disabled = await withSocket(
      { mode: 'worker', api: { enabled: false } },
      (_harness, client) => failureOf(client.projects()),
    )
    expect(disabled).toBe('ApiDisabled')

    const limited = await withSocket(
      { mode: 'worker', rateLimit: { capacity: 1, refillPerSecond: 0.0001 } },
      (_harness, client) =>
        Effect.gen(function*() {
          yield* client.projects()
          return yield* failureOf(client.projects())
        }),
    )
    expect(limited).toBe('RateLimited')
  })

  it('gates MCP operations for callers that are not the supervisor surface', async () => {
    const spec: HarnessSpec = { mode: 'worker', api: { mcpEnabled: false } }

    const gated = await withRawSocket(spec, (path) => rawNdjsonCall(path, rpcFrame('projects')))
    expect(gated).toContain('McpDisabled')

    const bypassed = await withSocket(
      spec,
      (_harness, client) => client.projects(),
      { [SURFACE_HEADER]: SUPERVISOR_SURFACE },
    )
    expect(bypassed.projects).toHaveLength(1)

    const otherSurface = await withSocket(
      spec,
      (_harness, client) => failureOf(client.projects()),
      { [SURFACE_HEADER]: 'mcp' },
    )
    expect(otherSurface).toBe('McpDisabled')
  })

  it('keeps the full auth matrix on the standalone socket', async () => {
    const spec: HarnessSpec = { mode: 'standalone', api: { allowUnauthenticated: false } }

    const missing = await withSocket(spec, (_harness, client) => failureOf(client.projects()))
    expect(missing).toBe('Unauthorized')

    const supervisorWithoutToken = await withSocket(
      spec,
      (_harness, client) => failureOf(client.projects()),
      { [SURFACE_HEADER]: SUPERVISOR_SURFACE },
    )
    expect(supervisorWithoutToken).toBe('Unauthorized')

    const granted = await withSocket(
      { mode: 'standalone', api: { allowUnauthenticated: true } },
      (_harness, client) => client.projects(),
    )
    expect(granted.currentProject?.id).toBe('p1')
  })
})

describe('supervisor approval channel', () => {
  it('defaults the approval budget to five minutes', () => {
    expect(DEFAULT_APPROVAL_TIMEOUT_MILLIS).toBe(300_000)
  })

  it('binds the control socket user-only and executes shell.exec on approval', async () => {
    const approvalPath = tempPath('approval')
    const calls: Array<ToolCall> = []
    const turns = { count: 0 }

    const outcome = await withSocket(
      workerShellSpec({
        approval: { socketPath: approvalPath },
        providerClient: scriptedShellProvider('echo approved', turns),
        executors: recordingShellExecutor(calls),
      }),
      (harness, client) =>
        Effect.gen(function*() {
          const supervisor = yield* Effect.promise(() => openSupervisor(approvalPath, () => 'approve'))
          const mode = (yield* Effect.promise(() => stat(approvalPath))).mode & 0o777
          const response = yield* chatTurn(client)
          return { supervisor, mode, response, root: harness.root }
        }),
    )

    expect(outcome.mode).toBe(APPROVAL_SOCKET_MODE)
    expect(outcome.supervisor.malformed).toEqual([])
    expect(outcome.supervisor.frames).toHaveLength(1)
    const frame = outcome.supervisor.frames[0]
    expect(frame?.type).toBe('approval_request')
    expect(frame?.projectId).toBe('p1')
    expect(frame?.sessionId).toBe('s1')
    expect(frame?.commands).toEqual(['echo approved'])
    expect(calls.map((call) => call.input['command'])).toEqual(['echo approved'])
    expect(calls[0]?.projectRoot).toBe(outcome.root)
    expect(
      outcome.response.toolEvents.some(
        (event) => event.tool === 'shell.exec' && event.status === 'completed',
      ),
    ).toBe(true)
    expect(outcome.response.message.content).toBe('finished')
  })

  it('denies shell.exec when the supervisor denies it', async () => {
    const approvalPath = tempPath('approval')
    const calls: Array<ToolCall> = []
    const turns = { count: 0 }

    const outcome = await withSocket(
      workerShellSpec({
        approval: { socketPath: approvalPath },
        providerClient: scriptedShellProvider('echo denied', turns),
        executors: recordingShellExecutor(calls),
      }),
      (_harness, client) =>
        Effect.gen(function*() {
          const supervisor = yield* Effect.promise(() => openSupervisor(approvalPath, () => 'deny'))
          const response = yield* chatTurn(client)
          return { supervisor, response }
        }),
    )

    expect(outcome.supervisor.frames).toHaveLength(1)
    expect(outcome.supervisor.frames[0]?.sessionId).toBe('s1')
    expect(outcome.supervisor.frames[0]?.commands).toEqual(['echo denied'])
    expect(calls).toEqual([])
    expect(
      outcome.response.toolEvents.some(
        (event) => event.tool === 'shell.exec' && event.status === 'completed',
      ),
    ).toBe(false)
    expect(
      outcome.response.toolEvents.some(
        (event) => event.detail === 'approval required: echo denied',
      ),
    ).toBe(true)
    expect(outcome.response.message.content).toContain('needs approval')
    expect(turns.count).toBe(1)
  })

  it('denies shell.exec when the approval budget expires without an answer', async () => {
    const approvalPath = tempPath('approval')
    const calls: Array<ToolCall> = []
    const turns = { count: 0 }

    const outcome = await withSocket(
      workerShellSpec({
        approval: { socketPath: approvalPath, timeoutMillis: 50 },
        providerClient: scriptedShellProvider('echo slow', turns),
        executors: recordingShellExecutor(calls),
      }),
      (_harness, client) =>
        Effect.gen(function*() {
          const supervisor = yield* Effect.promise(() => openSupervisor(approvalPath, () => 'ignore'))
          const run = yield* Effect.forkChild(chatTurn(client))
          const frame = yield* Effect.promise(() => supervisor.firstFrame)
          const response = yield* Fiber.join(run)
          return { supervisor, frame, response }
        }),
    )

    expect(outcome.frame.sessionId).toBe('s1')
    expect(outcome.frame.commands).toEqual(['echo slow'])
    expect(outcome.supervisor.frames).toHaveLength(1)
    expect(calls).toEqual([])
    expect(outcome.response.message.content).toContain('needs approval')
    expect(turns.count).toBe(1)
  })

  it('denies shell.exec when the supervisor drops the connection', async () => {
    const approvalPath = tempPath('approval')
    const calls: Array<ToolCall> = []
    const turns = { count: 0 }

    const outcome = await withSocket(
      workerShellSpec({
        approval: { socketPath: approvalPath },
        providerClient: scriptedShellProvider('echo gone', turns),
        executors: recordingShellExecutor(calls),
      }),
      (_harness, client) =>
        Effect.gen(function*() {
          const supervisor = yield* Effect.promise(() => openSupervisor(approvalPath, () => 'drop'))
          const run = yield* Effect.forkChild(chatTurn(client))
          const frame = yield* Effect.promise(() => supervisor.firstFrame)
          const response = yield* Fiber.join(run)
          return { supervisor, frame, response }
        }),
    )

    expect(outcome.frame.sessionId).toBe('s1')
    expect(outcome.frame.commands).toEqual(['echo gone'])
    expect(calls).toEqual([])
    expect(outcome.response.message.content).toContain('needs approval')
  })

  it('denies shell.exec when nobody is connected to the approval socket', async () => {
    const approvalPath = tempPath('approval')
    const calls: Array<ToolCall> = []
    const turns = { count: 0 }

    const response = await withSocket(
      workerShellSpec({
        approval: { socketPath: approvalPath },
        providerClient: scriptedShellProvider('echo nobody', turns),
        executors: recordingShellExecutor(calls),
      }),
      (_harness, client) => chatTurn(client),
    )

    expect(calls).toEqual([])
    expect(response.message.content).toContain('needs approval')
  })

  it('keeps deny-all when no approval socket is configured', async () => {
    const calls: Array<ToolCall> = []
    const turns = { count: 0 }

    const response = await withSocket(
      workerShellSpec({
        providerClient: scriptedShellProvider('echo unapproved', turns),
        executors: recordingShellExecutor(calls),
      }),
      (_harness, client) => chatTurn(client),
    )

    expect(calls).toEqual([])
    expect(response.message.content).toContain('needs approval')
    expect(
      response.toolEvents.some(
        (event) => event.tool === 'shell.exec' && event.status === 'completed',
      ),
    ).toBe(false)
  })

  it('ignores an approval list supplied on the wire', async () => {
    const approvalPath = tempPath('approval')
    const calls: Array<ToolCall> = []
    const turns = { count: 0 }

    const outcome = await withRawSocket(
      workerShellSpec({
        approval: { socketPath: approvalPath, timeoutMillis: 25 },
        providerClient: scriptedShellProvider('echo wire', turns),
        executors: recordingShellExecutor(calls),
      }),
      async (path) => {
        const supervisor = await openSupervisor(approvalPath, () => 'ignore')
        const body = await rawNdjsonCall(path, chatFrameWithWireApproval('run it', ['echo wire']))
        return { supervisor, body }
      },
    )

    expect(outcome.supervisor.frames).toHaveLength(1)
    expect(outcome.supervisor.frames[0]?.sessionId).toBe('s1')
    expect(outcome.supervisor.frames[0]?.commands).toEqual(['echo wire'])
    expect(calls).toEqual([])
    expect(outcome.body).toContain('approval required: echo wire')
  })
})
