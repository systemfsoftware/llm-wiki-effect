import { Effect } from 'effect'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  cancelKey,
  CancelRegistry,
  makeCancelRegistry,
  makeSessionStore,
  MAX_SESSION_MESSAGES,
  sanitizeSessionId,
  sessionFile,
  SessionStore,
} from '../src/agent/sessions/index.js'

const createdProjects: Array<string> = []

const makeProject = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'llm-wiki-agent-session-'))
  createdProjects.push(root)
  return root
}

const sessionFileIn = (project: string, sessionId: string): string => {
  const file = sessionFile(project, sessionId)
  if (file === undefined) throw new Error('expected a session file path')
  return file
}

afterEach(async () => {
  await Promise.all(
    createdProjects.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

describe('session store', () => {
  it('tracks recent messages in order across turns', async () => {
    const project = await makeProject()
    const store = makeSessionStore()
    await Effect.runPromise(store.appendTurn(project, 'p1', 's1', 'hello', 'hi'))
    await Effect.runPromise(store.appendTurn(project, 'p1', 's1', 'question', 'answer'))

    const messages = await Effect.runPromise(store.recentMessages(project, 's1', 3))

    expect(messages).toHaveLength(3)
    expect(messages[0]?.content).toBe('hi')
    expect(messages[1]?.role).toBe('user')
    expect(messages[2]?.content).toBe('answer')
  })

  it('returns no messages for a missing session', async () => {
    const project = await makeProject()
    const store = makeSessionStore()

    expect(await Effect.runPromise(store.recentMessages(project, 'missing', 10))).toEqual([])
    expect(await Effect.runPromise(store.listSessions(project))).toEqual([])
  })

  it('persists the session to the project state dir with the ported JSON shape', async () => {
    const project = await makeProject()
    const store = makeSessionStore({ now: () => 1_700 })
    await Effect.runPromise(store.appendTurn(project, 'p1', 's.persist', 'hello', 'hi'))

    const file = sessionFileIn(project, 's.persist')
    expect(file.startsWith(project)).toBe(true)
    const raw = await readFile(file, 'utf8')
    expect(JSON.parse(raw)).toEqual({
      sessionId: 's.persist',
      projectId: 'p1',
      messages: [
        { role: 'user', content: 'hello', timestamp: 1_700 },
        { role: 'assistant', content: 'hi', timestamp: 1_700 },
      ],
      updatedAt: 1_700,
    })
    expect(raw).toBe(JSON.stringify(JSON.parse(raw), null, 2))

    const fresh = makeSessionStore()
    const messages = await Effect.runPromise(fresh.recentMessages(project, 's.persist', 10))
    expect(messages.map((message) => message.content)).toEqual(['hello', 'hi'])
  })

  it('caps the persisted message list at 40, dropping the oldest', async () => {
    const project = await makeProject()
    const store = makeSessionStore({ now: () => 1 })
    for (let turn = 0; turn < 25; turn += 1) {
      await Effect.runPromise(store.appendTurn(project, 'p1', 'capped', `u${turn}`, `a${turn}`))
    }

    const messages = await Effect.runPromise(store.recentMessages(project, 'capped', 1_000))

    expect(messages).toHaveLength(MAX_SESSION_MESSAGES)
    expect(messages[0]?.content).toBe('u5')
    expect(messages[messages.length - 1]?.content).toBe('a24')
  })

  it('isolates the same session id between projects', async () => {
    const projectA = await makeProject()
    const projectB = await makeProject()
    const store = makeSessionStore()
    await Effect.runPromise(store.appendTurn(projectA, 'p1', 'same', 'hello a', 'answer a'))
    await Effect.runPromise(store.appendTurn(projectB, 'p2', 'same', 'hello b', 'answer b'))

    const a = await Effect.runPromise(store.recentMessages(projectA, 'same', 10))
    const b = await Effect.runPromise(store.recentMessages(projectB, 'same', 10))

    expect(a.map((message) => message.content)).toEqual(['hello a', 'answer a'])
    expect(b.map((message) => message.content)).toEqual(['hello b', 'answer b'])
  })

  it('lists sessions by newest update then session id, skipping non-session files', async () => {
    const project = await makeProject()
    const dir = join(project, '.llm-wiki', 'agent-sessions')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'notes.txt'), 'ignore me', 'utf8')
    await writeFile(join(dir, 'broken.json'), '{ not json', 'utf8')

    let tick = 1_000
    const store = makeSessionStore({ now: () => (tick += 1) })
    await Effect.runPromise(store.appendTurn(project, 'p1', 's1', 'hello', 'hi'))
    await Effect.runPromise(store.appendTurn(project, 'p1', 's2', 'hello', 'hi'))

    expect(
      (await Effect.runPromise(store.listSessions(project))).map((session) => session.sessionId),
    ).toEqual(['s2', 's1'])

    const tiedProject = await makeProject()
    const tied = makeSessionStore({ now: () => 5 })
    await Effect.runPromise(tied.appendTurn(tiedProject, 'p1', 'alpha', 'hello', 'hi'))
    await Effect.runPromise(tied.appendTurn(tiedProject, 'p1', 'beta', 'hello', 'hi'))
    const listed = await Effect.runPromise(tied.listSessions(tiedProject))
    expect(listed.map((session) => session.sessionId)).toEqual(['beta', 'alpha'])
  })

  it('rejects session ids that could escape the state dir', async () => {
    const project = await makeProject()
    const store = makeSessionStore()

    expect(sanitizeSessionId(' s.persist ')).toBe('s.persist')
    expect(sanitizeSessionId('run id*')).toBe('run_id_')
    expect(sanitizeSessionId('')).toBeUndefined()
    expect(sanitizeSessionId('a/b')).toBeUndefined()
    expect(sanitizeSessionId('a\\b')).toBeUndefined()
    expect(sanitizeSessionId('a..b')).toBeUndefined()
    expect(sanitizeSessionId('x'.repeat(129))).toBeUndefined()

    const error = await Effect.runPromise(
      Effect.flip(store.appendTurn(project, 'p1', '../escape', 'u', 'a')),
    )
    expect(error.name).toBe('InvalidRequest')
    expect(error.message).toBe('Invalid Agent session id')
  })

  it('serves the store through its layer', async () => {
    const project = await makeProject()
    const program = Effect.gen(function*() {
      const sessions = yield* SessionStore
      yield* sessions.appendTurn(project, 'p1', 'layer', 'hello', 'hi')
      return yield* sessions.recentMessages(project, 'layer', 5)
    })

    const messages = await Effect.runPromise(Effect.provide(program, SessionStore.layer))
    expect(messages.map((message) => message.content)).toEqual(['hello', 'hi'])
  })
})

describe('cancellation registry', () => {
  it('cancels a running run once and surfaces the typed ChatCancelled error', async () => {
    const registry = makeCancelRegistry()
    const token = registry.start('p1', 's1', 'r1')
    expect(token.isCancelled()).toBe(false)
    await Effect.runPromise(token.check())

    expect(registry.cancel('p1', 's1', 'r1')).toBe(true)
    expect(token.isCancelled()).toBe(true)
    expect(registry.cancel('p1', 's1', 'r1')).toBe(true)
    expect(token.isCancelled()).toBe(true)

    const error = await Effect.runPromise(Effect.flip(token.check()))
    expect(error.name).toBe('ChatCancelled')
    expect(error.message).toBe('Agent turn cancelled')
  })

  it('returns false when no run matches', () => {
    const registry = makeCancelRegistry()
    expect(registry.cancel('p1', 'missing')).toBe(false)
    expect(registry.cancel('p1', 'missing', 'r1')).toBe(false)
  })

  it('isolates projects and runs', () => {
    const registry = makeCancelRegistry()
    const p1 = registry.start('p1', 'same', 'r1')
    const p2 = registry.start('p2', 'same', 'r1')
    expect(registry.cancel('p1', 'same', 'r1')).toBe(true)
    expect(p1.isCancelled()).toBe(true)
    expect(p2.isCancelled()).toBe(false)

    const r2 = registry.start('p2', 'same', 'r2')
    registry.finish('p2', 'same', 'r1')
    expect(registry.cancel('p2', 'same', 'r2')).toBe(true)
    expect(r2.isCancelled()).toBe(true)
  })

  it('treats cancel after completion as a no-op', async () => {
    const registry = makeCancelRegistry()
    const token = registry.start('p1', 's1', 'r1')
    registry.finish('p1', 's1', 'r1')

    expect(registry.cancel('p1', 's1', 'r1')).toBe(false)
    expect(token.isCancelled()).toBe(false)
    await Effect.runPromise(token.check())
  })

  it('cancels the first matching run when no run id is given', () => {
    const registry = makeCancelRegistry()
    const first = registry.start('p1', 's1', 'r1')
    registry.start('p1', 's1', 'r2')

    expect(registry.cancel('p1', 's1')).toBe(true)
    expect(first.isCancelled()).toBe(true)
    expect(registry.cancel('p1', 'other')).toBe(false)
  })

  it('normalizes path separators into the registry key', () => {
    const registry = makeCancelRegistry()
    const token = registry.start('C:\\proj', 's/1', 'r1')

    expect(cancelKey('C:\\proj', 's/1', 'r1')).toBe('C:_proj::s_1::r1')
    expect(registry.cancel('C:/proj', 's\\1', 'r1')).toBe(true)
    expect(token.isCancelled()).toBe(true)
  })

  it('serves the registry through its layer', async () => {
    const program = Effect.gen(function*() {
      const registry = yield* CancelRegistry
      const token = registry.start('p1', 's1', 'r1')
      const cancelled = registry.cancel('p1', 's1', 'r1')
      return { cancelled, tokenCancelled: token.isCancelled() }
    })

    expect(await Effect.runPromise(Effect.provide(program, CancelRegistry.layer))).toEqual({
      cancelled: true,
      tokenCancelled: true,
    })
  })
})
