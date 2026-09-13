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
    'embedPage',
    'Create or replace the vector index of one wiki page.',
    true,
    '/api/v1/projects/{id}/pages/embed',
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
