/**
 * Models occasionally wrap an otherwise valid replacement in one Markdown
 * fence. Strip only that complete outer fence; partial or embedded fences are
 * user content and must remain untouched.
 */
export function normalizeSelectionReplacement(content: string): string {
  const trimmed = content.trim()
  const fenced = trimmed.match(/^```[^\n]*\n([\s\S]*?)\n```$/)
  return fenced?.[1] ?? content
}

/**
 * Textarea selection offsets use browser-normalized LF line endings even when
 * its assigned value came from a CRLF file. Normalize the editable snapshot so
 * those offsets always address the same string that selectionStart describes.
 */
export function normalizeEditableMarkdown(content: string): string {
  return content.replace(/\r\n?/g, '\n')
}

export interface TextSelectionSnapshot {
  prefix: string
  selectedText: string
  suffix: string
}

export interface WordDiffPart {
  type: 'equal' | 'insert' | 'delete'
  value: string
}

/** Small, deterministic LCS diff for selection-sized text candidates. */
export function buildWordDiff(original: string, replacement: string): WordDiffPart[] {
  const left = tokenizeDiff(original)
  const right = tokenizeDiff(replacement)
  // Keep pathological whole-document selections from allocating an unbounded
  // LCS matrix. The coarse fallback remains truthful and responsive.
  if (left.length * right.length > 250_000) {
    return [
      ...(original ? [{ type: 'delete' as const, value: original }] : []),
      ...(replacement ? [{ type: 'insert' as const, value: replacement }] : []),
    ]
  }
  const rows = Array.from({ length: left.length + 1 }, () => new Uint32Array(right.length + 1))
  for (let i = left.length - 1; i >= 0; i -= 1) {
    const row = requireDefined(rows, i)
    const nextRow = requireDefined(rows, i + 1)
    const leftToken = requireDefined(left, i)
    for (let j = right.length - 1; j >= 0; j -= 1) {
      row[j] = leftToken === right[j]
        ? requireDefined(nextRow, j + 1) + 1
        : Math.max(requireDefined(nextRow, j), requireDefined(row, j + 1))
    }
  }
  const parts: WordDiffPart[] = []
  let i = 0
  let j = 0
  while (i < left.length || j < right.length) {
    if (i < left.length && j < right.length && left[i] === right[j]) {
      pushDiff(parts, 'equal', requireDefined(left, i))
      i += 1
      j += 1
    } else if (
      j < right.length && (i === left.length || requireMatrixCell(rows, i, j + 1) >= requireMatrixCell(rows, i + 1, j))
    ) {
      pushDiff(parts, 'insert', requireDefined(right, j))
      j += 1
    } else {
      pushDiff(parts, 'delete', requireDefined(left, i))
      i += 1
    }
  }
  return parts
}

function tokenizeDiff(value: string): string[] {
  // Segment scripts that are commonly written without spaces by character so
  // a short CJK edit does not mark the entire sentence as replaced.
  return value.match(
    /\s+|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu,
  ) ?? []
}

function pushDiff(parts: WordDiffPart[], type: WordDiffPart['type'], value: string): void {
  const previous = parts[parts.length - 1]
  if (previous?.type === type) previous.value += value
  else parts.push({ type, value })
}

function requireDefined<T>(values: { readonly [index: number]: T }, index: number): T {
  const value = values[index]
  if (value === undefined) throw new RangeError(`index ${index} is out of range`)
  return value
}

function requireMatrixCell(rows: readonly Uint32Array[], row: number, column: number): number {
  return requireDefined(requireDefined(rows, row), column)
}

/**
 * Resolve rendered text back to one unambiguous Markdown source range. Browser
 * rendering can collapse line breaks and repeated spaces, so a whitespace-
 * flexible fallback is allowed. Ambiguous matches are rejected because an edit
 * action must never guess which occurrence the user selected.
 */
