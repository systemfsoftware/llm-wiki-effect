import { Effect, Stream } from 'effect'
import * as fc from 'fast-check'
import { Errors } from 'llm-wiki-protocol'
import { describe, expect, it } from 'vitest'
import { ProviderClient } from '../src/provider/provider-client.js'
import type { ProviderClientShape, ProviderStreamEvent } from '../src/provider/provider-client.js'
import { isUsableForHttp } from '../src/provider/provider-request.js'
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
