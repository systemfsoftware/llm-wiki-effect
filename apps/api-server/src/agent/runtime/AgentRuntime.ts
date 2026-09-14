/**
 * The backend Agent turn loop.
 *
 * Ported from `AgentRuntime::run_once_with_cancel_and_events` /
 * `run_agent_loop` / `execute_agent_loop_tool` in
 * apps/desktop/src-tauri/src/agent/runtime.rs. One turn assembles prompt
 * context, asks the provider for one compact JSON action, executes at most the
 * mode-and-config bounded number of tool iterations, and returns the aggregate
 * response with the full pre-redaction event log.
 *
 * Deviations from the Rust original, both deliberate:
 * - The provider call always goes through `ProviderClient.stream` so a
 *   cancelled turn interrupts the in-flight response instead of waiting for a
 *   buffered body (KTD8). Deltas are folded into the action text; the answer is
 *   emitted as a single `messageDelta`, matching the loop's Rust behavior.
 * - `promptChars`/`completionChars` count JS string length rather than Rust
 *   char/byte length. The counters are advisory usage telemetry.
 *
 * Injected tool executors return the ported tool-output JSON documents
 * (`{references}`, `{path, content}`, `{path, bytes, existedBefore,
 * previousContent}`, `{command, stdout, stderr, ...}`); `mapToolOutput` below
 * is the single place that knows those shapes.
 */
import { Context, Effect, Layer, Result, Stream } from 'effect'
import { Domain, Errors } from 'llm-wiki-protocol'
import { Config } from '../../config/Config.js'
import { isRecord } from '../../json.js'
import { ProviderClient } from '../../provider/provider-client.js'
import type { ProviderReasoning } from '../../provider/provider-request.js'
import { collapseWhitespace, loadExplicitContextFiles, loadProjectContext, trimChars } from '../context/project.js'
import {
  agentIterationLimitAnswer,
  buildAgentContext,
  buildAgentFinalSystem,
  buildAgentFinalUser,
  buildAgentLoopSystem,
  buildAgentLoopUser,
  forcedFinalAnswer,
} from '../context/prompt.js'
import type { AgentObservation } from '../context/prompt.js'
import {
  agentLoopIterationBudget,
  agentLoopRetrievalBudget,
  isAgentRetrievalTool,
  modeLabel,
  projectContextForRetrievalMode,
  retrievalAddedEvidence,
  retrievalSignature,
  smartEvidenceCount,
} from '../context/retrieval.js'
import { routeQuery } from '../context/router.js'
import { loadProjectSkills } from '../context/skills.js'
import type { CancelToken } from '../sessions/CancelRegistry.js'
import { SessionStore } from '../sessions/SessionStore.js'
import { denyAll } from '../tools/Approver.js'
import type { Approver } from '../tools/Approver.js'
import { APPROVAL_REQUIRED_OBSERVATION } from '../tools/permissions.js'
import type { PermissionPolicy } from '../tools/permissions.js'
import { ToolRegistry } from '../tools/ToolRegistry.js'
import type { ToolCall, ToolExecutors } from '../tools/types.js'
import { INVALID_TOOL_JSON, isUserAskTool, parseAgentLoopAction } from './action.js'
import type { AgentLoopAction } from './action.js'
import { sanitizeUserInputRequest } from './user-input.js'

export const DEFAULT_CHAT_SEARCH_RESULTS = 5
export const MAX_CHAT_SEARCH_RESULTS = 10
export const MAX_IMAGES_PER_TURN = 5
export const MAX_IMAGE_BASE64_BYTES = 7 * 1024 * 1024

export type AgentTurnError = Errors.InvalidRequest | Errors.ChatCancelled | Errors.AgentError

export interface AgentTurnImage {
  readonly mediaType: string
  readonly dataBase64: string
}

