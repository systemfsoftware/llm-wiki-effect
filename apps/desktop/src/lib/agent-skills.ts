import { listDirectory, readFile } from '@/commands/fs'
import { parseFrontmatter } from '@/lib/frontmatter'
import { normalizePath } from '@/lib/path-utils'
import type { FileNode } from '@/types/wiki'
import { homeDir } from '@tauri-apps/api/path'

export interface AvailableAgentSkill {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly source: string
}

const MAX_SKILL_FILE_BYTES = 64_000
const MAX_SKILL_SCAN_DEPTH = 8

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

function isPortableSkillName(value: string): boolean {
  if (value.endsWith(' ') || value.endsWith('.')) return false
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    if (code <= 0x1f || '<>:"|?*'.includes(char)) return false
  }
  const stem = (value.split('.')[0] ?? value).replace(/ +$/, '').toUpperCase()
  return RESERVED_STEMS[stem] !== true
}

export function normalizeSkillName(value: string): string | undefined {
  const trimmed = value.trim()
  if (trimmed === '' || trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('..')) {
    return undefined
  }
  return isPortableSkillName(trimmed) ? trimmed : undefined
}

interface SkillRoot {
  readonly path: string
  readonly source: string
}

interface SkillCandidate {
  readonly id: string
  readonly path: string
}

async function skillRoots(projectPath: string): Promise<SkillRoot[]> {
  const roots: SkillRoot[] = [
    { path: `${normalizePath(projectPath)}/.llm-wiki/skills`, source: 'project' },
  ]
  let home = ''
  try {
    home = normalizePath(await homeDir())
  } catch {
    home = ''
  }
  if (home !== '') {
    roots.push({ path: `${home}/.claude/skills`, source: 'claude' })
    roots.push({ path: `${home}/.codex/skills`, source: 'codex' })
    roots.push({ path: `${home}/.agents/skills`, source: 'agents' })
  }
  return roots
}

function collectCandidates(nodes: readonly FileNode[], out: SkillCandidate[]): void {
  for (const node of nodes) {
    if (node.is_dir) {
      if (node.children) collectCandidates(node.children, out)
      continue
    }
    if (node.name.toLowerCase() === 'skill.md') {
      const id = normalizeSkillName(parentDirectoryName(node.path))
      if (id !== undefined) out.push({ id, path: node.path })
      continue
    }
    if (node.name.toLowerCase().endsWith('.md')) {
      const id = normalizeSkillName(node.name.slice(0, -'.md'.length))
      if (id !== undefined) out.push({ id, path: node.path })
    }
  }
}

function parentDirectoryName(path: string): string {
  const normalized = normalizePath(path).replace(/\/+$/, '')
  const slash = normalized.lastIndexOf('/')
  if (slash === -1) return ''
  const rest = normalized.slice(0, slash)
  return rest.slice(rest.lastIndexOf('/') + 1)
}

function stringField(
  frontmatter: Record<string, string | string[]> | null,
  key: string,
): string | undefined {
  const value = frontmatter?.[key]
  return typeof value === 'string' ? value : undefined
}

async function loadCandidate(
  candidate: SkillCandidate,
  source: string,
): Promise<AvailableAgentSkill | undefined> {
  let raw: string
  try {
    raw = await readFile(candidate.path)
  } catch {
    return undefined
  }
  if (new TextEncoder().encode(raw).length > MAX_SKILL_FILE_BYTES) return undefined
  const { frontmatter, body } = parseFrontmatter(raw)
  const description = stringField(frontmatter, 'description') ?? ''
  if (description.trim() === '' || body.trim() === '') return undefined
  return {
    id: candidate.id,
    name: stringField(frontmatter, 'name') ?? candidate.id,
    description,
    source,
  }
}

export async function listAvailableAgentSkills(
  projectPath: string,
): Promise<AvailableAgentSkill[]> {
  const found = new Map<string, AvailableAgentSkill>()
  for (const root of await skillRoots(projectPath)) {
    let tree: FileNode[]
    try {
      tree = await listDirectory(root.path, { maxDepth: MAX_SKILL_SCAN_DEPTH })
    } catch {
      continue
    }
    const candidates: SkillCandidate[] = []
    collectCandidates(tree, candidates)
    for (const candidate of candidates) {
      if (found.has(candidate.id)) continue
      const skill = await loadCandidate(candidate, root.source)
      if (skill !== undefined) found.set(candidate.id, skill)
    }
  }
  return [...found.values()].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
}
