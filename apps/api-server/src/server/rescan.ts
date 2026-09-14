/**
 * Source rescan for the `rescanSources` RPC, ported from the rescan path of
 * apps/desktop/src-tauri/src/commands/file_sync.rs.
 *
 * The ingest pass, the `notify` watcher, and the `file-sync://*` app events
 * stay with the desktop relay: this module detects changes, appends them to
 * `.llm-wiki/file-change-queue.json`, and advances `.llm-wiki/file-snapshot.json`.
 */
import { Context, Effect, Layer } from 'effect'
import { Domain, Errors } from 'llm-wiki-protocol'
import { createHash } from 'node:crypto'
import type { Stats } from 'node:fs'
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { hasErrorCode, isRecord } from '../json.js'
import { ProjectRegistry } from '../projects/Registry.js'

const SYNC_DIR = '.llm-wiki'
const SNAPSHOT_FILE = 'file-snapshot.json'
const QUEUE_FILE = 'file-change-queue.json'
const MAX_HASH_BYTES = 32 * 1024 * 1024
const MAX_RETRY_COUNT = 3

export interface SourceWatchConfig {
  readonly enabled: boolean
  readonly autoIngest: boolean
  readonly includeExtensions: ReadonlyArray<string>
  readonly excludeExtensions: ReadonlyArray<string>
  readonly excludeDirs: ReadonlyArray<string>
  readonly excludeGlobs: ReadonlyArray<string>
  readonly maxFileSizeMb: number
}

export const SOURCE_WATCH_DEFAULTS: SourceWatchConfig = {
  enabled: true,
  autoIngest: true,
  includeExtensions: [
    'md',
    'mdx',
    'txt',
    'org',
    'pdf',
    'doc',
    'docx',
    'docm',
    'ppt',
    'pps',
    'pot',
    'pptx',
    'pptm',
    'ppsx',
    'ppsm',
    'xls',
    'xlsx',
    'xlsm',
    'xlsb',
    'odt',
    'odp',
    'ods',
    'rtf',
    'html',
    'htm',
    'csv',
  ],
  excludeExtensions: [
    'tmp',
    'temp',
    'bak',
    'swp',
    'part',
    'partial',
    'crdownload',
    'exe',
    'dll',
    'so',
    'dylib',
    'bin',
    'iso',
    'dmg',
  ],
  excludeDirs: [
    '.git',
    '.svn',
    '.hg',
    '.obsidian',
    '.idea',
    '.vscode',
    'node_modules',
    '.cache',
    '__pycache__',
  ],
  excludeGlobs: ['~$*', '.~lock.*#', '*.draft.*', 'draft-*', '*.private.*'],
  maxFileSizeMb: 100,
}

interface FileMeta {
  readonly hash: string | null
  readonly size: number
  readonly mtimeMs: number
}

interface FileSnapshot {
  readonly version: number
  readonly updatedAt: number
  readonly files: Readonly<Record<string, FileMeta>>
}

interface FileChangeQueue {
  readonly version: number
  readonly tasks: ReadonlyArray<Domain.FileChangeTask>
}

const normalizeExtList = (values: ReadonlyArray<string>): ReadonlyArray<string> =>
  [...new Set(values.map((value) => value.trim().replace(/^\.+/, '').toLowerCase()))]
    .filter((value) => value !== '')
    .sort()

const normalizeStringList = (values: ReadonlyArray<string>): ReadonlyArray<string> =>
  [...new Set(values.map((value) => value.trim()).filter((value) => value !== ''))].sort()

export const normalizeSourceWatchConfig = (
  config?: Partial<SourceWatchConfig>,
): SourceWatchConfig => {
  const base = { ...SOURCE_WATCH_DEFAULTS, ...(config ?? {}) }
  return {
    enabled: base.enabled,
    autoIngest: base.autoIngest,
    includeExtensions: normalizeExtList(base.includeExtensions),
    excludeExtensions: normalizeExtList(base.excludeExtensions),
    excludeDirs: normalizeStringList(base.excludeDirs),
    excludeGlobs: normalizeStringList(base.excludeGlobs),
    maxFileSizeMb: Math.min(Math.max(Math.trunc(base.maxFileSizeMb), 1), 4_096),
  }
}

const normalizeRelString = (value: string): string => value.replaceAll('\\', '/').replace(/^\/+|\/+$/g, '')

const extensionOf = (name: string): string => {
  const dot = name.lastIndexOf('.')
  return dot === -1 ? '' : name.slice(dot + 1)
}

