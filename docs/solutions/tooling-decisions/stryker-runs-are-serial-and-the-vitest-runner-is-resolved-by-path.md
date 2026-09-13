---
title: "Stryker runs are serial, the vitest runner plugin needs an explicit path under pnpm, and the Regex mutator can emit an unparseable module"
date: 2026-09-13
category: tooling-decisions
module: mutation
problem_type: tooling_decision
component: tooling
severity: high
root_cause: shared-sandbox-and-unresolved-test-runner-plugin
symptoms:
  - "Two overlapping Stryker runs in one package report all-survived or 0% no-coverage instead of failing loudly, because both runs write the same `stryker-setup-<worker>.js` files and the same `.stryker-tmp` sandbox."
  - "A run with no `plugins` entry aborts on test-runner discovery: Stryker cannot find the vitest runner plugin under pnpm's isolated `node_modules` layout."
  - "The Regex mutator substitutes a `\v` escape inside a `u`-flag character class with an invalid `\V`, so the instrumented module fails to parse and every importer's suite fails collection — the whole subtree reports NO COVERAGE at 0%."
applies_when:
  - "Running the mutation gate in apps/api-server or packages/protocol"
  - "Reading or writing stryker.config.mjs, or adding the mutation gate to a package"
  - "A Stryker run reports all-survived, 0% no-coverage, or a module that fails to parse only under instrumentation"
  - "Closing the gate to 100% by annotating provably-equivalent mutants"
resolution_type: source_fix
tags:
  - stryker
  - mutation-testing
  - vitest
  - pnpm-workspace
  - regex-mutator
  - sandbox
  - gate
related_components:
  - "docs/solutions/tooling-decisions/per-package-lint-from-a-shared-base.md"
  - "docs/solutions/tooling-decisions/turbo-owns-the-task-graph.md"
---

# Operating the Stryker mutation gate under pnpm workspaces

## Context

The api-server package runs a mutation gate over its pure-core files. The gate uses Stryker 10.0.0 (`pnpm-workspace.yaml:25`), the vitest runner 10.0.0 (`pnpm-workspace.yaml:26`), and vitest 4.1.11 as resolved in the lockfile (`pnpm-lock.yaml:4918`). The package pins effect 4.0.0-rc.113 (`pnpm-workspace.yaml:21`). The entry point is the `test:mutation` script, which runs `stryker run` (`apps/api-server/package.json:11`). The score scope is 13 files, listed verbatim in `config.mutate` of the preserved report. The report is kept at `apps/api-server/reports/mutation/mutation.html` and `apps/api-server/reports/mutation/mutation.json`.

The finished run reports 3133 mutants: 2605 killed, 37 timeout, 491 ignored, 0 survived, 0 no-coverage. Mutation score is killed + timeout over all non-ignored mutants, so every one of the 13 files scores 100.00%.

The gate hit three silent failure modes before it could run truthfully. Each mode either stops the run or, worse, produces a plausible fake score. This doc records the fixes.

## Guidance

### 1. Make the vitest runner visible to pnpm

Stryker resolves plugins from its own package context. Under pnpm the packages live in isolated stores, so Stryker cannot see `@stryker-mutator/vitest-runner` even when the package is a direct dependency (`apps/api-server/package.json:25`). The failure signature is:

```text
Cannot find TestRunner plugin "vitest". In fact, no TestRunner plugins were loaded.
```

Resolve the plugin to an absolute path in the config:

```js
import { createRequire } from 'node:module' // stryker.config.mjs:1

const require = createRequire(import.meta.url) // stryker.config.mjs:3

export default {
  // ...
  plugins: [require.resolve('@stryker-mutator/vitest-runner')], // stryker.config.mjs:9
}
```

`packageManager: 'pnpm'` (`stryker.config.mjs:7`) does not fix plugin resolution. Keep it, and keep the `plugins` entry.

Gate: `pnpm --filter llm-wiki-api-server test:mutation` gets past plugin loading, the dry run starts, and the reporter writes `apps/api-server/reports/mutation/mutation.json`. On failure the message above appears at startup, before any mutant runs.

A second config exists in this workspace. `packages/protocol/stryker.config.mjs` carries the same `createRequire` + `plugins` fix, applied before that package's first `test:mutation` run, so the failure mode never fired there. When adding the gate to a new package, copy both lines; the signature above is what a missing `plugins` entry produces.

### 2. Serialize runs

Two Stryker processes in one package share the `tempDirName` (`.stryker-tmp`, `stryker.config.mjs:13`). Each process writes per-worker setup files into that shared sandbox. The leftover sandbox `apps/api-server/.stryker-tmp/sandbox-pSdajf/` shows the shape: `stryker-setup-0.js` through `stryker-setup-5.js`, one per worker.

The first process to finish disposes the shared directory and deletes the other process's setup files. The second process then reports garbage — all mutants survived, or zero coverage — while its dry run stays green.

