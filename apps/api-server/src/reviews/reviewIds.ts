export type RawReviewItem = Readonly<Record<string, unknown>>

const TITLE_PREFIXES = [
  'missing page',
  'missing-page',
  'missingpage',
  'duplicate page',
  'duplicate-page',
  'duplicatepage',
  'possible duplicate',
  'possible-duplicate',
  'possibleduplicate',
  '缺失页面',
  '缺少页面',
  '重复页面',
  '疑似重复',
] as const

const FNV_OFFSET_BASIS = 0x811c9dc5
const FNV_PRIME = 0x01000193

export const normalizeReviewTitle = (title: string): string => {
  const trimmed = title.trimStart()
  const lower = trimmed.toLowerCase()
  let rest = trimmed
  for (const prefix of TITLE_PREFIXES) {
    if (!lower.startsWith(prefix)) continue
    const suffix = trimmed.slice(prefix.length)
    // Stryker disable next-line ConditionalExpression: an empty suffix yields a delimiter of '' which matches neither colon, so the loop continues either way.
    if (suffix.length === 0) continue
    const delimiter = suffix.charAt(0)
    if (delimiter === ':' || delimiter === '：') {
      // Stryker disable next-line MethodExpression: the following split/filter/join collapses leading whitespace anyway.
      rest = suffix.slice(1).trimStart()
      break
    }
  }
  // Stryker disable Regex: single-character splits only add empty strings, which the filter drops.
  return rest
    .split(/\s+/)
    .filter((word) => word !== '')
    .join(' ')
    .toLowerCase()
}

export const reviewIdFor = (itemType: string, title: string): string => {
  const key = `${itemType}::${normalizeReviewTitle(title)}`
  let hash = FNV_OFFSET_BASIS
  for (let index = 0; index < key.length; index += 1) {
    hash = Math.imul(hash ^ key.charCodeAt(index), FNV_PRIME)
  }
  return `review-${(hash >>> 0).toString(16).padStart(8, '0')}`
}

export const stableReviewId = (item: RawReviewItem): string | undefined => {
  const itemType = item['type']
  const title = item['title']
  if (typeof itemType !== 'string' || typeof title !== 'string') return undefined
  return reviewIdFor(itemType, title)
}
