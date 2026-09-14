/**
 * Production transports: the embedding HTTP transport and the search query
 * embedder, both over the shared `HttpClient`.
 */
import { Effect, Result } from 'effect'
import { HttpBody, HttpClient } from 'effect/unstable/http'
import { Errors } from 'llm-wiki-protocol'
import type { ConfigShape } from '../config/Config.js'
import type { EmbeddingTransport } from '../embeddings/Embeddings.js'
import { isDoubaoMultimodal, parseEmbeddingValues, singleEmbeddingRequest } from '../embeddings/request.js'
import { embeddingDisabled, embeddingSpecFrom, isGoogleEndpoint } from '../embeddings/spec.js'
import { errorMessage } from '../provider/provider-errors.js'
import type { EmbedQuery } from '../search/Search.js'

const embedError = (kind: Errors.EmbedErrorKind, message: string): Errors.EmbedError =>
  new Errors.EmbedError({ kind, message })

export const httpEmbeddingTransport = (client: HttpClient.HttpClient): EmbeddingTransport => ({
  post: (request) =>
    Effect.gen(function*() {
      const response = yield* client
        .post(request.url, { headers: request.headers, body: HttpBody.text(request.body) })
        .pipe(
          Effect.mapError((error) => embedError('Provider', `Embedding request failed: ${errorMessage(error)}`)),
        )
      const body = yield* response.text.pipe(
        Effect.mapError((error) => embedError('Provider', `Failed to read embedding response: ${errorMessage(error)}`)),
      )
      return { status: response.status, body }
    }),
})

const parseBody = (body: string): Result.Result<unknown, string> => {
  try {
    return Result.succeed(JSON.parse(body) as unknown)
  } catch (error) {
    return Result.fail(error instanceof Error ? error.message : String(error))
  }
}

export const httpQueryEmbedder = (
  transport: EmbeddingTransport,
  config: ConfigShape,
): EmbedQuery =>
(input) =>
  Effect.gen(function*() {
    const values = yield* config.values.pipe(
      Effect.mapError((error) => embedError('InvalidRequest', error.message)),
    )
    const spec = embeddingSpecFrom(values)
    if (!spec.enabled) return yield* Effect.fail(embeddingDisabled())
    const response = yield* transport.post(singleEmbeddingRequest(spec, input.text))
    if (response.status < 200 || response.status >= 300) {
      return yield* Effect.fail(
        embedError('Provider', `Embedding HTTP ${response.status}`),
      )
    }
    const parsed = parseBody(response.body)
    if (Result.isFailure(parsed)) {
      return yield* Effect.fail(
        embedError('Provider', `Embedding response is not JSON: ${parsed.failure}`),
      )
    }
    const vectors = parseEmbeddingValues(
      parsed.success,
      isGoogleEndpoint(spec.endpoint),
      isDoubaoMultimodal(spec),
    )
    if (Result.isFailure(vectors)) {
      return yield* Effect.fail(embedError('Provider', vectors.failure))
    }
    return vectors.success
  })
