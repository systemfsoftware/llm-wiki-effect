import lancedb from '@lancedb/lancedb'
import type { Connection, Table } from '@lancedb/lancedb'
import { Effect, Option } from 'effect'
import { Errors } from 'llm-wiki-protocol'
import { CHUNK_TABLE } from './spec.js'

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
