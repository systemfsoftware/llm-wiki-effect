import { Schema } from 'effect'

export class HealthAgent extends Schema.Class<HealthAgent>('HealthAgent')({
  chat: Schema.Boolean,
  streaming: Schema.Boolean,
  streamProtocol: Schema.String,
}) {}

export class Health extends Schema.Class<Health>('Health')({
  ok: Schema.Boolean,
  status: Schema.String,
  version: Schema.String,
  authRequired: Schema.Boolean,
  authConfigured: Schema.Boolean,
  tokenSource: Schema.String,
  enabled: Schema.Boolean,
  mcpEnabled: Schema.Boolean,
  allowUnauthenticated: Schema.Boolean,
  allowLanAccess: Schema.Boolean,
  agent: HealthAgent,
}) {}
