import { Context, Layer } from 'effect'
import { Headers } from 'effect/unstable/http'
import type { HttpClient } from 'effect/unstable/http'
import { RpcClient } from 'effect/unstable/rpc'
import { ApiProtocol, ApiSerializationLayer } from '../rpc.js'
import type { ApiClient } from '../rpc.js'

export type HttpApiClientTransform = <E, R>(
  client: HttpClient.HttpClient.With<E, R>,
) => HttpClient.HttpClient.With<E, R>

export interface HttpApiClientOptions {
  readonly url: string
  readonly token?: string | undefined
  readonly transformClient?: HttpApiClientTransform | undefined
}

const hasToken = (token: string | undefined): token is string => token !== undefined && token.trim().length > 0

const authorizationHeaders = (token: string | undefined): Headers.Headers => {
  if (hasToken(token)) return Headers.fromInput({ authorization: `Bearer ${token.trim()}` })
  return Headers.empty
}

const authorizationLayer = (token: string | undefined): Layer.Layer<never> =>
  Layer.succeedContext(Context.make(RpcClient.CurrentHeaders, authorizationHeaders(token)))

const protocolHttpOptions = (options: HttpApiClientOptions) => {
  if (options.transformClient === undefined) return { url: options.url }
  return { url: options.url, transformClient: options.transformClient }
}

export class HttpApiClient extends Context.Service<HttpApiClient, ApiClient>()(
  'llm-wiki-protocol/client/HttpApiClient',
) {
  static readonly layer = (
    options: HttpApiClientOptions,
  ): Layer.Layer<HttpApiClient, never, HttpClient.HttpClient> =>
    Layer.effect(HttpApiClient, RpcClient.make(ApiProtocol)).pipe(
      Layer.provide(RpcClient.layerProtocolHttp(protocolHttpOptions(options))),
      Layer.provide(ApiSerializationLayer),
      Layer.provideMerge(authorizationLayer(options.token)),
    )
}
