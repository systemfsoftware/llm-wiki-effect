import { basename } from 'node:path'

export const normalizePath = (path: string): string => path.replace(/\\/g, '/')

export const fileStem = (path: string): string => {
  const name = basename(normalizePath(path))
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(0, dot) : name
}

export const chunkDbPath = (projectRoot: string): string =>
  `${normalizePath(projectRoot).replace(/\/+$/, '')}/.llm-wiki/lancedb`
