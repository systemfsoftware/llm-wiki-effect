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

const authorizationLayer = (token: string | undefined): Layer.Layer<never> => {
  const trimmed = token?.trim() ?? ''
  const headers = trimmed === '' ? Headers.empty : Headers.fromInput({ authorization: `Bearer ${trimmed}` })
  return Layer.succeedContext(Context.make(RpcClient.CurrentHeaders, headers))
}

export class HttpApiClient extends Context.Service<HttpApiClient, ApiClient>()(
  'llm-wiki-protocol/client/HttpApiClient',
) {
  static readonly layer = (
    options: HttpApiClientOptions,
  ): Layer.Layer<HttpApiClient, never, HttpClient.HttpClient> =>
    Layer.effect(HttpApiClient, RpcClient.make(ApiProtocol)).pipe(
      Layer.provide(
        RpcClient.layerProtocolHttp(
          options.transformClient === undefined
            ? { url: options.url }
            : { url: options.url, transformClient: options.transformClient },
        ),
      ),
      Layer.provide(ApiSerializationLayer),
      Layer.provideMerge(authorizationLayer(options.token)),
    )
}
