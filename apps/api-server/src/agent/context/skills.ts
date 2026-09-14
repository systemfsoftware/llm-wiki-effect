/**
 * Skill discovery and loading.
 *
 * Ported from apps/desktop/src-tauri/src/agent/skills.rs: project skills live
 * under `<project>/.llm-wiki/skills`, user skills under the Claude/Codex/agents
 * home directories, only `SKILL.md` (or a single `<name>.md`) is injected into
 * the prompt, and symlinks are never followed.
 */
import { Effect } from 'effect'
import type { Stats } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, extname, join } from 'node:path'

export const MAX_SKILL_FILE_BYTES = 64_000
export const MAX_SKILL_SCAN_DEPTH = 8

export interface AgentSkill {
  readonly name: string
  readonly description: string
  readonly instructions: string
  readonly baseDir: string
  readonly location: string
}

export interface AvailableAgentSkill {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly source: string
}

interface SkillRoot {
  readonly path: string
  readonly source: string
}

interface SkillCandidate {
  readonly id: string
  readonly path: string
}

const RESERVED_STEMS: Record<string, true> = {
  CON: true,
  PRN: true,
  AUX: true,
  NUL: true,
  COM1: true,
  COM2: true,
  COM3: true,
  COM4: true,
  COM5: true,
  COM6: true,
  COM7: true,
  COM8: true,
  COM9: true,
  LPT1: true,
  LPT2: true,
  LPT3: true,
  LPT4: true,
  LPT5: true,
  LPT6: true,
  LPT7: true,
  LPT8: true,
  LPT9: true,
}

export const isPortableSkillName = (value: string): boolean => {
  if (value.endsWith(' ') || value.endsWith('.')) return false
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    if (code <= 0x1f || '<>:"|?*'.includes(char)) return false
  }
  const stem = (value.split('.')[0] ?? value).replace(/ +$/, '').toUpperCase()
  return RESERVED_STEMS[stem] !== true
}

export const normalizeSkillName = (value: string): string | undefined => {
  const trimmed = value.trim()
  if (trimmed === '' || trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('..')) {
    return undefined
  }
  return isPortableSkillName(trimmed) ? trimmed : undefined
}

const toPosix = (value: string): string => value.replaceAll('\\', '/')

export const splitFrontmatter = (raw: string): readonly [string | undefined, string] => {
  const withoutBom = raw.startsWith('\u{feff}') ? raw.slice(1) : raw
  const normalized = withoutBom.replaceAll('\r\n', '\n').replaceAll('\r', '\n')
  if (!normalized.startsWith('---\n')) return [undefined, normalized]
  const rest = normalized.slice(4)
  const end = rest.indexOf('\n---')
  if (end === -1) return [undefined, normalized]
  const after = rest.slice(end + '\n---'.length).replace(/^\n/, '')
  return [rest.slice(0, end), after]
}

export const yamlStringField = (frontmatter: string, key: string): string | undefined => {
  const prefix = `${key}:`
  for (const line of frontmatter.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith(prefix)) continue
    const raw = trimmed.slice(prefix.length).trim()
    const value = raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2
      ? raw.slice(1, -1)
      : raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2
      ? raw.slice(1, -1)
      : raw
    if (value !== '') return value
  }
  return undefined
}

const skillRoots = (projectRoot: string): ReadonlyArray<SkillRoot> => {
  const roots: Array<SkillRoot> = [{ path: join(projectRoot, '.llm-wiki', 'skills'), source: 'project' }]
  const home = homedir()
  if (home !== '') {
    roots.push({ path: join(home, '.claude', 'skills'), source: 'claude' })
    roots.push({ path: join(home, '.codex', 'skills'), source: 'codex' })
    roots.push({ path: join(home, '.agents', 'skills'), source: 'agents' })
  }
  return roots
}

const isSymlink = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isSymbolicLink()
  } catch {
    return true
  }
}

const isHiddenOrUnsafeSkillDir = (path: string): boolean => {
  const name = basename(path)
  return name.startsWith('.') || name === 'node_modules' || normalizeSkillName(name) === undefined
}

