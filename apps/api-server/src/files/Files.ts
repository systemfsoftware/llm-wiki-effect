/**
 * Public file listing and text serving for a project root.
 *
 * Ported from `handle_files` / `handle_file_content` / `safe_join` /
 * `list_tree` in apps/desktop/src-tauri/src/api_server.rs: hidden entries and
 * symlinks are skipped, directories sort first, the listing is capped, and a
 * resolved path must stay inside the project even through a symlink.
 */
import { Context, Effect, Layer, Result } from 'effect'
import { Domain, Errors } from 'llm-wiki-protocol'
import type { Dirent, Stats } from 'node:fs'
import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises'
import { basename, dirname, join, relative, sep } from 'node:path'
import { hasErrorCode } from '../json.js'
import {
  clampMaxFiles,
  guardRelativePath,
  isPublicProjectRel,
  isTextContentRel,
  isWithinRoot,
  MAX_FILE_CONTENT_BYTES,
  PUBLIC_ROOTS,
  resolveRootSelector,
} from './paths.js'

export interface ListOptions {
  readonly recursive?: boolean
  readonly maxFiles?: number
}

export interface FileContent {
  readonly path: string
  readonly content: string
}

export type ListError =
  | Errors.InvalidRequest
  | Errors.PathViolation
  | Errors.TooLarge
  | Errors.NotFound

export type ReadError = ListError | Errors.UnsupportedMediaType

export interface FilesShape {
  readonly list: (
    root: string,
    rel?: string,
    options?: ListOptions,
  ) => Effect.Effect<ReadonlyArray<Domain.FileNode>, ListError>
  readonly readContent: (
    root: string,
    rel: string,
  ) => Effect.Effect<FileContent, ReadError>
}

interface WalkState {
  count: number
}

const listFailure = (error: unknown): ListError =>
  error instanceof Errors.InvalidRequest ||
    error instanceof Errors.PathViolation ||
    error instanceof Errors.TooLarge ||
    error instanceof Errors.NotFound
    ? error
    : new Errors.InvalidRequest({ message: `Filesystem failure: ${String(error)}` })

const readFailure = (error: unknown): ReadError =>
  error instanceof Errors.UnsupportedMediaType ? error : listFailure(error)

const fromFsList = <A>(run: () => Promise<A>): Effect.Effect<A, ListError> =>
  Effect.tryPromise({ try: run, catch: listFailure })

const fromFsRead = <A>(run: () => Promise<A>): Effect.Effect<A, ReadError> =>
  Effect.tryPromise({ try: run, catch: readFailure })

const relativeToProject = (root: string, path: string): string => relative(root, path).split(sep).join('/')

const compareNodes = (left: Domain.FileNode, right: Domain.FileNode): number => {
  if (left.isDir !== right.isDir) return left.isDir ? -1 : 1
  if (left.name === right.name) return 0
  return left.name < right.name ? -1 : 1
}

const readDirectory = async (dir: string): Promise<ReadonlyArray<Dirent>> => {
  try {
    return await readdir(dir, { withFileTypes: true })
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      throw new Errors.NotFound({ message: `Directory not found: ${dir}` })
    }
    throw new Errors.InvalidRequest({ message: `Failed to list directory: ${String(error)}` })
  }
}

const pushFileNode = async (
  root: string,
  path: string,
  entry: Dirent | Stats,
  recursive: boolean,
  maxFiles: number,
  state: WalkState,
  out: Array<Domain.FileNode>,
): Promise<void> => {
  const name = basename(path)
  if (name.startsWith('.')) return
  if (entry.isSymbolicLink()) return
  state.count += 1
  if (state.count > maxFiles) {
    throw new Errors.TooLarge({ message: `File listing exceeds maxFiles limit (${maxFiles})` })
  }
  const isDir = entry.isDirectory()
  const children = recursive && isDir
    ? await listTree(root, path, recursive, maxFiles, state)
    : null
  out.push(
    new Domain.FileNode({
      name,
      path: relativeToProject(root, path),
      isDir,
      size: isDir ? null : (await lstat(path)).size,
      children,
    }),
  )
}

