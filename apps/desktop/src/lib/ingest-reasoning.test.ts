import type { LlmPreset } from '@/components/settings/llm-presets'
import { resolveConfig } from '@/components/settings/preset-resolver'
import type { LlmConfig } from '@/stores/wiki-store'
import { describe, expect, it } from 'vitest'
import { getProviderConfig } from './llm-providers'
import { resolveIngestReasoning } from './reasoning-capabilities'

const openAiConfig: LlmConfig = {
  provider: 'openai',
  apiKey: 'k',
  model: 'gpt-5',
  ollamaUrl: '',
  customEndpoint: '',
  maxContextSize: 128000,
}

describe('ingest reasoning is settable instead of hardcoded off', () => {
  it('defaults to off, preserving the behaviour ingest had when it was hardcoded', () => {
    expect(resolveIngestReasoning(openAiConfig)).toEqual({ mode: 'off' })
  })

  it('uses the configured mode when the user picks one', () => {
    expect(resolveIngestReasoning({ ...openAiConfig, ingestReasoning: { mode: 'low' } }))
      .toEqual({ mode: 'low' })
  })

  it('keeps chat reasoning independent of ingest reasoning', () => {
    const config: LlmConfig = {
      ...openAiConfig,
      reasoning: { mode: 'high' },
      ingestReasoning: { mode: 'off' },
    }
    expect(resolveIngestReasoning(config)).toEqual({ mode: 'off' })
    expect(config.reasoning).toEqual({ mode: 'high' })
  })

  it('leaves provider normalization to the wire builder', () => {
    const autoOnly: LlmConfig = {
      ...openAiConfig,
      provider: 'custom',
      customEndpoint: 'https://example.invalid/v1',
    }
    expect(resolveIngestReasoning(autoOnly)).toEqual({ mode: 'off' })
  })

  it('reaches the wire: the selected effort ends up in the request body', () => {
    const withLow = { ...openAiConfig, ingestReasoning: { mode: 'low' as const } }
    const body = getProviderConfig(withLow).buildBody(
      [{ role: 'user', content: 'hi' }],
      { reasoning: resolveIngestReasoning(withLow) },
    )
    if (body === null || typeof body !== 'object' || !('reasoning_effort' in body)) {
      throw new Error('expected the provider to build a request body object')
    }
    expect(body.reasoning_effort).toBe('low')
  })

  it('survives the preset resolver, which drops fields it does not carry', () => {
    const preset: LlmPreset = { id: 'openai', label: 'OpenAI', provider: 'openai' }
    const resolved = resolveConfig(
      preset,
      { ingestReasoning: { mode: 'low' } },
      openAiConfig,
    )
    expect(resolved.ingestReasoning).toEqual({ mode: 'low' })
    expect(resolveIngestReasoning(resolved)).toEqual({ mode: 'low' })
  })
})