export interface AgentTurnRequest {
  readonly projectId: string
  readonly projectRoot: string
  readonly message: string
  readonly sessionId: string
  readonly runId: string
  readonly mode: Domain.AgentMode
  readonly retrievalMode: Domain.AgentRetrievalMode
  readonly skillMode: Domain.AgentSkillMode
  readonly tools: Domain.AgentToolOptions
  readonly topK?: number | undefined
  readonly includeContent?: boolean | undefined
  readonly history: ReadonlyArray<{ readonly role: string; readonly content: string }>
  readonly skills: ReadonlyArray<string>
  readonly contextFiles: ReadonlyArray<string>
  readonly images: ReadonlyArray<AgentTurnImage>
  readonly persistSession: boolean
  readonly token: CancelToken
  readonly onEvent?: ((event: Domain.AgentEvent) => Effect.Effect<void>) | undefined
}

export interface AgentRuntimeShape {
  readonly runTurn: (request: AgentTurnRequest) => Effect.Effect<Domain.ChatResponse, AgentTurnError>
}

export interface AgentRuntimeOptions {
  readonly provider: string
  readonly model: string
  readonly reasoning?: ProviderReasoning | undefined
  readonly apiMode?: string | undefined
  readonly azureApiVersion?: string | undefined
  readonly azureModelFamily?: string | undefined
  readonly customHeaders?: Readonly<Record<string, string>> | undefined
  readonly approver?: Approver | undefined
  readonly executors?: ToolExecutors | undefined
  readonly policy?: PermissionPolicy | undefined
}

interface ToolEmission {
  readonly type: 'event' | 'reference'
  readonly event?: Domain.AgentEvent | undefined
  readonly reference?: Domain.ChatReference | undefined
}

type ToolMapping =
  | { readonly error: string }
  | { readonly summary: string; readonly emissions: ReadonlyArray<ToolEmission> }

const QUERY_TOOLS: ReadonlyArray<string> = [
  'wiki.search',
  'source.search',
  'graph.search',
  'web.search',
  'anytxt.search',
]

const approvalRequiredSummary = (command: string): string =>
  `The Agent needs approval before it can run this command:\n\n\`${command}\`\n\nApprove the command if you want the Agent to continue with this skill.`

const validateImages = (
  images: ReadonlyArray<AgentTurnImage>,
): Effect.Effect<void, Errors.InvalidRequest> => {
  if (images.length > MAX_IMAGES_PER_TURN) {
    return Effect.fail(
      new Errors.InvalidRequest({
        message: `At most ${MAX_IMAGES_PER_TURN} images can be attached to one Agent turn`,
      }),
    )
  }
  for (const image of images) {
    if (Buffer.byteLength(image.dataBase64, 'utf8') > MAX_IMAGE_BASE64_BYTES) {
      return Effect.fail(new Errors.InvalidRequest({ message: 'Attached image is too large' }))
    }
  }
  return Effect.void
}

const toolInput = (
  tool: string,
  action: AgentLoopAction,
  request: AgentTurnRequest,
): Readonly<Record<string, unknown>> | string => {
  const topK = Math.min(
    MAX_CHAT_SEARCH_RESULTS,
    Math.max(1, action.topK ?? request.topK ?? DEFAULT_CHAT_SEARCH_RESULTS),
  )
  const trimmed = (value: string | undefined): string | undefined => {
    const next = value?.trim() ?? ''
    return next === '' ? undefined : next
  }
  if (QUERY_TOOLS.includes(tool)) {
    const query = trimmed(action.query)
    if (query === undefined) return `${tool} requires query`
    return {
      query,
      topK,
      includeContent: action.includeContent ?? request.includeContent ?? false,
    }
  }
  switch (tool) {
    case 'wiki.read_page': {
      const path = trimmed(action.path)
      return path === undefined ? 'wiki.read_page requires path' : { path }
    }
    case 'skill.read_file': {
      const path = trimmed(action.path)
      if (path === undefined) return 'skill.read_file requires path'
      return { skill: trimmed(action.skill), path }
    }
    case 'wiki.write_page': {
      const path = trimmed(action.path)
      if (path === undefined) return 'wiki.write_page requires path'
      const content = trimmed(action.content)
      if (content === undefined) return 'wiki.write_page requires content'
      return { path, content, allowOverwrite: action.allowOverwrite ?? false }
    }
    case 'workspace.write_file':
    case 'workspace.append_file': {
      const path = trimmed(action.path)
      if (path === undefined) return `${tool} requires path`
      if (action.content === undefined) return `${tool} requires content`
      return { path, content: action.content }
    }
    case 'shell.exec': {
      const command = trimmed(action.command) ?? trimmed(action.query)
      if (command === undefined) return 'shell.exec requires command'
      return { command, timeoutSeconds: action.timeoutSeconds }
    }
    default:
      return `Unknown Agent tool: ${tool}`
  }
}

