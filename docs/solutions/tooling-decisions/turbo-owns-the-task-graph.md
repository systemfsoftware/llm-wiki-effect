---
title: Turbo owns the task graph, and every task belongs to a package
date: 2026-09-13
category: tooling-decisions
module: build
problem_type: tooling_decision
component: tooling
severity: medium
applies_when:
  - Adding or renaming a task in turbo.json
  - Adding a script to a package under apps/ or packages/
  - A task reports FULL TURBO when it should have re-run
tags: [turbo, task-graph, monorepo, caching, pnpm-workspace]
---

# Turbo owns the task graph, and every task belongs to a package

## Context

This repo is a pnpm workspace of five packages: the desktop app under
`apps/desktop`, the API server under `apps/api-server`, the MCP server under
`apps/mcp-server`, the wire contract under `packages/protocol`, the shared lint
config under `packages/oxlint-config`, and the root package, which is a pure
orchestrator (no runtime dependencies, no version). `turbo` routes the gates,
matching the template the repo's toolchain was drawn from.

Every task belongs to a package. `turbo.json` defines only unqualified task
names — `lint`, `typecheck`, `build`, `test:mocks`, `test` — and the root
package owns no task at all: its scripts are the orchestrator entry points
(`gate:tasks`, `gate:dist`, `check:ci`) and `turbo run` wrappers. Measured on
turbo 2.10.12: a bare `turbo run <task>` selects only member packages' scripts,
so the root's wrapper scripts can never be selected by their own run.

## Guidance

**The orchestrator scripts must not share a name with a task.** `gate:tasks`,
`gate:dist`, and `check:ci` are the entry points, and none of them is a task
name. A root script named `build` that invoked `turbo run build` would re-enter
itself. Gate: `pnpm exec turbo run build --dry=json` lists
`llm-wiki#build`, `llm-wiki-api-server#build`, `llm-wiki-mcp-server#build`, and
`llm-wiki-protocol#build` (plus the typechecks they depend on) and never selects
the root; a recursive script would not terminate at all.

**`check:ci` stays a three-phase enumeration, not a turbo invocation.**
`check:ci` is `node scripts/check-ci.mjs format:check gate:tasks gate:dist`:
`format:check` still runs outside turbo, and the two turbo runs are its other
phases. The script runs each named phase separately so one failure does not hide
the rest, and it is Node rather than shell because `s=0; a || s=1; exit $s` is
not valid `cmd.exe`. Folding the phases into one `turbo run` would trade that
per-phase reporting for nothing — turbo already reports each task's outcome
inside a phase. Gate: `pnpm check:ci` prints one `[check:ci] <phase> ok` line per
phase.

**Task definitions are unqualified; only the gate's selection may name a
package.** `turbo.json` defines `lint`, `typecheck`, `build`, `test:mocks`, and
`test`, and turbo runs each in the packages that define the script. The gate
selects `llm-wiki#test:mocks` (the desktop's mock suite) plus a qualified `#test`
per shipped package because the desktop's own `test` script is the paid-API
suite (`pnpm test:mocks && pnpm test:llm`), which CI must not run; the qualified
name picks one package without giving `test` a package-specific definition. A
package-qualified key in `turbo.json` would instead make the task's `inputs`,
`outputs`, and `dependsOn` apply to that package alone. Gate:
`pnpm exec turbo run lint typecheck llm-wiki#test:mocks
llm-wiki-mcp-server#test llm-wiki-protocol#test llm-wiki-api-server#test
--dry=json` returns 18 task entries, every one backed by a real script and none
`<NONEXISTENT>` — an earlier gate spelled the desktop suite as the unqualified
`test:mocks`, which produced four phantom selections (one per package that does
not define the script) and is why the census is read per command and not per
entry.

**`dependsOn` replaces an inline chained command, and the release path restates
it.** The app's `build` script is `vite build`; the ordering that used to be
`pnpm typecheck && vite build` now lives in the `build` task's
`dependsOn: ["typecheck"]`. `build:desktop` is `turbo run typecheck build`, so
the Tauri `beforeBuildCommand` still typechecks before bundling. The MCP
`test` script likewise dropped its inline `pnpm build &&`, because the graph
supplies it. Gate: `pnpm build:desktop` from a deleted `apps/desktop/dist/` and
`apps/mcp-server/dist/` restores both.

**Narrow `inputs` only to trees the task provably cannot read, and prove the
narrowing with an A/B on a real edit.** `lint` keys on `$TURBO_DEFAULT$` plus
the files that can change its verdict outside the package's own sources: the
package's `oxlint.config.ts`, its `tsconfig*.json` (the type-aware pass reads
them), and the shared config package it extends
(`$TURBO_ROOT$/packages/oxlint-config/src/**` and its `package.json`) — so
editing one rule in the shared base re-runs every package's lint. `typecheck`
keys on the same tsconfig set. Both carry depth-free `!**/repos/**`, `lint`
also `!**/*.md`, and member-package `typecheck`/`build` keep the
package-relative negation `!src-tauri/**`, which resolves to
`apps/desktop/src-tauri/**` for the app and matches nothing for the MCP server.
What excludes which tree: the shared base's `ignorePatterns` are depth-free
(`**/src-tauri/**`, `**/repos/**`, `**/dist/**`), and the app's
`tsconfig.app.json` scopes to `apps/desktop/src`. (The A/B that justified the
first narrowing — 61 files under `src-tauri/` and 41 under `repos/`
over-claimed — predates the `apps/*` move; the negations it proved carry over
verbatim in depth-free form.) Gate: after a Rust-only edit to
`apps/desktop/src-tauri/src/main.rs`, the JS-task hashes are unchanged.

