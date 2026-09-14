import { ApiProtocol } from './rpc.js'
import type { ApiOperationName, ApiRpc } from './rpc.js'

export interface ApiCatalogEntry {
  readonly name: ApiOperationName
  readonly summary: string
  readonly payload: ApiRpc['payloadSchema']
  readonly isMcpMapped: boolean
  readonly restRoute: string
}

const rpcFor = (name: ApiOperationName): ApiRpc => {
  const rpc = ApiProtocol.requests.get(name)
  if (rpc === undefined) {
    throw new Error(`Operation ${name} is not declared on ApiProtocol`)
  }
  return rpc
}

const entry = (
  name: ApiOperationName,
  summary: string,
  isMcpMapped: boolean,
  restRoute: string,
): ApiCatalogEntry => ({ name, summary, payload: rpcFor(name).payloadSchema, isMcpMapped, restRoute })

export const ApiCatalog: ReadonlyArray<ApiCatalogEntry> = [
  entry('health', 'Server status, gating flags, and auth configuration.', true, '/api/v1/health'),
  entry('projects', 'Known projects plus the current project.', true, '/api/v1/projects'),
  entry('files', 'Public project tree for wiki, sources, or all roots.', true, '/api/v1/projects/{id}/files'),
  entry(
    'fileContent',
    'Text content of one public project-relative path.',
    true,
    '/api/v1/projects/{id}/files/content',
  ),
  entry('reviews', 'Review items filtered by status, type, and limit.', true, '/api/v1/projects/{id}/reviews'),
  entry(
    'patchReview',
    'Resolve or reopen one review item by id.',
    false,
    '/api/v1/projects/{id}/reviews/{reviewId}',
  ),
  entry(
    'resolveReviews',
    'Bulk-resolve review ids, reporting the unmatched ones.',
    false,
    '/api/v1/projects/{id}/reviews/resolve',
  ),
  entry('search', 'Hybrid keyword/vector/graph retrieval over project pages.', true, '/api/v1/projects/{id}/search'),
  entry('graph', 'Knowledge graph nodes and edges, filtered and truncated.', true, '/api/v1/projects/{id}/graph'),
  entry(
    'rescanSources',
    'Rescan source folders and return the change queue.',
    true,
    '/api/v1/projects/{id}/sources/rescan',
  ),
  entry(
    'fileChanges',
    'Snapshot of the project file-change queue.',
    false,
    'get_file_change_queue (Tauri command)',
  ),
  entry(
    'retryFileChange',
    'Reset one queue task to pending and return the queue.',
    false,
    'retry_file_change_task (Tauri command)',
  ),
  entry(
    'ignoreFileChange',
    'Drop one queue task and return the queue.',
    false,
    'ignore_file_change_task (Tauri command)',
  ),
  entry(
    'embedPage',
    'Create or replace the vector index of one wiki page.',
    true,
    '/api/v1/projects/{id}/pages/embed',
  ),
  entry(
    'embedTexts',
    'Embed 1-512 texts through the configured embedding provider.',
    false,
    'embed_texts (desktop embedding pipeline batch call)',
  ),
  entry(
    'vectorStats',
    'Indexed v2 chunk count plus the legacy v1 row count.',
    false,
    'vector_count_chunks + vector_legacy_row_count (Tauri commands)',
  ),
  entry(
    'vectorOptimize',
    'Compact the v2 chunk table and prune old LanceDB versions.',
    false,
    'vector_optimize_chunks (Tauri command)',
  ),
  entry(
    'vectorClear',
    'Drop the whole v2 chunk table, reporting the rows removed.',
    false,
    'vector_clear_chunks (Tauri command)',
  ),
  entry(
    'vectorDeletePage',
    'Delete every indexed chunk of one page, reporting the rows removed.',
    false,
    'vector_delete_page (Tauri command)',
  ),
  entry(
    'vectorDropLegacy',
    'Drop the legacy v1 vector table once its pages are re-indexed.',
    false,
    'vector_drop_legacy (Tauri command)',
  ),
  entry('chat', 'One aggregate agent turn for a project session.', true, '/api/v1/projects/{id}/chat'),
  entry(
    'chatStream',
    'One agent turn as a stream of meta, agent, and done frames.',
    false,
    '/api/v1/projects/{id}/chat (SSE)',
  ),
  entry(
    'chatCancel',
    'Cancel the in-flight agent run of a session.',
    false,
    '/api/v1/projects/{id}/chat/{sessionId}/cancel',
  ),
  entry(
    'setCurrentProject',
    'Point the server current-project reference at a project.',
    false,
    'supervisor control channel (no REST route)',
  ),
  entry(
    'reloadConfig',
    'Drop the cached configuration so the next read reloads it.',
    false,
    'supervisor control channel (no REST route)',
  ),
]

export const ApiCatalogNames: ReadonlyArray<ApiOperationName> = ApiCatalog.map(
  (catalogEntry) => catalogEntry.name,
)

export const McpMappedOperations: ReadonlyArray<ApiOperationName> = ApiCatalog.filter(
  (catalogEntry) => catalogEntry.isMcpMapped,
).map((catalogEntry) => catalogEntry.name)
