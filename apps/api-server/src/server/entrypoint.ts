/**
 * Entrypoint helpers shared by the worker and standalone mounts: the agent
 * runtime identity, the worker socket path, and the stdout ready handshake.
 *
 * The agent identity comes from `LLM_WIKI_AGENT_PROVIDER` / `LLM_WIKI_AGENT_MODEL`
 * (defaults `openai` / `gpt-4o`): the landed `Config` carries no `llmConfig`
 * section, so the desktop's project-resolved provider profile is not available
 * here — the supervisor control channel owns that (U16/U17).
 */
import { Effect, Option, Schema } from 'effect'
import { PROTOCOL_VERSION } from 'llm-wiki-protocol'
import { join } from 'node:path'
import type { AgentRuntimeOptions } from '../agent/runtime/AgentRuntime.js'
import { VERSION } from '../version.js'
import type { ServerEnv } from './handlers.js'

export const READY_PREFIX = 'ready '
export const STANDALONE_PORT = 19_828
export const WORKER_SOCKET_ENV = 'LLM_WIKI_SOCKET_PATH'

export const ReadyHandshake = Schema.Struct({
  protocolVersion: Schema.Number,
  serverVersion: Schema.String,
  mode: Schema.Literals(['worker', 'standalone']),
  socketPath: Schema.optional(Schema.String),
  appStatePath: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
})

export type ReadyHandshake = Schema.Schema.Type<typeof ReadyHandshake>

export const readyLine = (handshake: ReadyHandshake): string => `${READY_PREFIX}${JSON.stringify(handshake)}`

export const runUntilShutdownSignal = <A, E, R>(
  program: Effect.Effect<A, E, R>,
): Effect.Effect<A | void, E, R> =>
  program.pipe(
    Effect.raceFirst(
      Effect.callback<void>((resume) => {
        const handler = () => resume(Effect.void)
        process.once('SIGINT', handler)
        process.once('SIGTERM', handler)
        return Effect.sync(() => {
          process.off('SIGINT', handler)
          process.off('SIGTERM', handler)
        })
      }),
    ),
  )

const decodeReadyHandshake = Schema.decodeUnknownOption(ReadyHandshake)

export const parseReadyLine = (line: string): ReadyHandshake | undefined => {
  if (!line.startsWith(READY_PREFIX)) return undefined
  try {
    const parsed: unknown = JSON.parse(line.slice(READY_PREFIX.length))
    const decoded = decodeReadyHandshake(parsed)
    return Option.isSome(decoded) ? decoded.value : undefined
  } catch {
    return undefined
  }
}

const nonEmpty = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim() ?? ''
  return trimmed === '' ? undefined : trimmed
}

export const agentOptionsFromEnv = (env: ServerEnv): AgentRuntimeOptions => ({
  provider: nonEmpty(env['LLM_WIKI_AGENT_PROVIDER']) ?? 'openai',
  model: nonEmpty(env['LLM_WIKI_AGENT_MODEL']) ?? 'gpt-4o',
})

export const workerSocketPath = (env: ServerEnv, appStatePath: string): string =>
  nonEmpty(env[WORKER_SOCKET_ENV]) ?? join(appStatePath, '..', 'api-server.sock')

export const workerHandshake = (socketPath: string, appStatePath: string): ReadyHandshake => ({
  protocolVersion: PROTOCOL_VERSION,
  serverVersion: VERSION,
  mode: 'worker',
  socketPath,
  appStatePath,
})

export const standaloneHandshake = (host: string, port: number): ReadyHandshake => ({
  protocolVersion: PROTOCOL_VERSION,
  serverVersion: VERSION,
  mode: 'standalone',
  url: `http://${host}:${port}`,
})
