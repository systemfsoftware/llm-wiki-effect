/**
 * Configuration for the API server in both run modes.
 *
 * Sources (KTD6/KTD11): worker mode receives the desktop's app-state.json path
 * as a spawn argument and reads that file behind a 5s TTL; standalone mode reads
 * one `--config` file plus `LLM_WIKI_*` env and never touches the desktop's
 * state. Precedence everywhere is env > source file > defaults.
 *
 * Port provenance: the field names trace to the `apiConfig` / `llmConfig` /
 * `embeddingConfig` / `providerConfigs` sections of the desktop `AppState` read
 * by apps/desktop/src-tauri/src/api_server.rs (and commands/search.rs for the
 * embedding config); the bind host and its sanitizer port server_bind.rs.
 * `allowUnauthenticated` and `bindHost` are carried at this seam because the auth
 * matrix (R5) and the standalone bind (KTD11) need them beside the token.
 */
import { Context, Effect, Layer, Option, Result } from 'effect'
import { Errors } from 'llm-wiki-protocol'
import { readFile } from 'node:fs/promises'
import { asString, boolOr, hasErrorCode, isRecord, nonEmptyString, positiveInteger } from '../json.js'

export const CONFIG_CACHE_TTL_MILLIS = 5_000

export const DEFAULT_MAX_CHAT_TOKENS = 2_048
export const MIN_MAX_CHAT_TOKENS = 256
export const MAX_MAX_CHAT_TOKENS = 32_768

export const DEFAULT_MAX_CHAT_TURNS = 8
export const MAX_CHAT_TURNS = 64

export const DEFAULT_EMBEDDING_PROVIDER = 'openai'
export const DEFAULT_EMBEDDING_MODEL = 'text-embedding-3-small'
export const DEFAULT_EMBEDDING_DIMENSIONS = 1_536

export const DEFAULT_BIND_HOST = '127.0.0.1'
export const PUBLIC_BIND_HOST = '0.0.0.0'

export interface ProviderCredentials {
  readonly apiKey: string
  readonly baseUrl: string
}

export interface ChatLimits {
  readonly maxTokens: number
  readonly maxTurns: number
}

export interface EmbeddingConfig {
  readonly provider: string
  readonly model: string
  readonly dimensions: number
}

export interface ConfigValues {
  readonly token: Option.Option<string>
  readonly apiEnabled: boolean
  readonly mcpEnabled: boolean
  readonly allowUnauthenticated: boolean
  readonly projectRoots: ReadonlyArray<string>
  readonly currentProject: Option.Option<string>
  readonly chatLimits: ChatLimits
  readonly embedding: EmbeddingConfig
  readonly providerCredentials: Readonly<Record<string, ProviderCredentials>>
  readonly bindHost: string
}

export interface ConfigShape extends ConfigValues {
  readonly values: Effect.Effect<ConfigValues, Errors.InvalidRequest>
  readonly reload: Effect.Effect<ConfigValues, Errors.InvalidRequest>
}

export interface WorkerConfigInput {
  readonly mode: 'worker'
  readonly appStatePath: string
  readonly projectRoots?: ReadonlyArray<string>
  readonly approvalSocket?: string | undefined
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly now?: () => number
}

export interface StandaloneConfigInput {
  readonly mode: 'standalone'
  readonly configPath?: string
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly now?: () => number
}

export type ConfigInput = WorkerConfigInput | StandaloneConfigInput

const WORKER_FLAGS: Record<string, true> = {
  'app-state': true,
  'project-root': true,
  'approval-socket': true,
}
const STANDALONE_FLAGS: Record<string, true> = { config: true }

export const sanitizeBindHost = (value: string): Option.Option<string> => {
  const host = value.trim()
  if (host.length === 0) return Option.none()
  return /^[A-Za-z0-9._:[\]-]+$/.test(host) ? Option.some(host) : Option.none()
}

export const isGoogleEmbeddingEndpoint = (endpoint: string): boolean => {
  const lower = endpoint.toLowerCase()
  return (
    lower.includes('generativelanguage.googleapis.com') || lower.includes(':embedcontent')
  )
}

export const normalizeProjectPath = (path: string): string => path.replace(/\\/g, '/').replace(/\/+$/, '')

export const projectPathMatches = (
  storedPath: string,
  candidate: string,
  caseInsensitive: boolean,
): boolean => {
  const stored = normalizeProjectPath(storedPath)
  const candidatePath = normalizeProjectPath(candidate)
  return caseInsensitive
    ? stored.toLowerCase() === candidatePath.toLowerCase()
    : stored === candidatePath
}

