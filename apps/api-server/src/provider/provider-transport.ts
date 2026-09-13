import { Effect, Stream } from 'effect'
import { HttpBody, HttpClient, HttpClientResponse } from 'effect/unstable/http'
import type { Errors } from 'llm-wiki-protocol'
import { agentError, errorMessage, trimErrorBody } from './provider-errors.js'

export interface TransportRequest {
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: string
}

export interface ProviderTransport {
  readonly complete: (request: TransportRequest) => Effect.Effect<string, Errors.AgentError>
  readonly stream: (
    request: TransportRequest,
  ) => Effect.Effect<Stream.Stream<Uint8Array, Errors.AgentError>, Errors.AgentError>
}

const isSuccess = (status: number): boolean => status >= 200 && status < 300

export const httpTransport = (client: HttpClient.HttpClient): ProviderTransport => {
  const send = (request: TransportRequest) =>
    client
      .post(request.url, { headers: request.headers, body: HttpBody.text(request.body) })
      .pipe(Effect.mapError((error) => agentError(`LLM request failed: ${errorMessage(error)}`)))

  const readBody = (response: HttpClientResponse.HttpClientResponse) =>
    response.text.pipe(
      Effect.mapError((error) => agentError(`Failed to read LLM response: ${errorMessage(error)}`)),
    )

  return {
    complete: (request) =>
      Effect.gen(function*() {
        const response = yield* send(request)
        const body = yield* readBody(response)
        return isSuccess(response.status)
          ? body
          : yield* agentError(`LLM HTTP ${response.status}: ${trimErrorBody(body)}`)
      }),
    stream: (request) =>
      Effect.gen(function*() {
        const response = yield* send(request)
        if (!isSuccess(response.status)) {
          const body = yield* readBody(response)
          return yield* agentError(`LLM HTTP ${response.status}: ${trimErrorBody(body)}`)
        }
        return response.stream.pipe(
          Stream.mapError((error) => agentError(`LLM stream failed: ${errorMessage(error)}`)),
        )
      }),
  }
}
