import { listDirectory, readFile } from '@/commands/fs'
import { normalizePath } from '@/lib/path-utils'
import type { FileNode } from '@/types/wiki'

export interface PageLinkEntry {
  title: string
  path?: string
  snippet?: string
}

export interface PageLinksResponse {
  outgoing: PageLinkEntry[]
  backlinks: PageLinkEntry[]
  missing: PageLinkEntry[]
}

const MAX_LINK_PAGES = 10_000
const SNIPPET_CONTEXT_CHARS = 80

interface WikiPage {
  readonly path: string
  readonly title: string
  readonly content: string
  readonly links: readonly string[]
}

function extractWikilinks(content: string): string[] {
  const links: string[] = []
  let rest = content
  for (;;) {
    const start = rest.indexOf('[[')
    if (start === -1) break
    rest = rest.slice(start + 2)
    const end = rest.indexOf(']]')
    if (end === -1) break
    const target = (rest.slice(0, end).split('|')[0] ?? '').trim()
    if (target !== '') links.push(target)
    rest = rest.slice(end + 2)
  }
  return links
}

function extractTitle(content: string, fileName: string): string {
  const hasFrontmatter = content.startsWith('---')
  let inFrontmatter = hasFrontmatter
  let frontmatterClosed = false
  const lines = content.split('\n')
  for (const line of lines.slice(hasFrontmatter ? 1 : 0)) {
    const trimmed = line.trim()
    if (inFrontmatter && trimmed === '---') {
      inFrontmatter = false
      frontmatterClosed = true
      continue
    }
    if (inFrontmatter && trimmed.startsWith('title:')) {
      return trimmed.slice('title:'.length).trim().replace(/^"|"$/g, '').replace(/^'|'$/g, '')
    }
    if (hasFrontmatter && !frontmatterClosed) continue
    if (trimmed.startsWith('# ')) return trimmed.slice(2).trim()
  }
  return fileName.replace(/\.md$/, '').replace(/-/g, ' ')
}

function buildSnippet(content: string, query: string): string {
  const index = content.toLowerCase().indexOf(query.toLowerCase())
  const matchIndex = index === -1 ? 0 : index
  const queryLength = Math.max(query.length, 1)
  const start = Math.max(matchIndex - SNIPPET_CONTEXT_CHARS, 0)
  const end = Math.min(matchIndex + queryLength + SNIPPET_CONTEXT_CHARS, content.length)
  let snippet = content.slice(start, end).replace(/\n/g, ' ')
  if (start > 0) snippet = `...${snippet}`
  if (end < content.length) snippet = `${snippet}...`
  return snippet
}

function flattenPages(nodes: readonly FileNode[], out: FileNode[]): void {
  for (const node of nodes) {
    if (out.length >= MAX_LINK_PAGES) return
    if (node.is_dir) {
      if (node.children) flattenPages(node.children, out)
      continue
    }
    if (node.name.endsWith('.md')) out.push(node)
  }
}

interface WikiIndex {
  readonly pages: ReadonlyMap<string, WikiPage>
  readonly byFilename: ReadonlyMap<string, string>
}

function resolveReaderWikilink(index: WikiIndex, link: string): string | undefined {
  const normalized = link.trim().replace(/\\/g, '/')
  if (normalized.includes('/')) {
    return index.pages.has(normalized) ? normalized : undefined
  }
  const filename = normalized.endsWith('.md') ? normalized : `${normalized}.md`
  return index.byFilename.get(filename)
}

function sortByTitle(entries: PageLinkEntry[]): PageLinkEntry[] {
  return [...entries].sort((left, right) => left.title < right.title ? -1 : left.title > right.title ? 1 : 0)
}

function dedupeBy(entries: PageLinkEntry[], key: (entry: PageLinkEntry) => string | undefined): PageLinkEntry[] {
  const out: PageLinkEntry[] = []
  for (const entry of entries) {
    const previous = out[out.length - 1]
    if (previous !== undefined && key(previous) === key(entry)) continue
    out.push(entry)
  }
  return out
}

export async function getPageLinks(
  projectPath: string,
  filePath: string,
): Promise<PageLinksResponse> {
  const project = normalizePath(projectPath)
  const target = normalizePath(filePath)
  const wikiRoot = `${project}/wiki`
  if (!target.startsWith(`${wikiRoot}/`) || !target.endsWith('.md')) {
    throw new Error('Page links target must be an existing Markdown file under wiki/')
  }

  let tree: FileNode[]
  try {
    tree = await listDirectory(wikiRoot)
  } catch {
    throw new Error('Page links target must be an existing Markdown file under wiki/')
  }

  const files: FileNode[] = []
  flattenPages(tree, files)

  const toRelative = (absolute: string): string =>
    absolute.startsWith(`${project}/`) ? absolute.slice(project.length + 1) : absolute

  const pages = new Map<string, WikiPage>()
  for (const file of files) {
    let content: string
    try {
      content = await readFile(file.path)
    } catch {
      continue
    }
    const path = toRelative(normalizePath(file.path))
    pages.set(path, {
      path,
      title: extractTitle(content, file.name),
      content,
      links: extractWikilinks(content),
    })
  }

  const sorted = [...pages.keys()].sort()
  const byFilename = new Map<string, string>()
  for (const path of sorted) {
    const filename = path.slice(path.lastIndexOf('/') + 1)
    if (!byFilename.has(filename)) byFilename.set(filename, path)
  }
  const index: WikiIndex = { pages, byFilename }

  const currentPath = toRelative(target)
  const current = pages.get(currentPath)
  if (current === undefined) {
    throw new Error('Page is not available in the current wiki index')
  }

  const outgoing: PageLinkEntry[] = []
  const missing: PageLinkEntry[] = []
  for (const link of current.links) {
    const targetPath = resolveReaderWikilink(index, link)
    if (targetPath === undefined) {
      missing.push({ title: link })
      continue
    }
    if (targetPath === currentPath) continue
    const page = pages.get(targetPath)
    if (page === undefined) continue
    outgoing.push({ title: page.title, path: page.path })
  }

  const backlinks: PageLinkEntry[] = []
  for (const page of pages.values()) {
    if (page.path === currentPath) continue
    const linksHere = page.links.some((link) => resolveReaderWikilink(index, link) === currentPath)
    if (linksHere) {
      backlinks.push({
        title: page.title,
        path: page.path,
        snippet: buildSnippet(page.content, current.title),
      })
    }
  }

  return {
    outgoing: dedupeBy(sortByTitle(outgoing), (entry) => entry.path),
    backlinks: sortByTitle(backlinks),
    missing: dedupeBy(sortByTitle(missing), (entry) => entry.title),
  }
}