export const matchesExcludedDir = (relLower: string, excluded: ReadonlyArray<string>): boolean =>
  excluded.some((rawDir) => {
    const dir = normalizeRelString(rawDir).toLowerCase()
    if (dir === '') return false
    return dir.includes('/')
      ? relLower === dir || relLower.startsWith(`${dir}/`) || relLower.includes(`/${dir}/`)
      : relLower.split('/').some((part) => part === dir)
  })

export const wildcardMatch = (pattern: string, value: string): boolean => {
  const p = Array.from(pattern.toLowerCase())
  const v = Array.from(value.toLowerCase())
  let pi = 0
  let vi = 0
  let star: number | undefined
  let afterStar = 0
  while (vi < v.length) {
    if (pi < p.length && (p[pi] === '?' || p[pi] === v[vi])) {
      pi += 1
      vi += 1
    } else if (pi < p.length && p[pi] === '*') {
      star = pi
      afterStar = vi
      pi += 1
    } else if (star !== undefined) {
      pi = star + 1
      afterStar += 1
      vi = afterStar
    } else {
      return false
    }
  }
  while (pi < p.length && p[pi] === '*') pi += 1
  return pi === p.length
}

export interface WatchRules {
  readonly includeExtensions: ReadonlyArray<string>
  readonly excludeExtensions: ReadonlyArray<string>
  readonly excludeDirs: ReadonlyArray<string>
  readonly excludeGlobs: ReadonlyArray<string>
  readonly maxFileSizeMb: number
}

export const watchRules = (config: SourceWatchConfig): WatchRules => ({
  includeExtensions: config.includeExtensions,
  excludeExtensions: config.excludeExtensions,
  excludeDirs: config.excludeDirs,
  excludeGlobs: config.excludeGlobs,
  maxFileSizeMb: config.maxFileSizeMb,
})

export const shouldWatchRel = (rel: string, rules: WatchRules): boolean => {
  if (rel === '') return false
  const lower = rel.toLowerCase()
  if (
    lower.includes('/.llm-wiki/') ||
    lower.startsWith('.llm-wiki/') ||
    lower.startsWith('wiki/media/') ||
    lower.endsWith('.ds_store')
  ) {
    return false
  }
  const name = lower.slice(lower.lastIndexOf('/') + 1)
  if (name === 'thumbs.db' || name === 'desktop.ini') return false
  if (matchesExcludedDir(lower, rules.excludeDirs)) return false
  if (rules.excludeGlobs.some((pattern) => wildcardMatch(pattern, rel) || wildcardMatch(pattern, name))) {
    return false
  }
  if (rel.startsWith('raw/sources/')) {
    const extension = extensionOf(name)
    if (extension !== '' && rules.excludeExtensions.includes(extension)) return false
    if (
      rules.includeExtensions.length > 0 &&
      (extension === '' || !rules.includeExtensions.includes(extension))
    ) {
      return false
    }
    return true
  }
  return rel === 'purpose.md' || rel === 'schema.md' || (rel.startsWith('wiki/') && rel.endsWith('.md'))
}

const isPrunableDir = (rel: string, name: string, rules: WatchRules): boolean =>
  name === SYNC_DIR || rel === 'wiki/media' || matchesExcludedDir(name.toLowerCase(), rules.excludeDirs)

export const mergeKind = (
  existing: Domain.FileChangeKind,
  incoming: Domain.FileChangeKind,
): Domain.FileChangeKind =>
  (existing === 'deleted' && incoming === 'created') ||
    (existing === 'created' && incoming === 'deleted') ||
    incoming === 'modified'
    ? 'modified'
    : incoming

const stablePathHash = (path: string): string => createHash('md5').update(path, 'utf8').digest('hex').slice(0, 12)

const md5File = async (path: string): Promise<string> => {
  const buffer = await readFile(path)
  return createHash('md5').update(buffer).digest('hex')
}

const statOrNull = async (path: string): Promise<Stats | null> => {
  try {
    return await stat(path)
  } catch {
    return null
  }
}

const walkedFileHash = async (path: string): Promise<string | null> => {
  try {
    return await md5File(path)
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return null
    throw error
  }
}

const readMeta = async (root: string, rel: string, walked?: Stats): Promise<FileMeta | null> => {
  const path = join(root, rel)
  const info = walked ?? (await statOrNull(path))
  if (info === null || !info.isFile()) return null
  if (info.size > MAX_HASH_BYTES) {
    return { hash: null, size: info.size, mtimeMs: Math.trunc(info.mtimeMs) }
  }
  const hash = walked === undefined ? await md5File(path) : await walkedFileHash(path)
  if (hash === null) return null
  return { hash, size: info.size, mtimeMs: Math.trunc(info.mtimeMs) }
}

