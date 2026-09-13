import { Effect, Option } from 'effect'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  Config,
  CONFIG_CACHE_TTL_MILLIS,
  DEFAULT_BIND_HOST,
  DEFAULT_EMBEDDING_DIMENSIONS,
  DEFAULT_EMBEDDING_MODEL,
  DEFAULT_MAX_CHAT_TOKENS,
  DEFAULT_MAX_CHAT_TURNS,
  MAX_MAX_CHAT_TOKENS,
  MIN_MAX_CHAT_TOKENS,
  parseStandaloneFlags,
  parseWorkerSpawnArgs,
  PUBLIC_BIND_HOST,
} from '../src/config/Config.js'

const tempDirs: Array<string> = []

const makeTempDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'llm-wiki-config-'))
  tempDirs.push(dir)
  return dir
}

const writeJson = async (path: string, value: unknown): Promise<void> => {
  await writeFile(path, JSON.stringify(value), 'utf8')
}

const failed = async <A, E>(effect: Effect.Effect<A, E>): Promise<E> => Effect.runPromise(Effect.flip(effect))

afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('standalone configuration', () => {
  it('applies defaults when the config file is absent', async () => {
    const config = await Effect.runPromise(Config.make({ mode: 'standalone', env: {} }))

    expect(Option.isNone(config.token)).toBe(true)
    expect(config.apiEnabled).toBe(true)
    expect(config.mcpEnabled).toBe(false)
    expect(config.allowUnauthenticated).toBe(false)
    expect(config.projectRoots).toEqual([])
    expect(Option.isNone(config.currentProject)).toBe(true)
    expect(config.chatLimits).toEqual({
      maxTokens: DEFAULT_MAX_CHAT_TOKENS,
      maxTurns: DEFAULT_MAX_CHAT_TURNS,
    })
    expect(config.embedding).toEqual({
      provider: 'openai',
      model: DEFAULT_EMBEDDING_MODEL,
      dimensions: DEFAULT_EMBEDDING_DIMENSIONS,
    })
    expect(config.providerCredentials).toEqual({})
    expect(config.bindHost).toBe(DEFAULT_BIND_HOST)
  })

  it('prefers env over the config file over defaults', async () => {
    const dir = await makeTempDir()
    const configPath = join(dir, 'config.json')
    await writeJson(configPath, {
      api: { token: 'file-token', enabled: false, mcpEnabled: true, bindHost: '10.0.0.5' },
      chat: { maxTokens: 4096, maxTurns: 12 },
      embedding: { provider: 'google', model: 'gemini-embedding-001', dimensions: 768 },
      projects: [join(dir, 'proj')],
      currentProject: 'proj',
      providerCredentials: { openai: { apiKey: 'file-key', baseUrl: 'https://file.example/v1' } },
    })
    const config = await Effect.runPromise(
      Config.make({
        mode: 'standalone',
        configPath,
        env: { LLM_WIKI_API_TOKEN: 'env-token', LLM_WIKI_BIND_HOST: '0.0.0.0' },
      }),
    )

    expect(Option.getOrUndefined(config.token)).toBe('env-token')
    expect(config.bindHost).toBe(PUBLIC_BIND_HOST)
    expect(config.apiEnabled).toBe(false)
    expect(config.mcpEnabled).toBe(true)
    expect(config.chatLimits).toEqual({ maxTokens: 4096, maxTurns: 12 })
    expect(config.embedding).toEqual({
      provider: 'google',
      model: 'gemini-embedding-001',
      dimensions: 768,
    })
    expect(config.projectRoots).toEqual([join(dir, 'proj')])
    expect(Option.getOrUndefined(config.currentProject)).toBe('proj')
    expect(config.providerCredentials['openai']).toEqual({
      apiKey: 'file-key',
      baseUrl: 'https://file.example/v1',
    })
  })

  it('falls back to the file token and raises the bind host for lan access', async () => {
    const dir = await makeTempDir()
    const configPath = join(dir, 'config.json')
    await writeJson(configPath, { api: { token: 'file-token', allowLanAccess: true } })

    const config = await Effect.runPromise(Config.make({ mode: 'standalone', configPath, env: {} }))

    expect(Option.getOrUndefined(config.token)).toBe('file-token')
    expect(config.bindHost).toBe(PUBLIC_BIND_HOST)
  })

  it('clamps chat token limits to the ported 256..32768 band', async () => {
    const dir = await makeTempDir()
    const low = join(dir, 'low.json')
    const high = join(dir, 'high.json')
    await writeJson(low, { chat: { maxTokens: 10 } })
    await writeJson(high, { chat: { maxTokens: 999_999 } })

    const lowConfig = await Effect.runPromise(
      Config.make({ mode: 'standalone', configPath: low, env: {} }),
    )
    const highConfig = await Effect.runPromise(
      Config.make({ mode: 'standalone', configPath: high, env: {} }),
    )

    expect(lowConfig.chatLimits.maxTokens).toBe(MIN_MAX_CHAT_TOKENS)
    expect(highConfig.chatLimits.maxTokens).toBe(MAX_MAX_CHAT_TOKENS)
  })

  it('opens reads with an env token when the file omits one', async () => {
    const dir = await makeTempDir()
    const configPath = join(dir, 'config.json')
    await writeJson(configPath, { api: { allowUnauthenticated: true } })

    const config = await Effect.runPromise(Config.make({ mode: 'standalone', configPath, env: {} }))

    expect(config.allowUnauthenticated).toBe(true)
    expect(Option.isNone(config.token)).toBe(true)
  })

  it('rejects a missing config file and malformed JSON as typed InvalidRequest', async () => {
    const dir = await makeTempDir()
    const missing = await failed(
      Config.make({ mode: 'standalone', configPath: join(dir, 'absent.json'), env: {} }),
    )
    const malformedPath = join(dir, 'malformed.json')
    await writeFile(malformedPath, '{ not json', 'utf8')
    const malformed = await failed(
      Config.make({ mode: 'standalone', configPath: malformedPath, env: {} }),
    )

    expect(missing.name).toBe('InvalidRequest')
    expect(malformed.name).toBe('InvalidRequest')
    expect(malformed.message).toContain('Invalid JSON')
  })
})

