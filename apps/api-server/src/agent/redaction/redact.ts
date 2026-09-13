/**
 * Ported from `AgentEvent::redact_for_external_api` in
 * apps/desktop/src-tauri/src/agent/events.rs. Rollback snapshots are needed by
 * the trusted desktop UI for immediate Undo but are not part of the public
 * agent event contract, so the only internal field is dropped before an event
 * crosses an untrusted egress (KTD12). The input event is never mutated, so the
 * desktop relay can keep consuming the pre-redaction event.
 */
import { Domain } from 'llm-wiki-protocol'

export const redactEvent = (event: Domain.AgentEvent): Domain.AgentEvent =>
  event.type === 'fileChanged' && event.previousContent !== undefined
    ? new Domain.AgentFileChangedEvent({
      type: 'fileChanged',
      path: event.path,
      tool: event.tool,
      existedBefore: event.existedBefore,
    })
    : event