const toRel = (root: string, path: string): string | undefined => {
  const rel = relative(root, path).split(sep).join('/')
  return rel === '' || rel.startsWith('..') ? undefined : rel
}

interface WatchedWalk {
  readonly rels: ReadonlyArray<string>
  readonly stats: ReadonlyMap<string, Stats>
}

const collectWatchedRels = async (
  root: string,
  rules: WatchRules,
): Promise<WatchedWalk> => {
  const out: Array<string> = []
  const stats = new Map<string, Stats>()
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const path = join(dir, entry.name)
      const rel = toRel(root, path)
      if (rel === undefined || entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (!isPrunableDir(rel, entry.name, rules)) await walk(path)
        continue
      }
      if (!entry.isFile() || !shouldWatchRel(rel, rules)) continue
      if (rel.startsWith('raw/sources/')) {
        const info = await stat(path)
        if (info.size > rules.maxFileSizeMb * 1024 * 1024) continue
        stats.set(rel, info)
      }
      out.push(rel)
    }
  }
  await walk(root)
  return { rels: out.sort(), stats }
}

const readJsonFile = async (path: string): Promise<unknown> => {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown
  } catch {
    return undefined
  }
}

const readSnapshot = async (root: string): Promise<FileSnapshot> => {
  const raw = await readJsonFile(join(root, SYNC_DIR, SNAPSHOT_FILE))
  const files = isRecord(raw) && isRecord(raw['files']) ? raw['files'] : {}
  const parsed: Record<string, FileMeta> = {}
  for (const [rel, value] of Object.entries(files)) {
    if (!isRecord(value)) continue
    parsed[rel] = {
      hash: typeof value['hash'] === 'string' ? value['hash'] : null,
      size: typeof value['size'] === 'number' ? value['size'] : 0,
      mtimeMs: typeof value['mtimeMs'] === 'number' ? value['mtimeMs'] : 0,
    }
  }
  return { version: 1, updatedAt: 0, files: parsed }
}

const decodeTask = (value: unknown): Domain.FileChangeTask | undefined => {
  if (!isRecord(value)) return undefined
  const id = value['id']
  const projectId = value['projectId']
  const path = value['path']
  const kind = value['kind']
  const status = value['status']
  if (typeof id !== 'string' || typeof projectId !== 'string' || typeof path !== 'string') {
    return undefined
  }
  if (kind !== 'created' && kind !== 'modified' && kind !== 'deleted') return undefined
  if (status !== 'pending' && status !== 'processing' && status !== 'done' && status !== 'failed') {
    return undefined
  }
  return new Domain.FileChangeTask({
    id,
    projectId,
    path,
    kind,
    status,
    hashBefore: typeof value['hashBefore'] === 'string' ? value['hashBefore'] : null,
    hashAfter: typeof value['hashAfter'] === 'string' ? value['hashAfter'] : null,
    size: typeof value['size'] === 'number' ? value['size'] : null,
    mtimeMs: typeof value['mtimeMs'] === 'number' ? value['mtimeMs'] : null,
    createdAt: typeof value['createdAt'] === 'number' ? value['createdAt'] : 0,
    updatedAt: typeof value['updatedAt'] === 'number' ? value['updatedAt'] : 0,
    retryCount: typeof value['retryCount'] === 'number' ? value['retryCount'] : 0,
    error: typeof value['error'] === 'string' ? value['error'] : null,
    needsRerun: value['needsRerun'] === true,
  })
}

const readQueue = async (root: string): Promise<FileChangeQueue> => {
  const raw = await readJsonFile(join(root, SYNC_DIR, QUEUE_FILE))
  const rawTasks = isRecord(raw) && Array.isArray(raw['tasks']) ? raw['tasks'] : []
  return {
    version: 1,
    tasks: rawTasks.flatMap((task) => {
      const decoded = decodeTask(task)
      return decoded === undefined ? [] : [decoded]
    }),
  }
}