**A negation cannot be undone by naming the file back.** Turbo hoists every
`!`-pattern ahead of the positive globs, so
`["$TURBO_DEFAULT$", "!src-tauri/**", "src-tauri/Cargo.toml"]` resolves with the
negation first and the file stays excluded — measured, the resolved input map
contained zero `src-tauri` paths either way round. This is why
`llm-wiki#test:mocks` keeps the whole `src-tauri/` tree rather than trying to
keep two files out of it: `apps/desktop/src/lib/changelog.test.ts` reads
`apps/desktop/src-tauri/tauri.conf.json` and `apps/desktop/src-tauri/Cargo.toml`,
and it is the only guard against version skew between the app manifest, the
Tauri config, and the crate manifest. Gate: `llm-wiki#test:mocks` re-runs after
an `apps/desktop/src-tauri/Cargo.toml` edit.

**`dependsOn: ["^build"]` is not written, and the ordering it would add is not
declared anywhere.** `^` expands to a package's `directDependencies`, and the
graph now has edges — 7 of them, because every workspace package depends on
`llm-wiki-protocol` and `llm-wiki-oxlint-config` — so `^build` would change the
schedule today (it was a no-op when the graph had zero edges). What the graph as
written does _not_ declare is that `packages/protocol/dist` must exist before a
package that typechecks or bundles against it: `llm-wiki-api-server#typecheck`
resolves the dependency through `llm-wiki-protocol`'s
`exports.types -> ./dist/src/index.d.ts`, and its `dependencies` list is empty.
Measured with the TypeScript resolver against the API server's own entry import of
`llm-wiki-protocol`: the module resolves to
`packages/protocol/dist/src/index.d.ts`, and is `UNRESOLVED` when that file is
hidden — while `gate:tasks` schedules `llm-wiki-api-server#typecheck` with no
dependency on `llm-wiki-protocol#build`.
On a worktree that already has `packages/protocol/dist` this is invisible; from
a clean checkout nothing in the graph builds the protocol first. Gate:
`pnpm exec turbo run build --dry=json` shows `llm-wiki-api-server#build`
depending only on `llm-wiki-api-server#typecheck`, and schedules 10 entries (9
executing: the four `build`s and the five `typecheck`s that `build`'s
`dependsOn` pulls in; the tenth is `llm-wiki-oxlint-config#build`, which has no
script). This is recorded as an **open divergence** for the unit that owns
`turbo.json`, not as a settled decision.

**`outputs` must name only artifacts the task actually writes.** `test:mocks`
runs vitest without `--coverage`, so its `outputs` is `[]`. Listing a
`coverage/**` directory vitest never creates makes turbo warn
`no output files found for task` on every run and hides a real missing
artifact. Gate: `pnpm gate:tasks` produces no warning, and the MCP suite's
`dist-test/**` is present after a cached run.

