---
title: Turbo owns the task graph, and a workspace-listed root package owns tasks
date: 2026-09-13
category: tooling-decisions
module: build
problem_type: tooling_decision
component: tooling
severity: medium
applies_when:
  - Adding or renaming a task in turbo.json
  - Adding a script to the root package.json or to mcp-server
  - A task reports FULL TURBO when it should have re-run
tags: [turbo, task-graph, monorepo, caching, pnpm-workspace]
---

# Turbo owns the task graph, and a workspace-listed root package owns tasks

## Context

This repo is a pnpm workspace of exactly two projects: the desktop app, which
lives at the repository root, and the MCP server under `mcp-server`. `turbo`
was installed and the gates were routed through it, matching the template the
repo's toolchain was drawn from.

The shape differs from that template in one way that changes every rule below.
The template's `pnpm-workspace.yaml` lists only `apps/*` and `packages/*`, so
its root `package.json` is a pure orchestrator with no task scripts of its own.
This repo lists `"."` explicitly, so the root **is** a task-owning package.

## Guidance

**The orchestrator scripts must not share a name with a task.** `gate:tasks`,
`gate:dist`, and `check:ci` are the entry points, and none of them is a task
name. A root script named `build` that invoked `turbo run build` would re-enter
itself. Gate: `pnpm exec turbo run build --dry=json` lists
`llm-wiki#build` and `llm-wiki-mcp-server#build`; a recursive script would not
terminate at all.

**`check:ci` stays a three-phase enumeration, not a turbo invocation.**
`check:ci` is `node scripts/check-ci.mjs format:check gate:tasks gate:dist`:
`format:check` still runs outside turbo, and the two turbo runs are its other
phases. The script runs each named phase separately so one failure does not hide
the rest, and it is Node rather than shell because `s=0; a || s=1; exit $s` is
not valid `cmd.exe`. Folding the phases into one `turbo run` would trade that
per-phase reporting for nothing — turbo already reports each task's outcome
inside a phase. Gate: `pnpm check:ci` prints one `[check:ci] <phase> ok` line per
phase.

**A task definition may be package-qualified, and every task only one package
implements must be.** `llm-wiki#lint`, `llm-wiki#test:mocks`, and
`llm-wiki-mcp-server#test` carry their package; only `typecheck` and `build`
stay unqualified, because only those two are defined in both packages.
Unqualified definitions are not harmless: an unqualified `test` would also
capture the root `test` script — which runs `test:llm` and needs paid API keys
— after building the whole app, and the unqualified `lint` and `test:mocks`
tasks appear in the graph for the MCP server even though that package has no
such script. Gate: `pnpm exec turbo run lint typecheck test:mocks
llm-wiki-mcp-server#test --dry=json` lists exactly the six tasks that execute,
with no phantom entries for a package that does not define the script.

**`dependsOn` replaces an inline chained command, and the release path restates
it.** The root `build` script is `vite build`; the ordering that used to be
`pnpm typecheck && vite build` now lives in the `build` task's
`dependsOn: ["typecheck"]`. `build:desktop` is `turbo run typecheck build`, so
the Tauri `beforeBuildCommand` still typechecks before bundling. The MCP
`test` script likewise dropped its inline `pnpm build &&`, because the graph
supplies it. Gate: `pnpm build:desktop` from a deleted `dist/` and
`mcp-server/dist/` restores both.

**Narrow `inputs` only to trees the task provably cannot read, and prove the
narrowing with an A/B on a real edit.** Every root task keyed on 527 files,
including 61 under `src-tauri/` and 41 under `repos/`; `oxlint`'s
`ignorePatterns` and both `tsconfig` include lists exclude both trees, so the
declared inputs over-claimed by 102 files. `llm-wiki#lint`, `typecheck`, and
`build` now carry `!repos/**` and `!src-tauri/**`; `llm-wiki#test:mocks` carries
`!repos/**` only. Gate: one Rust-only edit to `src-tauri/src/main.rs` left 3 of
6 tasks cached before the change and 5 of 6 after; one `src-tauri/Cargo.toml`
edit still invalidates `llm-wiki#test:mocks`, and one `src/` edit still
invalidates all three root tasks.

**A negation cannot be undone by naming the file back.** Turbo hoists every
`!`-pattern ahead of the positive globs, so
`["$TURBO_DEFAULT$", "!src-tauri/**", "src-tauri/Cargo.toml"]` resolves with the
negation first and the file stays excluded — measured, the resolved input map
contained zero `src-tauri` paths either way round. This is why
`llm-wiki#test:mocks` keeps the whole `src-tauri/` tree rather than trying to
keep two files out of it: `src/lib/changelog.test.ts` reads
`src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml`, and it is the only guard
against version skew between `package.json`, the Tauri config, and the crate
manifest. Gate: `llm-wiki#test:mocks` re-runs after a `src-tauri/Cargo.toml`
edit.

