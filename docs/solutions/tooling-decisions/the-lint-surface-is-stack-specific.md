---
title: The lint surface is stack-specific, and an autofix is a code change
date: 2026-09-12
category: tooling-decisions
module: lint
problem_type: tooling_decision
component: tooling
severity: medium
applies_when:
  - Adding a plugin, rule, or override to packages/oxlint-config or to a package's oxlint.config.ts
  - Explaining why a rule that looks correct is not enabled here
  - Running oxlint --fix across a tree that has never been linted
tags: [oxlint, lint, tauri, react, autofix]
---

# The lint surface is stack-specific, and an autofix is a code change

## Context

This repo adopted `oxlint` with a config derived from the sibling
`systemfsoftware/starter` template. Two of that template's assumptions do not
hold here, and one of its practices is unsafe on a tree that has never been
linted. The rules now live in one place — the shared base at
`packages/oxlint-config/src/oxlint-config.base.ts`, spread into each package's
`oxlint.config.ts` — so a stack-specific decision made here applies to every
package at once: the app, the API server, the MCP server, the protocol package,
and the config package.

## Guidance

**Do not import `@systemfsoftware/all`.** That preset bans `node:*` imports and
enables the Effect, workflow, and cell-vocabulary plugins; it declares `effect`
as a peer. This repo is a Tauri shell plus a React UI plus Node
services — the API server, the MCP server, the protocol package — and `node:fs`,
`node:path`, and `node:child_process` are load-bearing in the app's `src/lib`,
in `apps/api-server`, in `apps/mcp-server`, and in the build configs. Applying
the preset here reports errors against a stack the repo does not use.

**`react/react-in-jsx-scope` is off, and only that rule.** It premises the
classic JSX runtime. The app tsconfig sets `jsx: react-jsx`, so JSX compiles to
`jsx()` imports and `React` needs no scope entry. The rule's demanded fix is
itself a compiler error under this project's `noUnusedLocals`: the compiler
reports `TS6133: 'React' is declared but its value is never read`. Either the
rule is off or the compiler is; at the time of writing, the compiler wins.

**`import/no-unassigned-import` carries an allow list, not an `off`.** A bare
`import 'x.css'` is how Vite loads a stylesheet; a bare `import 'x'` of a JS
module is the accidental side-effect import the rule exists to catch. The config
keeps the rule at `error` with `allow: ['**/*.css']`, so the stylesheet form is
legal and the JS form still fails. Assigning the CSS import instead is not a fix:
rolldown fails the build with `MISSING_EXPORT: "default" is not exported by
katex.min.css`.

**Treat `oxlint --fix` as an edit to source, not as a formatter.**
`eslint/preserve-caught-error` rewrites `throw new Error(message)` inside a
`catch` into `throw new Error(message, { cause: error })`. That rewrite needs
`ErrorOptions`, which the ES2020 lib in the app tsconfig does not declare, so
the autofix turned a warning into a build failure on a file nobody had opened.
Run the compiler and the test suite after `--fix`, exactly as after a hand edit.

## Why This Matters

A config copied from a neighbouring repo imports that repo's premises along with
its rules. Where the premise fails, the rule reports work that cannot be done,
and the tempting repair is to weaken the rule — which trains everyone to read a
green lint run as meaningless. The autofix case is the same failure in a
different costume: a tool changed code, and the change was assumed correct
because a tool made it.

## Architectural Invariants

**A rule's premise is part of the rule.** Before enabling a rule, name what
about this codebase makes it fire. If the premise is absent, the rule does not
belong in the config — that is a scoping decision, not a suppression, and it
belongs in this document rather than in a comment beside the rule.

**An autofix is a code change.** It passes the same gates as a hand edit: the
type checker, the tests, and review. Tool authorship confers no correctness.

**A gate that cannot fail is not a gate.** Before adopting a rule or a check,
run it against a known-bad input and confirm it reports. `typescript/strict-boolean-expressions`
and `typescript/no-unnecessary-condition` are registered by oxlint but produce
no diagnostic on a file that plainly violates them, with or without
`--type-aware`; enabling them would add a green line that measures nothing.

**A judgment surface has one owner.** The work being graded and the instrument
that grades it are changed by different hands. A branch that adds a rule and the
fixes that satisfy it has chosen both sides of the verdict, so the exceptions it
carves are the ones a second reviewer has to look at hardest.

## When to Apply

- Before copying an `oxlint` config, or any linter preset, from another repo.
- Before enabling a rule: run it on the tree and count the findings. A rule with
  zero findings on code that violates it is not wired up.
- After any `--fix` run, and before blaming the tool for a broken build.

## Examples

The premise check, in order:

```text
rule fires -> read the rule's premise -> name what in this repo satisfies it
           -> absent? the rule is out of scope; record why in the solution doc
           -> present? fix the code
```

The config changes the gate forced, and why they are not suppressions:
`tsconfig.app.json` carries no `baseUrl` because `tsgolint` rejects it
(`Option 'baseUrl' has been removed`); `paths` resolves relative to the tsconfig
on its own. The app project extends `@systemfsoftware/tsconfig/bundler/dom`,
whose `target: es2024` and `lib: esnext` declare `ErrorOptions` — the same
option the autofixed `preserve-caught-error` calls require — and adds only the
two things the preset cannot know: `jsx: react-jsx` and the `@/*` path alias.
