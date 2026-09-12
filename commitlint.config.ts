import type { UserConfig } from '@commitlint/types'
import { execFileSync } from 'node:child_process'

const SCOPES = [
  'repo',
  'deps',
  'release',
  'ci',
  'global',
  'solutions',
  'build',
  'lint',
  'ui',
  'chat',
  'ingest',
  'wiki',
  'graph',
  'search',
  'settings',
  'sources',
  'research',
  'i18n',
  'mcp',
  'tauri',
  'extension',
] as const

const matchesAny = (...patterns: readonly RegExp[]) => (path: string) => patterns.some((p) => p.test(path))

const isDoc = matchesAny(
  /\.mdx?$/,
  /^docs\//,
  /^plans\//,
  /(^|\/)README\.md$/i,
  /(^|\/)AGENTS\.md$/i,
  /(^|\/)CLAUDE\.md$/i,
  /(^|\/)CONSTITUTION\.md$/i,
  /(^|\/)CONTRIBUTING\.md$/i,
  /(^|\/)CHANGELOG\.md$/i,
)

const isTest = matchesAny(
  /\.(test|spec|tst)\.(ts|tsx|js|jsx|mjs|cjs)$/,
  /(^|\/)__tests__\//,
  /(^|\/)__mocks__\//,
  /(^|\/)tests?\//,
  /(^|\/)test-helpers\//,
  /(^|\/)e2e\//,
  /(^|\/)fixtures\//,
)

const isCI = matchesAny(/^\.github\//)

const isLockfile = matchesAny(
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)package-lock\.json$/,
  /(^|\/)Cargo\.lock$/,
  /(^|\/)bun\.lockb?$/,
  /(^|\/)yarn\.lock$/,
)

const isTooling = matchesAny(
  /^\.husky\//,
  /(^|\/)commitlint\.config\.[mc]?[jt]s$/,
  /(^|\/)\.lintstagedrc(\..+)?$/,
  /(^|\/)vitest\.config\.[mc]?[jt]s$/,
  /(^|\/)vite\.config\.[mc]?[jt]s$/,
  /(^|\/)tsconfig.*\.json$/,
  /(^|\/)\.editorconfig$/,
  /(^|\/)\.gitignore$/,
  /(^|\/)oxlint\.config\.[mc]?[jt]s$/,
  /(^|\/)dprint\.json$/,
  /(^|\/)package\.json$/,
  /(^|\/)pnpm-workspace\.yaml$/,
  /(^|\/)\.npmrc$/,
  /^bin\//,
  /^src-tauri\/tauri\..*\.json$/,
  /^src-tauri\/Cargo\.toml$/,
)

const ALLOWED_BY_SHAPE: readonly {
  readonly name: string
  readonly match: (path: string) => boolean
  readonly allowed: Readonly<Record<string, true>>
}[] = [
  { name: 'docs', match: isDoc, allowed: { docs: true, chore: true } },
  { name: 'test', match: isTest, allowed: { test: true, chore: true, fix: true } },
  { name: 'CI', match: isCI, allowed: { ci: true, chore: true, build: true } },
  { name: 'lockfile', match: isLockfile, allowed: { deps: true, chore: true, release: true, build: true } },
  {
    name: 'tooling',
    match: isTooling,
    allowed: { chore: true, build: true, ci: true, deps: true, release: true, security: true },
  },
]

const stagedFiles = (): readonly string[] => {
  try {
    const output = execFileSync('git', ['diff', '--cached', '--name-only'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'] as const,
    })
    return output
      .split('\n')
      .map((l: string) => l.trim())
      .filter((l: string) => l.length > 0)
  } catch {
    return []
  }
}

const configuration: UserConfig = {
  extends: ['@commitlint/config-conventional'],

  plugins: [
    {
      rules: {
        'no-ai-coauthors': ({ raw }) => {
          if (raw == null || raw === '') {
            return [true, 'OK']
          }

          const aiEmailPatterns = [
            /noreply@anthropic\.com/i,
            /cursoragent@cursor\.com/i,
            /noreply@aider\.dev/i,
            /cascade@windsurf\.com/i,
            /noreply@codeium\.com/i,
            /clio-agent@sisyphuslabs\.ai/i,
            /factory-droid\[bot\]@users\.noreply\.github\.com/i,
          ] as const

          const coauthorLines = raw.match(/^Co-?-?[Aa]uthored-by:.*$/gim) || []
          const aiModelPatterns = [
            /\b(Claude\s+)?(Opus|Sonnet|Haiku)\b/i,
            /\bgpt-4o\b/i,
            /\bClaude\b.*\b3\.\d+\b/i,
          ] as const
          const hasAIModelInCoauthor = coauthorLines.some((line: string) =>
            aiModelPatterns.some((pattern) => pattern.test(line))
          )

          const hasAIEmail = aiEmailPatterns.some((pattern) => pattern.test(raw))
          if (hasAIEmail || hasAIModelInCoauthor) {
            return [false, 'AI co-authors and AI model references are not allowed in commit messages']
          }
          return [true, 'OK']
        },

        'type-matches-diff-shape': ({ type }) => {
          const files = stagedFiles()
          if (files.length === 0 || type == null || type === '') return [true, 'OK']

          const allMatch = (m: (p: string) => boolean) => files.every(m)

          for (const shape of ALLOWED_BY_SHAPE) {
            if (allMatch(shape.match) && !(type in shape.allowed)) {
              const allowed = Object.keys(shape.allowed).sort().join(' / ')
              return [false, `'${type}' with 100% ${shape.name} paths — REQUIRED type: ${allowed}`]
            }
          }

          if (type === 'feat' || type === 'fix') {
            const hasProductionSource = files.some(
              (p) => !isDoc(p) && !isTest(p) && !isCI(p) && !isLockfile(p) && !isTooling(p),
            )
            if (!hasProductionSource) {
              return [
                false,
                `'${type}' MUST touch >=1 production source file (none of: docs, test, CI, lockfile, tooling)`,
              ]
            }
          }

          return [true, 'OK']
        },
      },
    },
  ],

  rules: {
    'no-ai-coauthors': [2, 'always'],
    'type-matches-diff-shape': [2, 'always'],

    'type-enum': [
      2,
      'always',
      [
        'build',
        'chore',
        'ci',
        'deps',
        'docs',
        'feat',
        'fix',
        'perf',
        'refactor',
        'release',
        'revert',
        'security',
        'style',
        'test',
      ],
    ],

    'scope-enum': [2, 'always', [...SCOPES]],
    'scope-case': [2, 'always', 'kebab-case'],

    'type-case': [2, 'always', 'lower-case'],
    'type-empty': [2, 'never'],

    'subject-case': [0],
    'subject-empty': [2, 'never'],
    'subject-full-stop': [2, 'never', '.'],

    'header-max-length': [0],
    'body-max-line-length': [0],
    'footer-max-line-length': [0],
    'body-leading-blank': [0],
    'footer-leading-blank': [0],

    'header-full-stop': [2, 'never', '.'],
    'body-full-stop': [2, 'never', '.'],

    'references-empty': [1, 'never'],
  },

  defaultIgnores: true,
  ignores: [(commit) => commit.startsWith("Squashed '") || commit.includes('git-subtree-dir:')],
  formatter: '@commitlint/format',
}

export default configuration
