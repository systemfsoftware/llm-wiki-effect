import lancedb from '@lancedb/lancedb'
import type { Connection, Table } from '@lancedb/lancedb'
import { Context, Effect, Layer, Option } from 'effect'
import { Errors } from 'llm-wiki-protocol'
import { join } from 'node:path'
import { makeVectorStore } from '../search/vector.js'
import { validatePageId } from './Embeddings.js'
import { CHUNK_TABLE, LANCEDB_DIR } from './spec.js'

export interface ChunkRow {
  readonly chunkId: string
  readonly pageId: string
  readonly chunkIndex: number
  readonly chunkText: string
  readonly headingPath: string
  readonly vector: ReadonlyArray<number>
}

export interface VectorTable {
  readonly checkoutLatest: Effect.Effect<void, Errors.EmbedError>
  readonly countPage: (pageId: string) => Effect.Effect<number, Errors.EmbedError>
  readonly deletePage: (pageId: string) => Effect.Effect<void, Errors.EmbedError>
  readonly addChunks: (rows: ReadonlyArray<ChunkRow>) => Effect.Effect<void, Errors.EmbedError>
}

export interface VectorStore {
  readonly openTable: (
    dbDir: string,
  ) => Effect.Effect<Option.Option<VectorTable>, Errors.EmbedError>
  readonly createTable: (
    dbDir: string,
    rows: ReadonlyArray<ChunkRow>,
  ) => Effect.Effect<VectorTable, Errors.EmbedError>
}

const storage = (message: string): Errors.EmbedError => new Errors.EmbedError({ kind: 'Storage', message })

const pageFilter = (pageId: string): string => `page_id = '${pageId}'`

const toRecord = (row: ChunkRow): Record<string, unknown> => ({
  chunk_id: row.chunkId,
  page_id: row.pageId,
  chunk_index: row.chunkIndex,
  chunk_text: row.chunkText,
  heading_path: row.headingPath,
  vector: [...row.vector],
})

const lanceTable = (table: Table): VectorTable => ({
  checkoutLatest: Effect.tryPromise({
    try: () => table.checkoutLatest(),
    catch: (error) => storage(`Checkout latest error: ${String(error)}`),
  }),
  countPage: (pageId) =>
    Effect.tryPromise({
      try: () => table.countRows(pageFilter(pageId)),
      catch: (error) => storage(`Count page chunks error: ${String(error)}`),
    }),
  deletePage: (pageId) =>
    Effect.tryPromise({
      try: async () => {
        await table.delete(pageFilter(pageId))
      },
      catch: (error) => storage(`Delete page chunks error: ${String(error)}`),
    }),
  addChunks: (rows) =>
    Effect.tryPromise({
      try: async () => {
        await table.add(rows.map(toRecord))
      },
      catch: (error) => storage(`Add chunks error: ${String(error)}`),
    }),
})

const connect = (dbDir: string): Effect.Effect<Connection, Errors.EmbedError> =>
  Effect.tryPromise({
    try: () => lancedb.connect(dbDir),
    catch: (error) => storage(`DB connect error: ${String(error)}`),
  })

export const lanceVectorStore: VectorStore = {
  openTable: (dbDir) =>
    Effect.gen(function*() {
      const connection = yield* connect(dbDir)
      const names = yield* Effect.tryPromise({
        try: () => connection.tableNames(),
        catch: (error) => storage(`List tables error: ${String(error)}`),
      })
      if (!names.includes(CHUNK_TABLE)) return Option.none<VectorTable>()
      const table = yield* Effect.tryPromise({
        try: () => connection.openTable(CHUNK_TABLE),
        catch: (error) => storage(`Open table error: ${String(error)}`),
      })
      return Option.some(lanceTable(table))
    }),
  createTable: (dbDir, rows) =>
    Effect.gen(function*() {
      const connection = yield* connect(dbDir)
      const table = yield* Effect.tryPromise({
        try: () => connection.createTable(CHUNK_TABLE, rows.map(toRecord)),
        catch: (error) => storage(`Create table error: ${String(error)}`),
      })
      return lanceTable(table)
    }),
}

/**
 * v1 (legacy) table name — one row per page. Ported from `TABLE_V1` in
 * `commands/vectorstore.rs`; only its row count is surfaced any more.
 */
export const LEGACY_TABLE = 'wiki_vectors'

export interface VectorIndexStats {
  readonly chunks: number
  readonly legacyRows: number
}

