/**
 * The auth requirement matrix and header parsing, ported from
 * `is_token_required_request` / `is_token_authorized` in the retired Rust HTTP
 * server and from the protocol catalog's MCP mapping.
 */
import { Catalog } from 'llm-wiki-protocol'
import type { Api } from 'llm-wiki-protocol'
import { constantTimeEqualStrings } from './constant-time.js'

export type ApiOperationName = Api.ApiOperationName

const TOKEN_REQUIRED_OPERATIONS: Partial<Record<ApiOperationName, true>> = {
  chat: true,
  chatStream: true,
  chatCancel: true,
  embedPage: true,
}

export const isAlwaysTokenOperation = (operation: ApiOperationName): boolean =>
  TOKEN_REQUIRED_OPERATIONS[operation] === true

export const requiresToken = (
  operation: ApiOperationName,
  allowUnauthenticated: boolean,
): boolean => !allowUnauthenticated || isAlwaysTokenOperation(operation)

export const isMcpMappedOperation = (operation: ApiOperationName): boolean =>
  Catalog.McpMappedOperations.includes(operation)

export const isMcpGatedOperation = (operation: ApiOperationName): boolean =>
  operation !== 'health' && isMcpMappedOperation(operation)

export const tokenMatches = (configured: string, provided: ReadonlyArray<string>): boolean =>
  provided.some((candidate) => constantTimeEqualStrings(candidate, configured))

export const providedTokens = (
  lowercasedHeaders: Readonly<Record<string, string>>,
): ReadonlyArray<string> => {
  const tokens: Array<string> = []
  const direct = lowercasedHeaders['x-llm-wiki-token']
  if (direct !== undefined) {
    tokens.push(direct)
  }
  const authorization = lowercasedHeaders['authorization']
  if (authorization !== undefined && authorization.startsWith('Bearer ')) {
    tokens.push(authorization.slice('Bearer '.length))
  }
  return tokens
}
