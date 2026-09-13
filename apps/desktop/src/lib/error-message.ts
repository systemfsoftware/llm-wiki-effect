/**
 * The message a user or a log line should carry for a thrown value.
 *
 * `String(error)` prints `[object Object]` for the object shapes that reach
 * catch blocks in this app, and `JSON.stringify` throws on a circular one.
 */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error) ?? 'Unknown error'
  } catch {
    return 'Unknown error'
  }
}