Rule: take a sole-process lock for the WHOLE run, cleanup included. Check for a live run before you start:

```bash
pgrep -f stryker
```

An empty result means the gate is free. Hold the lock until the process exits and the report is written. This check is an operator practice today; no lock script exists in the repo (no `pgrep` anywhere in the tree).

Gate: `pgrep -f stryker` is empty when the run starts and stays empty until cleanup ends. A run that shares the sandbox is invalid even if it exits zero — verify by reading the report, where a real run shows a nonzero killed count (`jq '[.files[].mutants[] | select(.status=="Killed")] | length' apps/api-server/reports/mutation/mutation.json`).

### 3. Fix mutants that do not compile

The Regex mutator rewrites character classes. On `apps/api-server/src/search/query.ts:21` it turned `\v` into `\V`:

```ts
const WHITESPACE = /[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/u
```

`\V` is not a valid identity escape under the `u` flag. The mutant is a parse-time `SyntaxError`. Every test file that imports `query.ts` then fails collection, and the subtree scores 0% with status NO COVERAGE, even though those tests pass standalone.

The report records this mutant as id 2748, spanning line 21 of `src/search/query.ts`, with `status: Ignored` and `statusReason: "Ignored using a comment"` (`apps/api-server/reports/mutation/mutation.json`). The status reason confirms the disable comment is what disposes of it; without the comment the run would have to parse the mutant.

Diagnose it inside the sandbox:

1. Find the leftover sandbox at `apps/api-server/.stryker-tmp/sandbox-<id>/`.
2. Run vitest there, not in the package root.
3. Read the collection error. A `SyntaxError` in a `src/**` file names the mutated character.

Dispose of the mutant with an annotation on the line above (`apps/api-server/src/search/query.ts:20`):

```ts
// Stryker disable next-line Regex
const WHITESPACE = /[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/u
```

`query.ts:20` carries the bare form today. Add the one-line reason after the colon, as the same file does at `query.ts:121`, `:128`, `:141`, and `:145`. The alternative disposal keeps the mutant valid: respell `\v` as `\u000b`, which is legal under `/u` and therefore survivable by a test.

Gate: after the next run, the file shows no unparsed mutant and no zero-coverage subtree — `jq '[.files["src/search/query.ts"].mutants[] | select(.status=="NoCoverage")] | length' apps/api-server/reports/mutation/mutation.json` returns `0` while the same file reports killed mutants. A nonzero `NoCoverage` count with tests that pass under `pnpm --filter llm-wiki-api-server test` means a mutant still does not parse.

### 4. Close to 100% legitimately

Annotate only mutants you can prove equivalent. Use `// Stryker disable next-line <Mutator>: <one-line reason>` (`query.ts:121`). Name the mutator. Give the reason in one line. A file-level form, `// Stryker disable <Mutator>`, also exists (`query.ts:47`).

The success set is killed + timeout + annotated-ignored. Nothing may survive, and nothing may stay uncovered. Never delete or weaken a test to close a gap.

The closed gate holds 491 annotated-ignored mutants against 3133 total, with 0 survived and 0 no-coverage (`apps/api-server/reports/mutation/mutation.json`).

Gate: `jq '[.files[].mutants[] | select(.status=="Survived" or .status=="NoCoverage")] | length' apps/api-server/reports/mutation/mutation.json` returns `0`. The reviewer's decision is whether each new annotation names a provable equivalence; an annotation without a reason is a weakened gate, not a disposal.

## Why This Matters

Every failure mode is silent, and two of them produce a readable score.

- Mode 1 stops the run with a plugin error. It costs time, but it lies to no one.
- Modes 2 and 3 produce an all-survived table or a 0% subtree. Both look like real quality signals. Both pass the dry run.
- A reader cannot tell a sandbox collision from genuinely dead code, nor an unparseable mutant from an untested file.

Trust in the gate needs three conditions: plugin visibility, one run at a time, and parse-safe disposal of impossible mutants.

## When to Apply

- Any package in this pnpm workspace that adopts Stryker.
- Any run whose per-file table shows whole directories at exactly 0% while their tests pass standalone.
- Any run that reports all-survived with a green dry run.
- Any 100% closure effort: every illegal mutant needs an annotation.

## Examples

**Before / after: plugin resolution.** `apps/api-server/stryker.config.mjs` now opens with `createRequire` (`:1`), builds the require (`:3`), and passes the resolved runner path (`:9`). Without those three lines the run ends at "no TestRunner plugins were loaded".

**Before / after: the unparseable mutant.** `apps/api-server/src/search/query.ts:20-21` shows the annotation directly above the regex. The `\v` to `\V` mutant is now ignored, so the subtree scores 100.00% instead of 0% NO COVERAGE.

**The finished report.** 13 files, 0 survived, 0 no-coverage, rendered at `apps/api-server/reports/mutation/mutation.html` and machine-readable at `apps/api-server/reports/mutation/mutation.json`.
