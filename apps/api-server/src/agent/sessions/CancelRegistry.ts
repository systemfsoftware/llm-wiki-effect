/**
 * Run cancellation registry for agent turns.
 *
 * Ported from `AgentCancellationRegistry` / `AgentCancellationToken` in
 * apps/desktop/src-tauri/src/agent/cancel.rs: entries are keyed
 * (project, session, run), `finish` removes an entry when a run completes, and
 * a token whose run was cancelled fails the run's next step with the typed
 * `ChatCancelled` error. Shared by every caller (UI relay, HTTP, MCP) so all
 * consumers observe the same cancellation semantics.
 */
import { Context, Effect, Layer } from 'effect'
import { Errors } from 'llm-wiki-protocol'

export interface CancelToken {
  readonly isCancelled: () => boolean
  readonly check: () => Effect.Effect<void, Errors.ChatCancelled>
}

export interface CancelRegistryShape {
  readonly start: (projectId: string, sessionId: string, runId: string) => CancelToken
  readonly cancel: (projectId: string, sessionId: string, runId?: string) => boolean
  readonly finish: (projectId: string, sessionId: string, runId: string) => void
}

interface CancelEntry {
  cancelled: boolean
}

const normalizeKey = (value: string): string => value.replaceAll('\\', '_').replaceAll('/', '_')

export const cancelKey = (projectId: string, sessionId: string, runId: string): string =>
  `${normalizeKey(projectId)}::${normalizeKey(sessionId)}::${normalizeKey(runId)}`

const findRunKey = (
  entries: Map<string, CancelEntry>,
  projectId: string,
  sessionId: string,
): string | undefined => {
  const prefix = `${normalizeKey(projectId)}::${normalizeKey(sessionId)}::`
  for (const key of entries.keys()) {
    if (key.startsWith(prefix)) return key
  }
  return undefined
}

export const makeCancelRegistry = (): CancelRegistryShape => {
  const entries = new Map<string, CancelEntry>()

  const tokenFor = (entry: CancelEntry): CancelToken => ({
    isCancelled: () => entry.cancelled,
    check: () =>
      entry.cancelled
        ? Effect.fail(new Errors.ChatCancelled({ message: 'Agent turn cancelled' }))
        : Effect.void,
  })

  return {
    start: (projectId, sessionId, runId) => {
      const entry: CancelEntry = { cancelled: false }
      entries.set(cancelKey(projectId, sessionId, runId), entry)
      return tokenFor(entry)
    },
    cancel: (projectId, sessionId, runId) => {
      const key = runId === undefined
        ? findRunKey(entries, projectId, sessionId)
        : cancelKey(projectId, sessionId, runId)
      const entry = key === undefined ? undefined : entries.get(key)
      if (entry === undefined) return false
      entry.cancelled = true
      return true
    },
    finish: (projectId, sessionId, runId) => {
      entries.delete(cancelKey(projectId, sessionId, runId))
    },
  }
}

export class CancelRegistry extends Context.Service<CancelRegistry, CancelRegistryShape>()(
  'llm-wiki-api-server/agent/CancelRegistry',
) {
  static readonly make: Effect.Effect<CancelRegistryShape> = Effect.sync(makeCancelRegistry)

  static readonly layer: Layer.Layer<CancelRegistry> = Layer.effect(
    CancelRegistry,
    CancelRegistry.make,
  )
}