describe('worker configuration', () => {
  it('reads the injected app-state path and merges registry, recent, and spawn roots', async () => {
    const dir = await makeTempDir()
    const appStatePath = join(dir, 'app-state.json')
    const registered = join(dir, 'registered')
    const recent = join(dir, 'recent')
    const spawned = join(dir, 'spawned')
    await writeJson(appStatePath, {
      apiConfig: {
        enabled: false,
        mcpEnabled: true,
        allowUnauthenticated: true,
        token: 'store-token',
      },
      llmConfig: { maxTokens: 8192, maxTurns: 4 },
      embeddingConfig: {
        endpoint: 'https://generativelanguage.googleapis.com/v1beta/models/x:embedContent',
        model: 'gemini-embedding-2',
        outputDimensionality: 768,
      },
      projectRegistry: {
        alpha: { path: registered, name: 'Alpha' },
        broken: { path: '' },
      },
      recentProjects: [{ path: recent }],
      providerConfigs: {
        deepseek: { apiKey: 'k', baseUrl: 'https://api.deepseek.com/v1' },
        ollama: { ollamaUrl: 'http://127.0.0.1:11434' },
      },
    })

    const config = await Effect.runPromise(
      Config.make({ mode: 'worker', appStatePath, projectRoots: [spawned], env: {} }),
    )

    expect(Option.getOrUndefined(config.token)).toBe('store-token')
    expect(config.apiEnabled).toBe(false)
    expect(config.mcpEnabled).toBe(true)
    expect(config.allowUnauthenticated).toBe(true)
    expect(config.projectRoots).toEqual([spawned, registered, recent])
    expect(config.chatLimits).toEqual({ maxTokens: 8192, maxTurns: 4 })
    expect(config.embedding).toEqual({
      provider: 'google',
      model: 'gemini-embedding-2',
      dimensions: 768,
    })
    expect(config.providerCredentials['deepseek']).toEqual({
      apiKey: 'k',
      baseUrl: 'https://api.deepseek.com/v1',
    })
    expect(config.providerCredentials['ollama']).toEqual({
      apiKey: '',
      baseUrl: 'http://127.0.0.1:11434',
    })
  })

  it('lets the env token override the app-state token', async () => {
    const dir = await makeTempDir()
    const appStatePath = join(dir, 'app-state.json')
    await writeJson(appStatePath, { apiConfig: { token: 'store-token' } })

    const config = await Effect.runPromise(
      Config.make({
        mode: 'worker',
        appStatePath,
        env: { LLM_WIKI_API_TOKEN: 'env-token' },
      }),
    )

    expect(Option.getOrUndefined(config.token)).toBe('env-token')
  })

  it('starts from defaults when the app-state file does not exist yet', async () => {
    const dir = await makeTempDir()
    const config = await Effect.runPromise(
      Config.make({ mode: 'worker', appStatePath: join(dir, 'app-state.json'), env: {} }),
    )

    expect(config.apiEnabled).toBe(true)
    expect(Option.isNone(config.token)).toBe(true)
    expect(config.projectRoots).toEqual([])
  })
})

describe('config reload', () => {
  it('serves the cached value until the TTL elapses and busts it on reload', async () => {
    const dir = await makeTempDir()
    const configPath = join(dir, 'config.json')
    await writeJson(configPath, { api: { token: 'first' } })
    let clock = 1_000
    const config = await Effect.runPromise(
      Config.make({ mode: 'standalone', configPath, env: {}, now: () => clock }),
    )

    await writeJson(configPath, { api: { token: 'second' } })
    const cached = await Effect.runPromise(config.values)
    expect(Option.getOrUndefined(cached.token)).toBe('first')

    clock += CONFIG_CACHE_TTL_MILLIS
    const expired = await Effect.runPromise(config.values)
    expect(Option.getOrUndefined(expired.token)).toBe('second')

    await writeJson(configPath, { api: { token: 'third' } })
    const reloaded = await Effect.runPromise(config.reload)
    expect(Option.getOrUndefined(reloaded.token)).toBe('third')
    expect(Option.getOrUndefined(config.token)).toBe('third')
  })
})

describe('spawn arguments', () => {
  it('parses the worker handshake arguments', async () => {
    const parsed = await Effect.runPromise(
      parseWorkerSpawnArgs(['--app-state', '/data/app-state.json', '--project-root', '/a', '--project-root=/b']),
    )

    expect(parsed).toEqual({
      mode: 'worker',
      appStatePath: '/data/app-state.json',
      projectRoots: ['/a', '/b'],
    })
  })

  it('requires the app-state path in worker mode', async () => {
    const error = await failed(parseWorkerSpawnArgs([]))

    expect(error.name).toBe('InvalidRequest')
    expect(error.message).toContain('--app-state')
  })

  it('accepts only --config in standalone mode, never the desktop state', async () => {
    const parsed = await Effect.runPromise(parseStandaloneFlags(['--config', '/etc/llm-wiki.json']))
    const rejected = await failed(parseStandaloneFlags(['--app-state', '/data/app-state.json']))

    expect(parsed).toEqual({ mode: 'standalone', configPath: '/etc/llm-wiki.json' })
    expect(rejected.name).toBe('InvalidRequest')
    expect(rejected.message).toContain('Unknown flag: --app-state')
  })
})
