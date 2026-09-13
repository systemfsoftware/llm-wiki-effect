export type ToolEffect = 'read' | 'write' | 'network' | 'process'

export const SHELL_EXEC_TIMEOUT_SECONDS = 30

export type ToolParameters = Readonly<Record<string, unknown>>

export interface ToolSpec {
  readonly name: string
  readonly description: string
  readonly effects: ReadonlyArray<ToolEffect>
  readonly parameters: ToolParameters | null
}

const QUERY_TOP_K: ToolParameters = {
  type: 'object',
  properties: {
    query: { type: 'string' },
    topK: { type: 'integer', minimum: 1, maximum: 10 },
  },
  required: ['query'],
}

const PATH_ONLY: ToolParameters = {
  type: 'object',
  properties: { path: { type: 'string' } },
  required: ['path'],
}

export const TOOL_SPECS: ReadonlyArray<ToolSpec> = [
  {
    name: 'wiki.search',
    description: 'Search generated LLM Wiki pages using backend keyword/vector retrieval.',
    effects: ['read'],
    parameters: QUERY_TOP_K,
  },
  {
    name: 'wiki.read_page',
    description: 'Read a project wiki markdown page by project-relative path.',
    effects: ['read'],
    parameters: PATH_ONLY,
  },
  {
    name: 'source.search',
    description: 'Search raw source files stored under raw/sources for exact keyword snippets.',
    effects: ['read'],
    parameters: QUERY_TOP_K,
  },
  {
    name: 'web.search',
    description: 'Search external web sources when the user enables web search.',
    effects: ['network'],
    parameters: QUERY_TOP_K,
  },
  {
    name: 'graph.search',
    description:
      'Retrieve graph relationships, neighbors, backlinks, dependencies, and connections between project entities. Use concise entity or concept names rather than a full question.',
    effects: ['read'],
    parameters: QUERY_TOP_K,
  },
  {
    name: 'anytxt.search',
    description: 'Search files indexed by an AnyTXT JSON-RPC service.',
    effects: ['network', 'read'],
    parameters: QUERY_TOP_K,
  },
  {
    name: 'deep_research.run',
    description: 'Collect broader external/local evidence for deep research turns before synthesis.',
    effects: ['network', 'read'],
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        sources: { type: 'array', items: { enum: ['web', 'anytxt', 'wiki', 'source'] } },
      },
      required: ['query'],
    },
  },
  {
    name: 'wiki.write_page',
    description:
      'Create a Markdown wiki page under wiki/ with project-bound path checks. Existing files require allowOverwrite=true.',
    effects: ['write'],
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Project-relative path such as wiki/queries/new-page.md',
        },
        content: { type: 'string' },
        allowOverwrite: {
          type: 'boolean',
          description:
            'Defaults to false. Set true only when the user explicitly asks to overwrite an existing wiki page.',
        },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'llm.generate',
    description: 'Generate a final assistant answer from retrieved context.',
    effects: ['network'],
    parameters: null,
  },
  {
    name: 'skills.load',
    description: 'Load instruction-only project skills from .llm-wiki/skills.',
    effects: ['read'],
    parameters: null,
  },
  {
    name: 'skill.read_file',
    description: 'Read a text reference file from an active skill directory by relative path.',
    effects: ['read'],
    parameters: {
      type: 'object',
      properties: {
        skill: {
          type: 'string',
          description: 'Optional active skill name; required when multiple skills are active.',
        },
        path: {
          type: 'string',
          description: 'Relative path inside the active skill directory, such as references/types.md.',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'workspace.write_file',
    description: 'Write a generated artifact file under the visible agent-workspace directory.',
    effects: ['write'],
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Relative path under agent-workspace, such as cover-image/cover.svg.',
        },
        content: { type: 'string' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'workspace.append_file',
    description:
      'Append generated artifact content under agent-workspace. Use after workspace.write_file for large HTML/PPT files.',
    effects: ['write'],
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Relative path under agent-workspace, matching the file being appended.',
        },
        content: { type: 'string' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'shell.exec',
    description: 'Run a project-scoped shell command requested by an active skill instruction.',
    effects: ['read', 'process'],
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        timeoutSeconds: { type: 'integer', minimum: 1, maximum: SHELL_EXEC_TIMEOUT_SECONDS },
      },
      required: ['command'],
    },
  },
]

const SPECS_BY_NAME: Record<string, ToolSpec> = Object.fromEntries(
  TOOL_SPECS.map((spec) => [spec.name, spec]),
)

export const specFor = (name: string): ToolSpec | undefined => SPECS_BY_NAME[name]

export const requiresApproval = (spec: ToolSpec): boolean => spec.effects.includes('process')