export function findUniqueTextSelection(
  markdown: string,
  renderedSelection: string,
): TextSelectionSnapshot | null {
  const selected = renderedSelection.trim()
  if (!selected) return null

  const exactStart = markdown.indexOf(selected)
  if (exactStart >= 0 && markdown.indexOf(selected, exactStart + selected.length) < 0) {
    return snapshot(markdown, exactStart, exactStart + selected.length)
  }

  const tokens = selected.split(/\s+/u).filter(Boolean)
  if (tokens.length < 2) return null
  const pattern = tokens.map(escapeRegExp).join('\\s+')
  const matches = [...markdown.matchAll(new RegExp(pattern, 'gu'))]
  if (matches.length !== 1) return null
  const match = requireDefined(matches, 0)
  if (match.index === undefined) return null
  return snapshot(markdown, match.index, match.index + requireDefined(match, 0).length)
}

/**
 * Resolve a browser Range through source-position attributes emitted by the
 * Markdown renderer. The renderer narrows each endpoint to its source block;
 * walking text nodes in DOM order then disambiguates repeated text without
 * relying on a project-wide string match.
 */
export function findDomTextSelection(
  markdown: string,
  selection: Selection,
  root: HTMLElement,
): TextSelectionSnapshot | null {
  if (selection.rangeCount === 0 || selection.isCollapsed) return null
  const range = selection.getRangeAt(0)
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null
  const start = domPointToSourceOffset(markdown, range.startContainer, range.startOffset, root)
  const end = domPointToSourceOffset(markdown, range.endContainer, range.endOffset, root)
  if (start === null || end === null || start >= end) return null
  return snapshot(markdown, start, end)
}

function domPointToSourceOffset(
  markdown: string,
  container: Node,
  offset: number,
  root: HTMLElement,
): number | null {
  const textPoint = normalizeToTextPoint(container, offset)
  if (!textPoint) return null
  const [target, targetOffset] = textPoint
  const parent = target.parentElement?.closest<HTMLElement>('[data-source-start][data-source-end]')
  if (!parent || !root.contains(parent)) return null
  const start = Number(parent.dataset['sourceStart'])
  const end = Number(parent.dataset['sourceEnd'])
  if (
    !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end > markdown.length || start >= end
  ) return null

  const walker = document.createTreeWalker(parent, NodeFilter.SHOW_TEXT)
  let cursor = start
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const value = node.nodeValue ?? ''
    if (!value) continue
    const match = findTextFrom(markdown, value, cursor, end)
    if (!match) continue
    if (node === target) return Math.min(match.start + targetOffset, match.end)
    cursor = match.end
  }
  return null
}

function normalizeToTextPoint(container: Node, offset: number): [Text, number] | null {
  if (container instanceof Text) {
    return [container, Math.min(offset, container.data.length)]
  }
  const child = container.childNodes[Math.min(offset, container.childNodes.length - 1)]
  if (!child) return null
  const walker = document.createTreeWalker(child, NodeFilter.SHOW_TEXT)
  const text = child instanceof Text ? child : walker.nextNode()
  return text instanceof Text ? [text, 0] : null
}

function findTextFrom(
  markdown: string,
  value: string,
  from: number,
  to: number,
): { start: number; end: number } | null {
  const exact = markdown.indexOf(value, from)
  if (exact >= from && exact + value.length <= to) return { start: exact, end: exact + value.length }
  const tokens = value.trim().split(/\s+/u).filter(Boolean)
  if (tokens.length === 0) return null
  const match = new RegExp(tokens.map(escapeRegExp).join('\\s+'), 'u').exec(markdown.slice(from, to))
  if (!match?.[0]) return null
  return { start: from + match.index, end: from + match.index + match[0].length }
}

function snapshot(markdown: string, start: number, end: number): TextSelectionSnapshot {
  return {
    prefix: markdown.slice(0, start),
    selectedText: markdown.slice(start, end),
    suffix: markdown.slice(end),
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
