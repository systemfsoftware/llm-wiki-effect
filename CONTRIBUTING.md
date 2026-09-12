# Contributing

## Prerequisites

- Node.js `>=24`
- pnpm `>=11.21.0` (the `packageManager` field pins the exact version; Corepack resolves it)
- Rust stable + the Tauri platform prerequisites, to build the desktop app

## Setup

```bash
git clone <your-repo-url>
cd llm-wiki-effect
pnpm install
```

`pnpm install` also installs the git hooks (husky): pre-commit formats and lints
staged files, commit-msg enforces the commit format, pre-push keeps `main` from
falling behind `origin/main`.

## Commands

```bash
pnpm dev            # Vite dev server (pnpm tauri dev for the desktop shell)
pnpm build          # typecheck + frontend build
pnpm format         # dprint fmt
pnpm format:check   # dprint check
pnpm lint           # oxlint, type-aware
pnpm typecheck      # tsc --build
pnpm test:mocks     # unit suites (no network, no API keys)
pnpm test:llm       # real-LLM suites — needs keys, not run in CI
pnpm mcp:test       # MCP server package tests
pnpm check:ci       # the gate: format, lint, build, both suites
```

## Commits

Conventional Commits: `<type>(<scope>): <subject>`. `commitlint.config.ts` holds
the type and scope enums; a `feat` or `fix` must touch production source, and a
docs-only, test-only, CI-only, or lockfile-only change must use its own type.
AI co-author trailers are rejected.

## Before you open a PR

`pnpm check:ci` green, working tree clean. See `AGENTS.md` for the definition of
done and the surfaces that are read-only.
