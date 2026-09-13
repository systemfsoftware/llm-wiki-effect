import { Errors } from 'llm-wiki-protocol'

export const agentError = (message: string): Errors.AgentError => new Errors.AgentError({ message })

const MAX_ERROR_BODY_CHARS = 800

export const trimErrorBody = (text: string): string => {
  const characters = Array.from(text.trim())
  return characters.length <= MAX_ERROR_BODY_CHARS
    ? characters.join('')
    : `${characters.slice(0, MAX_ERROR_BODY_CHARS).join('')}...`
}

export const errorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message
  }
  if (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof error.message === 'string'
  ) {
    return error.message
  }
  return String(error)
}
