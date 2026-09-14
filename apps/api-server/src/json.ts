export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export const asString = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined

export const nonEmptyString = (value: unknown): string | undefined => {
  const text = asString(value)
  if (text === undefined) return undefined
  const trimmed = text.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

export const boolOr = (value: unknown, fallback: boolean): boolean => typeof value === 'boolean' ? value : fallback

export const positiveInteger = (value: unknown): number | undefined => {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim().length > 0
    ? Number(value)
    : Number.NaN
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}

export const hasErrorCode = (error: unknown, code: string): boolean => isRecord(error) && error['code'] === code
