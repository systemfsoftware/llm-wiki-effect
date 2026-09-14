import { Schema } from 'effect'

export class Project extends Schema.Class<Project>('Project')({
  id: Schema.String,
  name: Schema.String,
  path: Schema.String,
  current: Schema.Boolean,
}) {}

export class ProjectsResponse extends Schema.Class<ProjectsResponse>('ProjectsResponse')({
  projects: Schema.Array(Project),
  currentProject: Schema.NullOr(Project),
}) {}
