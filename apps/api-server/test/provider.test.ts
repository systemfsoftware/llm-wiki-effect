import { Effect, Stream } from 'effect'
import * as fc from 'fast-check'
import { Errors } from 'llm-wiki-protocol'
import { describe, expect, it } from 'vitest'
import { ProviderClient } from '../src/provider/provider-client.js'
import type { ProviderClientShape, ProviderStreamEvent } from '../src/provider/provider-client.js'
import {
  anthropicCompletionText,
  googleCompletionText,
  makeSseDeltaDecoder,
  openAiCompletionText,
  parseAnthropicDelta,
  parseGoogleDelta,
  parseOpenAiDelta,
} from '../src/provider/provider-parsing.js'
import { buildProviderRequest, isUsableForHttp, maxOutputTokens } from '../src/provider/provider-request.js'
import type { ProviderCompletionRequest, ProviderCredentials } from '../src/provider/provider-request.js'
import type { ProviderTransport, TransportRequest } from '../src/provider/provider-transport.js'

interface ScriptedResponses {
  readonly body?: string
  readonly chunks?: ReadonlyArray<Uint8Array>
  readonly failure?: string
  readonly streamFailure?: string
}

const credentials: ProviderCredentials = {
  openai: { apiKey: 'sk-openai', baseUrl: '' },
  anthropic: { apiKey: 'sk-anthropic', baseUrl: 'https://anthropic.gateway.example' },
  google: { apiKey: 'goog-key', baseUrl: '' },
  azure: { apiKey: 'az-key', baseUrl: 'https://resource.openai.azure.com' },
  ollama: { apiKey: '', baseUrl: 'http://localhost:11434' },
  custom: { apiKey: 'custom-key', baseUrl: 'https://gateway.example/v1' },
  minimax: { apiKey: 'mm-key', baseUrl: '' },
  'claude-code': { apiKey: 'cli', baseUrl: '' },
}

const scripted = (responses: ScriptedResponses) => {
  const requests: TransportRequest[] = []
  const transport: ProviderTransport = {
    complete: (request) => {
      requests.push(request)
      return responses.failure === undefined
        ? Effect.succeed(responses.body ?? '')
        : Effect.fail(new Errors.AgentError({ message: responses.failure }))
    },
    stream: (request) => {
      requests.push(request)
      if (responses.streamFailure !== undefined) {
        return Effect.fail(new Errors.AgentError({ message: responses.streamFailure }))
      }
      return Effect.succeed(Stream.fromIterable(responses.chunks ?? []))
    },
  }
  return { transport, requests }
}

const makeClient = async (
  responses: ScriptedResponses,
  configured: ProviderCredentials = credentials,
) => {
  const { transport, requests } = scripted(responses)
  const provider = await Effect.runPromise(
    ProviderClient.make({ credentials: configured, transport }),
  )
  return { provider, requests }
}

const request = (
  overrides: Partial<ProviderCompletionRequest> = {},
): ProviderCompletionRequest => ({
  provider: 'openai',
  model: 'gpt-4o',
  system: 'system prompt',
  user: 'user prompt',
  ...overrides,
})

const record = (value: unknown): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`expected an object, received ${JSON.stringify(value)}`)
  }
  return Object.fromEntries(Object.entries(value))
}

const array = (value: unknown): ReadonlyArray<unknown> => {
  if (!Array.isArray(value)) {
    throw new Error(`expected an array, received ${JSON.stringify(value)}`)
  }
  return value
}

const onlyRequest = (requests: ReadonlyArray<TransportRequest>): TransportRequest => {
  const first = requests[0]
  if (requests.length !== 1 || first === undefined) {
    throw new Error(`expected exactly one transport request, received ${requests.length}`)
  }
  return first
}

const bodyOf = (sent: TransportRequest): Record<string, unknown> => record(JSON.parse(sent.body))

const encoder = new TextEncoder()