export const projectNameFromPath = (path: string): string => {
  const normalized = normalizeProjectPath(path)
  const base = normalized.slice(normalized.lastIndexOf('/') + 1)
  return base.length > 0 ? base : 'Project'
}

export const dedupeProjectRoots = (paths: ReadonlyArray<string>): ReadonlyArray<string> => {
  const seen = new Set<string>()
  const out: Array<string> = []
  for (const path of paths) {
    const normalized = normalizeProjectPath(path)
    if (normalized.length === 0 || seen.has(normalized)) continue
    seen.add(normalized)
    out.push(normalized)
  }
  return out
}

const clampChatTokens = (value: unknown): number => {
  const parsed = positiveInteger(value) ?? DEFAULT_MAX_CHAT_TOKENS
  return Math.min(Math.max(parsed, MIN_MAX_CHAT_TOKENS), MAX_MAX_CHAT_TOKENS)
}

const clampChatTurns = (value: unknown): number => {
  const parsed = positiveInteger(value) ?? DEFAULT_MAX_CHAT_TURNS
  return Math.min(parsed, MAX_CHAT_TURNS)
}

const embeddingFrom = (embedding: Record<string, unknown>): EmbeddingConfig => {
  const endpoint = asString(embedding['endpoint']) ?? ''
  const provider = nonEmptyString(embedding['provider']) ??
    (isGoogleEmbeddingEndpoint(endpoint) ? 'google' : DEFAULT_EMBEDDING_PROVIDER)
  const dimensions = positiveInteger(embedding['dimensions']) ??
    positiveInteger(embedding['outputDimensionality']) ??
    DEFAULT_EMBEDDING_DIMENSIONS
  return {
    provider,
    model: nonEmptyString(embedding['model']) ?? DEFAULT_EMBEDDING_MODEL,
    dimensions,
  }
}

const credentialsFrom = (value: unknown): Readonly<Record<string, ProviderCredentials>> => {
  const out: Record<string, ProviderCredentials> = {}
  if (!isRecord(value)) return out
  for (const [name, entry] of Object.entries(value)) {
    if (!isRecord(entry)) continue
    out[name] = {
      apiKey: asString(entry['apiKey']) ?? '',
      baseUrl: asString(entry['baseUrl']) ??
        asString(entry['customEndpoint']) ??
        asString(entry['ollamaUrl']) ??
        '',
    }
  }
  return out
}

const bindHostFor = (
  env: Readonly<Record<string, string | undefined>>,
  api: Record<string, unknown>,
): string => {
  const envHost = env['LLM_WIKI_BIND_HOST']
  const fromEnv = envHost === undefined ? Option.none<string>() : sanitizeBindHost(envHost)
  if (Option.isSome(fromEnv)) return fromEnv.value
  const fromFile = Option.flatMap(Option.fromNullishOr(asString(api['bindHost'])), sanitizeBindHost)
  if (Option.isSome(fromFile)) return fromFile.value
  return boolOr(api['allowLanAccess'], false) ? PUBLIC_BIND_HOST : DEFAULT_BIND_HOST
}

const tokenFor = (
  env: Readonly<Record<string, string | undefined>>,
  stored: unknown,
): Option.Option<string> => Option.fromNullishOr(nonEmptyString(env['LLM_WIKI_API_TOKEN']) ?? nonEmptyString(stored))

const pathsFromRecords = (value: unknown, key: string): ReadonlyArray<string> => {
  if (!isRecord(value)) return []
  return Object.values(value)
    .map((entry) => (isRecord(entry) ? nonEmptyString(entry[key]) : undefined))
    .filter((path): path is string => path !== undefined)
}

const registryPathsFromAppState = (raw: Record<string, unknown>): ReadonlyArray<string> =>
  pathsFromRecords(raw['projectRegistry'], 'path')

const recentPathsFromAppState = (raw: Record<string, unknown>): ReadonlyArray<string> => {
  const recent = raw['recentProjects']
  if (!Array.isArray(recent)) return []
  return recent
    .map((entry) => (isRecord(entry) ? nonEmptyString(entry['path']) : undefined))
    .filter((path): path is string => path !== undefined)
}

const standalonePaths = (value: unknown): ReadonlyArray<string> => {
  if (!Array.isArray(value)) return []
  return value
    .map((entry) =>
      typeof entry === 'string'
        ? nonEmptyString(entry)
        : isRecord(entry)
        ? nonEmptyString(entry['path'])
        : undefined
    )
    .filter((path): path is string => path !== undefined)
}