const summarizeToolInput = (
  tool: string,
  input: Readonly<Record<string, unknown>>,
): string | undefined => {
  if (QUERY_TOOLS.includes(tool)) return typeof input['query'] === 'string' ? input['query'] : undefined
  if (tool === 'shell.exec') return typeof input['command'] === 'string' ? input['command'] : undefined
  if (PATH_INPUT_TOOLS.includes(tool)) {
    return typeof input['path'] === 'string' ? input['path'] : undefined
  }
  return undefined
}

const PATH_INPUT_TOOLS: ReadonlyArray<string> = [
  'wiki.read_page',
  'wiki.write_page',
  'workspace.write_file',
  'workspace.append_file',
  'skill.read_file',
]

const referenceKey = (reference: Domain.ChatReference): string => `${reference.kind}::${reference.path}`

const pushUniqueReference = (
  references: Array<Domain.ChatReference>,
  seen: Set<string>,
  reference: Domain.ChatReference,
): boolean => {
  const key = referenceKey(reference)
  if (seen.has(key)) return false
  seen.add(key)
  references.push(reference)
  return true
}

const referenceFrom = (value: unknown): Domain.ChatReference | undefined => {
  if (!isRecord(value)) return undefined
  const { title, path, kind } = value
  if (typeof title !== 'string' || typeof path !== 'string' || typeof kind !== 'string') return undefined
  const snippet = typeof value['snippet'] === 'string' ? value['snippet'] : undefined
  const score = typeof value['score'] === 'number' ? value['score'] : undefined
  return new Domain.ChatReference({
    title,
    path,
    kind,
    ...(snippet === undefined ? {} : { snippet }),
    ...(score === undefined ? {} : { score }),
  })
}

const referenceEvent = (reference: Domain.ChatReference): ToolEmission => ({ type: 'reference', reference })

const fileChangedEvent = (event: Domain.AgentEvent): ToolEmission => ({ type: 'event', event })

const bytesOf = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

const asText = (value: unknown): string => (typeof value === 'string' ? value : '')