**Options go after the subcommand, and the flags are literal.** The form is
`turbo run --concurrency=100% --continue <tasks>`. The template writes
`turbo --concurrency=${TURBO_CONCURRENCY:-50%} <tasks>`, which carries both a
missing subcommand and a POSIX-only expansion. The subcommand half fails with
`Cannot use run arguments before 'run' subcommand`. The expansion is the worse
half: pnpm runs package scripts through `cmd.exe` on Windows, where
`${TURBO_CONCURRENCY:-100%}` is literal text, so the Windows leg of the matrix
would pass `--concurrency=${TURBO_CONCURRENCY:-100%}` as a value. The repo
already paid for this lesson once — `scripts/check-ci.mjs` exists precisely
because `s=0; a || s=1; exit $s` is not valid `cmd.exe`. Gate: `pnpm gate:tasks`
exits 0 on all three matrix platforms, and `pnpm exec turbo run build --dry=json`
resolves the flag.

## Why This Matters

A cached task that cannot miss is worse than no cache: it reports a green run
for code the task never looked at. The failure is silent in exactly the way that
makes CI untrustworthy, because the output line reads `FULL TURBO` either way.

The graph is small but no longer edgeless: five packages and 7 dependency edges,
because each package depends on `llm-wiki-protocol` for the wire contract and on
`llm-wiki-oxlint-config` for the shared lint base. The app still does not depend
on the MCP server as a package — it bundles it as a Tauri resource — so most of
the value is content-addressed caching and `--continue` rather than fan-out, and
the edges are _not_ automatically cache keys: no task declares a `^`-prefixed
dependency, so a task hashes its own package's inputs rather than its
dependency's task results. Editing protocol source re-runs
`llm-wiki-protocol#build` and, without `^build`, nothing downstream — and a task
whose only reading of a dependency is that dependency's built `dist` can go green
on a stale one.

## Architectural Invariants

**A task's inputs are a claim about what can change its result.** A wildcard
that misses a file makes the task pass on stale output; an input list that
includes an unrelated tree makes the cache useless. Both failure modes look
identical from the outside. The defence is a deliberate negative: break a file
the task is supposed to read and confirm the task re-runs and fails.

**An orchestrator is not a task.** The moment an entry-point script shares a
name with a task, running it in a package that defines the task re-enters it.
Names are the only thing separating the two, so they are load-bearing rather
than cosmetic.

**A gate declares what it runs, and `--dry=json` is how that is checked.**
Task selection is not obvious: `turbo run lint typecheck test:mocks …` reports
the same task list whether or not a package actually defines the script, so
"it was scheduled" and "it ran" are different facts.

**Cache correctness is proven by a negative, not by a positive.** `FULL TURBO`
on a clean tree and `FULL TURBO` on a broken tree print the same summary. The
only evidence that separates them is an injected defect and a cache miss.

## When to Apply

- Adding, renaming, or removing a script in a package.json (root or an app
  package under apps/).
- Changing `inputs`, `outputs`, or `dependsOn` in `turbo.json`.
- A gate that reports `FULL TURBO` on a tree whose files just changed.

## Examples