export interface VectorIndexShape {
  readonly stats: (projectRoot: string) => Effect.Effect<VectorIndexStats, Errors.EmbedError>
  readonly optimize: (projectRoot: string) => Effect.Effect<void, Errors.EmbedError>
  readonly clearChunks: (projectRoot: string) => Effect.Effect<number, Errors.EmbedError>
  readonly deletePage: (
    projectRoot: string,
    pageId: string,
  ) => Effect.Effect<number, Errors.EmbedError>
  readonly dropLegacy: (projectRoot: string) => Effect.Effect<boolean, Errors.EmbedError>
}

const dirOf = (projectRoot: string): string => join(projectRoot, LANCEDB_DIR)

const listTables = (connection: Connection): Effect.Effect<ReadonlyArray<string>, Errors.EmbedError> =>
  Effect.tryPromise({
    try: () => connection.tableNames(),
    catch: (error) => storage(`List tables error: ${String(error)}`),
  })

const openNamedTable = (
  connection: Connection,
  name: string,
): Effect.Effect<Table, Errors.EmbedError> =>
  Effect.tryPromise({
    try: () => connection.openTable(name),
    catch: (error) => storage(`Open table error: ${String(error)}`),
  })

const checkoutLatest = (table: Table): Effect.Effect<void, Errors.EmbedError> =>
  Effect.tryPromise({
    try: () => table.checkoutLatest(),
    catch: (error) => storage(`Checkout latest error: ${String(error)}`),
  })

const countRows = (
  table: Table,
  filter?: string,
): Effect.Effect<number, Errors.EmbedError> =>
  Effect.tryPromise({
    try: () => table.countRows(filter),
    catch: (error) => storage(`Count error: ${String(error)}`),
  })

export const lanceVectorIndex: VectorIndexShape = {
  stats: (projectRoot) =>
    Effect.gen(function*() {
      const connection = yield* connect(dirOf(projectRoot))
      const names = yield* listTables(connection)
      const chunks = names.includes(CHUNK_TABLE)
        ? yield* countRows(yield* openNamedTable(connection, CHUNK_TABLE))
        : 0
      const legacyRows = names.includes(LEGACY_TABLE)
        ? yield* countRows(yield* openNamedTable(connection, LEGACY_TABLE))
        : 0
      return { chunks, legacyRows }
    }),

  optimize: (projectRoot) =>
    Effect.mapError(
      makeVectorStore().optimizeIndex(dirOf(projectRoot)),
      (error) => storage(error.message),
    ),

  clearChunks: (projectRoot) =>
    Effect.gen(function*() {
      const connection = yield* connect(dirOf(projectRoot))
      const names = yield* listTables(connection)
      if (!names.includes(CHUNK_TABLE)) return 0
      const table = yield* openNamedTable(connection, CHUNK_TABLE)
      yield* checkoutLatest(table)
      const deleted = yield* countRows(table)
      yield* Effect.tryPromise({
        try: () => connection.dropTable(CHUNK_TABLE),
        catch: (error) => storage(`Drop chunk table error: ${String(error)}`),
      })
      return deleted
    }),

  deletePage: (projectRoot, pageId) =>
    Effect.gen(function*() {
      const invalid = validatePageId(pageId)
      if (invalid !== undefined) {
        return yield* Effect.fail(new Errors.EmbedError({ kind: 'InvalidRequest', message: invalid }))
      }
      const connection = yield* connect(dirOf(projectRoot))
      const names = yield* listTables(connection)
      if (!names.includes(CHUNK_TABLE)) return 0
      const table = yield* openNamedTable(connection, CHUNK_TABLE)
      yield* checkoutLatest(table)
      const result = yield* Effect.tryPromise({
        try: () => table.delete(pageFilter(pageId)),
        catch: (error) => storage(`Delete error: ${String(error)}`),
      })
      return result.numDeletedRows
    }),

  dropLegacy: (projectRoot) =>
    Effect.gen(function*() {
      const connection = yield* connect(dirOf(projectRoot))
      const names = yield* listTables(connection)
      if (!names.includes(LEGACY_TABLE)) return false
      yield* Effect.tryPromise({
        try: () => connection.dropTable(LEGACY_TABLE),
        catch: (error) => storage(`Drop legacy table error: ${String(error)}`),
      })
      return true
    }),
}

export class VectorIndex extends Context.Service<VectorIndex, VectorIndexShape>()(
  'llm-wiki-api-server/VectorIndex',
) {
  static readonly layer = (
    index: VectorIndexShape = lanceVectorIndex,
  ): Layer.Layer<VectorIndex> => Layer.succeed(VectorIndex, index)
}