const writeJson = async (path: string, value: unknown): Promise<void> => {
  await mkdir(join(path, '..'), { recursive: true })
  const temporary = `${path}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(temporary, path)
}

const writeSnapshot = (root: string, snapshot: FileSnapshot): Promise<void> =>
  writeJson(join(root, SYNC_DIR, SNAPSHOT_FILE), snapshot)

const writeQueue = (root: string, queue: FileChangeQueue): Promise<void> =>
  writeJson(join(root, SYNC_DIR, QUEUE_FILE), queue)

const fileExists = async (path: string): Promise<boolean> => {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

const sameMeta = (left: FileMeta | undefined, right: FileMeta | null): boolean =>
  left?.hash === right?.hash && left?.size === right?.size

const upsertTask = (
  tasks: Array<Domain.FileChangeTask>,
  projectId: string,
  rel: string,
  kind: Domain.FileChangeKind,
  old: FileMeta | undefined,
  next: FileMeta | null,
  now: number,
): Domain.FileChangeTask => {
  const existing = tasks.find(
    (task) =>
      task.projectId === projectId &&
      task.path === rel &&
      (task.status === 'pending' || task.status === 'processing' || task.status === 'failed'),
  )
  const size = next?.size ?? old?.size ?? null
  if (existing !== undefined) {
    const updated = new Domain.FileChangeTask({
      id: existing.id,
      projectId: existing.projectId,
      path: existing.path,
      hashBefore: existing.hashBefore,
      createdAt: existing.createdAt,
      retryCount: existing.retryCount,
      kind: mergeKind(existing.kind, kind),
      status: existing.status === 'failed' && existing.retryCount < MAX_RETRY_COUNT
        ? 'pending'
        : existing.status,
      hashAfter: next?.hash ?? null,
      size,
      mtimeMs: next?.mtimeMs ?? null,
      updatedAt: now,
      needsRerun: existing.status === 'processing' ? true : existing.needsRerun,
      error: existing.status === 'failed' && existing.retryCount >= MAX_RETRY_COUNT
        ? `Retry limit reached (${MAX_RETRY_COUNT})`
        : null,
    })
    tasks[tasks.indexOf(existing)] = updated
    return updated
  }
  const created = new Domain.FileChangeTask({
    id: `change_${now}_${stablePathHash(rel)}`,
    projectId,
    path: rel,
    kind,
    status: 'pending',
    hashBefore: old?.hash ?? null,
    hashAfter: next?.hash ?? null,
    size,
    mtimeMs: next?.mtimeMs ?? null,
    createdAt: now,
    updatedAt: now,
    retryCount: 0,
    error: null,
    needsRerun: false,
  })
  tasks.push(created)
  return created
}

export interface RescanOptions {
  readonly config?: Partial<SourceWatchConfig> | undefined
  readonly now?: (() => number) | undefined
}

export const rescanProjectSources = (
  root: string,
  projectId: string,
  options: RescanOptions = {},
): Effect.Effect<Domain.RescanResult, Errors.InvalidRequest> => {
  const now = options.now ?? Date.now
  return Effect.tryPromise({
    try: async () => {
      const rules = watchRules(normalizeSourceWatchConfig(options.config))
      await mkdir(join(root, SYNC_DIR), { recursive: true })
      const snapshot = await readSnapshot(root)
      const walked = await collectWatchedRels(root, rules)
      const rels = new Set(walked.rels)
      for (const rel of Object.keys(snapshot.files)) {
        if (!rels.has(rel) && !(await fileExists(join(root, rel)))) rels.add(rel)
      }
      const timestamp = now()
      const { tasks: current } = await readQueue(root)
      const tasks = [...current]
      const changed: Array<Domain.FileChangeTask> = []
      const observed: Record<string, FileMeta> = { ...snapshot.files }
      for (const rel of [...rels].sort()) {
        const old = snapshot.files[rel]
        const next = await readMeta(root, rel, walked.stats.get(rel))
        if (!(next === null && old !== undefined) && sameMeta(old, next)) continue
        const kind: Domain.FileChangeKind | undefined = old === undefined && next !== null
          ? 'created'
          : next === null && old !== undefined
          ? 'deleted'
          : old !== undefined && next !== null
          ? 'modified'
          : undefined
        if (kind === undefined) continue
        changed.push(upsertTask(tasks, projectId, rel, kind, old, next, timestamp))
        if (next === null) delete observed[rel]
        else observed[rel] = next
      }
      await writeSnapshot(root, { version: 1, updatedAt: timestamp, files: observed })
      await writeQueue(root, { version: 1, tasks })
      return new Domain.RescanResult({
        queue: new Domain.FileChangeQueue({ version: 1, tasks }),
        changedTasks: changed,
      })
    },
    catch: (error) =>
      error instanceof Errors.InvalidRequest
        ? error
        : new Errors.InvalidRequest({ message: `Source rescan failed: ${String(error)}` }),
  })
}

export interface RescanSourcesShape {
  readonly rescan: (
    projectId: string,
  ) => Effect.Effect<Domain.RescanResult, Errors.InvalidRequest | Errors.NotFound>
  readonly fileChanges: (
    projectId: string,
  ) => Effect.Effect<Domain.FileChangeQueue, Errors.InvalidRequest | Errors.NotFound>
  readonly retryFileChange: (
    projectId: string,
    taskId: string,
  ) => Effect.Effect<Domain.FileChangeQueue, Errors.InvalidRequest | Errors.NotFound>
  readonly ignoreFileChange: (
    projectId: string,
    taskId: string,
  ) => Effect.Effect<Domain.FileChangeQueue, Errors.InvalidRequest | Errors.NotFound>
}

const queueFailure = (label: string, error: unknown): Errors.InvalidRequest =>
  error instanceof Errors.InvalidRequest
    ? error
    : new Errors.InvalidRequest({ message: `${label}: ${String(error)}` })

export const readFileChangeQueue = (
  root: string,
): Effect.Effect<Domain.FileChangeQueue, Errors.InvalidRequest> =>
  Effect.tryPromise({
    try: async () => {
      const queue = await readQueue(root)
      return new Domain.FileChangeQueue({ version: queue.version, tasks: [...queue.tasks] })
    },
    catch: (error) => queueFailure('File change queue read failed', error),
  })

export const retryFileChangeTask = (
  root: string,
  projectId: string,
  taskId: string,
  options: RescanOptions = {},
): Effect.Effect<Domain.FileChangeQueue, Errors.InvalidRequest> =>
  Effect.tryPromise({
    try: async () => {
      const now = (options.now ?? Date.now)()
      const queue = await readQueue(root)
      const tasks = queue.tasks.map((task) =>
        task.id === taskId && task.projectId === projectId
          ? new Domain.FileChangeTask({
            id: task.id,
            projectId: task.projectId,
            path: task.path,
            kind: task.kind,
            status: 'pending',
            hashBefore: task.hashBefore,
            hashAfter: task.hashAfter,
            size: task.size,
            mtimeMs: task.mtimeMs,
            createdAt: task.createdAt,
            updatedAt: now,
            retryCount: 0,
            error: null,
            needsRerun: false,
          })
          : task
      )
      await writeQueue(root, { version: queue.version, tasks })
      return new Domain.FileChangeQueue({ version: queue.version, tasks })
    },
    catch: (error) => queueFailure('File change retry failed', error),
  })

export const ignoreFileChangeTask = (
  root: string,
  projectId: string,
  taskId: string,
): Effect.Effect<Domain.FileChangeQueue, Errors.InvalidRequest> =>
  Effect.tryPromise({
    try: async () => {
      const queue = await readQueue(root)
      const tasks = queue.tasks.filter(
        (task) => !(task.id === taskId && task.projectId === projectId),
      )
      await writeQueue(root, { version: queue.version, tasks })
      return new Domain.FileChangeQueue({ version: queue.version, tasks })
    },
    catch: (error) => queueFailure('File change ignore failed', error),
  })

export const makeRescanSources = (
  options: RescanOptions = {},
): Effect.Effect<RescanSourcesShape, never, ProjectRegistry> =>
  Effect.gen(function*() {
    const registry = yield* ProjectRegistry
    return {
      rescan: (projectId) =>
        Effect.flatMap(registry.resolveRoot(projectId), (root) => rescanProjectSources(root, projectId, options)),
      fileChanges: (projectId) => Effect.flatMap(registry.resolveRoot(projectId), (root) => readFileChangeQueue(root)),
      retryFileChange: (projectId, taskId) =>
        Effect.flatMap(
          registry.resolveRoot(projectId),
          (root) => retryFileChangeTask(root, projectId, taskId, options),
        ),
      ignoreFileChange: (projectId, taskId) =>
        Effect.flatMap(
          registry.resolveRoot(projectId),
          (root) => ignoreFileChangeTask(root, projectId, taskId),
        ),
    }
  })

export class RescanSources extends Context.Service<RescanSources, RescanSourcesShape>()(
  'llm-wiki-api-server/server/RescanSources',
) {
  static readonly make = makeRescanSources

  static readonly layer = (
    options: RescanOptions = {},
  ): Layer.Layer<RescanSources, never, ProjectRegistry> => Layer.effect(RescanSources, makeRescanSources(options))
}
