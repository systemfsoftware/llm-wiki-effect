---
title: The lint and format surface stops at vendored subtrees
date: 2026-09-13
category: tooling-decisions
module: lint
problem_type: tooling_decision
component: tooling
severity: medium
applies_when:
  - Adding a git subtree under repos/ or a [[repos]] entry to subtrees.toml
  - A lint or format finding names a path under repos/
  - A vendored file shows as modified in git status after running the formatter
tags: [oxlint, dprint, subtree, vendored, scoping]
---

# The lint and format surface stops at vendored subtrees

## Context

This repo vendors upstream trees as git subtrees under `repos/`, declared by the
`[[repos]]` entries in `subtrees.toml` and imported by the `git-subtree-vendor`
scripts. The root linters predate them and walk the whole tree: `pnpm lint` runs
`oxlint .` and `pnpm format:check` runs `dprint check`, neither of which named a
file set.

`pnpm check:ci` runs five gates. On the branch that added the subtrees three
passed outright — `pnpm build`, `pnpm test:mocks` (132 files, 1876 tests), and
`pnpm mcp:test` (23 tests) — and `pnpm lint` failed with 155 errors and 12
warnings, every one of them under `repos/**`. The fifth, `pnpm format:check`,
passed for the wrong reason: `dprint` had already rewritten 14 vendored files in
the worktree, so `git status` showed them as modified and the green run was
grading the formatter's own uncommitted output. The rule set was identical to
the one that had cleared this repo's own source one commit earlier.

## Guidance

**Exclude `repos/**` at the whole-tree scope.** `repos/**` is a member of
`oxlint`'s `ignorePatterns` in `oxlint.config.ts` and of `dprint`'s `excludes`
in `dprint.json`. Nothing else changes: same plugins, same rules, same
severities for every file this repo owns. Gate: `pnpm lint` reports
`0 warnings and 0 errors` over the remaining files, and `pnpm format:check`
exits clean from a clean worktree.

**Do not fix the findings in the vendored code.** Any one of three reasons is
sufficient:

1. The repair has a scheduled deletion date — `update-subtrees.sh` replaces the
   whole prefix on the next run, and `audit-subtrees.sh` then reports the tree
   as current against upstream, so nothing reports that the fix evaporated.
2. The findings are this config's premise applied to a stack that rejects it.
   The dominant rule, `typescript/no-unsafe-type-assertion`, fires on
   `catch`-clause narrowing like `(e as Error).message` in a Deno CLI whose own
   gate is `deno task check`.
3. Upstream owns that gate. Grading the tree from here makes the consumer the
   authority over code it does not maintain.

Gate: `review` — the change edits no file under `repos/`, which `WT-S3` in the
vendored `worktrunk-scripts` doctrine and this repo's own vendoring procedure
both require be read-only. The same branch adds those trees wholesale from
upstream, which is an import, not an edit.

**Do not turn the rules off.** Every rule that fired is load-bearing for
`apps/desktop/src/`, `apps/mcp-server/`, `extension/`, and `scripts/` — the
same rules were clearing this
repo's own source one commit before the subtrees landed. The file set was wrong,
not the rule. A scoped exclusion says _this subtree is not ours_; an `off` or an
inline disable says _this rule does not work here_, which is a false claim and
the one that teaches readers to discount a green run. Gate: `pnpm lint` with the
exclusion removed reproduces the 155 errors, proving the exclusion — not a rule
change — is what moved the gate.

**Revert the formatter's writes with plumbing.** The destructive-op guard
intercepts `git checkout --`, `git restore`, `git reset --hard`, and
`git clean -fd`; the repair is `git diff --name-only -- repos | xargs git
checkout-index -f --`, which rewrites the worktree from the index without
touching history. Gate: `git status --porcelain` lists only the two intended
config edits.

**`lint-staged` needs no `repos/` filter.** A subtree import commits through
`git commit-tree`, which runs no hooks, so vendored paths never reach
`pnpm precommit`. The upstream sibling keeps an explicit `grep -vE '^repos/'` in
its hook because its import path differs; here that filter would be dead code.
Gate: `review` — the hook body is `pnpm precommit`, and its input is the staged
file list.

## Why This Matters

Both remedies for a finding in vendored code lose. Edit the vendored file and
the next subtree update silently reverts it — the fix evaporates with no error
and no diff. Weaken the rule and a real defect in `apps/desktop/src/` stops
being reported forever. Scoping the file set is the only move that keeps the
gate meaningful
_and_ keeps the subtree replaceable.

The failure is quiet in both directions. Nothing in the import announces that
the tree is now linted, and nothing in the lint run says the file it is grading
belongs to another maintainer. The output is an ordinary, plausible error list
pointing at paths that happen to start with `repos/`.

## Architectural Invariants

**A linter's file set is part of its premise.** Before adopting a config, or
adding a tree the config will walk, name who is being graded. A rule whose
subject is another maintainer's code has no premise in this repo, and the
sibling doc `docs/solutions/tooling-decisions/the-lint-surface-is-stack-specific.md`
carries the same argument for a rule whose premise is another stack.

**A vendored tree is graded by its owner's gate, not the consumer's.** The
consumer's obligation is to import the tree faithfully and keep it replaceable.
That obligation is discharged by `audit-subtrees.sh`, which compares the
vendored tree against the vendor ref — not by a lint run over third-party code.

**Scope decisions live at the file-set level; suppressions live at the
finding.** `excludes` and `ignorePatterns` name a subtree. An inline disable
names a rule and silences one line while leaving the premise unexamined. Only
the first is a scoping decision, and it is the one that belongs in a config
beside the reasoning recorded here.

**A vendored path is read-only, including to the formatter.** `dprint` writing
14 files under `repos/` is the same defect as a hand edit: a modified vendored
path in `git status` is the signal, and it is why the formatter exclusion and
the worktree revert ship together rather than as two changes.

## When to Apply

- Adding a subtree, or a `[[repos]]` entry to `subtrees.toml`.
- A lint or format finding names a path under `repos/`.
- `git status` shows modified files under `repos/` after any tool run — revert
  them, then fix the exclusion that let the tool reach them.

## Examples

The whole change, and the gate that proves each line:

```text
oxlint.config.ts   ignorePatterns += 'repos/**'     <- pnpm lint, pnpm check:ci
dprint.json        excludes       += 'repos/**'     <- pnpm format:check
git diff --name-only -- repos | xargs git checkout-index -f --
                                                    <- git status --porcelain

pnpm lint           Found 0 warnings and 0 errors.
pnpm format:check   clean, from a clean worktree
pnpm check:ci       exit 0
```

The rules are byte-identical between the red run and the green one; only the set
of files they are pointed at changed. That is the whole test of whether an
exclusion has hidden a real finding or removed a false one.
