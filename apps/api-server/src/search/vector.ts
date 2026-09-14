/**
 * LanceDB access for the search service.
 *
 * The chunk table layout (`wiki_chunks_v2`: `chunk_id` / `page_id` /
 * `chunk_index` / `chunk_text` / `heading_path` / `vector`, one row per chunk,
 * `chunk_id = page_id#chunk_index`) and the `1 / (1 + _distance)` score are
 * ported from apps/desktop/src-tauri/src/commands/vectorstore.rs. The on-disk
 * directory is always the project's `.llm-wiki/lancedb`, never the process CWD.
 *
 * KTD7: the worker is the only writer, but another handle's manifest is
 * invisible until `checkoutLatest()`, so every mutating call opens the table
 * and calls `checkoutLatest()` before it touches the table.
 */
import lancedb from '@lancedb/lancedb'
import { Context, Effect, Layer } from 'effect'
import { Errors } from 'llm-wiki-protocol'
import type { ChunkRow } from './fusion.js'

export const VECTOR_CHUNKS_TABLE = 'wiki_chunks_v2'

export interface LanceTable {
  readonly nearest: (
    vector: ReadonlyArray<number>,
    limit: number,
  ) => Promise<ReadonlyArray<Record<string, unknown>>>
  readonly checkoutLatest: () => Promise<void>
  readonly optimize: () => Promise<void>
}

export interface LanceConnection {
  readonly tableNames: () => Promise<ReadonlyArray<string>>
  readonly openTable: (name: string) => Promise<LanceTable>
}

export type LanceConnect = (dir: string) => Promise<LanceConnection>

const defaultConnect: LanceConnect = async (dir) => {
  const db = await lancedb.connect(dir)
  return {
    tableNames: () => db.tableNames(),
    openTable: async (name) => {
      const table = await db.openTable(name)
      return {
        nearest: async (vector, limit) => {
          const rows = await table.query().nearestTo([...vector]).limit(limit).toArray()
          return rows as ReadonlyArray<Record<string, unknown>>
        },
        checkoutLatest: () => table.checkoutLatest(),
        optimize: async () => {
          await table.optimize({ cleanupOlderThan: new Date(), deleteUnverified: false })
        },
      }
    },
  }
}

const toChunkRow = (row: Record<string, unknown>): ChunkRow => ({
  chunkId: String(row['chunk_id']),
  pageId: String(row['page_id']),
  chunkIndex: Number(row['chunk_index']),
  chunkText: String(row['chunk_text']),
  headingPath: String(row['heading_path']),
  score: 1 / (1 + Number(row['_distance'] ?? 0)),
})

export interface VectorStoreShape {
  readonly searchChunks: (
    dir: string,
    vector: ReadonlyArray<number>,
    limit: number,
  ) => Effect.Effect<ReadonlyArray<ChunkRow>, Errors.InvalidRequest>
  readonly optimizeIndex: (dir: string) => Effect.Effect<void, Errors.InvalidRequest>
}

export interface VectorStoreOptions {
  readonly connect?: LanceConnect
}

const lancedbFailure = (error: unknown): Errors.InvalidRequest =>
  error instanceof Errors.InvalidRequest
    ? error
    : new Errors.InvalidRequest({ message: `LanceDB failure: ${String(error)}` })

const fromLance = <A>(run: () => Promise<A>): Effect.Effect<A, Errors.InvalidRequest> =>
  Effect.tryPromise({ try: run, catch: lancedbFailure })

export const makeVectorStore = (options?: VectorStoreOptions): VectorStoreShape => {
  const connect = options?.connect ?? defaultConnect

  const searchChunks: VectorStoreShape['searchChunks'] = (dir, vector, limit) =>
    Effect.gen(function*() {
      const connection = yield* fromLance(() => connect(dir))
      const tables = yield* fromLance(() => connection.tableNames())
      if (!tables.includes(VECTOR_CHUNKS_TABLE)) return []
      const table = yield* fromLance(() => connection.openTable(VECTOR_CHUNKS_TABLE))
      const rows = yield* fromLance(() => table.nearest(vector, limit))
      return rows.map(toChunkRow)
    })

  const optimizeIndex: VectorStoreShape['optimizeIndex'] = (dir) =>
    Effect.gen(function*() {
      const connection = yield* fromLance(() => connect(dir))
      const tables = yield* fromLance(() => connection.tableNames())
      if (!tables.includes(VECTOR_CHUNKS_TABLE)) return
      const table = yield* fromLance(() => connection.openTable(VECTOR_CHUNKS_TABLE))
      yield* fromLance(() => table.checkoutLatest())
      yield* fromLance(() => table.optimize())
    })

  return { searchChunks, optimizeIndex }
}

export class VectorStore extends Context.Service<VectorStore, VectorStoreShape>()(
  'llm-wiki-api-server/VectorStore',
) {
  static readonly make = (options?: VectorStoreOptions): Effect.Effect<VectorStoreShape> =>
    Effect.sync(() => makeVectorStore(options))
  static readonly layer = (options?: VectorStoreOptions): Layer.Layer<VectorStore> =>
    Layer.succeed(VectorStore, makeVectorStore(options))
}
