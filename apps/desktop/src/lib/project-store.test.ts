import { describe, expect, it } from 'vitest'
import { projectStoreTest } from './project-store'

describe('project-store MinerU config normalization', () => {
  it('preserves valid MinerU config values', () => {
    expect(projectStoreTest.normalizeMineruConfig({
      enabled: true,
      backend: 'local',
      localEndpoint: 'http://localhost:9000/mineru',
      localToken: ' local-secret ',
      localBackend: 'pipeline',
      localEffort: 'high',
      localParseMethod: 'ocr',
      localLanguage: 'korean',
      localFormulaEnabled: false,
      localTableEnabled: true,
      localImageAnalysis: false,
      localServerUrl: 'http://localhost:30000',
      token: 'token-123',
      modelVersion: 'pipeline',
    })).toEqual({
      enabled: true,
      backend: 'local',
      localEndpoint: 'http://localhost:9000/mineru',
      localToken: 'local-secret',
      localBackend: 'pipeline',
      localEffort: 'high',
      localParseMethod: 'ocr',
      localLanguage: 'korean',
      localFormulaEnabled: false,
      localTableEnabled: true,
      localImageAnalysis: false,
      localServerUrl: 'http://localhost:30000',
      token: 'token-123',
      modelVersion: 'pipeline',
    })
  })

  it('migrates legacy and malformed MinerU config values to safe defaults', () => {
    const malformed = JSON.parse('{"enabled":"yes","token":123,"modelVersion":"mineru-html"}')
    expect(projectStoreTest.normalizeMineruConfig(malformed)).toEqual({
      enabled: false,
      backend: 'cloud',
      localEndpoint: 'http://127.0.0.1:8000',
      localToken: '',
      localBackend: 'hybrid-engine',
      localEffort: 'medium',
      localParseMethod: 'auto',
      localLanguage: 'ch',
      localFormulaEnabled: true,
      localTableEnabled: true,
      localImageAnalysis: true,
      localServerUrl: '',
      token: '',
      modelVersion: 'vlm',
    })
  })
})

describe('project-store zoom normalization', () => {
  it('preserves valid zoom values', () => {
    expect(projectStoreTest.normalizeZoomLevel(0.5)).toBe(0.5)
    expect(projectStoreTest.normalizeZoomLevel(1.25)).toBe(1.25)
    expect(projectStoreTest.normalizeZoomLevel(3)).toBe(3)
  })

  it('clamps finite out-of-range values', () => {
    expect(projectStoreTest.normalizeZoomLevel(-2)).toBe(0.5)
    expect(projectStoreTest.normalizeZoomLevel(0)).toBe(0.5)
    expect(projectStoreTest.normalizeZoomLevel(0.49)).toBe(0.5)
    expect(projectStoreTest.normalizeZoomLevel(3.01)).toBe(3)
  })

  it('falls back to 100% for malformed values', () => {
    expect(projectStoreTest.normalizeZoomLevel(undefined)).toBe(1)
    expect(projectStoreTest.normalizeZoomLevel(null)).toBe(1)
    expect(projectStoreTest.normalizeZoomLevel(Number.NaN)).toBe(1)
    expect(projectStoreTest.normalizeZoomLevel(Number.POSITIVE_INFINITY)).toBe(1)
    expect(projectStoreTest.normalizeZoomLevel('150')).toBe(1)
  })
})

describe('project-store custom LLM preset normalization', () => {
  it('keeps valid unique presets and bounds labels', () => {
    const longLabel = 'x'.repeat(100)
    expect(projectStoreTest.normalizeCustomLlmPresets([
      { id: 'custom-one', label: ' Team Gateway ' },
      { id: 'custom-one', label: 'duplicate' },
      { id: 'custom-two', label: longLabel },
      { id: 'openai', label: 'collision' },
      { id: 'custom-empty', label: ' ' },
    ])).toEqual([
      { id: 'custom-one', label: 'Team Gateway' },
      { id: 'custom-two', label: 'x'.repeat(80) },
    ])
  })
})
