import { Effect, Option } from 'effect'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { sha256Hex } from './fingerprint.js'
import { REVISION_DIR } from './spec.js'

export const revisionPath = (projectRoot: string, pageId: string): string =>
  join(projectRoot, ...REVISION_DIR.split('/'), `${sha256Hex(pageId)}.revision`)

export const loadRevision = (
  projectRoot: string,
  pageId: string,
): Effect.Effect<Option.Option<string>> =>
  Effect.promise(async () => {
    try {
      const value = (await readFile(revisionPath(projectRoot, pageId), 'utf8')).trim()
      return value === '' ? Option.none() : Option.some(value)
    } catch {
      return Option.none()
    }
  })

export const saveRevision = (
  projectRoot: string,
  pageId: string,
  revision: string,
): Effect.Effect<boolean> =>
  Effect.promise(async () => {
    const path = revisionPath(projectRoot, pageId)
    const temporary = `${path}.tmp-${randomUUID()}`
    try {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(temporary, revision, 'utf8')
    } catch {
      return false
    }
    try {
      await rename(temporary, path)
      return true
    } catch {
      try {
        await rm(path, { force: true })
        await rename(temporary, path)
        return true
      } catch {
        await rm(temporary, { force: true })
        return false
      }
    }
  })

export const invalidateRevision = (projectRoot: string, pageId: string): Effect.Effect<void> =>
  Effect.promise(async () => {
    await rm(revisionPath(projectRoot, pageId), { force: true }).catch(() => undefined)
  })
