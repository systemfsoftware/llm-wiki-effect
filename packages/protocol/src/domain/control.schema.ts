import { Schema } from 'effect'
import { Project } from './project.schema.js'

export class SetCurrentProjectResponse extends Schema.Class<SetCurrentProjectResponse>(
  'SetCurrentProjectResponse',
)({
  project: Project,
}) {}

export class ReloadConfigResponse extends Schema.Class<ReloadConfigResponse>('ReloadConfigResponse')({
  reloaded: Schema.Boolean,
}) {}
