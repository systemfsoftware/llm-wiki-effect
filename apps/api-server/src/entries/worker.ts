import { NodeHttpClient } from '@effect/platform-node'
import { Effect } from 'effect'
import { parseWorkerSpawnArgs } from '../config/Config.js'
import { buildApp } from '../server/app.js'
import {
  agentOptionsFromEnv,
  readyLine,
  runUntilShutdownSignal,
  workerHandshake,
  workerSocketPath,
} from '../server/entrypoint.js'
import { serveSocket } from '../server/mount.js'

const program = Effect.gen(function*() {
  const env = process.env
  const config = yield* parseWorkerSpawnArgs(process.argv.slice(2))
  const app = yield* buildApp({
    config,
    env,
    agent: agentOptionsFromEnv(env),
    ...(config.approvalSocket === undefined
      ? {}
      : { approval: { socketPath: config.approvalSocket } }),
  })
  const socketPath = workerSocketPath(env, config.appStatePath)
  yield* serveSocket({ app, env, path: socketPath, mode: 'worker' })
  process.stdout.write(`${readyLine(workerHandshake(socketPath, config.appStatePath))}\n`)
  return yield* Effect.never
}).pipe(runUntilShutdownSignal, Effect.provide(NodeHttpClient.layerNodeHttp), Effect.scoped)

Effect.runPromise(program).catch((error: unknown) => {
  process.stderr.write(`llm-wiki-api-server worker failed: ${String(error)}\n`)
  process.exitCode = 1
})
