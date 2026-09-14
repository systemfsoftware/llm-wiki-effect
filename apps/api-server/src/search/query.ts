/**
 * Query parsing for the hybrid search service.
 *
 * Ported from `tokenize_query` / `is_query_separator` / `is_stop_word` in
 * apps/desktop/src-tauri/src/commands/search.rs. Tokens are lowercased, split
 * on ASCII + CJK punctuation and whitespace, dropped when shorter than two
 * code points or when they are stop words, and CJK tokens longer than two code
 * points additionally expand into bigrams plus their individual characters
 * before deduplication. The final set is ordered by Unicode code point, which
 * is the order a Rust `BTreeSet<String>` yields (UTF-8 byte order equals code
 * point order for valid UTF-8).
 */

const isAsciiPunctuation = (codePoint: number): boolean =>
  (codePoint >= 0x21 && codePoint <= 0x2f) ||
  (codePoint >= 0x3a && codePoint <= 0x40) ||
  (codePoint >= 0x5b && codePoint <= 0x60) ||
  (codePoint >= 0x7b && codePoint <= 0x7e)

// Stryker disable next-line Regex
const WHITESPACE = /[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/u

const CJK_SEPARATORS: Record<string, true> = {
  '，': true,
  '。': true,
  '！': true,
  '？': true,
  '、': true,
  '；': true,
  '：': true,
  '“': true,
  '”': true,
  '‘': true,
  '’': true,
  '（': true,
  '）': true,
  '·': true,
  '～': true,
  '…': true,
}

export const isQuerySeparator = (char: string): boolean => {
  const codePoint = char.codePointAt(0) ?? 0
  return WHITESPACE.test(char) || isAsciiPunctuation(codePoint) || CJK_SEPARATORS[char] === true
}

// Stryker disable BooleanLiteral
const STOP_WORDS: Record<string, true> = {
  '的': true,
  '是': true,
  '了': true,
  '什么': true,
  '在': true,
  '有': true,
  '和': true,
  '与': true,
  '对': true,
  '从': true,
  the: true,
  is: true,
  a: true,
  an: true,
  what: true,
  how: true,
  are: true,
  was: true,
  were: true,
  do: true,
  does: true,
  did: true,
  be: true,
  been: true,
  being: true,
  have: true,
  has: true,
  had: true,
  it: true,
  its: true,
  in: true,
  on: true,
  at: true,
  to: true,
  for: true,
  of: true,
  with: true,
  by: true,
  this: true,
  that: true,
  these: true,
  those: true,
}

// Stryker restore BooleanLiteral

export const isStopWord = (token: string): boolean => Object.hasOwn(STOP_WORDS, token)

export const compareCodePoints = (left: string, right: string): number => {
  const leftChars = Array.from(left)
  const rightChars = Array.from(right)
  // Stryker disable next-line MethodExpression
  const shared = Math.min(leftChars.length, rightChars.length)
  // Stryker disable next-line EqualityOperator
  for (let index = 0; index < shared; index += 1) {
    const leftChar = leftChars[index]
    const rightChar = rightChars[index]
    // Stryker disable next-line OptionalChaining
    const leftCode = leftChar?.codePointAt(0) ?? 0
    // Stryker disable next-line OptionalChaining
    const rightCode = rightChar?.codePointAt(0) ?? 0
    // Stryker disable next-line EqualityOperator
    if (leftCode !== rightCode) return leftCode < rightCode ? -1 : 1
  }
  return leftChars.length - rightChars.length
}

const splitOnSeparators = (text: string): Array<string> => {
  const out: Array<string> = []
  let current = ''
  for (const char of text) {
    if (isQuerySeparator(char)) {
      // Stryker disable next-line ConditionalExpression,StringLiteral: tokenizeQuery drops every token shorter than two code points, so pushing the empty run is unobservable
      if (current !== '') out.push(current)
      current = ''
    } else {
      current += char
    }
  }
  // Stryker disable next-line ConditionalExpression,StringLiteral: the trailing empty run never reaches the token set, which drops tokens shorter than two code points
  if (current !== '') out.push(current)
  return out
}

const hasCjk = (token: string): boolean =>
  Array.from(token).some((char) => {
    const codePoint = char.codePointAt(0) ?? 0
    return codePoint >= 0x3400 && codePoint <= 0x9fff
  })

const expandCjk = (token: string, out: Array<string>): void => {
  const chars = Array.from(token)
  // Stryker disable next-line EqualityOperator,ArithmeticOperator: a one-off loop bound only adds iterations whose pair is rejected by the guard below
  for (let index = 0; index + 1 < chars.length; index += 1) {
    const current = chars[index]
    const next = chars[index + 1]
    // Stryker disable next-line ConditionalExpression,LogicalOperator: inside the loop bound both characters are always defined, so every guard form admits the pair
    if (current !== undefined && next !== undefined) out.push(`${current}${next}`)
  }
  for (const char of chars) {
    if (!isStopWord(char)) out.push(char)
  }
  out.push(token)
}

export const tokenizeQuery = (query: string): ReadonlyArray<string> => {
  const base = splitOnSeparators(query.toLowerCase())
    .filter((token) => Array.from(token).length > 1)
    .filter((token) => !isStopWord(token))

  const expanded: Array<string> = []
  for (const token of base) {
    if (hasCjk(token) && Array.from(token).length > 2) expandCjk(token, expanded)
    else expanded.push(token)
  }

  return [...new Set(expanded)].sort(compareCodePoints)
}
