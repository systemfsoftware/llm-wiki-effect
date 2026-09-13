#!/usr/bin/env node
import lancedbPkg from '@lancedb/lancedb'

const { connect, Table } = lancedbPkg
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dim = 384
const rowCount = 64
const targetChunk = 3

const dir = mkdtempSync(join(tmpdir(), 'llm-wiki-lancedb-spike-'))
try {
  const db = await connect(dir)
  const vector = (seed) => Array.from({ length: dim }, (_, d) => Math.sin(seed * 0.1 + d) * 0.01)
  const rows = Array.from({ length: rowCount }, (_, i) => ({
    id: randomUUID(),
    chunk: `chunk-${i}`,
    vector: vector(i),
  }))
  const table = await db.createTable('embeddings', rows, { mode: 'overwrite' })
  if (!(table instanceof Table)) throw new Error('createTable did not return a Table')

  const reopened = await (await connect(dir)).openTable('embeddings')
  const count = await reopened.countRows()
  if (count !== rowCount) throw new Error(`row count drifted: ${count}`)

  const hits = await reopened.query().nearestTo(vector(targetChunk)).limit(5).toArray()
  if (hits.length !== 5) throw new Error(`vector query returned ${hits.length} hits`)
  if (hits[0].chunk !== `chunk-${targetChunk}`) throw new Error(`nearest hit wrong: ${hits[0].chunk}`)

  console.log('spike green', JSON.stringify({ rows: count, hits: hits.length, topHit: hits[0].chunk }))
  process.exit(0)
} catch (error) {
  console.error('spike red', error)
  process.exitCode = 1
} finally {
  rmSync(dir, { recursive: true, force: true })
}
