/**
 * Diagnostic helper for "model emitted thinking but no actual answer"
 * symptoms.
 *
 * Some OpenAI-compatible endpoints (DeepSeek-R1, Kimi K2.x, Qwen
 * reasoning models, various third-party deployments) stream the
 * model's chain-of-thought through a non-content delta field —
 * either `reasoning_content` (DeepSeek/Kimi convention) or just
 * `reasoning` (some Qwen-flavored deployments). The user-facing
 * answer normally appears in `delta.content` AFTER the thinking
 * phase completes.
 *
 * When an endpoint misbehaves (max_tokens too small, server-side
 * thinking budget exhaustion, model bug) it can emit megabytes of
 * reasoning text and then end the stream with no content at all.
 * The streaming layer's parser correctly ignores reasoning fields
 * (we don't want to leak chain-of-thought into the user's wiki
 * output), but it leaves us with a silent empty-analysis result —
 * the user sees a meaningless "analysis not available" with no
 * actionable diagnosis.
 *
 * This helper does ONE thing: tally the byte-length of reasoning
 * text seen on a raw SSE line, so the streaming layer can
 * distinguish two stream-end states:
 *
 *   - 0 content + 0 reasoning  → plain empty response, network /
 *     auth / rate-limit territory; the existing error paths cover
 *     this.
 *   - 0 content + N>>0 reasoning → the diagnostic case above;
 *     surface "model only produced N chars of thinking, no final
 *     answer" instead of silently emptying the analysis.
 *
 * Implementation note: counts the JSON-escaped form's length
 * (e.g. `\\n` counts as 2). Close enough for a threshold check —
 * we're distinguishing "0 vs hundreds of chars", not measuring
 * exact tokens.
 */

const REASONING_FIELD_RE = /"reasoning(?:_content)?"\s*:\s*"((?:[^"\\]|\\.)*)"/g

export function countReasoningCharsInLine(rawLine: string): number {
  let total = 0
  for (const match of rawLine.matchAll(REASONING_FIELD_RE)) {
    const reasoning = match[1]
    if (reasoning !== undefined) total += reasoning.length
  }
  return total
}

export function extractReasoningTextFromLine(rawLine: string): string[] {
  const line = rawLine.trim()
  if (!line.startsWith('data: ')) return []
  const data = line.slice(6).trim()
  if (!data || data === '[DONE]') return []

  try {
    const parsed: unknown = JSON.parse(data)
    if (typeof parsed !== 'object' || parsed === null) return []

    const out: string[] = []

    if ('choices' in parsed && Array.isArray(parsed.choices)) {
      for (const choice of parsed.choices) {
        if (typeof choice !== 'object' || choice === null || !('delta' in choice)) continue
        const delta = choice.delta
        if (typeof delta !== 'object' || delta === null) continue
        if ('reasoning_content' in delta && typeof delta.reasoning_content === 'string') {
          out.push(delta.reasoning_content)
        }
        if ('reasoning' in delta && typeof delta.reasoning === 'string') out.push(delta.reasoning)
      }
    }

    if ('delta' in parsed) {
      const delta = parsed.delta
      if (typeof delta === 'object' && delta !== null && 'type' in delta && delta.type === 'thinking_delta') {
        if ('thinking' in delta && typeof delta.thinking === 'string') out.push(delta.thinking)
        if ('text' in delta && typeof delta.text === 'string') out.push(delta.text)
      }
    }

    if ('candidates' in parsed && Array.isArray(parsed.candidates)) {
      for (const candidate of parsed.candidates) {
        if (typeof candidate !== 'object' || candidate === null) continue
        const content = 'content' in candidate ? candidate.content : undefined
        if (typeof content !== 'object' || content === null) continue
        const parts = 'parts' in content ? content.parts : undefined
        if (!Array.isArray(parts)) continue
        for (const part of parts) {
          if (typeof part !== 'object' || part === null) continue
          const text = 'text' in part ? part.text : undefined
          if ('thought' in part && part.thought && typeof text === 'string') out.push(text)
        }
      }
    }

    return out
  } catch {
    return []
  }
}
