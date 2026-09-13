/**
 * CORS origin policy, ported from the retired Rust HTTP server
 * (`apps/desktop/src-tauri/src/cors.rs`).
 *
 * There is no `*` wildcard: the prefix/exact lists below are the whole
 * allow-list and are matched case-sensitively against the request `Origin`.
 * A request without an `Origin` header never receives reflection headers.
 */
import { Option } from 'effect'

export const CORS_ALLOW_METHODS = 'GET, POST, PATCH, OPTIONS'

export const CORS_ALLOW_HEADERS = 'Content-Type, Authorization, X-LLM-Wiki-Token'

const EXTENSION_ORIGIN_PREFIXES: ReadonlyArray<string> = [
  'chrome-extension://',
  'moz-extension://',
]

const LOOPBACK_ORIGINS: ReadonlyArray<string> = [
  'http://localhost',
  'http://127.0.0.1',
  'http://[::1]',
]

const LOOPBACK_ORIGIN_PREFIXES: ReadonlyArray<string> = [
  'http://localhost:',
  'http://127.0.0.1:',
  'http://[::1]:',
]

const TAURI_ORIGINS: ReadonlyArray<string> = [
  'tauri://localhost',
  'http://tauri.localhost',
  'https://tauri.localhost',
]

export const isAllowedBrowserOrigin = (origin: string): boolean =>
  EXTENSION_ORIGIN_PREFIXES.some((prefix) => origin.startsWith(prefix)) ||
  LOOPBACK_ORIGINS.includes(origin) ||
  LOOPBACK_ORIGIN_PREFIXES.some((prefix) => origin.startsWith(prefix)) ||
  TAURI_ORIGINS.includes(origin)

export type CorsDecision =
  | { readonly _tag: 'Allow'; readonly origin: string }
  | { readonly _tag: 'Reject' }

export const decideCorsOrigin = (origin: Option.Option<string>): CorsDecision =>
  Option.match(origin, {
    onNone: (): CorsDecision => ({ _tag: 'Reject' }),
    onSome: (value): CorsDecision =>
      isAllowedBrowserOrigin(value) ? { _tag: 'Allow', origin: value } : { _tag: 'Reject' },
  })

export interface CorsHeadersInput {
  readonly origin: Option.Option<string>
  readonly allowHeaders: string
}

export const corsHeaders = (
  input: CorsHeadersInput,
): ReadonlyArray<readonly [string, string]> => {
  const headers: Array<readonly [string, string]> = [
    ['Access-Control-Allow-Methods', CORS_ALLOW_METHODS],
    ['Access-Control-Allow-Headers', input.allowHeaders],
    ['Content-Type', 'application/json'],
  ]
  const decision = decideCorsOrigin(input.origin)
  if (decision._tag === 'Allow') {
    headers.push(
      ['Access-Control-Allow-Origin', decision.origin],
      ['Vary', 'Origin'],
      ['Access-Control-Allow-Private-Network', 'true'],
    )
  }
  return headers
}
