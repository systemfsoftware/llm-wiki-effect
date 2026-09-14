---
title: Monorepoify layout plan — claims superseded by the Effect RPC extraction
type: note
date: 2026-09-13
---

# Monorepoify layout: superseded claims

`docs/plans/2026-09-13-0724-refactor-monorepoify-apps-layout-plan.md` is a
started, frozen plan and is not rewritten. This note records the claims in it
that later work falsified, so nothing cites them as current. Authority for the
API surface is
`docs/plans/2026-09-13-1745-refactor-effect-rpc-server-plan-v2.md`.

| Frozen claim                                              | Current state (measured 2026-09-13)                                                                                                                                                          |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm-workspace.yaml` is `["apps/*"]`                     | `["apps/*", "packages/*"]` — five workspace packages: `apps/desktop`, `apps/api-server`, `apps/mcp-server`, `packages/protocol`, `packages/oxlint-config`                                    |
| "exactly seven tasks with no phantom entries"             | `pnpm gate:tasks` schedules 21 entries, 17 of them carrying a command; the other four (`test:mocks` in the API server, MCP server, protocol, and lint-config packages) define no such script |
| KTD4: one root `oxlint.config.ts` stays                   | no root `oxlint.config.ts` and no root `tsconfig.json`; each package owns a three-line config spreading the shared base (`pnpm lint` = `turbo run lint`, 5 tasks)                            |
| KTD6: register `//#lint` and `//#typecheck`               | neither is registered; a dry run lists no `//#` entry                                                                                                                                        |
| R4: the desktop bundles only the MCP server as a resource | `tauri.{linux,macos,windows}.conf.json` also bundle `api-server/package.json` and `api-server/dist`                                                                                          |
| The desktop hosts the in-process Rust API server          | deleted; `src-tauri` supervises an `apps/api-server` worker over a local socket (R2, R11 of the RPC plan)                                                                                    |

The counts re-derive from the gates recorded in
`docs/solutions/tooling-decisions/turbo-owns-the-task-graph.md` and
`docs/solutions/tooling-decisions/per-package-lint-from-a-shared-base.md`. The
pre-RPC plan file `docs/plans/2026-09-13-1612-refactor-effect-rpc-server-plan.md`
is superseded by the `-1745-…-plan-v2.md` file linked above; no document in the
repo referenced the old path (checked 2026-09-13), so no re-point was needed.
