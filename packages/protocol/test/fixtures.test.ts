import { Exit, Schema } from 'effect'
import { Rpc } from 'effect/unstable/rpc'
import * as fc from 'fast-check'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { Api, Domain, Errors, Fixtures } from '../src/index.js'

const fixtureDirectory = new URL('../src/fixtures/', import.meta.url)

const readFrameFile = (file: string): string => readFileSync(new URL(file, fixtureDirectory), 'utf8')

const encodeOrThrow = <A, E>(schema: Schema.Codec<A, E>, value: A): E => {
  const exit = Schema.encodeUnknownExit(schema)(value)
  if (Exit.isFailure(exit)) {
    throw new Error(`unexpected encode failure for ${String(schema)}`)
  }
  return exit.value
}

const jsonValue = fc.jsonValue({ maxDepth: 2 })

const envelope = fc.oneof(
  fc.record({ _tag: fc.constant('Ping') }),
  fc.record({
    _tag: fc.constant('Request'),
    id: fc.oneof(fc.string(), fc.integer()),
    tag: fc.string(),
    payload: jsonValue,
    headers: fc.array(fc.tuple(fc.string(), fc.string()), { maxLength: 3 }),
  }),
  fc.record({
    _tag: fc.constant('Chunk'),
    requestId: fc.oneof(fc.string(), fc.integer()),
    values: fc.array(jsonValue, { minLength: 1, maxLength: 3 }),
  }),
  fc.record({
    _tag: fc.constant('Exit'),
    requestId: fc.string(),
    exit: fc.oneof(
      fc.record({ _tag: fc.constant('Success'), value: jsonValue }),
      fc.record({
        _tag: fc.constant('Failure'),
        cause: fc.array(
          fc.oneof(
            fc.record({ _tag: fc.constant('Fail'), error: jsonValue }),
            fc.record({ _tag: fc.constant('Interrupt'), fiberId: fc.integer() }),
          ),
          { minLength: 1, maxLength: 2 },
        ),
      }),
    ),
  }),
  fc.record({ _tag: fc.constant('Defect'), defect: jsonValue }),
)

describe('golden ndjson frames', () => {
  it.each(Fixtures.goldenFrames)('$file matches its authored bytes', (frame) => {
    expect(readFrameFile(frame.file)).toBe(frame.bytes)
  })

  it.each(Fixtures.goldenFrames)('$file decodes to its authored envelope', (frame) => {
    const parser = Api.ApiSerialization.makeUnsafe()
    expect(parser.decode(frame.bytes)).toEqual([frame.envelope])
  })

  it.each(Fixtures.goldenFrames)('$file re-encodes byte-identically', (frame) => {
    const parser = Api.ApiSerialization.makeUnsafe()
    expect(parser.encode(frame.envelope)).toBe(frame.bytes)
  })
})

describe('golden frames agree with the declared schemas', () => {
  it('encodes the search payload exactly as the request frame carries it', () => {
    const frame = Fixtures.GoldenFrames.request.envelope
    if (frame._tag !== 'Request') throw new Error('request frame is not a Request envelope')
    expect(encodeOrThrow(Api.SearchPayload, { projectId: 'current', query: 'attention', topK: 10 })).toEqual(
      frame.payload,
    )
  })

  it('encodes the embedTexts payload exactly as the request frame carries it', () => {
    const frame = Fixtures.GoldenFrames.embedTexts.envelope
    if (frame._tag !== 'Request') throw new Error('embedTexts frame is not a Request envelope')
    expect(
      encodeOrThrow(Api.EmbedTextsPayload, { provider: 'openai', texts: ['alpha', 'beta'] }),
    ).toEqual(frame.payload)
  })

  it('encodes the stream meta exactly as the chunk frame carries it', () => {
    const frame = Fixtures.GoldenFrames.chunk.envelope
    if (frame._tag !== 'Chunk') throw new Error('chunk frame is not a Chunk envelope')
    const meta = new Domain.ChatStreamMeta({
      type: 'meta',
      projectId: 'p1',
      sessionId: 'api_1',
      runId: 'run_1',
    })
    expect(encodeOrThrow(Domain.ChatStreamEvent, meta)).toEqual(frame.values[0])
  })

  it('encodes a cancelled chat stream exit exactly as the exit frame carries it', () => {
    const frame = Fixtures.GoldenFrames.exit.envelope
    if (frame._tag !== 'Exit') throw new Error('exit frame is not an Exit envelope')
    const exitSchema = Schema.toCodecJson(Rpc.exitSchema(Api.ChatStreamRpc))
    const cancelled = Exit.fail(
      new Errors.ChatCancelled({ message: 'Agent turn cancelled' }),
    )
    expect(encodeOrThrow(exitSchema, cancelled)).toEqual(frame.exit)
  })

  it('encodes a stream defect exactly as the defect frame carries it', () => {
    const frame = Fixtures.GoldenFrames.defect.envelope
    if (frame._tag !== 'Defect') throw new Error('defect frame is not a Defect envelope')
    const defectSchema = Schema.toCodecJson(Schema.Defect())
    expect(encodeOrThrow(defectSchema, new Error('stream interrupted'))).toEqual(frame.defect)
  })
})

describe('ndjson codec laws', () => {
  it('round-trips any generated envelope (encode then decode is the identity)', () => {
    fc.assert(
      fc.property(envelope, (message) => {
        const parser = Api.ApiSerialization.makeUnsafe()
        const encoded = parser.encode(message)
        expect(typeof encoded).toBe('string')
        if (typeof encoded !== 'string') return
        const decoded = parser.decode(encoded)
        expect(decoded).toHaveLength(1)
        expect(JSON.stringify(decoded[0])).toBe(JSON.stringify(message))
      }),
      { numRuns: 200 },
    )
  })

  it('frames each message on its own line and decodes a batch of frames', () => {
    const parser = Api.ApiSerialization.makeUnsafe()
    const frames = Fixtures.goldenFrames.map((frame) => frame.envelope)
    const encoded = parser.encode(frames)
    if (typeof encoded !== 'string') throw new Error('batch encode did not produce a string')
    expect(encoded.split('\n').filter((line) => line.length > 0)).toHaveLength(frames.length)
    expect(parser.decode(encoded)).toEqual([...frames])
  })
})