export const configValuesFromAppState = (
  raw: unknown,
  env: Readonly<Record<string, string | undefined>>,
  spawnProjectRoots: ReadonlyArray<string>,
): ConfigValues => {
  const state = isRecord(raw) ? raw : {}
  const api = isRecord(state['apiConfig']) ? state['apiConfig'] : {}
  const llm = isRecord(state['llmConfig']) ? state['llmConfig'] : {}
  const embedding = isRecord(state['embeddingConfig']) ? state['embeddingConfig'] : {}
  return {
    token: tokenFor(env, api['token']),
    apiEnabled: boolOr(api['enabled'], true),
    mcpEnabled: boolOr(api['mcpEnabled'], false),
    allowUnauthenticated: boolOr(api['allowUnauthenticated'], false),
    projectRoots: dedupeProjectRoots([
      ...spawnProjectRoots,
      ...registryPathsFromAppState(state),
      ...recentPathsFromAppState(state),
    ]),
    currentProject: Option.fromNullishOr(nonEmptyString(state['currentProject'])),
    chatLimits: {
      maxTokens: clampChatTokens(llm['maxTokens']),
      maxTurns: clampChatTurns(llm['maxTurns']),
    },
    embedding: embeddingFrom(embedding),
    providerCredentials: credentialsFrom(state['providerConfigs']),
    bindHost: bindHostFor(env, api),
  }
}

export const configValuesFromStandaloneFile = (
  raw: unknown,
  env: Readonly<Record<string, string | undefined>>,
): ConfigValues => {
  const file = isRecord(raw) ? raw : {}
  const api = isRecord(file['api']) ? file['api'] : {}
  const chat = isRecord(file['chat']) ? file['chat'] : {}
  const embedding = isRecord(file['embedding']) ? file['embedding'] : {}
  return {
    token: tokenFor(env, api['token']),
    apiEnabled: boolOr(api['enabled'], true),
    mcpEnabled: boolOr(api['mcpEnabled'], false),
    allowUnauthenticated: boolOr(api['allowUnauthenticated'], false),
    projectRoots: dedupeProjectRoots(standalonePaths(file['projects'])),
    currentProject: Option.fromNullishOr(nonEmptyString(file['currentProject'])),
    chatLimits: {
      maxTokens: clampChatTokens(chat['maxTokens']),
      maxTurns: clampChatTurns(chat['maxTurns']),
    },
    embedding: embeddingFrom(embedding),
    providerCredentials: credentialsFrom(file['providerCredentials']),
    bindHost: bindHostFor(env, api),
  }
}

type Flags = ReadonlyMap<string, ReadonlyArray<string>>

const splitFlag = (token: string): readonly [string, string | undefined] => {
  const body = token.slice(2)
  const equals = body.indexOf('=')
  return equals === -1 ? [body, undefined] : [body.slice(0, equals), body.slice(equals + 1)]
}

const collectFlags = (
  argv: ReadonlyArray<string>,
  known: Record<string, true>,
): Result.Result<Flags, Errors.InvalidRequest> => {
  const flags = new Map<string, Array<string>>()
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === undefined || !token.startsWith('--')) {
      return Result.fail(
        new Errors.InvalidRequest({ message: `Unexpected argument: ${String(token)}` }),
      )
    }
    const [name, inlineValue] = splitFlag(token)
    if (known[name] !== true) {
      return Result.fail(new Errors.InvalidRequest({ message: `Unknown flag: --${name}` }))
    }
    let value = inlineValue
    if (value === undefined) {
      const next = argv[index + 1]
      if (next === undefined || next.startsWith('--')) {
        return Result.fail(
          new Errors.InvalidRequest({ message: `Flag --${name} requires a value` }),
        )
      }
      value = next
      index += 1
    }
    const bucket = flags.get(name)
    if (bucket === undefined) flags.set(name, [value])
    else bucket.push(value)
  }
  return Result.succeed(flags)
}