**`dependsOn: ["^build"]` would do nothing here, so it is not written.**
`^` expands to a package's `directDependencies`, and both packages report
`directDependencies: ["//"]` with `packageGraph.edges.length = 0`. Adding
`^build` to the `build` task produced an identical four-task schedule and an
identical resolved `dependencies` list on the `build` task; only the task hash
moved, which is a one-time full cache invalidation for no ordering gain. Gate:
`pnpm exec turbo run build --dry=json` schedules the same four tasks with and
without it.

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

The graph here is small — two packages and **zero** dependency edges between
them, since the app does not depend on the MCP server as a package but bundles
it as a Tauri resource. So the whole value is content-addressed caching and
`--continue`, not fan-out. With no edges to derive order from, every ordering
that matters has to be declared, and every declaration is a place the gate can
silently stop covering something.

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

- Adding, renaming, or removing a script in either `package.json`.
- Changing `inputs`, `outputs`, or `dependsOn` in `turbo.json`.
- A gate that reports `FULL TURBO` on a tree whose files just changed.

## Examples

The anti-vacuity probe, which is the check this document exists for:

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

A cold `pnpm gate:tasks` runs six tasks in about 13 seconds; the same command
on an unchanged tree finishes in under a tenth of a second. Deleting `dist/`
and `mcp-server/dist/` and running `pnpm build:desktop` restores both from
cache, which is what makes the `outputs` keys load-bearing rather than
decorative.

The A/B that justifies the input narrowing. Each side was warmed to
`FULL TURBO` with its own `turbo.json`, then given exactly one edit to a tracked
file under `src-tauri/`:

```text
                inputs as first written          inputs narrowed
                (527 files per root task)        (425 lint/typecheck, 486 test:mocks)
Rust-only edit  3 cached, 6 total                5 cached, 6 total
                lint/typecheck/test:mocks miss   test:mocks miss only
src/ edit       3 cached, 6 total                3 cached, 6 total
                lint/typecheck/test:mocks miss   lint/typecheck/test:mocks miss
Cargo.toml edit (not measured)                  5 cached, 6 total
                                                 test:mocks miss only
```

The `src-tauri/Cargo.toml` row is the one that keeps the narrowing honest: the
task that must notice a crate-version edit still does.

The graph itself, for reference:

```text
turbo query 'query { packageGraph { nodes { items { name } length } edges { items { source target } } } }'
  2 nodes (llm-wiki, llm-wiki-mcp-server), 0 edges

turbo query 'query { boundaries { items { message path } length } }'
  10 diagnostics, all under repos/ — `@std/fs`, `@std/path`, `@std/yaml`
  imported by vendored Deno scripts. None in src/ or mcp-server/.

turbo query 'query { affectedTasks(base: "origin/main", head: "HEAD") { items { fullName reason { __typename } } length } }'
  7 tasks, every reason TaskGlobalFileChanged — the set is all seven tasks in
  the repo, and it is the same set over HEAD~3..HEAD. With zero edges and a
  global file hash that any root-config edit moves, an --affected filter would
  select the same seven tasks and change nothing.
```

One hypothesis was written down and then refuted, which is why it is recorded
here rather than acted on: `src/components/layout/icon-sidebar.tsx` imports
`@/assets/logo.jpg`, and `vite.config.ts` aliases `@` to `./src`. The import
resolves to `src/assets/logo.jpg`, not to the root `assets/` directory of nine
marketing screenshots — the built `dist/assets/logo-*.jpg` is byte-identical to
`src/assets/logo.jpg` (same md5) and no root-`assets` file appears in `dist/`.
Excluding `assets/**` from `build`'s inputs would therefore have been safe, not
a regression; it was left in place only because those nine files do not churn.

```text
turbo query 'query { packageGraph { nodes { items { name } length } edges { items { source target } } } }'
  2 nodes (llm-wiki, llm-wiki-mcp-server), 0 edges

turbo query 'query { boundaries { items { message path } length } }'
  10 diagnostics, all under repos/ — `@std/fs`, `@std/path`, `@std/yaml`
  imported by vendored Deno scripts. None in src/ or mcp-server/.
```

The root also appears twice in `turbo query 'query { packages { items { name path } } }'`
— once as the synthetic `//` entry and once as `llm-wiki`, both with an empty
path. Task keys of the form `//#task` target the synthetic entry; this repo
targets the named package instead, so the two never contend. The workspace has
no `apps/` or `packages/` directories, so the template's `package#task`
conventions apply to exactly one non-root package.

## Where this landed in CI

`.github/workflows/ci.yml` restores `.turbo/cache` under
`turbo-${{ runner.os }}-gate-${{ github.sha }}` with prefix `restore-keys`, so
the six tasks run warm on all three matrix platforms instead of cold. The same
workflow gained a merge-conflict preflight (`conflict-check.yml`, a
`git merge-tree` against the PR base, annotated
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
