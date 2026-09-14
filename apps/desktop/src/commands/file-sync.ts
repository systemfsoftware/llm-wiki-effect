import { relay } from '@/lib/api-relay'
import { normalizePath } from '@/lib/path-utils'
import { normalizeSourceWatchConfig } from '@/lib/source-watch-config'
import type { SourceWatchConfig } from '@/stores/wiki-store'
import { invoke } from '@tauri-apps/api/core'

export type FileChangeKind = 'created' | 'modified' | 'deleted'
export type FileChangeStatus = 'pending' | 'processing' | 'done' | 'failed' | 'superseded'

export interface FileChangeTask {
  id: string
  projectId: string
  path: string
  kind: FileChangeKind
  status: FileChangeStatus
  hashBefore?: string | null
  hashAfter?: string | null
  size?: number | null
  mtimeMs?: number | null
  createdAt: number
  updatedAt: number
  retryCount: number
  error?: string | null
  needsRerun: boolean
}

export interface FileChangeQueue {
  version: number
  tasks: FileChangeTask[]
}

export interface FileChangeRescanResult {
  queue: FileChangeQueue
  changedTasks: FileChangeTask[]
}

export interface FileSyncPayload {
  projectId: string
  tasks: FileChangeTask[]
}

export function startProjectFileWatcher(
  projectId: string,
  projectPath: string,
  sourceWatchConfig?: SourceWatchConfig,
): Promise<FileChangeRescanResult> {
  return invoke<FileChangeRescanResult>('start_project_file_watcher', {
    projectId,
    projectPath,
    sourceWatchConfig: normalizeSourceWatchConfig(sourceWatchConfig),
  })
}

export function stopProjectFileWatcher(): Promise<void> {
  return invoke<void>('stop_project_file_watcher')
}

export function rescanProjectFiles(projectPath: string): Promise<FileChangeRescanResult> {
  return relay()
    .rescanSources({ projectId: normalizePath(projectPath) })
    .then((response) => ({
      queue: {
        version: response.result.queue.version,
        tasks: [...response.result.queue.tasks],
      },
      changedTasks: [...response.result.changedTasks],
    }))
}

export function retryFileChangeTask(
  projectPath: string,
  taskId: string,
): Promise<FileChangeQueue> {
  return relay()
    .retryFileChange({ projectId: normalizePath(projectPath), taskId })
    .then((response) => ({ version: response.queue.version, tasks: [...response.queue.tasks] }))
}

export function ignoreFileChangeTask(
  projectPath: string,
  taskId: string,
): Promise<FileChangeQueue> {
  return relay()
    .ignoreFileChange({ projectId: normalizePath(projectPath), taskId })
    .then((response) => ({ version: response.queue.version, tasks: [...response.queue.tasks] }))
}
