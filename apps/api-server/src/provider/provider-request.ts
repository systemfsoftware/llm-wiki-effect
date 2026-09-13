import { Effect } from 'effect'
import type { Errors } from 'llm-wiki-protocol'
import { agentError } from './provider-errors.js'

export interface ProviderCredential {
  readonly apiKey: string
  readonly baseUrl: string
}

export type ProviderCredentials = Readonly<Record<string, ProviderCredential>>

export interface ProviderImage {
  readonly mediaType: string
  readonly dataBase64: string
}

export interface ProviderReasoning {
  readonly mode?: string | undefined
  readonly budgetTokens?: number | undefined
}

export interface ProviderCompletionRequest {
  readonly provider: string
  readonly model: string
  readonly system: string
  readonly user: string
  readonly maxTokens?: number | undefined
  readonly images?: ReadonlyArray<ProviderImage> | undefined
  readonly streamingEnabled?: boolean | undefined
  readonly reasoning?: ProviderReasoning | undefined
  readonly apiMode?: string | undefined
  readonly azureApiVersion?: string | undefined
  readonly azureModelFamily?: string | undefined
  readonly customHeaders?: Readonly<Record<string, string>> | undefined
}

export type ProviderFamily = 'openai' | 'anthropic' | 'google'

export interface ProviderHttpRequest {
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: string
  readonly family: ProviderFamily
}

const DEFAULT_MAX_TOKENS = 2048
const MIN_MAX_TOKENS = 256
const MAX_MAX_TOKENS = 32_768
const ANTHROPIC_VERSION = '2023-06-01'
const AZURE_OPENAI_API_VERSION = '2024-10-21'
const OPENAI_CHAT_COMPLETIONS_URL = 'https://api.openai.com/v1/chat/completions'
const ANTHROPIC_BASE_URL = 'https://api.anthropic.com'
const GOOGLE_BASE_URL = 'https://generativelanguage.googleapis.com'
const MINIMAX_ANTHROPIC_BASE_URL = 'https://api.minimax.io/anthropic'
const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
const HEADER_VALUE_PATTERN = /^[\t\x20-\x7e\x80-\xff]*$/
const CLAUDE_4_PREFIXES = ['claude-opus-4-', 'claude-sonnet-4-', 'claude-haiku-4-']

export const maxOutputTokens = (maxTokens: number | undefined): number =>
  Math.min(MAX_MAX_TOKENS, Math.max(MIN_MAX_TOKENS, maxTokens ?? DEFAULT_MAX_TOKENS))

export const isUsableForHttp = (
  provider: string,
  model: string,
  credential: ProviderCredential | undefined,
): boolean => {
  if (credential === undefined) {
    return false
  }
  const hasModel = model.trim() !== ''
  const hasKey = credential.apiKey.trim() !== ''
  const hasEndpoint = credential.baseUrl.trim() !== ''
  switch (provider) {
    case 'openai':
    case 'anthropic':
    case 'google':
    case 'azure':
    case 'minimax':
      return hasModel && hasKey
    case 'ollama':
    case 'custom':
      return hasModel && hasEndpoint
    default:
      return false
  }
}

interface RequestShape {
  readonly provider: string
  readonly model: string
  readonly endpoint: string
  readonly azureModelFamily: string | undefined
  readonly reasoning: ProviderReasoning | undefined
  readonly customHeaders: Readonly<Record<string, string>> | undefined
  readonly maxTokens: number
}

// Stryker disable next-line MethodExpression: every caller passes an endpoint that buildProviderRequest already trimmed
const stripTrailingSlashes = (value: string): string => value.trim().replace(/\/+$/, '')

const isAzureEndpoint = (url: string): boolean => {
  const lower = url.toLowerCase()
  return lower.includes('.openai.azure.com') || lower.includes('/openai/deployments/')
}

const requiresBearerAuth = (url: string): boolean => {
  const lower = url.toLowerCase()
  return lower.includes('minimax.io') || lower.includes('minimaxi.com')
}

