import * as NodeSocket from '@effect/platform-node/NodeSocket'
import { Context, Layer } from 'effect'
import { RpcClient } from 'effect/unstable/rpc'
import type * as Socket from 'effect/unstable/socket/Socket'
import { ApiProtocol, ApiSerializationLayer } from '../rpc.js'
import type { ApiClient } from '../rpc.js'

export interface SocketApiClientOptions {
  readonly path: string
  readonly retryTransientErrors?: boolean | undefined
  readonly openTimeout?: number | undefined
}

const protocolSocketOptions = (options: SocketApiClientOptions) => {
  if (options.openTimeout === undefined) return { path: options.path }
  return { path: options.path, timeout: options.openTimeout }
}

export class SocketApiClient extends Context.Service<SocketApiClient, ApiClient>()(
  'llm-wiki-protocol/client/SocketApiClient',
) {
  static readonly layer = (
    options: SocketApiClientOptions,
  ): Layer.Layer<SocketApiClient, Socket.SocketError> =>
    Layer.effect(SocketApiClient, RpcClient.make(ApiProtocol)).pipe(
      Layer.provide(
        RpcClient.layerProtocolSocket({ retryTransientErrors: options.retryTransientErrors }),
      ),
      Layer.provide(ApiSerializationLayer),
      Layer.provide(NodeSocket.layerNet(protocolSocketOptions(options))),
    )
}