export const parseWorkerSpawnArgs = (
  argv: ReadonlyArray<string>,
): Effect.Effect<WorkerConfigInput, Errors.InvalidRequest> =>
  Effect.suspend(() => {
    const flags = collectFlags(argv, WORKER_FLAGS)
    if (Result.isFailure(flags)) return Effect.fail(flags.failure)
    const values = flags.success
    const appStatePath = values.get('app-state')?.[0]
    if (appStatePath === undefined) {
      return Effect.fail(
        new Errors.InvalidRequest({ message: 'Worker mode requires --app-state <path>' }),
      )
    }
    const projectRoots = values.get('project-root') ?? []
    const approvalSocket = values.get('approval-socket')?.[0]
    return Effect.succeed({
      mode: 'worker',
      appStatePath,
      projectRoots,
      ...(approvalSocket === undefined ? {} : { approvalSocket }),
    })
  })

export const parseStandaloneFlags = (
  argv: ReadonlyArray<string>,
): Effect.Effect<StandaloneConfigInput, Errors.InvalidRequest> =>
  Effect.suspend(() => {
    const flags = collectFlags(argv, STANDALONE_FLAGS)
    if (Result.isFailure(flags)) return Effect.fail(flags.failure)
    const configPath = flags.success.get('config')?.[0]
    return Effect.succeed(
      configPath === undefined ? { mode: 'standalone' } : { mode: 'standalone', configPath },
    )
  })

const readJsonFile = (
  path: string,
  onMissing: 'empty' | 'error',
): Effect.Effect<unknown, Errors.InvalidRequest> =>
  Effect.tryPromise({
    try: async () => {
      let text: string
      try {
        text = await readFile(path, 'utf8')
      } catch (error) {
        if (onMissing === 'empty' && hasErrorCode(error, 'ENOENT')) return {}
        throw new Errors.InvalidRequest({
          message: `Cannot read config file ${path}: ${String(error)}`,
        })
      }
      try {
        return JSON.parse(text) as unknown
      } catch (error) {
        throw new Errors.InvalidRequest({
          message: `Invalid JSON in config file ${path}: ${String(error)}`,
        })
      }
    },
    catch: (error) =>
      error instanceof Errors.InvalidRequest
        ? error
        : new Errors.InvalidRequest({ message: String(error) }),
  })

const readSource = (
  input: ConfigInput,
  env: Readonly<Record<string, string | undefined>>,
): Effect.Effect<ConfigValues, Errors.InvalidRequest> => {
  if (input.mode === 'worker') {
    return Effect.map(
      readJsonFile(input.appStatePath, 'empty'),
      (raw) => configValuesFromAppState(raw, env, input.projectRoots ?? []),
    )
  }
  const configPath = input.configPath
  return configPath === undefined
    ? Effect.succeed(configValuesFromStandaloneFile({}, env))
    : Effect.map(readJsonFile(configPath, 'error'), (raw) => configValuesFromStandaloneFile(raw, env))
}

export class Config extends Context.Service<Config, ConfigShape>()(
  'llm-wiki-api-server/Config',
) {
  static readonly make = (input: ConfigInput): Effect.Effect<ConfigShape, Errors.InvalidRequest> =>
    Effect.gen(function*() {
      const env = input.env ?? process.env
      const now = input.now ?? Date.now
      const loaded = yield* readSource(input, env)
      let cached: { readonly loadedAt: number; readonly value: ConfigValues } = {
        loadedAt: now(),
        value: loaded,
      }

      const refresh = (force: boolean): Effect.Effect<ConfigValues, Errors.InvalidRequest> =>
        Effect.suspend(() => {
          if (!force && now() - cached.loadedAt < CONFIG_CACHE_TTL_MILLIS) {
            return Effect.succeed(cached.value)
          }
          return Effect.map(readSource(input, env), (value) => {
            cached = { loadedAt: now(), value }
            return value
          })
        })

      const snapshot = (): ConfigValues => cached.value

      return {
        get token() {
          return snapshot().token
        },
        get apiEnabled() {
          return snapshot().apiEnabled
        },
        get mcpEnabled() {
          return snapshot().mcpEnabled
        },
        get allowUnauthenticated() {
          return snapshot().allowUnauthenticated
        },
        get projectRoots() {
          return snapshot().projectRoots
        },
        get currentProject() {
          return snapshot().currentProject
        },
        get chatLimits() {
          return snapshot().chatLimits
        },
        get embedding() {
          return snapshot().embedding
        },
        get providerCredentials() {
          return snapshot().providerCredentials
        },
        get bindHost() {
          return snapshot().bindHost
        },
        get values() {
          return refresh(false)
        },
        get reload() {
          return refresh(true)
        },
      }
    })

  static readonly layer = (input: ConfigInput): Layer.Layer<Config, Errors.InvalidRequest> =>
    Layer.effect(Config, Config.make(input))
}