const mapToolOutput = (tool: string, value: unknown): ToolMapping => {
  if (tool === 'wiki.search') {
    if (!isRecord(value)) return { error: `Invalid wiki.search result: ${JSON.stringify(value)}` }
    const rawReferences = Array.isArray(value['references']) ? value['references'] : []
    const references = rawReferences.map(referenceFrom).filter((r): r is Domain.ChatReference => r !== undefined)
    const summary = `${references.length} result(s), ${references.length} new, mode=${
      asText(value['mode'])
    }, tokenHits=${bytesOf(value['tokenHits'])}, vectorHits=${bytesOf(value['vectorHits'])}, graphHits=${
      bytesOf(value['graphHits'])
    }`
    return { summary, emissions: references.map(referenceEvent) }
  }
  if (tool === 'source.search' || tool === 'graph.search' || tool === 'web.search' || tool === 'anytxt.search') {
    if (!Array.isArray(value)) return { error: `Invalid ${tool} result: ${JSON.stringify(value)}` }
    const references = value.map(referenceFrom).filter((r): r is Domain.ChatReference => r !== undefined)
    return {
      summary: `${references.length} result(s), ${references.length} new`,
      emissions: references.map(referenceEvent),
    }
  }
  if (tool === 'wiki.read_page') {
    if (!isRecord(value)) return { error: `Invalid wiki.read_page result: ${JSON.stringify(value)}` }
    const path = asText(value['path']) || 'wiki page'
    const content = asText(value['content'])
    return {
      summary: `read ${path}\n${trimChars(collapseWhitespace(content), 4_000)}`,
      emissions: [],
    }
  }
  if (tool === 'skill.read_file') {
    if (!isRecord(value)) return { error: `Invalid skill.read_file result: ${JSON.stringify(value)}` }
    const skill = asText(value['skill']) || 'skill'
    const path = asText(value['path']) || 'file'
    return {
      summary: `read ${skill}:${path}\n${trimChars(collapseWhitespace(asText(value['content'])), 4_000)}`,
      emissions: [],
    }
  }
  if (tool === 'wiki.write_page') {
    if (!isRecord(value)) return { error: `Invalid wiki.write_page result: ${JSON.stringify(value)}` }
    const reference = referenceFrom(value['reference'])
    if (reference === undefined) return { error: 'Invalid wiki.write_page result: missing reference' }
    const existedBefore = value['existedBefore'] === true
    const previousContent = typeof value['previousContent'] === 'string' ? value['previousContent'] : undefined
    const emissions: Array<ToolEmission> = [
      fileChangedEvent(
        new Domain.AgentFileChangedEvent({
          type: 'fileChanged',
          path: reference.path,
          tool: 'wiki.write_page',
          existedBefore,
          ...(previousContent === undefined ? {} : { previousContent }),
        }),
      ),
      referenceEvent(reference),
    ]
    return { summary: `wrote ${reference.path}`, emissions }
  }
  if (tool === 'workspace.write_file' || tool === 'workspace.append_file') {
    if (!isRecord(value)) return { error: `Invalid ${tool} result: ${JSON.stringify(value)}` }
    const path = asText(value['path'])
    if (path === '') return { error: `Invalid ${tool} result: missing path` }
    const bytes = bytesOf(value['bytes'])
    const existedBefore = value['existedBefore'] === true
    const previousContent = typeof value['previousContent'] === 'string' ? value['previousContent'] : undefined
    const appended = tool === 'workspace.append_file'
    const reference = new Domain.ChatReference({
      title: path.split('/').pop() ?? path,
      path,
      kind: 'workspace',
      snippet: `Generated file ${appended ? 'updated' : 'written'} by Agent (${bytes} bytes).`,
    })
    return {
      summary: `${appended ? 'appended' : 'wrote'} ${path} (${bytes} bytes)`,
      emissions: [
        fileChangedEvent(
          new Domain.AgentFileChangedEvent({
            type: 'fileChanged',
            path,
            tool,
            existedBefore,
            ...(previousContent === undefined ? {} : { previousContent }),
          }),
        ),
        referenceEvent(reference),
      ],
    }
  }
  if (tool === 'shell.exec') {
    if (!isRecord(value)) return { error: `Invalid shell.exec result: ${JSON.stringify(value)}` }
    const generatedFiles = Array.isArray(value['generatedFiles']) ? value['generatedFiles'] : []
    const emissions: Array<ToolEmission> = []
    const generatedPaths: Array<string> = []
    for (const generated of generatedFiles) {
      if (!isRecord(generated)) continue
      const path = asText(generated['path'])
      if (path === '') continue
      generatedPaths.push(path)
      emissions.push(
        referenceEvent(
          new Domain.ChatReference({
            title: path.split('/').pop() ?? path,
            path,
            kind: 'workspace',
            snippet: `Generated file written by shell.exec (${bytesOf(generated['bytes'])} bytes).`,
          }),
        ),
      )
    }
    const generatedSummary = generatedPaths.length === 0
      ? ''
      : `\nGenerated files:\n${generatedPaths.map((path) => `- ${path}`).join('\n')}`
    return {
      summary: `\`${asText(value['command'])}\` exit=${JSON.stringify(value['exitCode'])} timedOut=${
        value['timedOut'] === true
      }\nstdout:\n${trimChars(asText(value['stdout']), 8_000)}\nstderr:\n${
        trimChars(asText(value['stderr']), 4_000)
      }${generatedSummary}`,
      emissions,
    }
  }
  return { summary: JSON.stringify(value) ?? String(value), emissions: [] }
}

const makeRuntime = (
  options: AgentRuntimeOptions,
): Effect.Effect<
  AgentRuntimeShape,
  never,
  ProviderClient | Config | SessionStore | ToolRegistry
