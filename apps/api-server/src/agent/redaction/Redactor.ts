import { Context, Layer } from 'effect'
import { Domain } from 'llm-wiki-protocol'
import { redactEvent } from './redact.js'

export interface RedactorShape {
  readonly redact: (event: Domain.AgentEvent) => Domain.AgentEvent
}

export class Redactor extends Context.Service<Redactor, RedactorShape>()(
  'llm-wiki-api-server/agent/Redactor',
) {
  static readonly layer: Layer.Layer<Redactor> = Layer.succeed(Redactor, { redact: redactEvent })
}
