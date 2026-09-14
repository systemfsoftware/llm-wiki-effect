import { Schema } from 'effect'

export class FileNode extends Schema.Class<FileNode>('FileNode')({
  name: Schema.String,
  path: Schema.String,
  isDir: Schema.Boolean,
  size: Schema.NullOr(Schema.Number),
  children: Schema.NullOr(Schema.Array(Schema.suspend((): Schema.Codec<FileNode> => FileNode))),
}) {}

export class FilesResponse extends Schema.Class<FilesResponse>('FilesResponse')({
  projectId: Schema.String,
  root: Schema.String,
  files: Schema.Array(FileNode),
  truncated: Schema.Boolean,
}) {}

export class FileContentResponse extends Schema.Class<FileContentResponse>('FileContentResponse')({
  projectId: Schema.String,
  path: Schema.String,
  content: Schema.String,
}) {}
