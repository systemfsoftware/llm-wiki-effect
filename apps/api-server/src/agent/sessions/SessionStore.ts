/**
 * Project-local agent session persistence.
 *
 * Ported from `AgentSessionStore` in
 * apps/desktop/src-tauri/src/agent/session.rs: each turn appends a user and an
 * assistant message to `<project>/.llm-wiki/agent-sessions/<id>.json`, the
 * message list is capped at 40, and the parsed-session cache is capped at 128.
 * The worker is the sole writer of that directory (KTD7), so the project root
 * always arrives from the caller and is never taken from the process CWD.
 *
 * Deviation from the Rust original: a persistence failure surfaces as a typed
 * `InvalidRequest` instead of being discarded (`let _ = save_session(...)`).
 * An Effect service must not silently lose a write the caller asked for.
 */
import { Context, Effect, Layer } from 'effect'
import { Errors } from 'llm-wiki-protocol'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { isRecord } from '../../json.js'

export const MAX_SESSION_MESSAGES = 40
export const MAX_CACHED_SESSIONS = 128
export const DEFAULT_RECENT_MESSAGES = 12

export interface AgentSessionMessage {
  readonly role: string
  readonly content: string
  readonly timestamp: number
}

export interface AgentSession {
  readonly sessionId: string
  readonly projectId: string
  readonly messages: ReadonlyArray<AgentSessionMessage>
  readonly updatedAt: number
}

export interface SessionStoreShape {
  readonly appendTurn: (
    projectPath: string,
    projectId: string,
    sessionId: string,
    user: string,
    assistant: string,
  ) => Effect.Effect<void, Errors.InvalidRequest>
  readonly recentMessages: (
    projectPath: string,
    sessionId: string,
    limit: number,
  ) => Effect.Effect<ReadonlyArray<AgentSessionMessage>>
  readonly listSessions: (projectPath: string) => Effect.Effect<ReadonlyArray<AgentSession>>
}

export interface SessionStoreOptions {
  readonly now?: () => number
}

const normalizeProjectPath = (path: string): string => path.replaceAll('\\', '/').replace(/\/+$/, '')

const sessionCacheKey = (projectPath: string, sessionId: string): string =>
  `${normalizeProjectPath(projectPath)}::${sessionId}`

export const sanitizeSessionId = (sessionId: string): string | undefined => {
  const trimmed = sessionId.trim()
  if (
    trimmed.length === 0 ||
    trimmed.includes('/') ||
    trimmed.includes('\\') ||
    trimmed.includes('..') ||
    Buffer.byteLength(trimmed, 'utf8') > 128
  ) {
    return undefined
  }
  let sanitized = ''
  for (const char of trimmed) {
    sanitized += /[A-Za-z0-9._-]/.test(char) ? char : '_'
  }
  return sanitized
}

export const sessionFile = (projectPath: string, sessionId: string): string | undefined => {
  const id = sanitizeSessionId(sessionId)
  return id === undefined
    ? undefined
    : join(projectPath, '.llm-wiki', 'agent-sessions', `${id}.json`)
}

const parseMessage = (value: unknown): AgentSessionMessage | undefined => {
  if (!isRecord(value)) return undefined
  const { role, content, timestamp } = value
  if (typeof role !== 'string' || typeof content !== 'string' || typeof timestamp !== 'number') {
    return undefined
  }
  return { role, content, timestamp }
}

const parseSession = (raw: string): AgentSession | undefined => {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!isRecord(parsed)) return undefined
  const messages = parsed['messages']
  const updatedAt = parsed['updatedAt']
  if (!Array.isArray(messages) || typeof updatedAt !== 'number') return undefined
  const stored: Array<AgentSessionMessage> = []
  for (const message of messages) {
    const parsedMessage = parseMessage(message)
    if (parsedMessage === undefined) return undefined
    stored.push(parsedMessage)
  }
  return {
    sessionId: typeof parsed['sessionId'] === 'string' ? parsed['sessionId'] : '',
    projectId: typeof parsed['projectId'] === 'string' ? parsed['projectId'] : '',
    messages: stored,
    updatedAt,
  }
}

const readSessionFile = async (file: string): Promise<AgentSession | undefined> => {
  try {
    return parseSession(await readFile(file, 'utf8'))
  } catch {
    return undefined
  }
}

