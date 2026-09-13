---
title: Every package lints itself from one shared oxlint base, and extends does not carry its plugins
date: 2026-09-13
category: tooling-decisions
module: lint
problem_type: tooling_decision
component: tooling
severity: medium
applies_when:
  - Adding a package, or a lint rule that every package should enforce
  - A package reports rules nobody enabled, or stops reporting rules it did
  - Reviewing a change to oxlint.config.ts or packages/oxlint-config
tags: [oxlint, lint, workspace, extends, preset, tsconfig]
---

# Every package lints itself from one shared oxlint base, and extends does not carry its plugins

## Context

`pnpm lint` used to be one repo-wide `oxlint .` at the root, defined by a single
root `oxlint.config.ts`. That shape has two costs the monorepo paid as soon as
`apps/` existed: the root config had to enumerate the trees its rules graded
(`apps/*/src/**`, `extension/**/*.js`) and negate the ones they must not
(`!**/repos/**`, `!**/src-tauri/**`), and every package's lint shared one cache
entry, so an edit anywhere re-linted everything.

The workspace now lints the way the sibling `systemfsoftware/systemfsoftware`
monorepo does: one private workspace package holds the ruleset
(`packages/oxlint-config/src/oxlint-config.base.ts`), each package owns a
three-line `oxlint.config.ts`, and `pnpm lint` is `turbo run lint` — one cached
`oxlint .` per package, with its own `tsconfig` and its own file set.

## Guidance

**A package's config spreads the base; it does not `extends` it.** `extends`
merges `rules`, `overrides`, and `ignorePatterns`, but **not `plugins`**. With
`defineConfig({ extends: [base] })` the package silently falls back to oxlint's
default plugin set, so `unicorn` rules nobody enabled fired on 350 app files
(14 errors, 112 warnings) while every hand-written rule still applied. The
spread form is the one that carries the whole config:

```ts
import base from 'llm-wiki-oxlint-config/base'
import { defineConfig } from 'oxlint'

export default defineConfig({ ...base })
```

