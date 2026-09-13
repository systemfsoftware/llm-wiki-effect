/**
 * Real-LLM enrich-wikilinks tests — 4 scenarios against MiniMax (or Ollama).
 *
 * Reuses the enrich-scenarios.ts input content, but ignores the scenario's
 * mocked llmResponse. Instead, it lets the real LLM generate the enriched
 * version of the page, then asserts contract properties:
 *   - Either writeFile was called (output passed the >=50% length guard),
 *     or it wasn't (LLM returned short output — acceptable).
 *   - If written, content is non-empty and frontmatter is preserved.
 *   - If written, contains at least one [[wikilink]] (soft — LLM should
 *     add at least one link to a page in the index).
 */
import { createTempProject, readFileRaw, realFs } from '@/test-helpers/fs-temp'
import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/commands/fs', () => realFs)

import { useWikiStore } from '@/stores/wiki-store'
import { enrichScenarios } from '@/test-helpers/scenarios/enrich-scenarios'
import { enrichWithWikilinks } from './enrich-wikilinks'

const LLM_PROVIDER: 'ollama' | 'minimax' = process.env['LLM_PROVIDER'] === 'minimax' ? 'minimax' : 'ollama'
const OLLAMA_URL = process.env['OLLAMA_URL'] ?? 'http://192.168.1.50:8080'
const OLLAMA_MODEL = process.env['OLLAMA_MODEL'] ?? 'Qwen3.6-35B-A3B-UD-Q4_K_M.gguf'
const MINIMAX_API_KEY = process.env['MINIMAX_API_KEY'] ?? ''
const MINIMAX_MODEL = process.env['MINIMAX_MODEL'] ?? 'MiniMax-M2.7-highspeed'
const MINIMAX_ENDPOINT = process.env['MINIMAX_ENDPOINT'] ?? 'https://api.minimaxi.com/v1'
const ENABLED = process.env['RUN_LLM_TESTS'] === '1'

const TEST_TIMEOUT_MS = 5 * 60 * 1000

beforeAll(() => {
  if (!ENABLED) return
  if (LLM_PROVIDER === 'minimax' && !MINIMAX_API_KEY) {
    throw new Error('MINIMAX_API_KEY env var is required when LLM_PROVIDER=minimax')
  }
})

interface Ctx {
  tmp: { path: string; cleanup: () => Promise<void> }
}
let ctx: Ctx | undefined

async function setup(scenario: typeof enrichScenarios[number]): Promise<Ctx> {
  const tmp = await createTempProject(`real-llm-enrich-${scenario.name}`)

  // Materialize the initial wiki into the tmp project
  for (const [rel, content] of Object.entries(scenario.initialWiki)) {
    const full = path.join(tmp.path, rel)
    await fs.mkdir(path.dirname(full), { recursive: true })
    await fs.writeFile(full, content, 'utf-8')
  }

  useWikiStore.setState({
    project: {
      id: 'real-llm-enrich-project',
      name: 'test',
      path: tmp.path,
    },
  })
  useWikiStore.getState().setLlmConfig(
    LLM_PROVIDER === 'minimax'
      ? {
        provider: 'custom',
        apiKey: MINIMAX_API_KEY,
        model: MINIMAX_MODEL,
        ollamaUrl: '',
        customEndpoint: MINIMAX_ENDPOINT,
        maxContextSize: 110000,
      }
      : {
        provider: 'ollama',
        apiKey: '',
        model: OLLAMA_MODEL,
        ollamaUrl: OLLAMA_URL,
        customEndpoint: '',
        maxContextSize: 110000,
      },
  )

  return { tmp }
}

beforeEach(() => {
  // Enrich doesn't touch the review or activity store
})

afterEach(async () => {
  if (ctx) {
    await ctx.tmp.cleanup()
    ctx = undefined
  }
})

describe('real-LLM enrich-wikilinks scenarios (4)', () => {
  for (const scenario of enrichScenarios) {
    it.skipIf(!ENABLED)(
      `enrich-wikilinks: ${scenario.name}`,
      async () => {
        ctx = await setup(scenario)
        const pagePath = path.join(ctx.tmp.path, scenario.pageToEnrich)
        const originalContent = await readFileRaw(pagePath)

        const t0 = Date.now()
        await enrichWithWikilinks(
          ctx.tmp.path,
          pagePath,
          useWikiStore.getState().llmConfig,
        )
        const elapsedS = ((Date.now() - t0) / 1000).toFixed(1)

        const finalContent = await readFileRaw(pagePath)
        const wasWritten = finalContent !== originalContent

        // eslint-disable-next-line no-console
        console.log(
          `\n[enrich: ${scenario.name}] ${elapsedS}s, ` +
            `${wasWritten ? 'written' : 'unchanged'} ` +
            `(${originalContent.length} → ${finalContent.length} chars)\n`,
        )

        // Contract 1: file still exists and is non-empty
        expect(finalContent.length).toBeGreaterThan(0)

        // Contract 2: if written, output ≥ 50% of original (guard in code)
        const lengthGuardHolds = !wasWritten || finalContent.length >= originalContent.length * 0.5
        expect(
          lengthGuardHolds,
          `enriched too short vs original (${finalContent.length} < ${originalContent.length * 0.5})`,
        ).toBe(true)

        // Contract 3: if original had YAML frontmatter, output still has it
        const frontmatterHolds = !(originalContent.startsWith('---\n') && wasWritten) ||
          finalContent.startsWith('---\n')
        expect(frontmatterHolds, 'frontmatter dropped during enrichment').toBe(true)

        // ── Scenario-specific strict assertions ────────────────────────
        // The generic contracts above just prevent corruption. These
        // enforce that the feature actually added value.
        // The survey page mentions "Transformer" (3×) and "Attention" (1×).
        // The wiki index has both. A functional enrichment should wrap
        // at least BOTH first-mentions, i.e. 2 distinct [[wikilinks]].
        const wikilinks = Array.from(finalContent.matchAll(/\[\[[^\]]+\]\]/g))
        const addsWikilinksHolds = scenario.name !== 'adds-wikilinks' || !wasWritten || wikilinks.length >= 2
        expect(
          addsWikilinksHolds,
          `adds-wikilinks: expected ≥2 wikilinks (Transformer + Attention), got ${wikilinks.length}`,
        ).toBe(true)

        // Chinese-term scenario: must have at least 1 CJK [[wikilink]]
        const cjkWikilinks = Array.from(
          finalContent.matchAll(/\[\[[^\]]*[\u4E00-\u9FFF][^\]]*\]\]/g),
        )
        const cjkTermHolds = scenario.name !== 'cjk-terms' || !wasWritten || cjkWikilinks.length >= 1
        expect(
          cjkTermHolds,
          `cjk-terms: expected ≥1 CJK wikilink, got ${cjkWikilinks.length}`,
        ).toBe(true)

        // Contract 4: if written AND the wiki index contained linkable terms,
        // the enriched page should include at least one [[wikilink]]
        const hasWikilink = /\[\[[^\]]+\]\]/.test(finalContent)
        const wikilinkContractHolds = !(wasWritten && scenario.expected.writeCalled) || hasWikilink
        expect(
          wikilinkContractHolds,
          `expected at least one [[wikilink]] in enriched output for ${scenario.name}`,
        ).toBe(true)
      },
      TEST_TIMEOUT_MS,
    )
  }
})
