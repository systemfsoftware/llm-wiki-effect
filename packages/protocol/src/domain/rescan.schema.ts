import { Schema } from 'effect'

export const FileChangeKind = Schema.Literals(['created', 'modified', 'deleted'])
export const FileChangeStatus = Schema.Literals([
  'pending',
  'processing',
  'done',
  'failed',
  'superseded',
])

export type FileChangeKind = Schema.Schema.Type<typeof FileChangeKind>
export type FileChangeStatus = Schema.Schema.Type<typeof FileChangeStatus>

export class FileChangeTask extends Schema.Class<FileChangeTask>('FileChangeTask')({
  id: Schema.String,
  projectId: Schema.String,
  path: Schema.String,
  kind: FileChangeKind,
  status: FileChangeStatus,
  hashBefore: Schema.NullOr(Schema.String),
  hashAfter: Schema.NullOr(Schema.String),
  size: Schema.NullOr(Schema.Number),
  mtimeMs: Schema.NullOr(Schema.Number),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
  retryCount: Schema.Number,
  error: Schema.NullOr(Schema.String),
  needsRerun: Schema.Boolean,
}) {}

export class FileChangeQueue extends Schema.Class<FileChangeQueue>('FileChangeQueue')({
  version: Schema.Number,
  tasks: Schema.Array(FileChangeTask),
}) {}

export class RescanResult extends Schema.Class<RescanResult>('RescanResult')({
  queue: FileChangeQueue,
  changedTasks: Schema.Array(FileChangeTask),
}) {}

export class RescanSourcesResponse extends Schema.Class<RescanSourcesResponse>(
  'RescanSourcesResponse',
)({
  projectId: Schema.String,
  result: RescanResult,
}) {}

export class FileChangeQueueResponse extends Schema.Class<FileChangeQueueResponse>(
  'FileChangeQueueResponse',
)({
  projectId: Schema.String,
  queue: FileChangeQueue,
}) {}