const data = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`

const openAiSse = (texts: ReadonlyArray<string>): string =>
  `${texts.map((text) => data({ choices: [{ delta: { content: text } }] })).join('')}data: [DONE]\n\n`

const anthropicSse = (texts: ReadonlyArray<string>): string =>
  `${
    texts
      .map((text) => {
        const payload = { type: 'content_block_delta', delta: { type: 'text_delta', text } }
        return `event: content_block_delta\n${data(payload)}`
      })
      .join('')
  }${data({ type: 'message_stop' })}`

const googleSse = (texts: ReadonlyArray<string>): string =>
  texts
    .map((text) => data({ candidates: [{ content: { parts: [{ text }] } }] }))
    .join('')

const token = fc
  .tuple(
    fc.constantFrom('a', 'Z', '0', '矿', 'é', '🙂'),
    fc.string({ maxLength: 5, unit: fc.constantFrom('b', '-', '_', '猫') }),
  )
  .map(([head, tail]) => head + tail)

const splitBytes = (bytes: Uint8Array, cuts: ReadonlyArray<number>): ReadonlyArray<Uint8Array> => {
  const positions = [...new Set(cuts.map((cut) => cut % (bytes.length + 1)))].sort((a, b) => a - b)
  const parts: Uint8Array[] = []
  let start = 0
  for (const position of positions) {
    parts.push(bytes.slice(start, position))
    start = position
  }
  parts.push(bytes.slice(start))
  return parts
}

const collectEvents = async (
  provider: ProviderClientShape,
  completion: ProviderCompletionRequest,
): Promise<ReadonlyArray<ProviderStreamEvent>> =>
  Array.from(await Effect.runPromise(Stream.runCollect(provider.stream(completion))))

describe('provider credential selection', () => {
  it('addresses each provider through its own credential entry', async () => {
    const { provider, requests } = await makeClient({
      body: JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }),
    })

    await Effect.runPromise(provider.complete(request({ provider: 'anthropic', model: 'claude-x' })))

    const sent = onlyRequest(requests)
    expect(sent.url).toBe('https://anthropic.gateway.example/v1/messages')
    expect(sent.headers['x-api-key']).toBe('sk-anthropic')
    expect(sent.headers['anthropic-version']).toBe('2023-06-01')
  })

  it('falls back to the provider endpoint when the credential carries no base url', async () => {
    const { provider, requests } = await makeClient({
      body: JSON.stringify({ choices: [{ message: { content: 'hi' } }] }),
    })

    await Effect.runPromise(provider.complete(request()))

    const sent = onlyRequest(requests)
    expect(sent.url).toBe('https://api.openai.com/v1/chat/completions')
    expect(sent.headers['authorization']).toBe('Bearer sk-openai')
    expect(sent.headers['content-type']).toBe('application/json')
  })

  it('fails with a typed AgentError when the provider has no credential entry', async () => {
    const { provider } = await makeClient({ body: '{}' })

    const error = await Effect.runPromise(
      Effect.flip(provider.complete(request({ provider: 'mistral' }))),
    )

    expect(error).toBeInstanceOf(Errors.AgentError)
    expect(error.message).toBe("No credentials configured for provider 'mistral'")
  })

  it('rejects CLI-subprocess providers, which the HTTP client never serves', async () => {
    const { provider, requests } = await makeClient({ body: '{}' })

    const error = await Effect.runPromise(
      Effect.flip(provider.complete(request({ provider: 'claude-code' }))),
    )

    expect(error.message).toBe(
      "Provider 'claude-code' is not supported by the backend HTTP Agent yet",
    )
    expect(requests).toHaveLength(0)
  })

  it('reports which providers the HTTP transport can serve', () => {
    expect(isUsableForHttp('openai', 'gpt-4o', { apiKey: 'k', baseUrl: '' })).toBe(true)
    expect(isUsableForHttp('openai', 'gpt-4o', { apiKey: '', baseUrl: '' })).toBe(false)
    expect(isUsableForHttp('openai', '  ', { apiKey: 'k', baseUrl: '' })).toBe(false)
    expect(isUsableForHttp('ollama', 'llama3', { apiKey: '', baseUrl: 'http://localhost:11434' })).toBe(true)
    expect(isUsableForHttp('ollama', 'llama3', { apiKey: '', baseUrl: '' })).toBe(false)
    expect(isUsableForHttp('claude-code', 'sonnet', { apiKey: 'k', baseUrl: '' })).toBe(false)
    expect(isUsableForHttp('openai', 'gpt-4o', undefined)).toBe(false)
  })

  it('sends no authorization header when the credential api key is blank', async () => {
    const { provider, requests } = await makeClient({
      body: JSON.stringify({ choices: [{ message: { content: 'hi' } }] }),
    })

    await Effect.runPromise(provider.complete(request({ provider: 'ollama', model: 'llama3' })))

    const sent = onlyRequest(requests)
    expect(sent.url).toBe('http://localhost:11434/v1/chat/completions')
    expect(sent.headers['authorization']).toBeUndefined()
    expect(sent.headers['x-api-key']).toBeUndefined()
  })
})

describe('provider request shaping', () => {
  it('assembles the openai chat completion body from the system and user prompt', async () => {
    const { provider, requests } = await makeClient({
      body: JSON.stringify({ choices: [{ message: { content: 'hi' } }] }),
    })

    await Effect.runPromise(provider.complete(request()))

    const body = bodyOf(onlyRequest(requests))
    expect(body['messages']).toEqual([
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'user prompt' },
    ])
    expect(body['model']).toBe('gpt-4o')
    expect(body['max_tokens']).toBe(2048)
    expect(body['stream']).toBe(false)
  })

  it('requests a stream body when the streaming path is used', async () => {
    const { provider, requests } = await makeClient({
      chunks: [encoder.encode(data({ choices: [{ delta: { content: 'hi' } }] }))],
    })

    const events = await collectEvents(provider, request())

    expect(bodyOf(onlyRequest(requests))['stream']).toBe(true)
    expect(events.at(-1)).toEqual({ type: 'complete', text: 'hi' })
  })

  it('clamps the max token budget the way provider.rs does', async () => {
    for (
      const [requested, expected] of [
        [100, 256],
        [4096, 4096],
        [99_999, 32_768],
      ] as const
    ) {
      const { provider, requests } = await makeClient({
        body: JSON.stringify({ choices: [{ message: { content: 'hi' } }] }),
      })
      await Effect.runPromise(provider.complete(request({ maxTokens: requested })))
      expect(bodyOf(onlyRequest(requests))['max_tokens']).toBe(expected)
    }
  })

  it('uses the completion token field for strict openai reasoning models', async () => {
    const { provider, requests } = await makeClient({
      body: JSON.stringify({ choices: [{ message: { content: 'hi' } }] }),
    })

    await Effect.runPromise(provider.complete(request({ model: 'o3-mini' })))

    const body = bodyOf(onlyRequest(requests))
    expect(body['max_completion_tokens']).toBe(2048)
    expect(body['max_tokens']).toBeUndefined()
  })

  it('addresses an azure deployment by model name and omits the model field', async () => {
    const { provider, requests } = await makeClient({
      body: JSON.stringify({ choices: [{ message: { content: 'hi' } }] }),
    })

    await Effect.runPromise(
      provider.complete(request({ provider: 'azure', model: 'my deployment' })),
    )

    const sent = onlyRequest(requests)
    expect(sent.url).toBe(
      'https://resource.openai.azure.com/openai/deployments/my%20deployment/chat/completions?api-version=2024-10-21',
    )
    expect(sent.headers['api-key']).toBe('az-key')
    const body = bodyOf(sent)
    expect(body['model']).toBeUndefined()
    expect(body['max_tokens']).toBe(2048)
  })

  it('honours an explicit azure api version and the gpt5 model family', async () => {
    const { provider, requests } = await makeClient({
      body: JSON.stringify({ choices: [{ message: { content: 'hi' } }] }),
    })

    await Effect.runPromise(
      provider.complete(
        request({
          provider: 'azure',
          model: 'deployment-name',
          azureApiVersion: '2025-01-01',
          azureModelFamily: 'gpt5',
        }),
      ),
    )

    const sent = onlyRequest(requests)
    expect(sent.url).toContain('api-version=2025-01-01')
    const body = bodyOf(sent)
    expect(body['max_completion_tokens']).toBe(2048)
    expect(body['max_tokens']).toBeUndefined()
  })

  it('normalizes ollama endpoint shapes onto the chat completions route', async () => {
    for (const baseUrl of ['http://localhost:11434', 'http://localhost:11434/v1']) {
      const { provider, requests } = await makeClient(
        { body: JSON.stringify({ choices: [{ message: { content: 'hi' } }] }) },
        { ...credentials, ollama: { apiKey: '', baseUrl } },
      )
      await Effect.runPromise(provider.complete(request({ provider: 'ollama', model: 'llama3' })))
      expect(onlyRequest(requests).url).toBe('http://localhost:11434/v1/chat/completions')
    }
  })

  it('assembles the anthropic messages body with the system prompt as a cached block', async () => {
    const { provider, requests } = await makeClient({
      body: JSON.stringify({ content: [{ type: 'text', text: 'hi' }] }),
    })

    await Effect.runPromise(provider.complete(request({ provider: 'anthropic', model: 'claude-x' })))

    const body = bodyOf(onlyRequest(requests))
    expect(body['model']).toBe('claude-x')
    expect(body['system']).toEqual([
      { type: 'text', text: 'system prompt', cache_control: { type: 'ephemeral' } },
    ])
    expect(body['messages']).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'user prompt' }] },
    ])
    expect(body['max_tokens']).toBe(2048)
  })

  it('keeps the anthropic messages route when the base url already names it', async () => {
    const { provider, requests } = await makeClient(
      { body: JSON.stringify({ content: [{ type: 'text', text: 'hi' }] }) },
      { ...credentials, anthropic: { apiKey: 'sk', baseUrl: 'https://anthropic.gateway.example/v1' } },
    )

    await Effect.runPromise(provider.complete(request({ provider: 'anthropic', model: 'claude-x' })))

    expect(onlyRequest(requests).url).toBe('https://anthropic.gateway.example/v1/messages')
  })

  it('routes a custom gateway through the anthropic messages api when apiMode says so', async () => {
    const { provider, requests } = await makeClient({
      body: JSON.stringify({ content: [{ type: 'text', text: 'hi' }] }),
    })

    await Effect.runPromise(
      provider.complete(request({ provider: 'custom', apiMode: 'anthropic_messages' })),
    )

    const sent = onlyRequest(requests)
    expect(sent.url).toBe('https://gateway.example/v1/messages')
    expect(sent.headers['x-api-key']).toBe('custom-key')
    expect(bodyOf(sent)['system']).toEqual([
      { type: 'text', text: 'system prompt', cache_control: { type: 'ephemeral' } },
    ])
  })

  it('routes a custom gateway through chat completions by default', async () => {
    const { provider, requests } = await makeClient({
      body: JSON.stringify({ choices: [{ message: { content: 'hi' } }] }),
    })

    await Effect.runPromise(provider.complete(request({ provider: 'custom' })))

    const sent = onlyRequest(requests)
    expect(sent.url).toBe('https://gateway.example/v1/chat/completions')
    expect(sent.headers['authorization']).toBe('Bearer custom-key')
    expect(bodyOf(sent)['model']).toBe('gpt-4o')
  })

  it('assembles the google generate content body', async () => {
    const { provider, requests } = await makeClient({
      body: JSON.stringify({ candidates: [{ content: { parts: [{ text: 'hi' }] } }] }),
    })

    await Effect.runPromise(provider.complete(request({ provider: 'google', model: 'gemini-3-flash' })))

    const sent = onlyRequest(requests)
    expect(sent.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash:generateContent',
    )
    expect(sent.headers['x-goog-api-key']).toBe('goog-key')
    const body = bodyOf(sent)
    expect(body['systemInstruction']).toEqual({ parts: [{ text: 'system prompt' }] })
    expect(body['contents']).toEqual([{ role: 'user', parts: [{ text: 'user prompt' }] }])
    expect(body['generationConfig']).toEqual({ maxOutputTokens: 2048 })
  })

  it('carries images in the provider-specific block shape', async () => {
    const image = { mediaType: 'image/png', dataBase64: 'QUJD' }
    const { provider, requests } = await makeClient({
      body: JSON.stringify({ choices: [{ message: { content: 'hi' } }] }),
    })

    await Effect.runPromise(provider.complete(request({ images: [image] })))

    const messages = array(bodyOf(onlyRequest(requests))['messages'])
    expect(record(messages[1])['content']).toEqual([
      { type: 'text', text: 'user prompt' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } },
    ])

    const anthropic = await makeClient({
      body: JSON.stringify({ content: [{ type: 'text', text: 'hi' }] }),
    })
    await Effect.runPromise(
      anthropic.provider.complete(
        request({ provider: 'anthropic', model: 'claude-x', images: [image] }),
      ),
    )
    expect(record(array(bodyOf(onlyRequest(anthropic.requests))['messages'])[0])['content']).toEqual([
      { type: 'text', text: 'user prompt' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } },
    ])

    const google = await makeClient({
      body: JSON.stringify({ candidates: [{ content: { parts: [{ text: 'hi' }] } }] }),
    })
    await Effect.runPromise(
      google.provider.complete(
        request({ provider: 'google', model: 'gemini-3-flash', images: [image] }),
      ),
    )
    expect(bodyOf(onlyRequest(google.requests))['contents']).toEqual([
      {
        role: 'user',
        parts: [
          { text: 'user prompt' },
          { inlineData: { mimeType: 'image/png', data: 'QUJD' } },
        ],
      },
    ])
  })

  it('refuses image input for the minimax anthropic-compatible endpoint', async () => {
    const { provider } = await makeClient({ body: '{}' })

    const error = await Effect.runPromise(
      Effect.flip(
        provider.complete(
          request({ provider: 'minimax', images: [{ mediaType: 'image/png', dataBase64: 'QUJD' }] }),
        ),
      ),
    )

    expect(error.message).toBe(
      'MiniMax official Anthropic-compatible endpoint does not support image input. Use a vision-capable provider for image chat.',
    )
  })

  it('rejects a custom header whose value would inject another header', async () => {
    const { provider, requests } = await makeClient({ body: '{}' })

    const error = await Effect.runPromise(
      Effect.flip(
        provider.complete(request({ customHeaders: { 'X-Bad': 'ok\r\nInjected: yes' } })),
      ),
    )

    expect(error).toBeInstanceOf(Errors.AgentError)
    expect(error.message).toContain('Invalid custom header value')
    expect(requests).toHaveLength(0)
  })

  it('lets the credential auth header win over a case-different custom header', async () => {
    const { provider, requests } = await makeClient({
      body: JSON.stringify({ choices: [{ message: { content: 'hi' } }] }),
    })

    await Effect.runPromise(
      provider.complete(request({ customHeaders: { 'X-Tenant-ID': 'team-a', authorization: 'Custom secret' } })),
    )

    const headers = onlyRequest(requests).headers
    expect(headers['x-tenant-id']).toBe('team-a')
    expect(headers['authorization']).toBe('Bearer sk-openai')
  })
})

describe('provider response parsing', () => {
  it('reads assistant content out of an openai completion', async () => {
    const { provider } = await makeClient({
      body: JSON.stringify({ choices: [{ message: { content: '  hello  ' } }] }),
    })

    const result = await Effect.runPromise(provider.complete(request()))

    expect(result.text).toBe('hello')
  })

  it('joins only text blocks of an anthropic completion', async () => {
    const { provider } = await makeClient({
      body: JSON.stringify({
        content: [
          { type: 'thinking', text: 'ignore me' },
          { type: 'text', text: 'hello ' },
          { type: 'text', text: 'world' },
        ],
      }),
    })

    const result = await Effect.runPromise(
      provider.complete(request({ provider: 'anthropic', model: 'claude-x' })),
    )

    expect(result.text).toBe('hello world')
  })

  it('joins the text parts of a google completion', async () => {
    const { provider } = await makeClient({
      body: JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'hello ' }, { text: 'world' }] } }],
      }),
    })

    const result = await Effect.runPromise(
      provider.complete(request({ provider: 'google', model: 'gemini-3-flash' })),
    )

    expect(result.text).toBe('hello world')
  })

  it('fails when the completion carries no assistant content', async () => {
    const { provider } = await makeClient({ body: JSON.stringify({ choices: [] }) })

    const error = await Effect.runPromise(Effect.flip(provider.complete(request())))

    expect(error.message).toBe('LLM response did not contain assistant content')
  })

  it('fails on an unparsable completion body', async () => {
    const { provider } = await makeClient({ body: 'not json' })

    const error = await Effect.runPromise(Effect.flip(provider.complete(request())))

    expect(error).toBeInstanceOf(Errors.AgentError)
    expect(error.message).toContain('Invalid LLM JSON:')
  })

  it('propagates a transport failure as the typed protocol error', async () => {
    const { provider } = await makeClient({ failure: 'LLM HTTP 500: upstream exploded' })

    const error = await Effect.runPromise(Effect.flip(provider.complete(request())))

    expect(error).toBeInstanceOf(Errors.AgentError)
    expect(error.message).toBe('LLM HTTP 500: upstream exploded')
  })
})

describe('provider streaming', () => {
  it('emits deltas in provider order and completes with the assembled text', async () => {
    const { provider } = await makeClient({
      chunks: [
        encoder.encode(
          'data: {"choices":[{"delta":{"content":"he"}}]}\r\n\r\n' +
            'event: ping\n\n' +
            'data: {"choices":[{"delta":{"content":"llo"}}]}\n\n' +
            'data: [DONE]\n\n',
        ),
      ],
    })

    const events = await collectEvents(provider, request())

    expect(events).toEqual([
      { type: 'delta', text: 'he' },
      { type: 'delta', text: 'llo' },
      { type: 'complete', text: 'hello' },
    ])
  })

  it('flushes a trailing sse line that has no newline', async () => {
    const { provider } = await makeClient({
      chunks: [encoder.encode('data: {"choices":[{"delta":{"content":"tail"}}]}')],
    })

    const events = await collectEvents(provider, request())

    expect(events).toEqual([
      { type: 'delta', text: 'tail' },
      { type: 'complete', text: 'tail' },
    ])
  })

  it('preserves multibyte text split across byte chunks', async () => {
    const line = 'data: {"choices":[{"delta":{"content":"煤矿"}}]}\n'
    const split = line.indexOf('矿') + 1
    const bytes = encoder.encode(line)
    const { provider } = await makeClient({
      chunks: [bytes.slice(0, split), bytes.slice(split)],
    })

    const events = await collectEvents(provider, request())

    expect(events).toEqual([
      { type: 'delta', text: '煤矿' },
      { type: 'complete', text: '煤矿' },
    ])
  })

  it('falls back to a single delta when streaming is disabled for the provider', async () => {
    const { provider, requests } = await makeClient({
      body: JSON.stringify({ choices: [{ message: { content: 'whole answer' } }] }),
    })

    const events = await collectEvents(provider, request({ streamingEnabled: false }))

    expect(events).toEqual([
      { type: 'delta', text: 'whole answer' },
      { type: 'complete', text: 'whole answer' },
    ])
    expect(bodyOf(onlyRequest(requests))['stream']).toBe(false)
  })

  it('fails the stream with the typed error when the transport stream fails', async () => {
    const { provider } = await makeClient({ streamFailure: 'LLM stream failed: socket closed' })

    const error = await Effect.runPromise(
      Effect.flip(Stream.runCollect(provider.stream(request()))),
    )

    expect(error).toBeInstanceOf(Errors.AgentError)
    expect(error.message).toBe('LLM stream failed: socket closed')
  })

  it('fails the stream when no assistant content arrived', async () => {
    const { provider } = await makeClient({ chunks: [encoder.encode('data: [DONE]\n\n')] })

    const error = await Effect.runPromise(
      Effect.flip(Stream.runCollect(provider.stream(request()))),
    )

    expect(error.message).toBe('LLM response did not contain assistant content')
  })

  it('preserves delta order and text through arbitrary chunk boundaries', async () => {
    const families = [
      { provider: 'openai', encode: openAiSse },
      { provider: 'anthropic', encode: anthropicSse },
      { provider: 'google', encode: googleSse },
    ] as const

    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...families),
        fc.array(token, { minLength: 1, maxLength: 6 }),
        fc.array(fc.nat({ max: 400 }), { maxLength: 10 }),
        async (family, texts, cuts) => {
          const { provider } = await makeClient({
            chunks: splitBytes(encoder.encode(family.encode(texts)), cuts),
          })

          const events = await collectEvents(
            provider,
            request({ provider: family.provider, model: 'model-x' }),
          )
          const deltas = events.filter((event) => event.type === 'delta').map((event) => event.text)

          expect(deltas).toEqual(texts)
          expect(events.at(-1)).toEqual({ type: 'complete', text: texts.join('') })
        },
      ),
      { numRuns: 200 },
    )
  })

  it('keeps every requested token budget inside the provider window', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: -10_000, max: 100_000 }), async (maxTokens) => {
        const { provider, requests } = await makeClient({
          body: JSON.stringify({ choices: [{ message: { content: 'hi' } }] }),
        })

        await Effect.runPromise(provider.complete(request({ maxTokens })))

        const budget = bodyOf(onlyRequest(requests))['max_tokens']
        if (typeof budget !== 'number') {
          throw new Error(`expected a numeric token budget, received ${JSON.stringify(budget)}`)
        }
        expect(budget).toBeGreaterThanOrEqual(256)
        expect(budget).toBeLessThanOrEqual(32_768)
      }),
      { numRuns: 100 },
    )
  })
})

describe('provider http request construction', () => {
  const build = (
    overrides: Partial<ProviderCompletionRequest> = {},
    configured: ProviderCredentials = credentials,
    stream = false,
  ) => Effect.runPromise(buildProviderRequest(configured, request(overrides), stream))

  const jsonBody = (built: { readonly body: string }): Record<string, unknown> => record(JSON.parse(built.body))

  const failureOf = (
    completion: ProviderCompletionRequest,
    configured: ProviderCredentials = credentials,
  ) => Effect.runPromise(Effect.flip(buildProviderRequest(configured, completion, false)))

  it('reports which providers the http transport can serve', () => {
    const complete = { apiKey: 'k', baseUrl: 'https://x.example' }
    const keyless = { apiKey: '', baseUrl: 'https://x.example' }
    const endpointless = { apiKey: 'k', baseUrl: '  ' }

    for (const provider of ['openai', 'anthropic', 'google', 'azure', 'minimax']) {
      expect(isUsableForHttp(provider, 'm', complete)).toBe(true)
      expect(isUsableForHttp(provider, 'm', keyless)).toBe(false)
      expect(isUsableForHttp(provider, 'm', endpointless)).toBe(true)
    }
    for (const provider of ['ollama', 'custom']) {
      expect(isUsableForHttp(provider, 'm', complete)).toBe(true)
      expect(isUsableForHttp(provider, 'm', keyless)).toBe(true)
      expect(isUsableForHttp(provider, 'm', endpointless)).toBe(false)
    }
    expect(isUsableForHttp('openai', 'm', undefined)).toBe(false)
    expect(isUsableForHttp('claude-code', 'm', complete)).toBe(false)
    expect(isUsableForHttp('openai', '   ', complete)).toBe(false)
    expect(isUsableForHttp('openai', 'm', { apiKey: '  ', baseUrl: 'https://x.example' })).toBe(false)
  })

  it('clamps an absent or explicit token budget', () => {
    expect(maxOutputTokens(undefined)).toBe(2048)
    expect(maxOutputTokens(0)).toBe(256)
    expect(maxOutputTokens(100_000)).toBe(32_768)
  })

  it('normalizes every provider endpoint onto its own route', async () => {
    const withBase = (provider: string, baseUrl: string): ProviderCredentials => ({
      ...credentials,
      [provider]: { apiKey: 'k', baseUrl },
    })

    expect((await build({})).url).toBe('https://api.openai.com/v1/chat/completions')
    expect((await build({}, withBase('openai', 'https://o.example/'))).url).toBe(
      'https://o.example/chat/completions',
    )
    expect((await build({}, withBase('openai', 'https://o.example/v1/chat/completions'))).url).toBe(
      'https://o.example/v1/chat/completions',
    )
    expect((await build({ provider: 'anthropic' }, withBase('anthropic', ''))).url).toBe(
      'https://api.anthropic.com/v1/messages',
    )
    expect((await build({ provider: 'anthropic' }, withBase('anthropic', 'https://a.example/v1'))).url)
      .toBe('https://a.example/v1/messages')
    expect(
      (await build({ provider: 'anthropic' }, withBase('anthropic', 'https://a.example/v1/messages/'))).url,
    ).toBe('https://a.example/v1/messages')
    expect(
      (await build({ provider: 'ollama' }, withBase('ollama', 'http://l.example/v1/chat/completions'))).url,
    ).toBe('http://l.example/v1/chat/completions')
    expect((await build({ provider: 'ollama' }, withBase('ollama', 'http://l.example/v1'))).url).toBe(
      'http://l.example/v1/chat/completions',
    )
    expect((await build({ provider: 'ollama' }, withBase('ollama', 'http://l.example'))).url).toBe(
      'http://l.example/v1/chat/completions',
    )
    expect((await build({ provider: 'google' })).url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gpt-4o:generateContent',
    )
    expect((await build({ provider: 'google' }, credentials, true)).url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gpt-4o:streamGenerateContent?alt=sse',
    )
    expect((await build({ provider: 'google', model: 'a b/矿' })).url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/a%20b%2F%E7%9F%BF:generateContent',
    )
    expect((await build({ provider: 'minimax' }, withBase('minimax', ''))).url).toBe(
      'https://api.minimax.io/anthropic/v1/messages',
    )
    expect((await build({ provider: 'minimax' }, withBase('minimax', 'https://api.minimaxi.com/anthropic'))).url)
      .toBe('https://api.minimaxi.com/anthropic/v1/messages')
    expect((await build({ provider: 'google' }, withBase('google', 'https://g.example'))).url).toBe(
      'https://g.example/v1beta/models/gpt-4o:generateContent',
    )
    expect((await build({}, withBase('openai', 'https://o.example///'))).url).toBe(
      'https://o.example/chat/completions',
    )
  })

  it('percent-encodes every model byte as two hex digits', async () => {
    const built = await build({ provider: 'google', model: 'a\tb' })

    expect(built.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/a%09b:generateContent',
    )
  })

  it('addresses azure deployments with an api version query', async () => {
    const azure = (baseUrl: string, overrides: Partial<ProviderCompletionRequest> = {}) =>
      build({ provider: 'azure', model: 'deploy/name', ...overrides }, {
        ...credentials,
        azure: { apiKey: 'az', baseUrl },
      })

    expect((await azure('https://r.openai.azure.com')).url).toBe(
      'https://r.openai.azure.com/openai/deployments/deploy%2Fname/chat/completions?api-version=2024-10-21',
    )
    expect((await azure('https://r.example', { azureApiVersion: ' 2024-01-01 ' })).url).toBe(
      'https://r.example/openai/deployments/deploy%2Fname/chat/completions?api-version=2024-01-01',
    )
    expect((await azure('https://r.openai.azure.com/openai/deployments/x')).url).toBe(
      'https://r.openai.azure.com/openai/deployments/x?api-version=2024-10-21',
    )
    expect((await azure('https://r.openai.azure.com/openai/deployments/x?api-version=old')).url).toBe(
      'https://r.openai.azure.com/openai/deployments/x?api-version=old&api-version=2024-10-21',
    )
    expect(
      (await failureOf(request({ provider: 'azure' }), {
        ...credentials,
        azure: { apiKey: 'az', baseUrl: '   ' },
      })).message,
    ).toBe('Azure endpoint is required')
  })

  it('routes a custom gateway by its endpoint shape', async () => {
    const custom = (baseUrl: string, overrides: Partial<ProviderCompletionRequest> = {}) =>
      build({ provider: 'custom', ...overrides }, {
        ...credentials,
        custom: { apiKey: 'k', baseUrl },
      })

    const chat = await custom('https://gateway.example/v1/')
    expect(chat.url).toBe('https://gateway.example/v1/chat/completions')
    expect(chat.family).toBe('openai')
    expect(jsonBody(chat)['model']).toBe('gpt-4o')

    const deployments = await custom('https://gateway.example/openai/deployments/d')
    expect(deployments.url).toBe(
      'https://gateway.example/openai/deployments/d?api-version=2024-10-21',
    )
    expect(jsonBody(deployments)['model']).toBeUndefined()

    const azureHost = await custom('https://resource.openai.azure.com')
    expect(azureHost.url).toBe(
      'https://resource.openai.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=2024-10-21',
    )
    expect(jsonBody(azureHost)['model']).toBeUndefined()

    const messages = await custom('https://gateway.example', { apiMode: 'anthropic_messages' })
    expect(messages.url).toBe('https://gateway.example/v1/messages')
    expect(messages.family).toBe('anthropic')

    expect(
      (await failureOf(request({ provider: 'custom' }), {
        ...credentials,
        custom: { apiKey: 'k', baseUrl: ' ' },
      })).message,
    ).toBe('Custom endpoint is required')
  })

  it('requires an ollama endpoint and refuses unsupported providers', async () => {
    expect(
      (await failureOf(request({ provider: 'ollama' }), {
        ...credentials,
        ollama: { apiKey: '', baseUrl: '' },
      })).message,
    ).toBe('Ollama URL is required')

    expect((await failureOf(request({ provider: 'claude-code' }))).message).toBe(
      "Provider 'claude-code' is not supported by the backend HTTP Agent yet",
    )
  })

  it('selects the provider authentication header family', async () => {
    const openai = await build({})
    expect(openai.headers['authorization']).toBe('Bearer sk-openai')
    expect(openai.headers['content-type']).toBe('application/json')

    const azure = await build({ provider: 'azure' })
    expect(azure.headers['api-key']).toBe('az-key')
    expect(azure.headers['authorization']).toBeUndefined()

    const anthropic = await build({ provider: 'anthropic' })
    expect(anthropic.headers['x-api-key']).toBe('sk-anthropic')
    expect(anthropic.headers['anthropic-version']).toBe('2023-06-01')

    const bearer = await build({ provider: 'minimax' }, {
      ...credentials,
      minimax: { apiKey: 'mm', baseUrl: 'https://api.minimaxi.com/anthropic' },
    })
    expect(bearer.headers['authorization']).toBe('Bearer mm')
    expect(bearer.headers['x-api-key']).toBeUndefined()
    expect(bearer.family).toBe('anthropic')

    const google = await build({ provider: 'google' })
    expect(google.headers['x-goog-api-key']).toBe('goog-key')
  })

  it('omits the api key header when the credential carries a blank key', async () => {
    const google = await build({ provider: 'google' }, {
      ...credentials,
      google: { apiKey: '  ', baseUrl: '' },
    })

    expect(google.headers['x-goog-api-key']).toBeUndefined()
    expect(google.headers['content-type']).toBe('application/json')

    const anthropic = await build({ provider: 'anthropic' }, {
      ...credentials,
      anthropic: { apiKey: '', baseUrl: 'https://a.example' },
    })

    expect(anthropic.headers['x-api-key']).toBeUndefined()
    expect(anthropic.headers['anthropic-version']).toBe('2023-06-01')
  })

  it('trims whitespace out of credentials and the provider id', async () => {
    const openai = await build({}, { ...credentials, openai: { apiKey: ' sk ', baseUrl: '' } })
    expect(openai.headers['authorization']).toBe('Bearer sk')

    const anthropic = await build({ provider: 'anthropic' }, {
      ...credentials,
      anthropic: { apiKey: ' sk ', baseUrl: 'https://a.example' },
    })
    expect(anthropic.headers['x-api-key']).toBe('sk')

    const paddedId = await build({ provider: 'openai ' })
    expect(paddedId.headers['authorization']).toBe('Bearer sk-openai')
  })

  it('rejects an api key that cannot travel in an http header', async () => {
    const unauthorized = await failureOf(
      request(),
      { ...credentials, openai: { apiKey: 'bad\nkey', baseUrl: '' } },
    )
    expect(unauthorized.message).toContain('Invalid authorization header')

    const azure = await failureOf(
      request({ provider: 'azure' }),
      { ...credentials, azure: { apiKey: 'bad\nkey', baseUrl: 'https://r.openai.azure.com' } },
    )
    expect(azure.message).toContain('Invalid API key header')

    const google = await failureOf(
      request({ provider: 'google' }),
      { ...credentials, google: { apiKey: 'bad\x7fkey', baseUrl: '' } },
    )
    expect(google.message).toContain('Invalid API key header')
  })

  it('validates, trims and lowercases custom headers', async () => {
    const built = await build({
      customHeaders: { ' X-Trace ': ' abc ', 'Content-Type': 'text/plain' },
    })

    expect(built.headers['x-trace']).toBe('abc')
    expect(built.headers['content-type']).toBe('application/json')

    const badName = await failureOf(request({ customHeaders: { 'bad name': 'v' } }))
    expect(badName.message).toBe("Invalid custom header name 'bad name'")

    const badValue = await failureOf(request({ customHeaders: { 'x-trace': 'a\nb' } }))
    expect(badValue.message).toBe("Invalid custom header value for 'x-trace'")

    const emptyName = await failureOf(request({ customHeaders: { '': 'v' } }))
    expect(emptyName.message).toBe("Invalid custom header name ''")
  })

  it('applies the openai reasoning effort windows', async () => {
    const gpt5 = async (mode: string, extra: Record<string, unknown> = {}) =>
      jsonBody(await build({ provider: 'openai', model: 'gpt-5', reasoning: { mode, ...extra } }))

    expect((await gpt5('low'))['reasoning_effort']).toBe('low')
    expect((await gpt5('medium'))['reasoning_effort']).toBe('medium')
    expect((await gpt5('high'))['reasoning_effort']).toBe('high')
    expect((await gpt5('custom', { budgetTokens: 900 }))['reasoning_effort']).toBeUndefined()
    expect((await gpt5('off'))['reasoning_effort']).toBeUndefined()
    expect((await gpt5('max'))['reasoning_effort']).toBeUndefined()

    const o1 = jsonBody(await build({ provider: 'openai', model: 'o3-mini', reasoning: { mode: 'low' } }))
    expect(o1['reasoning_effort']).toBe('low')

    const plain = jsonBody(
      await build({ provider: 'openai', model: 'gpt-4o', reasoning: { mode: 'high' } }),
    )
    expect(plain['reasoning_effort']).toBeUndefined()
    expect(plain['max_tokens']).toBe(2048)

    const azure = jsonBody(
      await build({ provider: 'azure', model: 'gpt-5', reasoning: { mode: 'low' } }),
    )
    expect(azure['reasoning_effort']).toBe('low')

    const gateway = jsonBody(
      await build({ provider: 'custom', model: 'gpt-5', reasoning: { mode: 'low' } }),
    )
    expect(gateway['reasoning_effort']).toBeUndefined()

    const vendor = jsonBody(
      await build({ provider: 'openai', model: 'vendor/gpt-5', reasoning: { mode: 'low' } }),
    )
    expect(vendor['reasoning_effort']).toBeUndefined()

    const gatewayId = jsonBody(
      await build({ provider: 'openai', model: 'openai/o1', reasoning: { mode: 'low' } }),
    )
    expect(gatewayId['reasoning_effort']).toBeUndefined()
  })

  it('does not read a plain endpoint as a deepseek thinking endpoint', async () => {
    const plain = jsonBody(
      await build(
        { provider: 'openai', model: 'deepseek-v4', reasoning: { mode: 'off' } },
        { ...credentials, openai: { apiKey: 'k', baseUrl: 'https://api.openai.com' } },
      ),
    )

    expect(plain['thinking']).toBeUndefined()
  })

  it('switches to the completion token field for a custom azure deployment', async () => {
    const customAt = (baseUrl: string): ProviderCredentials => ({
      ...credentials,
      custom: { apiKey: 'k', baseUrl },
    })

    const azureHost = jsonBody(
      await build(
        { provider: 'custom', model: 'gpt-4o', azureModelFamily: 'gpt5', maxTokens: 1000 },
        customAt('https://resource.openai.azure.com'),
      ),
    )
    expect(azureHost['max_completion_tokens']).toBe(1000)
    expect(azureHost['max_tokens']).toBeUndefined()

    const deployments = jsonBody(
      await build(
        { provider: 'custom', model: 'gpt-4o', maxTokens: 1000 },
        customAt('https://gateway.example/openai/deployments/d'),
      ),
    )
    expect(deployments['max_tokens']).toBe(1000)

    const plainChat = jsonBody(
      await build(
        { provider: 'custom', model: 'gpt-5', maxTokens: 1000 },
        customAt('https://gateway.example/v1'),
      ),
    )
    expect(plainChat['max_tokens']).toBe(1000)

    const openAiOnAzureHost = jsonBody(
      await build(
        { provider: 'openai', model: 'gpt-4o', azureModelFamily: 'gpt5', maxTokens: 1000 },
        { ...credentials, openai: { apiKey: 'k', baseUrl: 'https://resource.openai.azure.com' } },
      ),
    )
    expect(openAiOnAzureHost['max_tokens']).toBe(1000)
    expect(openAiOnAzureHost['max_completion_tokens']).toBeUndefined()
  })

  it('keeps the model in the ollama body and marks the anthropic body as streaming', async () => {
    const ollama = await build({ provider: 'ollama', model: 'qwen' })
    expect(jsonBody(ollama)['model']).toBe('qwen')

    const streaming = await build({ provider: 'anthropic', model: 'claude-x' }, credentials, true)
    expect(jsonBody(streaming)['stream']).toBe(true)

    const single = await build({ provider: 'anthropic', model: 'claude-x' })
    expect(jsonBody(single)['stream']).toBeUndefined()
  })

  it('switches the token field for strict reasoning models', async () => {
    const strict = jsonBody(
      await build({ provider: 'openai', model: 'gpt-5', maxTokens: 4096 }),
    )
    expect(strict['max_completion_tokens']).toBe(4096)
    expect(strict['max_tokens']).toBeUndefined()

    const family = jsonBody(
      await build(
        { provider: 'azure', model: 'prod', azureModelFamily: 'gpt5', maxTokens: 1024 },
      ),
    )
    expect(family['max_completion_tokens']).toBe(1024)
    expect(family['max_tokens']).toBeUndefined()

    const nonStrict = jsonBody(await build({ provider: 'azure', model: 'gpt-4o' }))
    expect(nonStrict['max_tokens']).toBe(2048)
  })

  it('maps the deepseek and ollama reasoning dialects', async () => {
    const deepseek = async (overrides: Partial<ProviderCompletionRequest>) =>
      jsonBody(
        await build(overrides, {
          ...credentials,
          openai: { apiKey: 'k', baseUrl: 'https://api.deepseek.com' },
        }),
      )

    expect(
      (await deepseek({
        provider: 'openai',
        model: 'deepseek-v4-pro',
        reasoning: { mode: 'off' },
      }))['thinking'],
    ).toEqual({ type: 'disabled' })
    expect(
      (await deepseek({
        provider: 'openai',
        model: 'deepseek_v4',
        reasoning: { mode: 'off' },
      }))['thinking'],
    ).toEqual({ type: 'disabled' })
    expect(
      (await deepseek({
        provider: 'openai',
        model: 'deepseek-v4',
        reasoning: { mode: 'high' },
      }))['thinking'],
    ).toBeUndefined()

    const cn = jsonBody(
      await build(
        { provider: 'openai', model: 'deepseek-v4', reasoning: { mode: 'off' } },
        { ...credentials, openai: { apiKey: 'k', baseUrl: 'https://api.deepseek.cn' } },
      ),
    )
    expect(cn['thinking']).toEqual({ type: 'disabled' })

    const other = jsonBody(
      await build(
        { provider: 'openai', model: 'deepseek-v3', reasoning: { mode: 'off' } },
        { ...credentials, openai: { apiKey: 'k', baseUrl: 'https://api.deepseek.com' } },
      ),
    )
    expect(other['thinking']).toBeUndefined()

    const ollama = async (mode: string) =>
      jsonBody(await build({ provider: 'ollama', model: 'qwen', reasoning: { mode } }))

    expect((await ollama('max'))['reasoning_effort']).toBe('high')
    expect((await ollama('low'))['reasoning_effort']).toBe('low')
    expect((await ollama('medium'))['reasoning_effort']).toBe('medium')
    expect((await ollama('off'))['reasoning_effort']).toBe('none')
    expect((await ollama('custom'))['reasoning_effort']).toBeUndefined()
  })

  it('maps the anthropic thinking dialect', async () => {
    const anthropic = async (model: string, reasoning: Record<string, unknown>) =>
      jsonBody(await build({ provider: 'anthropic', model, reasoning }))

    const adaptive = await anthropic('claude-sonnet-4-6', { mode: 'low' })
    expect(adaptive['thinking']).toEqual({ type: 'adaptive' })
    expect(adaptive['output_config']).toEqual({ effort: 'low' })
    expect(adaptive['max_tokens']).toBe(2048)

    const older = await anthropic('claude-sonnet-4-5', { mode: 'custom', budgetTokens: 3000 })
    expect(older['thinking']).toEqual({ type: 'enabled', budget_tokens: 3000 })
    expect(older['max_tokens']).toBe(4024)

    const small = await anthropic('claude-3-opus', { mode: 'low' })
    expect(small['thinking']).toEqual({ type: 'enabled', budget_tokens: 1024 })
    expect(small['max_tokens']).toBe(2048)

    const unsuffixed = await anthropic('claude-opus-4-6x', { mode: 'high' })
    expect(unsuffixed['thinking']).toEqual({ type: 'enabled', budget_tokens: 8192 })

    const off = await anthropic('claude-opus-4-6', { mode: 'off' })
    expect(off['thinking']).toBeUndefined()

    const noBudget = await anthropic('claude-opus-4-6', {})
    expect(noBudget['thinking']).toBeUndefined()

    const medium = await anthropic('claude-sonnet-4-6', { mode: 'medium' })
    expect(medium['output_config']).toEqual({ effort: 'medium' })

    const max = await anthropic('claude-sonnet-4-6', { mode: 'max' })
    expect(max['output_config']).toEqual({ effort: 'max' })

    const high = await anthropic('claude-sonnet-4-6', { mode: 'high' })
    expect(high['output_config']).toEqual({ effort: 'high' })

    const budgeted = await anthropic('claude-sonnet-4-6', { mode: 'custom', budgetTokens: 700 })
    expect(budgeted['output_config']).toEqual({ effort: 'high' })

    const twoDigit = await anthropic('claude-sonnet-4-12', { mode: 'medium' })
    expect(twoDigit['thinking']).toEqual({ type: 'adaptive' })

    const tagged = await anthropic('claude-sonnet-4-6rc2', { mode: 'medium' })
    expect(tagged['thinking']).toEqual({ type: 'enabled', budget_tokens: 4096 })

    const haiku = await anthropic('claude-haiku-4-6', { mode: 'medium' })
    expect(haiku['thinking']).toEqual({ type: 'adaptive' })

    const ceiling = await anthropic('claude-3-opus', { mode: 'max' })
    expect(ceiling['thinking']).toEqual({ type: 'enabled', budget_tokens: 8192 })
    expect(ceiling['max_tokens']).toBe(9216)

    const minimax = jsonBody(
      await build(
        { provider: 'minimax', model: 'claude-x', reasoning: { mode: 'low' } },
        { ...credentials, minimax: { apiKey: 'mm', baseUrl: 'https://api.minimaxi.com/anthropic' } },
      ),
    )
    expect(minimax['thinking']).toBeUndefined()
    expect(minimax['max_tokens']).toBe(2048)
  })

  it('maps the google thinking dialect', async () => {
    const google = async (model: string, reasoning: Record<string, unknown>) => {
      const built = await build({ provider: 'google', model, reasoning })
      return record(jsonBody(built)['generationConfig'])['thinkingConfig']
    }

    expect(await google('gemini-3-pro', { mode: 'medium' })).toEqual({ thinkingLevel: 'medium' })
    expect(await google('gemini-3.1-pro', { mode: 'high' })).toEqual({ thinkingLevel: 'high' })
    expect(await google('gemini_3_pro', { mode: 'low' })).toEqual({ thinkingLevel: 'low' })
    expect(await google('gemini-3.pro', { mode: 'custom', budgetTokens: 700 })).toEqual({
      thinkingLevel: 'high',
    })
    expect(await google('gemini-2.5-flash', { mode: 'low' })).toEqual({ thinkingBudget: 1024 })
    expect(await google('gemini-2.5-flash', { mode: 'off' })).toEqual({ thinkingBudget: 0 })
    expect(await google('gemini-2.5-pro', { mode: 'off' })).toBeUndefined()
    expect(await google('gemini-2.5-pro', { mode: 'custom', budgetTokens: 300 })).toEqual({
      thinkingBudget: 300,
    })
    expect(await google('gemini_3.5', { mode: 'medium' })).toEqual({ thinkingLevel: 'medium' })
    expect(await google('gemini-2.5-pro-preview', { mode: 'off' })).toBeUndefined()
    expect(await google('gemini-3.pro', { mode: 'custom' })).toBeUndefined()
  })

  it('always caps the anthropic budget above the default window', async () => {
    const built = jsonBody(
      await build({ provider: 'anthropic', model: 'claude-3-opus', reasoning: { mode: 'medium' } }),
    )
    expect(built['max_tokens']).toBe(5120)
    expect(record(built['thinking'])['budget_tokens']).toBe(4096)
  })
})

describe('provider payload parsing', () => {
  it('extracts openai deltas from both delta and message shapes', () => {
    expect(parseOpenAiDelta('{"choices":[{"delta":{"content":"a"}}]}')).toBe('a')
    expect(parseOpenAiDelta('{"choices":[{"message":{"content":"b"}}]}')).toBe('b')
    expect(parseOpenAiDelta('{"choices":[]}')).toBeUndefined()
    expect(parseOpenAiDelta('{"choices":[{"delta":{"content":7}}]}')).toBeUndefined()
    expect(parseOpenAiDelta('{"choices":{}}')).toBeUndefined()
    expect(parseOpenAiDelta('not json')).toBeUndefined()
    expect(parseOpenAiDelta('[1,2]')).toBeUndefined()
  })

  it('extracts anthropic deltas only from content block deltas', () => {
    expect(parseAnthropicDelta('{"type":"content_block_delta","delta":{"text":"a"}}')).toBe('a')
    expect(parseAnthropicDelta('{"type":"message_stop"}')).toBeUndefined()
    expect(parseAnthropicDelta('{"type":"message_start","delta":{"text":"x"}}')).toBeUndefined()
    expect(parseAnthropicDelta('{"type":"content_block_delta","delta":{"text":5}}')).toBeUndefined()
    expect(parseAnthropicDelta('"text"')).toBeUndefined()
  })

  it('extracts google deltas from the first candidate part list', () => {
    expect(parseGoogleDelta('{"candidates":[{"content":{"parts":[{"text":"a"},{"text":"b"}]}}]}'))
      .toBe('ab')
    expect(parseGoogleDelta('{"candidates":[{"content":{"parts":[{"inlineData":{}}]}}]}'))
      .toBeUndefined()
    expect(parseGoogleDelta('{"candidates":[{"content":{"parts":"nope"}}]}')).toBeUndefined()
    expect(parseGoogleDelta('{"candidates":[]}')).toBeUndefined()
  })

  it('extracts completion text with the provider fallbacks', () => {
    expect(openAiCompletionText({ choices: [{ message: { content: 'hi' } }] })).toBe('hi')
    expect(openAiCompletionText({ choices: [] })).toBe('')
    expect(openAiCompletionText({ choices: [{ message: {} }] })).toBe('')
    expect(openAiCompletionText([{ message: { content: 'hi' } }])).toBe('')
    expect(openAiCompletionText(null)).toBe('')
    expect(parseOpenAiDelta('null')).toBeUndefined()

    expect(
      anthropicCompletionText({
        content: [{ type: 'thinking', text: 'x' }, { type: 'text', text: 'y' }, { type: 'text' }],
      }),
    ).toBe('y')
    expect(anthropicCompletionText({ content: 'nope' })).toBe('')
    expect(anthropicCompletionText(null)).toBe('')
    expect(anthropicCompletionText('nope')).toBe('')

    expect(googleCompletionText({ candidates: [{ content: { parts: [{ text: 'c' }] } }] })).toBe('c')
    expect(googleCompletionText({})).toBe('')
    expect(googleCompletionText('nope')).toBe('')
  })

  it('decodes sse lines and ignores non-data noise', () => {
    const decoder = makeSseDeltaDecoder(parseOpenAiDelta)

    const deltas = decoder.push(
      encoder.encode(
        'event: message\n' +
          'data: {"choices":[{"delta":{"content":"a"}}]}\n' +
          '\n' +
          'data\n' +
          '\n' +
          'data: \n' +
          '\n' +
          'data: [DONE]\n' +
          'DATA: {"choices":[{"delta":{"content":"nope"}}]}\n' +
          '  data: {"choices":[{"delta":{"content":"c"}}]}\n' +
          'data: {"choices":[{"delta":{"content":"b"}}]}\r\n',
      ),
    )

    expect(deltas).toEqual(['a', 'c', 'b'])
    expect(decoder.flush()).toEqual([])
  })

  it('holds an incomplete trailing line until the next push', () => {
    const decoder = makeSseDeltaDecoder(parseOpenAiDelta)

    expect(decoder.push(encoder.encode('data: {"choices":[{"delta":{"cont'))).toEqual([])
    expect(decoder.push(encoder.encode('ent":"ab"}}]}\n'))).toEqual(['ab'])
    expect(decoder.flush()).toEqual([])
  })

  it('flushes a final line that never got its newline', () => {
    const decoder = makeSseDeltaDecoder(parseOpenAiDelta)
    decoder.push(encoder.encode('data: {"choices":[{"delta":{"content":"tail"}}]}'))

    expect(decoder.flush()).toEqual(['tail'])
    expect(decoder.flush()).toEqual([])
  })

  it('flushes a final line that carries no whitespace at all', () => {
    const decoder = makeSseDeltaDecoder(parseOpenAiDelta)
    decoder.push(encoder.encode('data:{"choices":[{"delta":{"content":"tail"}}]}'))

    expect(decoder.flush()).toEqual(['tail'])
  })

  it('strips a carriage return only at the end of a line', () => {
    const decoder = makeSseDeltaDecoder(parseOpenAiDelta)

    expect(decoder.push(encoder.encode('\rdata: {"choices":[{"delta":{"content":"cr"}}]}\n')))
      .toEqual(['cr'])
  })

  it('replaces an invalid utf8 byte instead of failing the stream', () => {
    const decoder = makeSseDeltaDecoder(parseOpenAiDelta)

    expect(decoder.push(new Uint8Array([0xff, 0x0a]))).toEqual([])
    expect(decoder.push(encoder.encode('data: {"choices":[{"delta":{"content":"ok"}}]}\n')))
      .toEqual(['ok'])
  })

  it('never hands a blank or terminal payload to the delta parser', () => {
    const seen: Array<string> = []
    const decoder = makeSseDeltaDecoder((payload) => {
      seen.push(payload)
      return `<${payload}>`
    })

    expect(decoder.push(encoder.encode('data: \n'))).toEqual([])
    expect(decoder.push(encoder.encode('data: [DONE]\n'))).toEqual([])
    expect(seen).toEqual([])
  })

  it('drops a blank or whitespace-only tail', () => {
    const whitespace = makeSseDeltaDecoder(parseOpenAiDelta)
    expect(whitespace.push(encoder.encode(' \t '))).toEqual([])
    expect(whitespace.flush()).toEqual([])

    const blank = makeSseDeltaDecoder(parseOpenAiDelta)
    expect(blank.push(encoder.encode(' \t \n'))).toEqual([])
    expect(blank.flush()).toEqual([])

    const empty = makeSseDeltaDecoder(parseOpenAiDelta)
    expect(empty.push(encoder.encode('data: {"choices":[{"delta":{"content":""}}]}\n'))).toEqual([])
    expect(empty.flush()).toEqual([])
  })

  it('splits multibyte payloads across arbitrary byte boundaries', () => {
    const line = 'data: {"choices":[{"delta":{"content":"煤矿"}}]}\n'
    const bytes = encoder.encode(line)

    for (let cut = 1; cut < bytes.length; cut += 1) {
      const decoder = makeSseDeltaDecoder(parseOpenAiDelta)
      const first = decoder.push(bytes.slice(0, cut))
      const second = decoder.push(bytes.slice(cut))
      expect([...first, ...second]).toEqual(['煤矿'])
    }
  })
})
