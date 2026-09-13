/**
 * Chat RPC handlers.
 *
 * Ported from `prepare_chat` / `handle_chat` / `respond_chat_sse` /
 * `handle_cancel_chat` in apps/desktop/src-tauri/src/api_server.rs. The
 * handler owns request preparation (empty-message rejection, `api_`/`run_` id
 * defaulting, persisted-history backfill, cancellation registration), the
 * concurrent-chat gate, stream shaping, and the redaction boundary.
 *
 * Redaction (KTD12) applies per untrusted egress: every `agentEvent` an
 * external consumer sees is redacted, while the terminal aggregate keeps the
 * pre-redaction events so the trusted desktop relay can still offer Undo.
 *
 * Project resolution: the wire `chat` payload carries no project id (only
 * `chatCancel` does), so a chat turn runs against the registry's current
 * project. `chatCancel` resolves its explicit id for the ported 404 parity.
 */
import { Context, Effect, Fiber, Layer, Queue, Stream } from 'effect'
import type { Cause } from 'effect'
import { Domain, Errors } from 'llm-wiki-protocol'
import { randomUUID } from 'node:crypto'
import { Redactor } from '../agent/redaction/Redactor.js'
import { AgentRuntime } from '../agent/runtime/AgentRuntime.js'
import type { AgentTurnImage, AgentTurnRequest } from '../agent/runtime/AgentRuntime.js'
import { CancelRegistry } from '../agent/sessions/CancelRegistry.js'
import { SessionStore } from '../agent/sessions/SessionStore.js'
import { ProjectRegistry } from '../projects/Registry.js'

export const MAX_IN_FLIGHT_CHAT_STREAMS = 8
export const TOO_MANY_CHAT_STREAMS = 'Too many concurrent Agent chat streams'
export const MAX_RECENT_HISTORY = 12

export type ChatError =
  | Errors.InvalidRequest
  | Errors.NotFound
  | Errors.Busy
  | Errors.ChatCancelled
  | Errors.AgentError

export interface ChatRequest {
  readonly message: string
  readonly sessionId?: string | undefined
  readonly runId?: string | undefined
  readonly mode?: Domain.AgentMode | undefined
  readonly retrievalMode?: Domain.AgentRetrievalMode | undefined
  readonly tools?: Domain.AgentToolOptions | undefined
  readonly topK?: number | undefined
  readonly includeContent?: boolean | undefined
  readonly history?: ReadonlyArray<Domain.ChatMessage> | undefined
  readonly historyExplicit?: boolean | undefined
  readonly skills?: ReadonlyArray<string> | undefined
  readonly contextFiles?: ReadonlyArray<string> | undefined
  readonly skillMode?: Domain.AgentSkillMode | undefined
  readonly images?: ReadonlyArray<Domain.AgentImage> | undefined
  readonly persistSession?: boolean | undefined
}

export interface ChatCancelRequest {
  readonly projectId: string
  readonly sessionId: string
}

export interface ChatServiceShape {
  readonly chat: (request: ChatRequest) => Effect.Effect<Domain.ChatResponse, ChatError>
  readonly chatStream: (request: ChatRequest) => Stream.Stream<Domain.ChatStreamEvent, ChatError>
  readonly chatCancel: (
    request: ChatCancelRequest,
  ) => Effect.Effect<Domain.ChatCancelResponse, Errors.InvalidRequest | Errors.NotFound>
}

interface PreparedTurn {
  readonly key: string
  readonly projectId: string
  readonly projectRoot: string
  readonly message: string
  readonly sessionId: string
  readonly runId: string
  readonly mode: Domain.AgentMode
  readonly retrievalMode: Domain.AgentRetrievalMode
  readonly skillMode: Domain.AgentSkillMode
  readonly tools: Domain.AgentToolOptions
  readonly topK: number | undefined
  readonly includeContent: boolean | undefined
  readonly history: ReadonlyArray<{ readonly role: string; readonly content: string }>
  readonly skills: ReadonlyArray<string>
  readonly contextFiles: ReadonlyArray<string>
  readonly images: ReadonlyArray<AgentTurnImage>
  readonly persistSession: boolean
}

const DEFAULT_TOOLS = new Domain.AgentToolOptions({ wiki: true, web: false, anytxt: false })

const makeChatService = (): Effect.Effect<
  ChatServiceShape,
  never,
  ProjectRegistry | SessionStore | CancelRegistry | AgentRuntime | Redactor
