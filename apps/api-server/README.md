# LLM Wiki API Server

`llm-wiki-api-server` is the deployable LLM Wiki API: an Effect RPC server that serves the full protocol with no desktop app present.

The wire contract lives in [`packages/protocol`](../../packages/protocol) (`llm-wiki-protocol`) — schemas, the RPC group, typed errors, client factories, and the operation catalog. This package supplies the server side of that contract.

## Entries

- `src/entries/worker.ts` (built to `dist/src/entries/worker.js`) — the desktop-hosted worker: the app's Rust supervisor spawns this process and talks to it over local IPC. No network listener exists in this mode.
- `src/entries/standalone.ts` (built to `dist/src/entries/standalone.js`) — the standalone server: RPC over HTTP with a WebSocket upgrade for streams, token-authenticated.

Both entries are no-export program entries: running one _is_ the declaration.

## Build and run

`apps/api-server/` is a pnpm workspace package, so the root install already provides its dependencies.

```bash
pnpm install
pnpm api:build                          # bundles dist/src/entries/{worker,standalone}.js
node apps/api-server/scripts/smoke.mjs  # boots both built entries and checks their version output
```

## Checks

```bash
pnpm --filter llm-wiki-api-server typecheck
pnpm --filter llm-wiki-api-server lint
pnpm --filter llm-wiki-api-server test
pnpm api:test                           # same suite through turbo, across the workspace graph
```

The package is bundled into the desktop app as a Tauri resource (`api-server/package.json` and `api-server/dist`), so a packaged build resolves its entry without a repository checkout — hence the layout-robust version resolution in `src/version.ts`.