> =>
  Effect.gen(function*() {
    const provider = yield* ProviderClient
    const config = yield* Config
    const sessions = yield* SessionStore
    const tools = yield* ToolRegistry

    const runTurn = (request: AgentTurnRequest): Effect.Effect<Domain.ChatResponse, AgentTurnError> =>
      Effect.gen(function*() {
        const message = request.message.trim()
        if (message === '') {
          return yield* Effect.fail(new Errors.InvalidRequest({ message: 'message is required' }))
        }
        yield* validateImages(request.images)
        yield* request.token.check()

        const values = yield* config.values
        const events: Array<Domain.AgentEvent> = []
        const toolEvents: Array<Domain.ChatToolEvent> = []
        const sink = request.onEvent
        const emit = (event: Domain.AgentEvent): Effect.Effect<void> =>
          Effect.gen(function*() {
            events.push(event)
            if (sink !== undefined) yield* sink(event)
          })
        const recordTool = (tool: string, status: string, detail?: string): void => {
          toolEvents.push(
            new Domain.ChatToolEvent({ tool, status, ...(detail === undefined ? {} : { detail }) }),
          )
        }
        const toolStart = (tool: string, detail: string | undefined): Effect.Effect<void> =>
          emit(
            new Domain.AgentToolStartEvent({ type: 'toolStart', tool, input: detail ?? null }),
          )
        const toolEnd = (tool: string, detail: string | undefined): Effect.Effect<void> =>
          emit(new Domain.AgentToolEndEvent({ type: 'toolEnd', tool, output: detail ?? null }))

        yield* emit(new Domain.AgentStartEvent({ type: 'agentStart', sessionId: request.sessionId }))
        yield* emit(new Domain.AgentTurnStartEvent({ type: 'turnStart', mode: modeLabel(request.mode) }))

        const references: Array<Domain.ChatReference> = []
        const referenceKeys = new Set<string>()
        const observations: Array<AgentObservation> = []
        const router = routeQuery(message, request.mode, request.tools)
        const skills = yield* loadProjectSkills(request.projectRoot, request.skills)
        yield* request.token.check()
        if (request.skills.length > 0) {
          const detail = request.skillMode === 'explicit'
            ? `${skills.length} skill(s) selected`
            : `${skills.length} skill(s) available`
          recordTool('skills.load', 'completed', detail)
          yield* toolEnd('skills.load', detail)
        }
        if (request.tools.web && request.retrievalMode !== 'faithful') {
          recordTool(
            'web.search',
            'available',
            'Web search is enabled for this turn. Router decides whether to execute it immediately.',
          )
        }
        if (request.tools.anytxt && request.retrievalMode !== 'faithful') {
          recordTool(
            'anytxt.search',
            'available',
            'AnyTXT search is enabled for this turn. Router decides whether to execute it immediately.',
          )
        }

        const projectContext = projectContextForRetrievalMode(
          yield* loadProjectContext(request.projectRoot),
          request.retrievalMode,
        )
        const explicitFiles = yield* loadExplicitContextFiles(request.projectRoot, request.contextFiles)
        if (request.contextFiles.length > 0) {
          const detail = `${explicitFiles.length} of ${
            Math.min(request.contextFiles.length, 8)
          } selected file(s) attached`
          recordTool('context.attach', explicitFiles.length === 0 ? 'failed' : 'completed', detail)
          yield* toolEnd('context.attach', detail)
        }

        const hasExplicitSkills = request.skillMode === 'explicit' && skills.length > 0
        const maxIterations = Math.min(
          agentLoopIterationBudget(request.mode, hasExplicitSkills),
          values.chatLimits.maxTurns,
        )
        const retrievalBudget = agentLoopRetrievalBudget(
          request.mode,
          request.retrievalMode,
          hasExplicitSkills,
        )

        const generate = (
          system: string,
          user: string,
          images: ReadonlyArray<AgentTurnImage>,
        ): Effect.Effect<string, Errors.AgentError | Errors.ChatCancelled> =>
          Effect.gen(function*() {
            const stream = provider.stream({
              provider: options.provider,
              model: options.model,
              system,
              user,
              maxTokens: values.chatLimits.maxTokens,
              ...(images.length === 0 ? {} : { images }),
              ...(options.reasoning === undefined ? {} : { reasoning: options.reasoning }),
              ...(options.apiMode === undefined ? {} : { apiMode: options.apiMode }),
              ...(options.azureApiVersion === undefined ? {} : { azureApiVersion: options.azureApiVersion }),
              ...(options.azureModelFamily === undefined ? {} : { azureModelFamily: options.azureModelFamily }),
              ...(options.customHeaders === undefined ? {} : { customHeaders: options.customHeaders }),
            })
            let text = ''
            yield* Stream.runForEach(stream, (event) =>
              Effect.gen(function*() {
                yield* request.token.check()
                if (event.type === 'delta') text += event.text
              }))
            return text
          })

        const reject = (tool: string, error: string): Effect.Effect<AgentObservation> =>
          Effect.gen(function*() {
            recordTool(tool, 'failed', error)
            yield* toolEnd(tool, `rejected: ${error}`)
            return { tool, summary: `rejected: ${error}` }
          })

        const executeTool = (action: AgentLoopAction): Effect.Effect<AgentObservation, AgentTurnError> =>
          Effect.gen(function*() {
            const tool = (action.tool ?? '').trim()
            if (tool === '') {
              return { tool: 'agent.action', summary: 'invalid tool action: missing tool name' }
            }
            const input = toolInput(tool, action, request)
            if (typeof input === 'string') return yield* reject(tool, input)
            const inputDetail = summarizeToolInput(tool, input)
            recordTool(tool, 'started', inputDetail)
            yield* toolStart(tool, inputDetail)
            const call: ToolCall = { projectRoot: request.projectRoot, tool, input }
            const outcome = yield* Effect.result(
              tools.execute(call, { sessionId: request.sessionId }),
            )
            if (Result.isFailure(outcome)) return yield* reject(tool, outcome.failure.message)
            const result = outcome.success
            if (result.status === 'approval_required') {
              recordTool(tool, 'available', result.detail)
              yield* toolEnd(tool, result.detail)
              const command = typeof input['command'] === 'string' ? input['command'] : ''
              return { tool: result.observation, summary: approvalRequiredSummary(command) }
            }
            const mapped = mapToolOutput(tool, result.output)
            if ('error' in mapped) return yield* reject(tool, mapped.error)
            for (const emission of mapped.emissions) {
              if (emission.type === 'reference' && emission.reference !== undefined) {
                if (pushUniqueReference(references, referenceKeys, emission.reference)) {
                  yield* emit(
                    new Domain.AgentReferenceAddedEvent({
                      type: 'referenceAdded',
                      reference: emission.reference,
                    }),
                  )
                }
                continue
              }
              if (emission.event !== undefined) yield* emit(emission.event)
            }
            recordTool(tool, 'completed', inputDetail)
            yield* toolEnd(tool, mapped.summary)
            return { tool, summary: mapped.summary }
          })

        let retrievalSteps = 0
        let consecutiveNoGainRetrievals = 0
        let forceFinalNext = false
        let lastPromptChars = 0
        const executedRetrievals = new Set<string>()

        const failWith = (error: string): Effect.Effect<never, Errors.AgentError> =>
          Effect.gen(function*() {
            recordTool('llm.generate', 'failed', error)
            yield* emit(new Domain.AgentErrorEvent({ type: 'error', message: error }))
            return yield* Effect.fail(new Errors.AgentError({ message: error }))
          })

        if (request.retrievalMode === 'faithful' && request.tools.wiki) {
          const observation = yield* executeTool({ action: 'tool', tool: 'source.search', query: message })
          const sourceInput = toolInput('source.search', { action: 'tool', query: message }, request)
          if (typeof sourceInput !== 'string') {
            executedRetrievals.add(retrievalSignature('source.search', sourceInput, request.retrievalMode))
          }
          retrievalSteps += 1
          observations.push(observation)
        }

        for (let iteration = 0; iteration < maxIterations; iteration += 1) {
          yield* request.token.check()
          const mustFinalize = forceFinalNext || retrievalSteps >= retrievalBudget
          const built = buildAgentContext({
            query: message,
            project: projectContext,
            router,
            history: request.history,
            skills,
            skillMode: request.skillMode,
            references,
            retrievalSummary: '',
            explicitFiles,
          })
          const system = mustFinalize
            ? buildAgentFinalSystem(built.system, request.retrievalMode)
            : buildAgentLoopSystem(built.system, request.retrievalMode)
          const user = mustFinalize
            ? buildAgentFinalUser(built.user, observations)
            : buildAgentLoopUser(
              built.user,
              request.tools,
              request.retrievalMode,
              skills,
              observations,
              iteration,
              maxIterations,
              references.some((reference) => reference.kind === 'workspace'),
            )
          lastPromptChars = system.length + user.length
          recordTool('llm.generate', 'started', `${options.provider}:${options.model}`)
          const images = iteration === 0 ? request.images : []
          const generated = yield* Effect.result(generate(system, user, images))
          if (Result.isFailure(generated)) {
            if (generated.failure._tag === 'ChatCancelled') {
              return yield* Effect.fail(generated.failure)
            }
            return yield* failWith(generated.failure.message)
          }
          const raw = generated.success
          recordTool('llm.generate', 'completed')
          const action = parseAgentLoopAction(raw)

          if (mustFinalize) {
            const answer = forcedFinalAnswer(raw, action, references)
            if (sink !== undefined) {
              yield* emit(new Domain.AgentMessageDeltaEvent({ type: 'messageDelta', text: answer }))
            }
            yield* emit(new Domain.AgentDoneEvent({ type: 'done', sessionId: request.sessionId }))
            return aggregate({
              request,
              answer,
              references,
              toolEvents,
              events,
              promptChars: lastPromptChars,
            })
          }

          if (action.action === INVALID_TOOL_JSON) {
            observations.push(
              yield* reject(
                'agent.action',
                action.answer ?? 'Invalid tool JSON. Return a corrected compact JSON action.',
              ),
            )
            continue
          }

          if (action.action.toLowerCase() === 'final') {
            const answer = (action.answer ?? '').trim() === '' ? raw.trim() : (action.answer ?? '').trim()
            if (sink !== undefined) {
              yield* emit(new Domain.AgentMessageDeltaEvent({ type: 'messageDelta', text: answer }))
            }
            yield* emit(new Domain.AgentDoneEvent({ type: 'done', sessionId: request.sessionId }))
            return aggregate({ request, answer, references, toolEvents, events, promptChars: lastPromptChars })
          }

          if (action.action.toLowerCase() !== 'tool') {
            const answer = raw.trim()
            if (sink !== undefined && answer !== '') {
              yield* emit(new Domain.AgentMessageDeltaEvent({ type: 'messageDelta', text: answer }))
            }
            yield* emit(new Domain.AgentDoneEvent({ type: 'done', sessionId: request.sessionId }))
            return aggregate({ request, answer, references, toolEvents, events, promptChars: lastPromptChars })
          }

          if (action.tool !== undefined && isUserAskTool(action.tool)) {
            const form = sanitizeUserInputRequest(action)
            if (typeof form === 'string') {
              observations.push(
                yield* reject(
                  'user.ask',
                  `${form}. Return a corrected user.ask schema or answer without asking.`,
                ),
              )
              continue
            }
            yield* emit(new Domain.AgentUserInputRequiredEvent({ type: 'userInputRequired', request: form }))
            yield* emit(new Domain.AgentDoneEvent({ type: 'done', sessionId: request.sessionId }))
            const answer = form.description ?? 'Please provide the requested information to continue.'
            return aggregate({
              request,
              answer,
              references,
              toolEvents,
              events,
              promptChars: lastPromptChars,
            })
          }

          const retrievalTool = action.tool !== undefined && isAgentRetrievalTool(action.tool)
          const evidenceBefore = smartEvidenceCount(references)
          if (retrievalTool) {
            const tool = action.tool ?? ''
            const candidate = toolInput(tool, action, request)
            if (typeof candidate !== 'string') {
              const signature = retrievalSignature(tool, candidate, request.retrievalMode)
              if (executedRetrievals.has(signature)) {
                observations.push(
                  yield* reject(
                    tool,
                    'duplicate retrieval skipped; use the existing observation and answer the user',
                  ),
                )
                forceFinalNext = true
                continue
              }
              executedRetrievals.add(signature)
            }
            retrievalSteps += 1
          }

          const observation = yield* executeTool(action)
          if (observation.tool === APPROVAL_REQUIRED_OBSERVATION) {
            const answer = observation.summary
            if (sink !== undefined) {
              yield* emit(new Domain.AgentMessageDeltaEvent({ type: 'messageDelta', text: answer }))
            }
            yield* emit(new Domain.AgentDoneEvent({ type: 'done', sessionId: request.sessionId }))
            return aggregate({ request, answer, references, toolEvents, events, promptChars: lastPromptChars })
          }
          observations.push(observation)
          if (retrievalTool && request.retrievalMode === 'smart') {
            const evidenceAfter = smartEvidenceCount(references)
            if (retrievalAddedEvidence(observation.tool, observation.summary, evidenceBefore, evidenceAfter)) {
              consecutiveNoGainRetrievals = 0
            } else {
              consecutiveNoGainRetrievals += 1
              if (consecutiveNoGainRetrievals >= 2) forceFinalNext = true
            }
          }
        }

        const answer = agentIterationLimitAnswer(maxIterations, observations.length, references)
        if (sink !== undefined) {
          yield* emit(new Domain.AgentMessageDeltaEvent({ type: 'messageDelta', text: answer }))
        }
        yield* emit(new Domain.AgentDoneEvent({ type: 'done', sessionId: request.sessionId }))
        return aggregate({ request, answer, references, toolEvents, events, promptChars: lastPromptChars })
      })

    const chat: AgentRuntimeShape['runTurn'] = (request) =>
      Effect.gen(function*() {
        const response = yield* runTurn(request)
        if (request.persistSession) {
          yield* sessions.appendTurn(
            request.projectRoot,
            request.projectId,
            request.sessionId,
            request.message,
            response.message.content,
          )
        }
        return response
      })

    return { runTurn: chat }
  })

