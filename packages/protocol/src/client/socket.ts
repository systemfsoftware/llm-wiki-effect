import * as NodeSocket from '@effect/platform-node/NodeSocket'
import { Context, Layer } from 'effect'
import { RpcClient } from 'effect/unstable/rpc'
import type * as Socket from 'effect/unstable/socket/Socket'
import type * as Net from 'node:net'
import { ApiProtocol, ApiSerializationLayer } from '../rpc.js'
import type { ApiClient } from '../rpc.js'

export interface SocketApiClientOptions {
  readonly path: string
  readonly retryTransientErrors?: boolean | undefined
  readonly openTimeout?: Net.NetConnectOpts['timeout'] | undefined
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
      Layer.provide(
        NodeSocket.layerNet({
          path: options.path,
          ...(options.openTimeout === undefined ? {} : { timeout: options.openTimeout }),
        }),
      ),
    )
}
