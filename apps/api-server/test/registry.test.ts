import { Effect } from 'effect'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Config, normalizeProjectPath } from '../src/config/Config.js'
import { ProjectRegistry } from '../src/projects/Registry.js'

const tempDirs: Array<string> = []
let root: string
let alphaDir: string
let betaDir: string

const makeProject = async (path: string, id?: string): Promise<string> => {
  if (id === undefined) {
    await mkdir(path, { recursive: true })
    return path
  }
  await mkdir(join(path, '.llm-wiki'), { recursive: true })
  await writeFile(join(path, '.llm-wiki', 'project.json'), JSON.stringify({ id }), 'utf8')
  return path
}

const standaloneConfig = async (value: unknown) => {
  const dir = await mkdtemp(join(tmpdir(), 'llm-wiki-registry-'))
  tempDirs.push(dir)
  const configPath = join(dir, 'config.json')
  await writeFile(configPath, JSON.stringify(value), 'utf8')
  return Effect.runPromise(Config.make({ mode: 'standalone', configPath, env: {} }))
}

const statePathIn = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'llm-wiki-registry-state-'))
  tempDirs.push(dir)
  return join(dir, 'registry.json')
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'llm-wiki-registry-fixtures-'))
  tempDirs.push(root)
  alphaDir = normalizeProjectPath(await makeProject(join(root, 'alpha-project'), 'alpha-id'))
  betaDir = normalizeProjectPath(await makeProject(join(root, 'beta-project')))
})

afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('project registry', () => {
  it('lists existing roots with ids, names, and the configured current project', async () => {
    const config = await standaloneConfig({
      projects: [betaDir, alphaDir],
      currentProject: 'alpha-id',
    })
    const registry = await Effect.runPromise(ProjectRegistry.make(config))
    const projects = await Effect.runPromise(registry.list)

    expect(projects.map((project) => project.path)).toEqual([alphaDir, betaDir])
    expect(projects.find((project) => project.path === alphaDir)).toMatchObject({
      id: 'alpha-id',
      name: 'alpha-project',
      current: true,
    })
    expect(projects.find((project) => project.path === betaDir)).toMatchObject({
      id: betaDir,
      name: 'beta-project',
      current: false,
    })
  })

  it('dedupes roots that normalize to the same path', async () => {
    const config = await standaloneConfig({
      projects: [alphaDir, `${alphaDir}/`, alphaDir.replace(/\//g, '\\')],
    })
    const registry = await Effect.runPromise(ProjectRegistry.make(config))
    const projects = await Effect.runPromise(registry.list)

    expect(projects).toHaveLength(1)
    expect(projects[0]?.path).toBe(alphaDir)
  })

  it('resolves a root by id and by path', async () => {
    const config = await standaloneConfig({ projects: [alphaDir, betaDir] })
    const registry = await Effect.runPromise(ProjectRegistry.make(config))

    expect(await Effect.runPromise(registry.resolveRoot('alpha-id'))).toBe(alphaDir)
    expect(await Effect.runPromise(registry.resolveRoot(betaDir))).toBe(betaDir)
  })

  it('resolves the current project from configuration and fails without a selection', async () => {
    const selected = await standaloneConfig({ projects: [alphaDir, betaDir], currentProject: alphaDir })
    const unselected = await standaloneConfig({ projects: [alphaDir] })
    const selectedRegistry = await Effect.runPromise(ProjectRegistry.make(selected))
    const unselectedRegistry = await Effect.runPromise(ProjectRegistry.make(unselected))

    expect(await Effect.runPromise(selectedRegistry.resolveRoot('current'))).toBe(alphaDir)
    const error = await Effect.runPromise(Effect.flip(unselectedRegistry.resolveRoot('current')))
    expect(error.name).toBe('NotFound')
    expect(error.message).toBe('Unknown project: current')
  })

  it('resolves through the service layer', async () => {
    const config = await standaloneConfig({ projects: [alphaDir] })
    const resolved = await Effect.runPromise(
      Effect.provide(
        ProjectRegistry.use((registry) => registry.resolveRoot('alpha-id')),
        ProjectRegistry.layer(config),
      ),
    )

    expect(resolved).toBe(alphaDir)
  })

  it('persists a pushed switch and reports it as current afterwards', async () => {
    const statePath = await statePathIn()
    const config = await standaloneConfig({
      projects: [alphaDir, betaDir],
      currentProject: 'alpha-id',
    })
    const registry = await Effect.runPromise(ProjectRegistry.make(config, { statePath }))

    const switched = await Effect.runPromise(registry.setCurrent(betaDir))

    expect(switched).toMatchObject({ id: betaDir, current: true })
    expect(await Effect.runPromise(registry.resolveRoot('current'))).toBe(betaDir)

    const reopened = await Effect.runPromise(ProjectRegistry.make(config, { statePath }))
    const projects = await Effect.runPromise(reopened.list)

    expect(projects.find((project) => project.path === betaDir)?.current).toBe(true)
    expect(await Effect.runPromise(reopened.resolveRoot('current'))).toBe(betaDir)
  })

  it('keeps the persisted selection inside the service instance without a state path', async () => {
    const config = await standaloneConfig({
      projects: [alphaDir, betaDir],
      currentProject: betaDir,
    })
    const registry = await Effect.runPromise(ProjectRegistry.make(config))

    expect(await Effect.runPromise(registry.resolveRoot('current'))).toBe(betaDir)
    await Effect.runPromise(registry.setCurrent('alpha-id'))

    expect(await Effect.runPromise(registry.resolveRoot('current'))).toBe(alphaDir)
  })

  it('rejects an unknown project and a configured root missing from disk', async () => {
    const missingRoot = join(root, 'not-on-disk')
    const config = await standaloneConfig({ projects: [alphaDir, missingRoot] })
    const registry = await Effect.runPromise(ProjectRegistry.make(config))

    const unknown = await Effect.runPromise(Effect.flip(registry.resolveRoot('nope')))
    const missing = await Effect.runPromise(Effect.flip(registry.resolveRoot(missingRoot)))
    const switched = await Effect.runPromise(Effect.flip(registry.setCurrent(missingRoot)))
    const projects = await Effect.runPromise(registry.list)

    expect(unknown.name).toBe('NotFound')
    expect(unknown.message).toBe('Unknown project: nope')
    expect(missing.name).toBe('NotFound')
    expect(missing.message).toBe(`Project root does not exist: ${normalizeProjectPath(missingRoot)}`)
    expect(switched.name).toBe('NotFound')
    expect(projects.map((project) => project.path)).toEqual([alphaDir])
  })
})