interface AggregateInput {
  readonly request: AgentTurnRequest
  readonly answer: string
  readonly references: ReadonlyArray<Domain.ChatReference>
  readonly toolEvents: ReadonlyArray<Domain.ChatToolEvent>
  readonly events: ReadonlyArray<Domain.AgentEvent>
  readonly promptChars: number
}

const aggregate = (input: AggregateInput): Domain.ChatResponse =>
  new Domain.ChatResponse({
    projectId: input.request.projectId,
    sessionId: input.request.sessionId,
    mode: input.request.mode,
    message: new Domain.ChatMessage({ role: 'assistant', content: input.answer }),
    references: [...input.references],
    toolEvents: [...input.toolEvents],
    events: [...input.events],
    usage: new Domain.ChatUsage({
      promptChars: input.promptChars,
      completionChars: input.answer.length,
      referenceCount: input.references.length,
      toolEventCount: input.toolEvents.length,
    }),
  })

export class AgentRuntime extends Context.Service<AgentRuntime, AgentRuntimeShape>()(
  'llm-wiki-api-server/agent/AgentRuntime',
) {
  static readonly make = makeRuntime

  static readonly layer = (
    options: AgentRuntimeOptions,
  ): Layer.Layer<
    AgentRuntime,
    never,
    ProviderClient | Config | SessionStore | ToolRegistry
  > => Layer.effect(AgentRuntime, makeRuntime(options))
}

export const agentRuntimeLayer = (
  options: AgentRuntimeOptions,
): Layer.Layer<AgentRuntime, never, ProviderClient | Config | SessionStore> =>
  AgentRuntime.layer(options).pipe(
    Layer.provide(
      ToolRegistry.layer({
        approver: options.approver ?? denyAll,
        executors: options.executors,
        policy: options.policy,
      }),
    ),
  )
