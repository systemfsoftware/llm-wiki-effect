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
pnpm build          # bundle every package (turbo run build)
pnpm format         # dprint fmt
pnpm format:check   # dprint check
pnpm lint           # oxlint, type-aware, once per package
pnpm typecheck      # tsc --noEmit per package (turbo run typecheck)
pnpm test:mocks     # desktop app unit suite (no network, no API keys)
pnpm test:llm       # real-LLM suites — needs keys, not run in CI
pnpm api:build      # API server bundle: dist/src/entries/{worker,standalone}.js
pnpm api:test       # API server package tests
pnpm mcp:test       # MCP server package tests
pnpm gate:tasks     # lint + typecheck + every package's test task
pnpm check:ci       # the gate: format:check, gate:tasks, gate:dist
pnpm changeset      # record a change intent
pnpm release:version  # consume pending intents: version + CHANGELOG
```

## Commits

Conventional Commits: `<type>(<scope>): <subject>`. `commitlint.config.ts` holds
the type and scope enums; a `feat` or `fix` must touch production source, and a
docs-only, test-only, CI-only, or lockfile-only change must use its own type.
AI co-author trailers are rejected.

## Releases

Versioning is changeset-driven and scoped to the app. Nothing publishes to npm:
`llm-wiki` is private, and `llm-wiki-mcp-server`, `llm-wiki-protocol`, and
`llm-wiki-api-server` are excluded from the release plan in
`.changeset/config.json`.

1. Record the intent with the change, in the same PR:
   `pnpm changeset` (or write `.changeset/<name>.md` by hand). A PR touching
   `apps/desktop/src/**`, `apps/desktop/src-tauri/**`, or `extension/**` fails
   the `Changeset` job without one.
2. At release time, `pnpm release:version` bumps `apps/desktop/package.json`,
   writes `CHANGELOG.md`, deletes the intents it consumed, and syncs the copies
   in `apps/desktop/src-tauri/tauri.conf.json`,
   `apps/desktop/src-tauri/Cargo.toml` and `apps/desktop/src-tauri/Cargo.lock`.
   Prepend the in-app changelog entry (`en` + `zh`) in
   `apps/desktop/src/lib/changelog.ts` by hand —
   `apps/desktop/src/lib/changelog.test.ts` fails until its version matches.
3. Commit the result, tag `v<version>`, push the tag. `build.yml` runs on `v*`
   tags and that tag is what cuts the desktop release — everything else is a
   dry run. Tags and releases need explicit human approval.

## The API is RPC now

The desktop's in-process `/api/v1` HTTP API and its SSE framing are gone, and no
shim replaces them. The API is an Effect RPC server (`llm-wiki-api-server`) that
speaks the wire contract in `packages/protocol` (`llm-wiki-protocol`) as ndjson
frames: the desktop spawns it as a supervised worker and reaches it over a local
socket, and the same server runs standalone, serving RPC over HTTP on
`127.0.0.1:19828` with a WebSocket upgrade for streams.

Boot the standalone server and check health over RPC (`health` is the one
operation with neither auth nor the API/MCP gates):

```bash
LLM_WIKI_API_TOKEN=dev-token node apps/api-server/dist/src/entries/standalone.js &
printf '%s\n' '{"_tag":"Request","id":"1","tag":"health","payload":null,"headers":[]}' \
  | curl -sS --data-binary @- -H 'content-type: application/ndjson' http://127.0.0.1:19828/rpc
```

Transport-level failures stay transport-level (`404` off `/rpc`, `405` for a
non-POST, `415` for another content type). Application failures arrive as typed
errors inside the frame's `Exit`, never as a status code — the mapping from every
deleted status site is `packages/protocol/src/errors/ledger.ts`, and the error
classes it names are `packages/protocol/src/errors/errors.ts`.

Consumers migrate to one of the two in-repo surfaces:

- the MCP server (`apps/mcp-server`) — 11 `llm_wiki_*` tools with unchanged names,
  schemas, and result text;
- the protocol package's client factories (`packages/protocol/src/client`), used
  from a repository checkout — nothing in this workspace publishes to npm.

## Before you open a PR

`pnpm check:ci` green, working tree clean, and an app change carries a change
intent. See `AGENTS.md` for the definition of done and the surfaces that are
read-only.
