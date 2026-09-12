# llm-wiki

Tauri desktop app: Rust shell + React UI, plus a workspace MCP server and a
Chrome clipper.

## Boundaries

| Surface        | Paths                                                                                                                   | Rule                                            |
| -------------- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Evaluator      | `oxlint.config.ts`, `dprint.json`, `commitlint.config.ts`, `.lintstagedrc.js`, `tsconfig*.json`, `.github/workflows/**` | Read-only. Never edit to make your change pass. |
| Doctrine       | `AGENTS.md`                                                                                                             | Edit only on explicit direction.                |
| Vendored       | `extension/Readability.js`, `extension/Turndown.js`, `src-tauri/pdfium/**`, `llm-wiki.md`                               | Third-party. Never hand-edit.                   |
| Human approval | Releases, tags, signing keys, npm publishing                                                                            | Ask first.                                      |
| Editable       | `src/**`, `src-tauri/src/**`, `mcp-server/**`, `docs/solutions/**`                                                      | Edit freely.                                    |

## Definition of Done

| id   | Rule                                 | Gate                               |
| ---- | ------------------------------------ | ---------------------------------- |
| LW-1 | dprint reports no diff               | `pnpm format:check`                |
| LW-2 | oxlint reports no finding            | `pnpm lint`                        |
| LW-3 | Types check in app and node projects | `pnpm typecheck`                   |
| LW-4 | Unit and MCP suites pass             | `pnpm test:mocks && pnpm mcp:test` |
| LW-5 | LW-1 to LW-4 in one command          | `pnpm check:ci`                    |
| LW-6 | An app change ships a change intent  | `Changeset` job / `pnpm changeset` |

`pnpm test` also runs `test:llm`, which needs paid API keys and a built app;
CI and local gates use `pnpm test:mocks`.

## Layout

- `src/` — React UI. Pure helpers in `src/lib/`, Tauri calls in `src/commands/`, state in `src/stores/`.
- `src-tauri/` — Rust shell and the local HTTP API on `127.0.0.1:19828`.
- `mcp-server/` — workspace package, bundled into the app as a resource.
- `extension/` — Chrome clipper.
- `docs/solutions/<category>/<slug>.md` — one durable doc per solved problem.
- `.changeset/` — pending change intents. `pnpm release:version` is
  `changeset version` (bumps `package.json`, writes `CHANGELOG.md` on the first
  release, deletes the intents it consumed) followed by `pnpm version:sync`
  (`scripts/sync-app-version.mjs`, which rewrites the copies in
  `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` and `src-tauri/Cargo.lock`).
  `src/lib/changelog.test.ts` holds those three equal to `package.json`, plus the
  app version shown in the in-app changelog; that entry in `src/lib/changelog.ts`
  is the one step a release still writes by hand.

## End of Session

Commit with `<type>(<scope>): <subject>`; commitlint enforces the type and scope
enums and rejects AI co-author trailers. Leave the tree clean and `pnpm check:ci`
green.