The anti-vacuity probe, which is the check this document exists for (totals as
recorded pre-move; today's task list is the 17-task gate block above):

```text
write src/__turbo-cache-probe.ts:  const probe: number = 'not a number'
pnpm gate:tasks
  llm-wiki:typecheck: cache miss, executing …
  llm-wiki:typecheck: error TS2322: Type 'string' is not assignable to type 'number'.
  llm-wiki:lint:      cache miss, executing …
  Tasks:    4 successful, 6 total
  Cached:   3 cached, 6 total
  Failed:   llm-wiki#lint, llm-wiki#typecheck     exit 2

rm src/__turbo-cache-probe.ts
pnpm gate:tasks
  Tasks:    6 successful, 6 total
  Cached:   6 cached, 6 total
  Time:    16ms >>> FULL TURBO
```

The cold-gate measurement this doc was founded on: `pnpm gate:tasks` ran six
tasks in about 13 seconds pre-move (it schedules 18 executing tasks today); the
same command on an unchanged tree finishes in under a tenth of a second. Deleting
`apps/desktop/dist/` and `apps/mcp-server/dist/` and running
`pnpm build:desktop` restores both from cache, which is what makes the
`outputs` keys load-bearing rather than decorative.

The A/B that justifies the input narrowing. Each side was warmed to
`FULL TURBO` with its own `turbo.json`, then given exactly one edit to a tracked
file under `apps/desktop/src-tauri/` (paths below are as measured pre-move):

```text
                inputs as first written          inputs narrowed
                (527 files per root task)        (425 lint/typecheck, 486 test:mocks)
Rust-only edit  3 cached, 6 total                5 cached, 6 total
                lint/typecheck/test:mocks miss   test:mocks miss only
src/ edit       3 cached, 6 total                3 cached, 6 total
                lint/typecheck/test:mocks miss   lint/typecheck/test:mocks miss
Cargo.toml edit 3 cached, 6 total                5 cached, 6 total
                lint/typecheck/test:mocks miss   test:mocks miss only
```

The `apps/desktop/src-tauri/Cargo.toml` row is the one that keeps the narrowing
honest: the task that must notice a crate-version edit still does, while `lint`,
`typecheck` and `build` correctly do not re-run for it.

The graph itself. The counts below were re-measured after the API-server
extraction; re-measure after any workspace change:

```text
turbo query 'query { packageGraph { nodes { items { name } length } edges { items { source target } length } } }'
  5 nodes (llm-wiki, llm-wiki-api-server, llm-wiki-mcp-server,
           llm-wiki-oxlint-config, llm-wiki-protocol), 7 edges
  each package -> llm-wiki-protocol and -> llm-wiki-oxlint-config;
  llm-wiki-protocol -> llm-wiki-oxlint-config

turbo query 'query { boundaries { items { message path } length } }'
  0 diagnostics today. The pre-move run reported 10, all under `repos/` —
  `@std/fs`, `@std/path`, `@std/yaml` imported by vendored Deno scripts.
```

One hypothesis was written down and then refuted, which is why it is recorded
here rather than acted on (paths as they were pre-move):
`apps/desktop/src/components/layout/icon-sidebar.tsx` imports
`@/assets/logo.jpg`, and `vite.config.ts` aliases `@` to `./src`. The import
resolves to `apps/desktop/src/assets/logo.jpg`, not to the root `assets/`
directory of nine marketing screenshots — the built `dist/assets/logo-*.jpg` is
byte-identical to `apps/desktop/src/assets/logo.jpg` (same md5) and no
root-`assets` file appears in `dist/`. Excluding `assets/**` from `build`'s
inputs would therefore have been safe, not a regression; it was left in place
only because those nine files do not churn.

Today the graph is five packages plus the root orchestrator, with 7 edges among
them — `llm-wiki-protocol` and `llm-wiki-oxlint-config` are dependencies of every
other package, and the protocol depends on the lint config. The root owns no
task: a dry run lists no `//#` entry, and every task key is `package#task`.

## Where this landed in CI

`.github/workflows/ci.yml` restores `.turbo/cache` under
`turbo-${{ runner.os }}-gate-${{ github.event.pull_request.head.sha || github.sha }}`
with prefix `restore-keys`, so the gate's 18 executing tasks run warm on all
three matrix platforms instead of cold. The key names the pull request's head commit rather
than `github.sha`, because on a `pull_request` event `github.sha` is the merge
commit GitHub synthesizes for the run: it moves every time the base branch does,
so the exact key would miss on every PR and only the prefix fallback would
supply a cache. The same workflow gained a merge-conflict preflight
(`conflict-check.yml`, a `git merge-tree` against the PR base, annotated
`::error title=merge conflicts::`) and a 45-minute job timeout. Gate: a run on
an unchanged tree reports `FULL TURBO` and the conflict job exits 0.

One legibility idea was dropped rather than shipped. `OXLINT_FORMAT=github`
turns each lint finding into a `::error file=…,line=…,col=…` annotation, and
oxlint does emit it — `pnpm exec oxlint … --format=github` produced
`::error file=src/__ci-annotation-probe.ts,line=1,endLine=1,col=14,endColumn=24,title=typescript(TS2322)::…`
on a planted type error. But the `lint` script is
`oxlint . --type-aware --type-check` with no format hook, and adding one needs
either a POSIX shell expansion — which breaks the Windows leg that
`scripts/check-ci.mjs` exists to protect — or a second lint definition, which
breaks the one-gate-definition rule. Turbo naming the failing task
(`Failed: llm-wiki#lint`) is what carries the failure instead.
