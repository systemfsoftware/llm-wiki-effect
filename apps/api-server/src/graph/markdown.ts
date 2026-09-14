// Ported from the graph helpers in apps/desktop/src-tauri/src/{api_server.rs,commands/search.rs}.

const trimQuoteRuns = (value: string): string => value.replace(/^["']+/, '').replace(/["']+$/, '')

export const extractTitle = (content: string, fileName: string): string => {
  const hasFrontmatter = content.startsWith('---')
  let inFrontmatter = hasFrontmatter
  let frontmatterClosed = false
  const lines = content.split('\n')
  for (let index = hasFrontmatter ? 1 : 0; index < lines.length; index += 1) {
    const trimmed = (lines[index] ?? '').trim()
    if (inFrontmatter && trimmed === '---') {
      inFrontmatter = false
      frontmatterClosed = true
      continue
    }
    if (inFrontmatter && trimmed.startsWith('title:')) {
      return trimQuoteRuns(trimmed.slice('title:'.length).trim())
    }
    if (hasFrontmatter && !frontmatterClosed) continue
    if (trimmed.startsWith('# ')) return trimmed.slice(2).trim()
  }
  return fileName.replace(/(?:\.md)+$/, '').replaceAll('-', ' ')
}

export const extractType = (content: string): string => {
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('type:')) continue
    return trimQuoteRuns(trimmed.slice('type:'.length).trim()).toLowerCase()
  }
  return 'other'
}

export const extractWikilinks = (content: string): ReadonlyArray<string> => {
  const links: Array<string> = []
  let rest = content
  for (;;) {
    const start = rest.indexOf('[[')
    if (start === -1) break
    rest = rest.slice(start + 2)
    const end = rest.indexOf(']]')
    if (end === -1) break
    const inner = rest.slice(0, end)
    const pipe = inner.indexOf('|')
    const target = (pipe === -1 ? inner : inner.slice(0, pipe)).trim()
    if (target !== '') links.push(target)
    rest = rest.slice(end + 2)
  }
  return links
}
