import { listDirectory } from '@/commands/fs'
import { relay } from '@/lib/api-relay'
import { normalizePath } from '@/lib/path-utils'
import type { EmbeddingConfig } from '@/stores/wiki-store'
import type { FileNode } from '@/types/wiki'

const AGGREGATE_PAGE_STEMS: Record<string, true> = {
  index: true,
  log: true,
  overview: true,
  purpose: true,
  schema: true,
}

let lastEmbeddingError: string | null = null

export function getLastEmbeddingError(): string | null {
  return lastEmbeddingError
}

export function resetEmbeddingStateForTests(): void {
  lastEmbeddingError = null
}

const describeError = (error: unknown): string => error instanceof Error ? error.message : String(error)

export async function fetchEmbedding(
  text: string,
  cfg: EmbeddingConfig,
): Promise<number[] | null> {
  if (!cfg.enabled || cfg.endpoint.trim() === '' || cfg.model.trim() === '') return null
  try {
    const response = await relay().embedTexts({ texts: [text] })
    const vector = response.vectors[0]
    if (vector === undefined) {
      throw new Error('Embedding provider returned no vector')
    }
    lastEmbeddingError = null
    return [...vector]
  } catch (error) {
    lastEmbeddingError = describeError(error)
    return null
  }
}

export type EmbeddingReindexState =
  | { kind: 'idle' }
  | { kind: 'running'; projectPath: string; done: number; total: number }
  | { kind: 'done'; projectPath: string; count: number }
  | { kind: 'error'; projectPath: string; message: string }

let embeddingReindexState: EmbeddingReindexState = { kind: 'idle' }
const embeddingReindexListeners = new Set<() => void>()

export function getEmbeddingReindexState(): EmbeddingReindexState {
  return embeddingReindexState
}

export function subscribeEmbeddingReindexState(listener: () => void): () => void {
  embeddingReindexListeners.add(listener)
  return () => embeddingReindexListeners.delete(listener)
}

function setEmbeddingReindexState(state: EmbeddingReindexState): void {
  embeddingReindexState = state
  for (const listener of embeddingReindexListeners) listener()
}

function contentPages(
  tree: readonly FileNode[],
  projectPath: string,
): Array<{ id: string; path: string }> {
  const files: Array<{ id: string; path: string }> = []
  const toRelative = (absolute: string): string =>
    absolute.startsWith(`${projectPath}/`) ? absolute.slice(projectPath.length + 1) : absolute
  const walk = (nodes: readonly FileNode[]): void => {
    for (const node of nodes) {
      if (node.is_dir) {
        if (node.children) walk(node.children)
        continue
      }
      if (!node.name.endsWith('.md')) continue
      const id = node.name.slice(0, -'.md'.length)
      if (AGGREGATE_PAGE_STEMS[id] === true) continue
      files.push({ id, path: toRelative(normalizePath(node.path)) })
    }
  }
  walk(tree)
  return files
}

async function embedPageAtPath(
  projectPath: string,
  pagePath: string,
  force: boolean,
): Promise<boolean> {
  try {
    await relay().embedPage({
      projectId: projectPath,
      path: pagePath,
      force,
    })
    lastEmbeddingError = null
    return true
  } catch (error) {
    lastEmbeddingError = describeError(error)
    return false
  }
}

export async function embedPage(projectPath: string, pagePath: string): Promise<boolean> {
  return embedPageAtPath(normalizePath(projectPath), pagePath, true)
}

export async function embedAllPages(
  projectPath: string,
  cfg: EmbeddingConfig,
  onProgress?: (done: number, total: number) => void,
  options?: { clearExisting?: boolean },
): Promise<number> {
  if (!cfg.enabled || !cfg.model) return 0
  lastEmbeddingError = null

  const pp = normalizePath(projectPath)
  setEmbeddingReindexState({ kind: 'running', projectPath: pp, done: 0, total: 0 })

  let tree: FileNode[]
  try {
    tree = await listDirectory(`${pp}/wiki`)
  } catch {
    const message = 'Could not read wiki tree; existing index was left unchanged.'
    setEmbeddingReindexState({ kind: 'error', projectPath: pp, message })
    throw new Error(message)
  }

  const files = contentPages(tree, pp)
  if (options?.clearExisting) {
    if (files.length === 0) {
      const existing = await getEmbeddingCount(pp).catch(() => 0)
      const message = existing > 0
        ? `Wiki tree returned no content pages, but ${existing} chunks are currently indexed. Existing index was left unchanged.`
        : 'Wiki tree returned no content pages; nothing to re-index.'
      setEmbeddingReindexState({ kind: 'error', projectPath: pp, message })
      throw new Error(message)
    }
    try {
      await clearChunkVectorTable(pp)
    } catch (error) {
      const message = `Could not clear the existing index: ${describeError(error)}`
      setEmbeddingReindexState({ kind: 'error', projectPath: pp, message })
      throw new Error(message, { cause: error })
    }
  }

  let done = 0
  let indexed = 0
  const failures: string[] = []
  for (const file of files) {
    const embedded = await embedPageAtPath(pp, file.path, options?.clearExisting === true)
    if (embedded) indexed += 1
    else failures.push(`${file.id}: ${getLastEmbeddingError() ?? 'embedding failed'}`)
    done += 1
    setEmbeddingReindexState({ kind: 'running', projectPath: pp, done, total: files.length })
    onProgress?.(done, files.length)
  }

  if (indexed > 0) await optimizeChunkVectorTableBestEffort(pp)

  if (options?.clearExisting === true && failures.length === 0) {
    await dropLegacyVectorTableBestEffort(pp)
  }

  if (failures.length > 0 && indexed === 0) {
    const message = `None of the ${files.length} pages could be embedded (${failures[0]}).`
    setEmbeddingReindexState({ kind: 'error', projectPath: pp, message })
    throw new Error(message)
  }

  setEmbeddingReindexState({ kind: 'done', projectPath: pp, count: indexed })
  return indexed
}

export async function removePageEmbedding(projectPath: string, pageId: string): Promise<void> {
  try {
    await relay().vectorDeletePage({ projectId: normalizePath(projectPath), pageId })
  } catch {
    // Cleanup after the delete flow already succeeded on disk.
  }
}

export async function getEmbeddingCount(projectPath: string): Promise<number> {
  try {
    const stats = await relay().vectorStats({ projectId: normalizePath(projectPath) })
    return stats.chunks
  } catch {
    return 0
  }
}

export async function legacyVectorRowCount(projectPath: string): Promise<number> {
  try {
    const stats = await relay().vectorStats({ projectId: normalizePath(projectPath) })
    return stats.legacyRows
  } catch {
    return 0
  }
}

export async function clearChunkVectorTable(projectPath: string): Promise<void> {
  await relay().vectorClear({ projectId: normalizePath(projectPath) })
}

export async function dropLegacyVectorTable(projectPath: string): Promise<boolean> {
  const result = await relay().vectorDropLegacy({ projectId: normalizePath(projectPath) })
  return result.dropped
}

async function optimizeChunkVectorTableBestEffort(projectPath: string): Promise<void> {
  try {
    await relay().vectorOptimize({ projectId: normalizePath(projectPath) })
  } catch {
    // Search keeps working on an uncompacted index.
  }
}

async function dropLegacyVectorTableBestEffort(projectPath: string): Promise<void> {
  try {
    await relay().vectorDropLegacy({ projectId: normalizePath(projectPath) })
  } catch {
    // Non-fatal: the next forced rebuild retries the drop.
  }
}
