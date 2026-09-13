import { describe, expect, it } from 'vitest'

describe('provider parsing module loading', () => {
  it('loads the sse parsing module and decodes a delta through it', async () => {
    const { makeSseDeltaDecoder, parseOpenAiDelta } = await import(
      '../src/provider/provider-parsing.js'
    )

    const decoder = makeSseDeltaDecoder(parseOpenAiDelta)

    expect(
      decoder.push(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n')),
    ).toEqual(['hi'])
  })
})
