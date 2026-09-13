/**
 * Transport mounts: the socket server used by the supervised worker and the
 * HTTP POST + WebSocket server used by the standalone process. Both mount the
 * same `ApiGroup` handlers and middleware.
 */
import { NodeHttpServer, NodeSocketServer } from '@effect/platform-node'
import { Context, Effect, Layer, Scope } from 'effect'
import { Headers, HttpMiddleware, HttpServer, HttpServerRequest, HttpServerResponse } from 'effect/unstable/http'
import * as NetAddress from 'effect/unstable/net/NetAddress'
import { RpcServer } from 'effect/unstable/rpc'
import { SocketServer } from 'effect/unstable/socket'
import { Api, Errors } from 'llm-wiki-protocol'
import { chmod, mkdir, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { dirname } from 'node:path'
import { isAllowedBrowserOrigin } from '../auth/cors.js'
import type { AppContext } from './app.js'
import { handlersLayer } from './handlers.js'
import type { ServerEnv } from './handlers.js'
import { apiGroup, rpcMiddlewareLayer, workerApiGroup } from './middleware.js'
import type { RpcMode } from './middleware.js'

type Response = HttpServerResponse.HttpServerResponse

export const RPC_PATH = '/rpc'
export const RPC_STREAM_PATH = '/rpc/stream'

const rpcServicesLayer = (input: {
  readonly app: AppContext
  readonly env: ServerEnv
}) =>
  Layer.mergeAll(handlersLayer(input.env), rpcMiddlewareLayer).pipe(
    Layer.provide(Layer.succeedContext(input.app)),
  )

export interface SocketMountInput {
  readonly app: AppContext
  readonly env: ServerEnv
  readonly socketServer: SocketServer.SocketServer['Service']
  readonly mode?: RpcMode | undefined
}

const standaloneSocketLayer = (input: SocketMountInput): Layer.Layer<never> =>
  RpcServer.layer(apiGroup).pipe(
    Layer.provide(RpcServer.layerProtocolSocketServer),
    Layer.provide(Api.ApiSerializationLayer),
    Layer.provide(Layer.succeed(SocketServer.SocketServer, input.socketServer)),
    Layer.provide(rpcServicesLayer(input)),
  )

const workerSocketLayer = (input: SocketMountInput): Layer.Layer<never> =>
  RpcServer.layer(workerApiGroup).pipe(
    Layer.provide(RpcServer.layerProtocolSocketServer),
    Layer.provide(Api.ApiSerializationLayer),
    Layer.provide(Layer.succeed(SocketServer.SocketServer, input.socketServer)),
    Layer.provide(rpcServicesLayer(input)),
  )

export const socketRpcLayer = (input: SocketMountInput): Layer.Layer<never> =>
  input.mode === 'worker' ? workerSocketLayer(input) : standaloneSocketLayer(input)

export interface HttpRpcEffects {
  readonly post: Effect.Effect<Response, never, HttpServerRequest.HttpServerRequest | Scope.Scope>
  readonly upgrade: Effect.Effect<Response, never, HttpServerRequest.HttpServerRequest | Scope.Scope>
}

export const makeHttpRpcEffects = (input: {
  readonly app: AppContext
  readonly env: ServerEnv
}): Effect.Effect<HttpRpcEffects, never, Scope.Scope> =>
  Effect.gen(function*() {
    const services = rpcServicesLayer(input)
    const post = yield* RpcServer.toHttpEffect(apiGroup).pipe(
      Effect.provide(services),
      Effect.provide(Api.ApiSerializationLayer),
    )
    const upgrade = yield* RpcServer.toHttpEffectWebsocket(apiGroup).pipe(
      Effect.provide(services),
      Effect.provide(Api.ApiSerializationLayer),
    )
    return { post, upgrade }
  })

const headerValue = (headers: Headers.Headers, name: string): string | undefined => {
  const value = Headers.get(headers, name)
  return value._tag === 'Some' ? value.value : undefined
}

export const isUpgradeOriginAllowed = (headers: Headers.Headers): boolean => {
  const origin = headerValue(headers, 'origin')
  return origin === undefined || isAllowedBrowserOrigin(origin)
}

const requestPath = (url: string): string => {
  const withoutQuery = url.split('?')[0] ?? url
  if (withoutQuery.startsWith('http://') || withoutQuery.startsWith('https://')) {
    try {
      return new URL(withoutQuery).pathname
    } catch {
      return withoutQuery
    }
  }
  return withoutQuery
}

export const makeHttpApp = (input: {
  readonly app: AppContext
  readonly env: ServerEnv
}): Effect.Effect<
  Effect.Effect<Response, never, HttpServerRequest.HttpServerRequest>,
  never,
  Scope.Scope
> =>
  Effect.gen(function*() {
    const effects = yield* makeHttpRpcEffects(input)
    const scope = yield* Effect.scope
    return Effect.gen(function*() {
      const request = yield* HttpServerRequest.HttpServerRequest
      const path = requestPath(request.url)
      const upgrade = headerValue(request.headers, 'upgrade')
      if (path === RPC_STREAM_PATH && upgrade !== undefined) {
        if (!isUpgradeOriginAllowed(request.headers)) {
          return HttpServerResponse.text('Forbidden origin', { status: 403 })
        }
        return yield* Effect.provideService(effects.upgrade, Scope.Scope, scope)
      }
      if (path !== RPC_PATH) {
        return HttpServerResponse.text('Not Found', { status: 404 })
      }
      if (request.method !== 'POST') {
        return HttpServerResponse.text('Method Not Allowed', { status: 405 })
      }
      const contentType = headerValue(request.headers, 'content-type')?.split(';')[0]?.trim()
      if (contentType !== undefined && contentType !== '' && contentType !== Api.ApiSerialization.contentType) {
        return HttpServerResponse.text(
          `Unsupported media type: expected ${Api.ApiSerialization.contentType}`,
          { status: 415, contentType: 'text/plain' },
        )
      }
      return yield* Effect.provideService(effects.post, Scope.Scope, scope)
    })
  })

export const isSocketAlive = (path: string): Promise<boolean> => {
  const { promise, resolve } = Promise.withResolvers<boolean>()
  const socket = connect({ path })
  const finish = (value: boolean) => {
    socket.destroy()
    resolve(value)
  }
  socket.once('connect', () => finish(true))
  socket.once('error', () => finish(false))
  socket.setTimeout(250, () => finish(false))
  return promise
}

export const serveSocket = (input: {
  readonly app: AppContext
  readonly env: ServerEnv
  readonly path: string
  readonly mode?: RpcMode | undefined
}): Effect.Effect<{ readonly path: string }, Errors.BindConflict, Scope.Scope> =>
  Effect.gen(function*() {
    if (yield* Effect.promise(() => isSocketAlive(input.path))) {
      return yield* Effect.fail(
        new Errors.BindConflict({ message: `Socket is already served: ${input.path}` }),
      )
    }
    yield* Effect.promise(async () => {
      await rm(input.path, { force: true })
      await mkdir(dirname(input.path), { recursive: true, mode: 0o700 })
    })
    const socketServer = yield* NodeSocketServer.make({ path: input.path }).pipe(
      Effect.mapError(
        (error) => new Errors.BindConflict({ message: `Cannot bind ${input.path}: ${String(error)}` }),
      ),
    )
    yield* Effect.promise(() => chmod(input.path, 0o600))
    yield* Effect.addFinalizer(() => Effect.promise(() => rm(input.path, { force: true })))
    yield* Effect.forkScoped(
      Layer.launch(socketRpcLayer({ ...input, socketServer })),
    )
    return { path: input.path }
  })

export interface HttpListenOptions {
  readonly host?: string | undefined
  readonly port?: number | undefined
  readonly path?: string | undefined
}

export const serveHttp = (input: {
  readonly app: AppContext
  readonly env: ServerEnv
  readonly listen: HttpListenOptions
}): Effect.Effect<NetAddress.SocketAddress, Errors.BindConflict, Scope.Scope> =>
  Effect.gen(function*() {
    const app = yield* makeHttpApp(input)
    const layer = HttpServer.serve(
      app,
      HttpMiddleware.cors({
        allowedOrigins: (origin) => typeof origin === 'string' && isAllowedBrowserOrigin(origin),
      }),
    ).pipe(
      Layer.provideMerge(
        NodeHttpServer.layer(() => createServer(), { ...input.listen }),
      ),
    )
    const context = yield* Layer.build(layer).pipe(
      Effect.mapError(
        (error) =>
          new Errors.BindConflict({
            message: `Cannot bind ${describeListen(input.listen)}: ${String(error)}`,
          }),
      ),
    )
    return Context.get(context, HttpServer.HttpServer).address
  })

const describeListen = (listen: HttpListenOptions): string =>
  listen.path !== undefined ? listen.path : `${listen.host ?? '127.0.0.1'}:${listen.port ?? 0}`