Gate: a planted `unicorn` violation is reported when `plugins` is missing and
silent when the base is spread — measured on the app's 350 files, `112 warnings
and 14 errors` against `0`.

**The base owns every tree-wide exclusion; packages own nothing.** `**/repos/**`,
`**/src-tauri/**`, `**/dist/**`, and the two vendored `extension/` files live in
the base's `ignorePatterns`, so a new package inherits them and cannot forget
one. Gate: `pnpm lint` reports `0 warnings and 0 errors` in every package.

**The shared base is a declared input of every package's lint.** Each package's
`lint` task lists `$TURBO_ROOT$/packages/oxlint-config/src/**` alongside its own
`oxlint.config.ts` and `tsconfig*.json`, so one rule edit in the base re-runs
every package's lint instead of serving stale cached verdicts. Gate: adding a
rule to the base turns all three `llm-wiki*#lint` tasks to `cache MISS` in
`pnpm exec turbo run lint --dry=json`.

**TypeScript configs come from the published preset, not from hand-written
compiler options.** Every package extends `@systemfsoftware/tsconfig` — the app
`bundler/dom` plus `jsx: react-jsx` and the `@/*` alias; the config projects
`schema`-free `node`; the MCP server and the config package
`tsc/no-dom/library`. The preset's strictness is the point: adopting it surfaced
1048 type errors in the app and 168 in the MCP server, all of which had to be
fixed rather than suppressed. Gate: `pnpm typecheck` is green with no
`@ts-ignore`, `@ts-expect-error`, or `!` assertion added — the last is enforced
by `typescript/no-non-null-assertion: error`.

**A library preset does not declare ambient types; the consumer does.** The
`tsc/no-dom/library` preset sets neither `lib: dom` nor `types: ["node"]`, so
`fetch`, `process`, and `Buffer` resolved for `tsc` (which auto-includes
`@types`) but not for oxlint's type-aware pass, which reported 109 phantom
`Cannot find name` errors in the MCP server. `"types": ["node"]` in that
package's `tsconfig.json` clears them. Gate: `pnpm --filter
llm-wiki-mcp-server lint` reports nothing.

**Typecheck without emitting, and never `tsc --build`, for a config project.**
The `node` preset sets `composite: true`, so `tsc --build` emitted
`vite.config.js`, `oxlint.config.d.ts`, and friends beside the sources. Every
package typechecks with `tsc --noEmit -p <project>` instead, which also keeps
parallel runs from contending on one `tsconfig.tsbuildinfo`. Gate: `git status
--porcelain` shows no emitted config artifact after a full `pnpm check:ci`.

**Root-level files are outside the lint and typecheck surface.** There is no
root `oxlint.config.ts` and no root task: `turbo.json` defines only unqualified
task names, and a bare `turbo run lint` selects member packages only. The root's
own tooling (`scripts/`, `bin/`, `commitlint.config.ts`, `.lintstagedrc.js`) is
formatted by `dprint` and read by neither oxlint nor a tsconfig. Gate:
`pnpm exec turbo run lint --dry=json` lists `llm-wiki#lint`,
`llm-wiki-mcp-server#lint`, and `llm-wiki-oxlint-config#lint` and no `//#` entry.

**`lint-staged` grades a staged file with its owning package's config.**
`.lintstagedrc.js` walks up from each file to the nearest `oxlint.config.ts` and
passes it as `--config`; a file with no owning config (a root-level script) is
formatted and not linted. Gate: staging a file under `apps/desktop/src/` runs
`oxlint --config apps/desktop/oxlint.config.ts`, and the same file passes
`pnpm lint` unchanged.

## Why This Matters

A shared base that only half-propagates is the worst of both: the rules an author
wrote apply, so the config looks right, and an entire plugin's defaults apply on
top, so the verdict is not the one anybody specified. It is invisible in review —
the diff of a three-line package config looks correct — and it surfaces later as
findings on a stack nobody enabled, which is exactly the pressure that gets a
`plugins` list deleted instead of understood.

The per-package shape also moves the file set into the package, where it can be
reasoned about locally: the app's lint cannot see vendored code because the base
says so, and a package added tomorrow inherits that without any new decision.

## Architectural Invariants

**Merging is not inheritance.** `extends` merged two of four top-level keys in
the measured run. Any shared config consumed this way is spread or enumerated
field by field, and the fields that must propagate are proven by a planted
violation rather than assumed from a diff that looks right.

**A shared input is a cache key, not a comment.** A package task that reads
another package's file names that file in `inputs`; otherwise the cache serves a
verdict computed under rules that no longer exist.

**Rules live in one package; packages own only their own exceptions.** Reviewing
a lint change means reading the base, not N package configs that drift.

## When to Apply

- Adding a package to the workspace: create its `oxlint.config.ts` (three lines),
  its `lint` script, and its tsconfig projects extending the presets.
- Adding or changing a rule: edit the base, and confirm the base is in every
  package's `lint` inputs.
- A package reporting a rule nobody enabled, or missing one it used to report:
  check whether its config `extends` the base instead of spreading it.

## Examples

```text
packages/oxlint-config/src/oxlint-config.base.ts   the ruleset, one copy
apps/desktop/oxlint.config.ts                      spread + app tsconfig
apps/mcp-server/oxlint.config.ts                   spread + node types
packages/oxlint-config/oxlint.config.ts            spread + own tsconfig

pnpm lint                                          turbo run lint -> 3 package tasks
pnpm typecheck                                     turbo run typecheck -> 3 package tasks
pnpm exec turbo run lint --dry=json                no //# task, 3 cache entries
```

The measured failing form, for contrast: `extends: [base]` on the app, then
`pnpm exec oxlint . --type-aware --type-check` in `apps/desktop` reporting
`Found 112 warnings and 14 errors` — every one of them a `unicorn` rule the base
never enabled.
