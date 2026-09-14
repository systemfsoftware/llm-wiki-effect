import { Context, Effect, Stream } from 'effect'
import type { Errors } from 'llm-wiki-protocol'
import { agentError, errorMessage } from './provider-errors.js'
import {
  anthropicCompletionText,
  googleCompletionText,
  makeSseDeltaDecoder,
  openAiCompletionText,
  parseAnthropicDelta,
  parseGoogleDelta,
  parseOpenAiDelta,
} from './provider-parsing.js'
import type { CompletionExtractor, DeltaParser } from './provider-parsing.js'
import { buildProviderRequest } from './provider-request.js'
import type { ProviderCompletionRequest, ProviderCredentials, ProviderFamily } from './provider-request.js'
import type { ProviderTransport } from './provider-transport.js'

export interface CompletionResult {
  readonly text: string
}

export type ProviderStreamEvent =
  | { readonly type: 'delta'; readonly text: string }
  | { readonly type: 'complete'; readonly text: string }

export type ProviderCompletion = (
  request: ProviderCompletionRequest,
) => Effect.Effect<CompletionResult, Errors.AgentError>

export type ProviderStream = (
  request: ProviderCompletionRequest,
) => Stream.Stream<ProviderStreamEvent, Errors.AgentError>

export interface ProviderClientShape {
  readonly complete: ProviderCompletion
  readonly stream: ProviderStream
}

export interface ProviderClientOptions {
  readonly credentials: ProviderCredentials
  readonly transport: ProviderTransport
}

const DELTA_PARSERS: Record<ProviderFamily, DeltaParser> = {
  openai: parseOpenAiDelta,
  anthropic: parseAnthropicDelta,
  google: parseGoogleDelta,
}

const COMPLETION_EXTRACTORS: Record<ProviderFamily, CompletionExtractor> = {
  openai: openAiCompletionText,
  anthropic: anthropicCompletionText,
  google: googleCompletionText,
}

const MISSING_CONTENT = 'LLM response did not contain assistant content'

const decodeBody = (body: string): Effect.Effect<unknown, Errors.AgentError> =>
  Effect.suspend(() => {
    try {
      return Effect.succeed(JSON.parse(body) as unknown)
    } catch (error) {
      return agentError(`Invalid LLM JSON: ${errorMessage(error)}`)
    }
  })

const makeProviderClient = (options: ProviderClientOptions): ProviderClientShape => {
  const complete: ProviderCompletion = (request) =>
    Effect.gen(function*() {
      const prepared = yield* buildProviderRequest(options.credentials, request, false)
      const responseBody = yield* options.transport.complete({
        url: prepared.url,
        headers: prepared.headers,
        body: prepared.body,
      })
      const text = COMPLETION_EXTRACTORS[prepared.family](yield* decodeBody(responseBody)).trim()
      if (text === '') {
        return yield* agentError(MISSING_CONTENT)
      }
      return { text }
    })

  const stream: ProviderStream = (request) =>
    Stream.unwrap(
      Effect.gen(function*() {
        if (request.streamingEnabled === false) {
          const result = yield* complete(request)
          return Stream.fromIterable<ProviderStreamEvent>([
            { type: 'delta', text: result.text },
            { type: 'complete', text: result.text },
          ])
        }
        const prepared = yield* buildProviderRequest(options.credentials, request, true)
        const chunks = yield* options.transport.stream({
          url: prepared.url,
          headers: prepared.headers,
          body: prepared.body,
        })
        const decodeDeltas = makeSseDeltaDecoder(DELTA_PARSERS[prepared.family])
        let assembled = ''
        const deltas = Stream.flatMap(chunks, (chunk) => {
          const texts = decodeDeltas.push(chunk)
          assembled += texts.join('')
          return Stream.fromIterable<ProviderStreamEvent>(
            texts.map((text): ProviderStreamEvent => ({ type: 'delta', text })),
          )
        })
        const tail = Stream.suspend(() =>
          Stream.unwrap(
            Effect.gen(function*() {
              const flushed = decodeDeltas.flush()
              assembled += flushed.join('')
              const text = assembled.trim()
              if (text === '') {
                return yield* agentError(MISSING_CONTENT)
              }
              return Stream.fromIterable<ProviderStreamEvent>([
                ...flushed.map((delta): ProviderStreamEvent => ({ type: 'delta', text: delta })),
                { type: 'complete', text },
              ])
            }),
          )
        )
        return Stream.concat(deltas, tail)
      }),
    )

  return { complete, stream }
}

export class ProviderClient extends Context.Service<ProviderClient, ProviderClientShape>()(
  'llm-wiki-api-server/provider/ProviderClient',
  { make: (options: ProviderClientOptions) => Effect.succeed(makeProviderClient(options)) },
) {}