const loadSession = (
  projectPath: string,
  sessionId: string,
): Effect.Effect<AgentSession | undefined> =>
  Effect.promise(async () => {
    const file = sessionFile(projectPath, sessionId)
    return file === undefined ? undefined : readSessionFile(file)
  })

const saveSession = (
  file: string,
  session: AgentSession,
): Effect.Effect<void, Errors.InvalidRequest> =>
  Effect.tryPromise({
    try: async () => {
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, JSON.stringify(session, null, 2), 'utf8')
    },
    catch: (error) => new Errors.InvalidRequest({ message: `Failed to write session: ${String(error)}` }),
  })

const trimCache = (cache: Map<string, AgentSession>): void => {
  if (cache.size <= MAX_CACHED_SESSIONS) return
  const entries = [...cache.entries()].sort(
    ([leftKey, left], [rightKey, right]) =>
      left.updatedAt - right.updatedAt || (leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0),
  )
  for (const [key] of entries.slice(0, cache.size - MAX_CACHED_SESSIONS)) {
    cache.delete(key)
  }
}

const emptySession = (sessionId: string, projectId: string, now: number): AgentSession => ({
  sessionId,
  projectId,
  messages: [],
  updatedAt: now,
})

export const makeSessionStore = (options?: SessionStoreOptions): SessionStoreShape => {
  const now = options?.now ?? Date.now
  const cache = new Map<string, AgentSession>()

  const appendTurn: SessionStoreShape['appendTurn'] = (
    projectPath,
    projectId,
    sessionId,
    user,
    assistant,
  ) =>
    Effect.gen(function*() {
      const file = sessionFile(projectPath, sessionId)
      if (file === undefined) {
        return yield* Effect.fail(
          new Errors.InvalidRequest({ message: 'Invalid Agent session id' }),
        )
      }
      const timestamp = now()
      const key = sessionCacheKey(projectPath, sessionId)
      const cached = cache.get(key) ?? (yield* loadSession(projectPath, sessionId))
      const base = cached ?? emptySession(sessionId, projectId, timestamp)
      const appended = [
        ...base.messages,
        { role: 'user', content: user, timestamp },
        { role: 'assistant', content: assistant, timestamp },
      ]
      const messages = appended.length > MAX_SESSION_MESSAGES
        ? appended.slice(appended.length - MAX_SESSION_MESSAGES)
        : appended
      const session: AgentSession = { sessionId, projectId, messages, updatedAt: timestamp }
      cache.set(key, session)
      trimCache(cache)
      return yield* saveSession(file, session)
    })

  const recentMessages: SessionStoreShape['recentMessages'] = (projectPath, sessionId, limit) =>
    Effect.gen(function*() {
      const key = sessionCacheKey(projectPath, sessionId)
      let session = cache.get(key)
      if (session === undefined) {
        const loaded = yield* loadSession(projectPath, sessionId)
        if (loaded !== undefined) {
          cache.set(key, loaded)
          trimCache(cache)
          session = loaded
        }
      }
      if (session === undefined) return []
      const bounded = Math.max(0, limit)
      return session.messages.slice(Math.max(0, session.messages.length - bounded))
    })

  const listSessions: SessionStoreShape['listSessions'] = (projectPath) =>
    Effect.promise(async () => {
      const dir = join(projectPath, '.llm-wiki', 'agent-sessions')
      let names: ReadonlyArray<string>
      try {
        names = await readdir(dir)
      } catch {
        return []
      }
      const files = names
        .filter((name) => name.endsWith('.json'))
        .map((name) => join(dir, name))
      const parsed = await Promise.all(files.map((file) => readSessionFile(file)))
      const sessions = parsed.filter((session): session is AgentSession => session !== undefined)
      return sessions.sort(
        (left, right) =>
          right.updatedAt - left.updatedAt ||
          (right.sessionId < left.sessionId ? -1 : right.sessionId > left.sessionId ? 1 : 0),
      )
    })

  return { appendTurn, recentMessages, listSessions }
}

export class SessionStore extends Context.Service<SessionStore, SessionStoreShape>()(
  'llm-wiki-api-server/agent/SessionStore',
) {
  static readonly make: Effect.Effect<SessionStoreShape> = Effect.sync(() => makeSessionStore())

  static readonly layer: Layer.Layer<SessionStore> = Layer.effect(SessionStore, SessionStore.make)
}