const discoverSkillCandidates = async (root: string): Promise<ReadonlyArray<SkillCandidate>> => {
  const out: Array<SkillCandidate> = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_SKILL_SCAN_DEPTH) return
    let entries: ReadonlyArray<string>
    try {
      entries = (await readdir(dir)).slice().sort()
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(dir, entry)
      if (await isSymlink(path)) continue
      let info: Stats
      try {
        info = await stat(path)
      } catch {
        continue
      }
      if (info.isFile()) {
        if (basename(path).toLowerCase() === 'skill.md') {
          const id = normalizeSkillName(basename(dirname(path)))
          if (id !== undefined) out.push({ id, path })
          continue
        }
        if (extname(path).toLowerCase() === '.md') {
          const id = normalizeSkillName(basename(path, extname(path)))
          if (id !== undefined) out.push({ id, path })
        }
        continue
      }
      if (info.isDirectory()) {
        if (isHiddenOrUnsafeSkillDir(path)) continue
        await walk(path, depth + 1)
      }
    }
  }
  await walk(root, 0)
  return out
}

const loadSkillFile = async (path: string, fallbackName: string): Promise<AgentSkill | undefined> => {
  let info: Stats
  try {
    info = await stat(path)
  } catch {
    return undefined
  }
  if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_SKILL_FILE_BYTES) return undefined
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    return undefined
  }
  const [frontmatter, instructions] = splitFrontmatter(raw)
  const name = (frontmatter === undefined ? undefined : yamlStringField(frontmatter, 'name')) ?? fallbackName
  const description = (frontmatter === undefined ? undefined : yamlStringField(frontmatter, 'description')) ?? ''
  if (description.trim() === '') return undefined
  const trimmedInstructions = instructions.trim()
  if (trimmedInstructions === '') return undefined
  return {
    name,
    description,
    instructions: trimmedInstructions,
    baseDir: toPosix(dirname(path)),
    location: toPosix(path),
  }
}

const findSkillMainFile = async (dir: string): Promise<string | undefined> => {
  try {
    const entry = (await readdir(dir)).find((name) => name.toLowerCase() === 'skill.md')
    return entry === undefined ? undefined : join(dir, entry)
  } catch {
    return undefined
  }
}

const loadSkillDirectory = async (dir: string, fallbackName: string): Promise<AgentSkill | undefined> => {
  let info: Stats
  try {
    info = await stat(dir)
  } catch {
    return undefined
  }
  if (info.isSymbolicLink() || !info.isDirectory()) return undefined
  const main = (await findSkillMainFile(dir)) ?? join(dir, 'SKILL.md')
  return loadSkillFile(main, fallbackName)
}

const loadSkillPath = async (path: string, fallbackName: string): Promise<AgentSkill | undefined> =>
  basename(path) === 'SKILL.md'
    ? loadSkillDirectory(dirname(path), fallbackName)
    : loadSkillFile(path, fallbackName)

const loadOneSkill = async (root: string, name: string): Promise<AgentSkill | undefined> => {
  const single = await loadSkillFile(join(root, `${name}.md`), name)
  if (single !== undefined) return single
  const directory = await loadSkillDirectory(join(root, name), name)
  if (directory !== undefined) return directory
  for (const candidate of await discoverSkillCandidates(root)) {
    if (candidate.id === name) return loadSkillPath(candidate.path, name)
  }
  return undefined
}

export const listAvailableSkills = (
  projectRoot: string,
): Effect.Effect<ReadonlyArray<AvailableAgentSkill>> =>
  Effect.promise(async () => {
    const skills = new Map<string, AvailableAgentSkill>()
    for (const root of skillRoots(projectRoot)) {
      for (const candidate of await discoverSkillCandidates(root.path)) {
        if (skills.has(candidate.id)) continue
        const skill = await loadSkillPath(candidate.path, candidate.id)
        if (skill === undefined) continue
        skills.set(candidate.id, {
          id: candidate.id,
          name: skill.name,
          description: skill.description,
          source: root.source,
        })
      }
    }
    return [...skills.values()].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
  })

export const loadProjectSkills = (
  projectRoot: string,
  requested: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<AgentSkill>> =>
  Effect.promise(async () => {
    if (requested.length === 0) return []
    const names = [...new Set(requested.map(normalizeSkillName).filter((name): name is string => name !== undefined))]
      .sort()
    const roots = skillRoots(projectRoot)
    const out: Array<AgentSkill> = []
    for (const name of names) {
      let loaded: AgentSkill | undefined
      for (const root of roots) {
        loaded = await loadOneSkill(root.path, name)
        if (loaded !== undefined) break
      }
      if (loaded !== undefined) out.push(loaded)
    }
    return out
  })
