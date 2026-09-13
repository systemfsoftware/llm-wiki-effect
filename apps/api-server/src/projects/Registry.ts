/**
 * Project registry for the worker: the configured roots plus the current
 * project selection.
 *
 * Ported from `load_projects` / `resolve_project` / `read_project_id` and
 * `project_name_from_path` in apps/desktop/src-tauri/src/api_server.rs. The
 * selection is worker-owned state (KTD7): it is persisted at the injected
 * `statePath` when one is given, and the desktop pushes switches into it (R10).
 */
import { Context, Effect, Layer, Option } from 'effect'
import { Domain, Errors } from 'llm-wiki-protocol'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { ConfigShape } from '../config/Config.js'
import { normalizeProjectPath, projectNameFromPath, projectPathMatches } from '../config/Config.js'
import { isRecord, nonEmptyString } from '../json.js'

export interface RegistryOptions {
  readonly statePath?: string
}

export interface ProjectRegistryShape {
  readonly list: Effect.Effect<ReadonlyArray<Domain.Project>, Errors.InvalidRequest>
  readonly setCurrent: (
    projectId: string,
  ) => Effect.Effect<Domain.Project, Errors.InvalidRequest | Errors.NotFound>
  readonly resolveRoot: (
    projectId: string,
  ) => Effect.Effect<string, Errors.InvalidRequest | Errors.NotFound>
}

interface RootEntry {
  readonly id: string
  readonly name: string
  readonly path: string
  readonly exists: boolean
}

const CASE_INSENSITIVE_PATHS = process.platform === 'win32'

const isDirectory = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

const readProjectId = async (path: string): Promise<string | undefined> => {
  try {
    const raw = await readFile(join(path, '.llm-wiki', 'project.json'), 'utf8')
    const parsed = JSON.parse(raw) as unknown
    return isRecord(parsed) ? nonEmptyString(parsed['id']) : undefined
  } catch {
    return undefined
  }
}

const describeRoots = (
  roots: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<RootEntry>> =>
  Effect.promise(async () => {
    const out: Array<RootEntry> = []
    for (const root of roots) {
      const path = normalizeProjectPath(root)
      out.push({
        id: (await readProjectId(path)) ?? path,
        name: projectNameFromPath(path),
        path,
        exists: await isDirectory(path),
      })
    }
    return out.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
  })

const readState = (statePath: string): Effect.Effect<Option.Option<string>> =>
  Effect.promise(async () => {
    try {
      const raw = await readFile(statePath, 'utf8')
      const parsed = JSON.parse(raw) as unknown
      return isRecord(parsed)
        ? Option.fromNullishOr(nonEmptyString(parsed['currentProject']))
        : Option.none<string>()
    } catch {
      return Option.none<string>()
    }
  })

const writeState = (statePath: string, projectId: string): Effect.Effect<void> =>
  Effect.promise(async () => {
    await mkdir(dirname(statePath), { recursive: true })
    const temporary = `${statePath}.tmp`
    await writeFile(temporary, `${JSON.stringify({ currentProject: projectId }, null, 2)}\n`, 'utf8')
    await rename(temporary, statePath)
  })

export class ProjectRegistry extends Context.Service<ProjectRegistry, ProjectRegistryShape>()(
  'llm-wiki-api-server/ProjectRegistry',
) {
  static readonly make = (
    config: ConfigShape,
    options?: RegistryOptions,
  ): Effect.Effect<ProjectRegistryShape> =>
    Effect.gen(function*() {
      const statePath = options?.statePath
      let currentId: Option.Option<string> = Option.none()
      if (statePath !== undefined) {
        currentId = yield* readState(statePath)
      }

      const currentSelector = (configured: Option.Option<string>): string | undefined => {
        if (Option.isSome(currentId)) return currentId.value
        return Option.isSome(configured) ? configured.value : undefined
      }

      const selects = (entry: RootEntry, selector: string): boolean =>
        selector.toLowerCase() === 'current'
          ? false
          : entry.id === selector ||
            projectPathMatches(entry.path, selector, CASE_INSENSITIVE_PATHS)

      const toProject = (entry: RootEntry, current: boolean): Domain.Project =>
        new Domain.Project({
          id: entry.id,
          name: entry.name,
          path: entry.path,
          current,
        })

      const describedRoots = () =>
        Effect.gen(function*() {
          const values = yield* config.values
          const entries = yield* describeRoots(values.projectRoots)
          return { entries, selector: currentSelector(values.currentProject) }
        })

      const list = Effect.gen(function*() {
        const { entries, selector } = yield* describedRoots()
        return entries
          .filter((entry) => entry.exists)
          .map((entry) => toProject(entry, selector !== undefined && selects(entry, selector)))
      })

      const locate = (
        projectId: string,
      ): Effect.Effect<RootEntry, Errors.InvalidRequest | Errors.NotFound> =>
        Effect.gen(function*() {
          const wanted = projectId.trim()
          const { entries, selector } = yield* describedRoots()
          const wantsCurrent = wanted.toLowerCase() === 'current'
          const match = entries.find(
            (entry) =>
              (entry.exists && selects(entry, wanted)) ||
              (wantsCurrent &&
                entry.exists &&
                selector !== undefined &&
                selects(entry, selector)),
          )
          if (match !== undefined) return match
          const missing = entries.find((entry) => !entry.exists && selects(entry, wanted))
          if (missing !== undefined) {
            return yield* Effect.fail(
              new Errors.NotFound({ message: `Project root does not exist: ${missing.path}` }),
            )
          }
          return yield* Effect.fail(new Errors.NotFound({ message: `Unknown project: ${wanted}` }))
        })

      const setCurrent = (
        projectId: string,
      ): Effect.Effect<Domain.Project, Errors.InvalidRequest | Errors.NotFound> =>
        Effect.gen(function*() {
          const target = yield* locate(projectId)
          if (statePath !== undefined) {
            yield* writeState(statePath, target.id)
          }
          currentId = Option.some(target.id)
          return toProject(target, true)
        })

      const resolveRoot = (
        projectId: string,
      ): Effect.Effect<string, Errors.InvalidRequest | Errors.NotFound> =>
        Effect.map(locate(projectId), (entry) => entry.path)

      return { list, setCurrent, resolveRoot }
    })

  static readonly layer = (
    config: ConfigShape,
    options?: RegistryOptions,
  ): Layer.Layer<ProjectRegistry> => Layer.effect(ProjectRegistry, ProjectRegistry.make(config, options))
}