> =>
  Effect.gen(function*() {
    const projects = yield* ProjectRegistry
    const sessions = yield* SessionStore
    const registry = yield* CancelRegistry
    const runtime = yield* AgentRuntime
    const redactor = yield* Redactor

    const inFlight = new Set<string>()
    let streamCount = 0

    const acquire = (key: string): Effect.Effect<string, Errors.Busy> =>
      Effect.suspend(() => {
        if (inFlight.has(key)) {
          return Effect.fail(
            new Errors.Busy({ message: `Agent chat turn already in flight for ${key}` }),
          )
        }
        inFlight.add(key)
        return Effect.succeed(key)
      })

    const release = (key: string): void => {
      inFlight.delete(key)
    }

    const acquireStream = (key: string): Effect.Effect<string, Errors.Busy> =>
      Effect.gen(function*() {
        if (streamCount >= MAX_IN_FLIGHT_CHAT_STREAMS) {
          return yield* Effect.fail(new Errors.Busy({ message: TOO_MANY_CHAT_STREAMS }))
        }
        const acquired = yield* acquire(key)
        streamCount += 1
        return acquired
      })

    const releaseStream = (key: string): void => {
      streamCount -= 1
      release(key)
    }

    const prepare = (
      request: ChatRequest,
    ): Effect.Effect<PreparedTurn, Errors.InvalidRequest | Errors.NotFound> =>
      Effect.gen(function*() {
        const message = request.message.trim()
        if (message === '') {
          return yield* Effect.fail(new Errors.InvalidRequest({ message: 'message is required' }))
        }
        const current = (yield* projects.list).find((project) => project.current)
        if (current === undefined) {
          return yield* Effect.fail(new Errors.NotFound({ message: 'No current project' }))
        }
        const requestedSession = request.sessionId?.trim() ?? ''
        const sessionId = requestedSession === '' ? `api_${randomUUID()}` : requestedSession
        const requestedRun = request.runId?.trim() ?? ''
        const runId = requestedRun === '' ? `run_${randomUUID()}` : requestedRun
        let history = (request.history ?? []).map((entry) => ({
          role: entry.role,
          content: entry.content,
        }))
        if (history.length === 0 && request.historyExplicit !== true) {
          const recent = yield* sessions.recentMessages(current.path, sessionId, MAX_RECENT_HISTORY)
          history = recent.map((entry) => ({ role: entry.role, content: entry.content }))
        }
        return {
          key: `${current.id}::${sessionId}`,
          projectId: current.id,
          projectRoot: current.path,
          message,
          sessionId,
          runId,
          mode: request.mode ?? 'standard',
          retrievalMode: request.retrievalMode ?? 'standard',
          skillMode: request.skillMode ?? 'auto',
          tools: request.tools ?? DEFAULT_TOOLS,
          topK: request.topK,
          includeContent: request.includeContent,
          history,
          skills: [...(request.skills ?? [])],
          contextFiles: [...(request.contextFiles ?? [])],
          images: (request.images ?? []).map((image) => ({
            mediaType: image.mediaType,
            dataBase64: image.dataBase64,
          })),
          persistSession: request.persistSession !== false,
        }
      })

    const turnFor = (
      prepared: PreparedTurn,
      onEvent?: (event: Domain.AgentEvent) => Effect.Effect<void>,
    ): AgentTurnRequest => ({
      projectId: prepared.projectId,
      projectRoot: prepared.projectRoot,
      message: prepared.message,
      sessionId: prepared.sessionId,
      runId: prepared.runId,
      mode: prepared.mode,
      retrievalMode: prepared.retrievalMode,
      skillMode: prepared.skillMode,
      tools: prepared.tools,
      topK: prepared.topK,
      includeContent: prepared.includeContent,
      history: prepared.history,
      skills: prepared.skills,
      contextFiles: prepared.contextFiles,
      images: prepared.images,
      persistSession: prepared.persistSession,
      token: registry.start(prepared.projectId, prepared.sessionId, prepared.runId),
      ...(onEvent === undefined ? {} : { onEvent }),
    })

    const finish = (prepared: PreparedTurn): Effect.Effect<void> =>
      Effect.sync(() => registry.finish(prepared.projectId, prepared.sessionId, prepared.runId))

    const chat: ChatServiceShape['chat'] = (request) =>
      Effect.gen(function*() {
        const prepared = yield* prepare(request)
        const key = yield* acquire(prepared.key)
        return yield* runtime.runTurn(turnFor(prepared)).pipe(
          Effect.onExit(() => finish(prepared)),
          Effect.ensuring(Effect.sync(() => release(key))),
        )
      })

    const chatStream: ChatServiceShape['chatStream'] = (request) =>
      Stream.scoped(
        Stream.unwrap(
          Effect.gen(function*() {
            const prepared = yield* prepare(request)
            yield* Effect.acquireRelease(acquireStream(prepared.key), (key) => Effect.sync(() => releaseStream(key)))
            const queue = yield* Queue.unbounded<Domain.AgentEvent, Cause.Done>()
            const run = runtime
              .runTurn(turnFor(prepared, (event) => Effect.asVoid(Queue.offer(queue, event))))
              .pipe(
                Effect.onExit(() => finish(prepared)),
                Effect.onExit(() => Queue.end(queue)),
              )
            const fiber = yield* Effect.forkScoped(run)
            const meta = new Domain.ChatStreamMeta({
              type: 'meta',
              projectId: prepared.projectId,
              sessionId: prepared.sessionId,
              runId: prepared.runId,
            })
            const events = Stream.fromQueue(queue).pipe(
              Stream.map(
                (event) =>
                  new Domain.ChatStreamAgentEvent({
                    type: 'agentEvent',
                    event: redactor.redact(event),
                  }),
              ),
            )
            const done = Stream.fromEffect(Fiber.join(fiber)).pipe(
              Stream.map((response) => new Domain.ChatStreamDone({ type: 'done', response })),
            )
            return Stream.concat(Stream.make(meta), Stream.concat(events, done))
          }),
        ),
      )

    const chatCancel: ChatServiceShape['chatCancel'] = (request) =>
      Effect.gen(function*() {
        yield* projects.resolveRoot(request.projectId)
        const listed = yield* projects.list
        const match = listed.find(
          (project) => project.id === request.projectId || project.path === request.projectId,
        )
        const cancelled = registry.cancel(
          match?.id ?? request.projectId,
          request.sessionId,
        )
        return new Domain.ChatCancelResponse({ sessionId: request.sessionId, cancelled })
      })

    return { chat, chatStream, chatCancel }
  })

export class ChatService extends Context.Service<ChatService, ChatServiceShape>()(
  'llm-wiki-api-server/chat/ChatService',
) {
  static readonly make = makeChatService

  static readonly layer: Layer.Layer<
    ChatService,
    never,
    ProjectRegistry | SessionStore | CancelRegistry | AgentRuntime | Redactor
  > = Layer.effect(ChatService, makeChatService())
}
