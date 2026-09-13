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

**`outputs` must name only artifacts the task actually writes.** `test:mocks`
runs vitest without `--coverage`, so its `outputs` is `[]`. Listing a
`coverage/**` directory vitest never creates makes turbo warn
`no output files found for task` on every run and hides a real missing
artifact. Gate: `pnpm gate:tasks` produces no warning, and the MCP suite's
`dist-test/**` is present after a cached run.

**Options go after the subcommand.** The form is
`turbo run --concurrency=${TURBO_CONCURRENCY:-100%} --continue <tasks>`. The
template writes `turbo --concurrency=… <tasks>` because it omits `run`
entirely; combining that prefix with an explicit subcommand fails with
`Cannot use run arguments before 'run' subcommand`. Gate: `pnpm gate:tasks`
exits 0 rather than exiting 1 on argument parsing.

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

The graph itself, for reference:

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
targets the named package instead, so the two never contend.

Two consequences of the same toolchain are outside this repo's edit surface and
remain open. `.github/workflows/ci.yml` does not restore `.turbo/cache`, so CI
runs every task cold every time; and the workspace has no `apps/` or
`packages/` directories, so the template's `package#task` conventions apply to
exactly one non-root package.