const listTree = async (
  root: string,
  dir: string,
  recursive: boolean,
  maxFiles: number,
  state: WalkState,
): Promise<Array<Domain.FileNode>> => {
  const entries = await readDirectory(dir)
  const out: Array<Domain.FileNode> = []
  for (const entry of entries) {
    await pushFileNode(root, join(dir, entry.name), entry, recursive, maxFiles, state, out)
  }
  return out.sort(compareNodes)
}

const canonicalRoot = async (root: string): Promise<string> => {
  try {
    return await realpath(root)
  } catch (error) {
    throw new Errors.InvalidRequest({
      message: `Failed to resolve project path: ${String(error)}`,
    })
  }
}

const realpathOrNull = async (path: string): Promise<string | null> => {
  try {
    return await realpath(path)
  } catch {
    return null
  }
}

const containedPath = async (rootReal: string, target: string): Promise<string> => {
  const resolved = await realpathOrNull(target)
  if (resolved !== null) {
    if (!isWithinRoot(rootReal, resolved)) {
      throw new Errors.PathViolation({ message: 'Resolved path escapes the project directory' })
    }
    return resolved
  }
  const parentReal = await realpathOrNull(dirname(target))
  if (parentReal !== null && !isWithinRoot(rootReal, parentReal)) {
    throw new Errors.PathViolation({
      message: 'Resolved parent escapes the project directory',
    })
  }
  return target
}

const decodeUtf8 = (buffer: Uint8Array): string => {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    throw new Errors.UnsupportedMediaType({ message: 'File is not valid UTF-8 text' })
  }
}

const listPublicRoots = async (
  root: string,
  recursive: boolean,
  maxFiles: number,
): Promise<Array<Domain.FileNode>> => {
  const state: WalkState = { count: 0 }
  const out: Array<Domain.FileNode> = []
  for (const publicRoot of PUBLIC_ROOTS) {
    const path = join(root, publicRoot)
    const info = await lstat(path).catch(() => null)
    if (info === null) continue
    await pushFileNode(root, path, info, recursive, maxFiles, state, out)
  }
  return out
}

const readGuardedContent = async (
  root: string,
  rel: string,
  requestedRel: string,
): Promise<FileContent> => {
  const rootReal = await canonicalRoot(root)
  const resolved = await containedPath(rootReal, join(root, rel))
  let info: Stats
  try {
    info = await stat(resolved)
  } catch {
    throw new Errors.NotFound({ message: `File not found: ${requestedRel}` })
  }
  if (!info.isFile()) {
    throw new Errors.NotFound({ message: `File not found: ${requestedRel}` })
  }
  if (info.size > MAX_FILE_CONTENT_BYTES) {
    throw new Errors.TooLarge({ message: 'File is too large to return via API' })
  }
  const content = decodeUtf8(await readFile(resolved))
  return { path: requestedRel, content }
}

export const makeFiles = (): FilesShape => ({
  list: (root, rel, options) =>
    Effect.gen(function*() {
      const selector = resolveRootSelector(rel)
      if (Result.isFailure(selector)) return yield* Effect.fail(selector.failure)
      const recursive = options?.recursive ?? true
      const maxFiles = clampMaxFiles(options?.maxFiles)
      return yield* fromFsList(() =>
        selector.success === ''
          ? listPublicRoots(root, recursive, maxFiles)
          : listTree(root, join(root, selector.success), recursive, maxFiles, { count: 0 })
      )
    }),
  readContent: (root, rel) =>
    Effect.gen(function*() {
      if (!isPublicProjectRel(rel)) {
        return yield* Effect.fail(
          new Errors.PathViolation({ message: 'Path is not exposed by the local API' }),
        )
      }
      if (!isTextContentRel(rel)) {
        return yield* Effect.fail(
          new Errors.UnsupportedMediaType({
            message: 'Only text-like project files can be read via this endpoint',
          }),
        )
      }
      const guarded = guardRelativePath(rel)
      if (Result.isFailure(guarded)) return yield* Effect.fail(guarded.failure)
      return yield* fromFsRead(() => readGuardedContent(root, guarded.success, rel))
    }),
})

export class Files extends Context.Service<Files, FilesShape>()('llm-wiki-api-server/Files') {
  static readonly layer: Layer.Layer<Files> = Layer.succeed(Files, makeFiles())
}