const urlEncodePathSegment = (value: string): string => {
  let encoded = ''
  for (const byte of new TextEncoder().encode(value)) {
    const character = String.fromCharCode(byte)
    encoded += /[A-Za-z0-9\-_.~]/.test(character)
      ? character
      : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`
  }
  return encoded
}

const buildChatCompletionsUrl = (base: string): string => {
  const trimmed = stripTrailingSlashes(base)
  return trimmed.toLowerCase().endsWith('/chat/completions')
    ? trimmed
    : `${trimmed}/chat/completions`
}

const buildOllamaUrl = (base: string): string => {
  let trimmed = stripTrailingSlashes(base)
  const lower = trimmed.toLowerCase()
  if (lower.endsWith('/v1/chat/completions')) {
    trimmed = trimmed.slice(0, -'/v1/chat/completions'.length)
  } else if (lower.endsWith('/v1')) {
    trimmed = trimmed.slice(0, -'/v1'.length)
  }
  return `${trimmed}/v1/chat/completions`
}

const buildAnthropicUrl = (base: string): string => {
  const trimmed = stripTrailingSlashes(base)
  const lower = trimmed.toLowerCase()
  if (lower.endsWith('/v1/messages')) {
    return trimmed
  }
  return lower.endsWith('/v1') ? `${trimmed}/messages` : `${trimmed}/v1/messages`
}

const buildGoogleUrl = (base: string, model: string, stream: boolean): string => {
  const trimmed = stripTrailingSlashes(base)
  const encodedModel = urlEncodePathSegment(model)
  return stream
    ? `${trimmed}/v1beta/models/${encodedModel}:streamGenerateContent?alt=sse`
    : `${trimmed}/v1beta/models/${encodedModel}:generateContent`
}

const buildAzureUrl = (
  base: string,
  model: string,
  apiVersion: string | undefined,
): Effect.Effect<string, Errors.AgentError> =>
  Effect.suspend(() => {
    const endpoint = stripTrailingSlashes(base)
    if (endpoint === '') {
      return agentError('Azure endpoint is required')
    }
    const requested = (apiVersion ?? '').trim()
    const version = requested === '' ? AZURE_OPENAI_API_VERSION : requested
    if (endpoint.toLowerCase().includes('/openai/deployments/')) {
      return Effect.succeed(`${endpoint}${endpoint.includes('?') ? '&' : '?'}api-version=${version}`)
    }
    return Effect.succeed(
      `${endpoint}/openai/deployments/${urlEncodePathSegment(model)}/chat/completions?api-version=${version}`,
    )
  })

const baseHeaders = (
  customHeaders: Readonly<Record<string, string>> | undefined,
): Effect.Effect<Record<string, string>, Errors.AgentError> =>
  Effect.suspend(() => {
    const headers: Record<string, string> = {}
    for (const [rawName, rawValue] of Object.entries(customHeaders ?? {})) {
      const name = rawName.trim()
      const value = rawValue.trim()
      if (!HEADER_NAME_PATTERN.test(name)) {
        return agentError(`Invalid custom header name '${rawName}'`)
      }
      if (!HEADER_VALUE_PATTERN.test(value)) {
        return agentError(`Invalid custom header value for '${name}'`)
      }
      headers[name.toLowerCase()] = value
    }
    headers['content-type'] = 'application/json'
    return Effect.succeed(headers)
  })

const setApiKeyHeader = (
  headers: Record<string, string>,
  name: 'api-key' | 'authorization' | 'x-api-key' | 'x-goog-api-key',
  value: string,
): Effect.Effect<Record<string, string>, Errors.AgentError> =>
  HEADER_VALUE_PATTERN.test(value)
    ? Effect.succeed({ ...headers, [name]: value })
    : agentError(
      name === 'authorization'
        ? 'Invalid authorization header: the api key contains characters that are not allowed in an HTTP header'
        : 'Invalid API key header: the api key contains characters that are not allowed in an HTTP header',
    )

const openAiHeaders = (
  shape: RequestShape,
  apiKey: string,
  url: string,
): Effect.Effect<Record<string, string>, Errors.AgentError> =>
  Effect.gen(function*() {
    const headers = yield* baseHeaders(shape.customHeaders)
    const key = apiKey.trim()
    if (key === '') {
      return headers
    }
    return yield* isAzureEndpoint(url)
      ? setApiKeyHeader(headers, 'api-key', key)
      : setApiKeyHeader(headers, 'authorization', `Bearer ${key}`)
  })

const anthropicHeaders = (
  shape: RequestShape,
  apiKey: string,
  url: string,
): Effect.Effect<Record<string, string>, Errors.AgentError> =>
  Effect.gen(function*() {
    const headers = yield* baseHeaders(shape.customHeaders)
    headers['anthropic-version'] = ANTHROPIC_VERSION
    const key = apiKey.trim()
    if (key === '') {
      return headers
    }
    return yield* requiresBearerAuth(url)
      ? setApiKeyHeader(headers, 'authorization', `Bearer ${key}`)
      : setApiKeyHeader(headers, 'x-api-key', key)
  })

const googleHeaders = (
  shape: RequestShape,
  apiKey: string,
): Effect.Effect<Record<string, string>, Errors.AgentError> =>
  Effect.gen(function*() {
    const headers = yield* baseHeaders(shape.customHeaders)
    const key = apiKey.trim()
    return key === '' ? headers : yield* setApiKeyHeader(headers, 'x-goog-api-key', key)
  })

const openAiUserContent = (user: string, images: ReadonlyArray<ProviderImage>): unknown =>
  images.length === 0
    ? user
    : [
      { type: 'text', text: user },
      ...images.map((image) => ({
        type: 'image_url',
        image_url: { url: `data:${image.mediaType};base64,${image.dataBase64}` },
      })),
    ]

const anthropicUserContent = (user: string, images: ReadonlyArray<ProviderImage>): unknown => [
  { type: 'text', text: user },
  ...images.map((image) => ({
    type: 'image',
    source: { type: 'base64', media_type: image.mediaType, data: image.dataBase64 },
  })),
]

const isDeepSeekEndpoint = (endpoint: string): boolean => {
  const lower = endpoint.toLowerCase()
  return lower.includes('api.deepseek.com') || lower.includes('api.deepseek.cn')
}

const supportsDeepSeekThinkingParam = (model: string): boolean =>
  model.toLowerCase().replace(/_/g, '-').includes('deepseek-v4')

const reasoningBudget = (reasoning: ProviderReasoning | undefined): number | undefined => {
  // Stryker disable next-line OptionalChaining: both callers reject an undefined reasoning block before reading its mode
  switch (reasoning?.mode) {
    case 'custom':
      return reasoning.budgetTokens
    case 'low':
      return 1024
    case 'medium':
      return 4096
    case 'high':
    case 'max':
      return 8192
    // Stryker disable next-line ConditionalExpression: an emptied default case falls through to the same implicit undefined return
    default:
      return undefined
  }
}

const isOpenAiReasoningModel = (shape: RequestShape): boolean => {
  if (shape.provider === 'azure' && shape.azureModelFamily === 'gpt5') {
    return true
  }
  const lower = shape.model.toLowerCase()
  return lower.startsWith('gpt-5') || /^o\d/.test(lower)
}

const isClaude46OrLater = (model: string): boolean => {
  const lower = model.toLowerCase()
  const prefix = CLAUDE_4_PREFIXES.find((candidate) => lower.startsWith(candidate))
  if (prefix === undefined) {
    return false
  }
  const version = lower.slice(prefix.length).split(/[-_.]/)[0]
  // Stryker disable next-line ConditionalExpression: split always yields at least one segment, so the version is never undefined
  return version !== undefined && /^\d+$/.test(version) && Number.parseInt(version, 10) >= 6
}

const isGemini3 = (model: string): boolean => {
  const lower = model.toLowerCase()
  return (
    lower.startsWith('gemini-3-') ||
    lower.startsWith('gemini-3.') ||
    lower.startsWith('gemini_3_') ||
    lower.startsWith('gemini_3.')
  )
}

const isGeminiThinkingRequired = (model: string): boolean =>
  model.toLowerCase().startsWith('gemini-2.5-pro') || isGemini3(model)

const anthropicEffort = (mode: string | undefined): 'low' | 'medium' | 'high' | 'max' =>
  mode === 'low' || mode === 'medium' || mode === 'max' ? mode : 'high'

const googleThinkingLevel = (mode: string | undefined): 'low' | 'medium' | 'high' =>
  mode === 'low' || mode === 'medium' ? mode : 'high'

const adaptOpenAiStrictCompletionBody = (
  body: Record<string, unknown>,
  shape: RequestShape,
): void => {
  const customAzure = shape.provider === 'custom' && isAzureEndpoint(shape.endpoint)
  const strict = isOpenAiReasoningModel(shape) || (customAzure && shape.azureModelFamily === 'gpt5')
  if (!strict || (shape.provider !== 'openai' && shape.provider !== 'azure' && !customAzure)) {
    return
  }
  // Stryker disable next-line ConditionalExpression: openAiLikeBody always sets max_tokens, so the guard is always taken
  if ('max_tokens' in body) {
    body['max_completion_tokens'] = body['max_tokens']
    delete body['max_tokens']
  }
}

const applyOpenAiReasoning = (body: Record<string, unknown>, shape: RequestShape): void => {
  const reasoning = shape.reasoning
  if (reasoning === undefined) {
    return
  }
  if (isDeepSeekEndpoint(shape.endpoint) && supportsDeepSeekThinkingParam(shape.model)) {
    if (reasoning.mode === 'off') {
      body['thinking'] = { type: 'disabled' }
    }
    return
  }
  if (shape.provider === 'ollama') {
    const effort = reasoning.mode === 'off' ? 'none' : reasoning.mode === 'max' ? 'high' : reasoning.mode
    if (effort === 'none' || effort === 'low' || effort === 'medium' || effort === 'high') {
      body['reasoning_effort'] = effort
    }
    return
  }
  if (shape.provider !== 'openai' && shape.provider !== 'azure') {
    return
  }
  if (!isOpenAiReasoningModel(shape)) {
    return
  }
  if (reasoning.mode === 'low' || reasoning.mode === 'medium' || reasoning.mode === 'high') {
    body['reasoning_effort'] = reasoning.mode
  }
}

const applyAnthropicReasoning = (body: Record<string, unknown>, shape: RequestShape): void => {
  const reasoning = shape.reasoning
  // Stryker disable next-line ConditionalExpression,StringLiteral: an off mode already yields no reasoning budget, so dropping this early return changes nothing
  if (reasoning === undefined || shape.provider !== 'anthropic' || reasoning.mode === 'off') {
    return
  }
  const budget = reasoningBudget(reasoning)
  if (budget === undefined) {
    return
  }
  if (isClaude46OrLater(shape.model)) {
    body['thinking'] = { type: 'adaptive' }
    body['output_config'] = { effort: anthropicEffort(reasoning.mode) }
    return
  }
  body['thinking'] = { type: 'enabled', budget_tokens: budget }
  body['max_tokens'] = Math.max(budget + 1024, DEFAULT_MAX_TOKENS)
}

const applyGoogleReasoning = (
  generationConfig: Record<string, unknown>,
  shape: RequestShape,
): void => {
  const reasoning = shape.reasoning
  if (reasoning === undefined) {
    return
  }
  if (reasoning.mode === 'off') {
    if (isGeminiThinkingRequired(shape.model)) {
      return
    }
    generationConfig['thinkingConfig'] = { thinkingBudget: 0 }
    return
  }
  const budget = reasoningBudget(reasoning)
  if (isGemini3(shape.model) && budget !== undefined) {
    generationConfig['thinkingConfig'] = { thinkingLevel: googleThinkingLevel(reasoning.mode) }
    return
  }
  if (budget !== undefined) {
    generationConfig['thinkingConfig'] = { thinkingBudget: budget }
  }
}

const openAiLikeBody = (
  shape: RequestShape,
  completion: ProviderCompletionRequest,
  includeModel: boolean,
  stream: boolean,
): Record<string, unknown> => {
  const body: Record<string, unknown> = {
    messages: [
      { role: 'system', content: completion.system },
      { role: 'user', content: openAiUserContent(completion.user, completion.images ?? []) },
    ],
    stream,
    max_tokens: shape.maxTokens,
  }
  if (includeModel) {
    body['model'] = shape.model
  }
  adaptOpenAiStrictCompletionBody(body, shape)
  applyOpenAiReasoning(body, shape)
  return body
}

const anthropicLikeBody = (
  shape: RequestShape,
  completion: ProviderCompletionRequest,
  stream: boolean,
): Record<string, unknown> => {
  const body: Record<string, unknown> = {
    model: shape.model,
    system: [{ type: 'text', text: completion.system, cache_control: { type: 'ephemeral' } }],
    messages: [
      { role: 'user', content: anthropicUserContent(completion.user, completion.images ?? []) },
    ],
    max_tokens: shape.maxTokens,
  }
  if (stream) {
    body['stream'] = true
  }
  applyAnthropicReasoning(body, shape)
  return body
}

const googleBody = (
  shape: RequestShape,
  completion: ProviderCompletionRequest,
): Record<string, unknown> => {
  const parts: unknown[] = [{ text: completion.user }]
  for (const image of completion.images ?? []) {
    parts.push({ inlineData: { mimeType: image.mediaType, data: image.dataBase64 } })
  }
  const generationConfig: Record<string, unknown> = { maxOutputTokens: shape.maxTokens }
  applyGoogleReasoning(generationConfig, shape)
  return {
    systemInstruction: { parts: [{ text: completion.system }] },
    contents: [{ role: 'user', parts }],
    generationConfig,
  }
}

export const buildProviderRequest = (
  credentials: ProviderCredentials,
  completion: ProviderCompletionRequest,
  stream: boolean,
): Effect.Effect<ProviderHttpRequest, Errors.AgentError> =>
  Effect.gen(function*() {
    const provider = completion.provider.trim()
    const credential = credentials[provider]
    if (credential === undefined) {
      return yield* agentError(`No credentials configured for provider '${provider}'`)
    }
    const endpoint = credential.baseUrl.trim()
    const shape: RequestShape = {
      provider,
      model: completion.model,
      endpoint,
      azureModelFamily: completion.azureModelFamily,
      reasoning: completion.reasoning,
      customHeaders: completion.customHeaders,
      maxTokens: maxOutputTokens(completion.maxTokens),
    }
    const jsonBody = (
      body: Record<string, unknown>,
      url: string,
      headers: Record<string, string>,
      family: ProviderFamily,
    ): ProviderHttpRequest => ({ url, headers, body: JSON.stringify(body), family })

    switch (provider) {
      case 'openai': {
        const url = endpoint === '' ? OPENAI_CHAT_COMPLETIONS_URL : buildChatCompletionsUrl(endpoint)
        const headers = yield* openAiHeaders(shape, credential.apiKey, url)
        return jsonBody(openAiLikeBody(shape, completion, true, stream), url, headers, 'openai')
      }
      case 'azure': {
        const url = yield* buildAzureUrl(endpoint, shape.model, completion.azureApiVersion)
        const headers = yield* openAiHeaders(shape, credential.apiKey, url)
        return jsonBody(openAiLikeBody(shape, completion, false, stream), url, headers, 'openai')
      }
      case 'ollama': {
        if (endpoint === '') {
          return yield* agentError('Ollama URL is required')
        }
        const url = buildOllamaUrl(endpoint)
        const headers = yield* openAiHeaders(shape, credential.apiKey, url)
        return jsonBody(openAiLikeBody(shape, completion, true, stream), url, headers, 'openai')
      }
      case 'anthropic': {
        const url = buildAnthropicUrl(endpoint === '' ? ANTHROPIC_BASE_URL : endpoint)
        const headers = yield* anthropicHeaders(shape, credential.apiKey, url)
        return jsonBody(anthropicLikeBody(shape, completion, stream), url, headers, 'anthropic')
      }
      case 'minimax': {
        if ((completion.images ?? []).length > 0) {
          return yield* agentError(
            'MiniMax official Anthropic-compatible endpoint does not support image input. Use a vision-capable provider for image chat.',
          )
        }
        const url = buildAnthropicUrl(endpoint === '' ? MINIMAX_ANTHROPIC_BASE_URL : endpoint)
        const headers = yield* anthropicHeaders(shape, credential.apiKey, url)
        return jsonBody(anthropicLikeBody(shape, completion, stream), url, headers, 'anthropic')
      }
      case 'custom': {
        if (endpoint === '') {
          return yield* agentError('Custom endpoint is required')
        }
        if (completion.apiMode === 'anthropic_messages') {
          const url = buildAnthropicUrl(endpoint)
          const headers = yield* anthropicHeaders(shape, credential.apiKey, url)
          return jsonBody(anthropicLikeBody(shape, completion, stream), url, headers, 'anthropic')
        }
        const url = isAzureEndpoint(endpoint)
          ? yield* buildAzureUrl(endpoint, shape.model, completion.azureApiVersion)
          : buildChatCompletionsUrl(endpoint)
        const headers = yield* openAiHeaders(shape, credential.apiKey, url)
        return jsonBody(
          openAiLikeBody(shape, completion, !isAzureEndpoint(url), stream),
          url,
          headers,
          'openai',
        )
      }
      case 'google': {
        const url = buildGoogleUrl(endpoint === '' ? GOOGLE_BASE_URL : endpoint, shape.model, stream)
        const headers = yield* googleHeaders(shape, credential.apiKey)
        return jsonBody(googleBody(shape, completion), url, headers, 'google')
      }
      default:
        return yield* agentError(
          `Provider '${provider}' is not supported by the backend HTTP Agent yet`,
        )
    }
  })
