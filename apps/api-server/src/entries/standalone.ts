import { NodeHttpClient } from '@effect/platform-node'
import { Context, Effect } from 'effect'
import * as NetAddress from 'effect/unstable/net/NetAddress'
import { Config, DEFAULT_BIND_HOST, parseStandaloneFlags } from '../config/Config.js'
import { buildApp } from '../server/app.js'
import {
  agentOptionsFromEnv,
  readyLine,
  runUntilShutdownSignal,
  STANDALONE_PORT,
  standaloneHandshake,
} from '../server/entrypoint.js'
import { serveHttp } from '../server/mount.js'

const program = Effect.gen(function*() {
  const env = process.env
  const config = yield* parseStandaloneFlags(process.argv.slice(2))
  const app = yield* buildApp({ config, env, agent: agentOptionsFromEnv(env) })
  const host = (yield* Context.get(app, Config).values).bindHost || DEFAULT_BIND_HOST
  const address = yield* serveHttp({
    app,
    env,
    listen: { host, port: STANDALONE_PORT },
  })
  const boundHost = NetAddress.isInetAddress(address) ? host : '127.0.0.1'
  const port = NetAddress.isInetAddress(address) ? address.port : STANDALONE_PORT
  process.stdout.write(`${readyLine(standaloneHandshake(boundHost, port))}\n`)
  return yield* Effect.never
}).pipe(runUntilShutdownSignal, Effect.provide(NodeHttpClient.layerNodeHttp), Effect.scoped)

Effect.runPromise(program).catch((error: unknown) => {
  process.stderr.write(`llm-wiki-api-server standalone failed: ${String(error)}\n`)
  process.exitCode = 1
})
