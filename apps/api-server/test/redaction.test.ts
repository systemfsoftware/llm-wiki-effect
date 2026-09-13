import { Effect, Option, Schema } from 'effect'
import { assert, boolean, constant, oneof, property, record, string, tuple } from 'fast-check'
import { Domain } from 'llm-wiki-protocol'
import { describe, expect, it } from 'vitest'
import { redactEvent, Redactor } from '../src/agent/redaction/index.js'
import { isRecord } from '../src/json.js'

const encode = (event: Domain.AgentEvent): Record<string, unknown> => {
  const parsed: unknown = JSON.parse(JSON.stringify(event))
  if (!isRecord(parsed)) throw new Error('expected a JSON object for the redacted event')
  return parsed
}

const arbReference = record({ title: string(), path: string(), kind: string() }).map(
  (value) => new Domain.ChatReference(value),
)

const arbUserInput = record({ requestId: string(), title: string() }).map(
  (value) => new Domain.ChatUserInputRequest({ ...value, fields: [] }),
)

const arbToolPair = tuple(string(), oneof(string(), constant(null)))

const arbFileChanged = tuple(string(), string(), boolean()).chain(
  ([path, tool, existedBefore]) =>
    oneof(
      constant(
        new Domain.AgentFileChangedEvent({ type: 'fileChanged', path, tool, existedBefore }),
      ),
      string().map(
        (previousContent) =>
          new Domain.AgentFileChangedEvent({
            type: 'fileChanged',
            path,
            tool,
            existedBefore,
            previousContent,
          }),
      ),
    ),
)

const arbEvent = oneof(
  string().map((sessionId) => new Domain.AgentStartEvent({ type: 'agentStart', sessionId })),
  string().map((mode) => new Domain.AgentTurnStartEvent({ type: 'turnStart', mode })),
  arbToolPair.map(
    ([tool, input]) => new Domain.AgentToolStartEvent({ type: 'toolStart', tool, input }),
  ),
  arbToolPair.map(
    ([tool, output]) => new Domain.AgentToolEndEvent({ type: 'toolEnd', tool, output }),
  ),
  arbReference.map(
    (reference) => new Domain.AgentReferenceAddedEvent({ type: 'referenceAdded', reference }),
  ),
  arbFileChanged,
  string().map((text) => new Domain.AgentMessageDeltaEvent({ type: 'messageDelta', text })),
  string().map((message) => new Domain.AgentErrorEvent({ type: 'error', message })),
  arbUserInput.map(
    (request) => new Domain.AgentUserInputRequiredEvent({ type: 'userInputRequired', request }),
  ),
  string().map((sessionId) => new Domain.AgentDoneEvent({ type: 'done', sessionId })),
)

const fileChangedWithRollback = (): Domain.AgentFileChangedEvent =>
  new Domain.AgentFileChangedEvent({
    type: 'fileChanged',
    path: 'agent-workspace/report.md',
    tool: 'workspace.write_file',
    existedBefore: true,
    previousContent: 'private previous body',
  })

const unionMembers = (): ReadonlyArray<Domain.AgentEvent> => [
  new Domain.AgentStartEvent({ type: 'agentStart', sessionId: 's' }),
  new Domain.AgentTurnStartEvent({ type: 'turnStart', mode: 'standard' }),
  new Domain.AgentToolStartEvent({ type: 'toolStart', tool: 'wiki.search', input: null }),
  new Domain.AgentToolEndEvent({ type: 'toolEnd', tool: 'wiki.search', output: null }),
  new Domain.AgentReferenceAddedEvent({
    type: 'referenceAdded',
    reference: new Domain.ChatReference({ title: 't', path: 'p', kind: 'wiki' }),
  }),
  fileChangedWithRollback(),
  new Domain.AgentMessageDeltaEvent({ type: 'messageDelta', text: 'hello' }),
  new Domain.AgentErrorEvent({ type: 'error', message: 'boom' }),
  new Domain.AgentUserInputRequiredEvent({
    type: 'userInputRequired',
    request: new Domain.ChatUserInputRequest({ requestId: 'r', title: 't', fields: [] }),
  }),
  new Domain.AgentDoneEvent({ type: 'done', sessionId: 's' }),
]

const UNION_TYPES = [
  'agentStart',
  'turnStart',
  'toolStart',
  'toolEnd',
  'referenceAdded',
  'fileChanged',
  'messageDelta',
  'error',
  'userInputRequired',
  'done',
] as const

describe('agent event redaction', () => {
  it('redacts every event union member without mutating it, idempotently', () => {
    assert(
      property(arbEvent, (event) => {
        const snapshot = encode(event)
        const expected = encode(event)
        delete expected['previousContent']

        const redacted = redactEvent(event)

        expect(redacted.type).toBe(event.type)
        expect(encode(event)).toEqual(snapshot)
        expect(encode(redacted)).toEqual(expected)
        expect(encode(redactEvent(redacted))).toEqual(expected)
        expect(Option.isSome(Schema.decodeUnknownOption(Domain.AgentEvent)(redacted))).toBe(true)
      }),
      { numRuns: 200 },
    )
  })

  it('enumerates the complete agent event union', () => {
    const members = unionMembers()
    expect(members.map((event) => event.type).sort()).toEqual([...UNION_TYPES].sort())
    for (const event of members) {
      expect(redactEvent(event).type).toBe(event.type)
    }
  })

  it('keeps the rollback snapshot on the pre-redaction internal path', () => {
    const event = fileChangedWithRollback()
    const redacted = redactEvent(event)

    expect(redacted).not.toBe(event)
    expect(encode(redacted)).toEqual({
      type: 'fileChanged',
      path: 'agent-workspace/report.md',
      tool: 'workspace.write_file',
      existedBefore: true,
    })
    expect(event.previousContent).toBe('private previous body')
    expect(encode(event)['previousContent']).toBe('private previous body')
  })

  it('returns the same event reference when there is nothing to strip', () => {
    const bare = new Domain.AgentFileChangedEvent({
      type: 'fileChanged',
      path: 'p',
      tool: 't',
      existedBefore: false,
    })
    const delta = new Domain.AgentMessageDeltaEvent({ type: 'messageDelta', text: 'hi' })

    expect(redactEvent(bare)).toBe(bare)
    expect(redactEvent(delta)).toBe(delta)
  })

  it('serves redaction through the Redactor layer', async () => {
    const redacted = await Effect.runPromise(
      Effect.provide(
        Redactor.use((redactor) => Effect.succeed(redactor.redact(fileChangedWithRollback()))),
        Redactor.layer,
      ),
    )

    expect(redacted.type).toBe('fileChanged')
    expect(encode(redacted)).not.toHaveProperty('previousContent')
  })
})
