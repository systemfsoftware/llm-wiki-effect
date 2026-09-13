---
title: The conflict preflight is the merge-tree exit status, and it must succeed off a pull request
date: 2026-09-13
category: tooling-decisions
module: ci
problem_type: tooling_decision
component: tooling
severity: medium
applies_when:
  - Changing the conflicts job or conflict-check.yml
  - Deciding what a merge preflight should detect
  - A gate reports success without having checked anything
tags: [github-actions, merge-tree, ci-gate, pull-request, preflight]
---

# The conflict preflight is the merge-tree exit status, and it must succeed off a pull request

## Context

The `conflict-check.yml` reusable workflow refuses a pull request whose branch
cannot merge into its base, before the desktop and MCP suites spend twenty
minutes proving it. It merges `inputs.base_ref` against the detached head and
reads the result. Two decisions in it are load-bearing and neither is obvious:
which signal means "cannot merge", and what the job does when there is no pull
request to check.

Both were challenged in review with a P0, and both survived an experiment. This
document records the experiment, so the next reader does not have to rediscover
the answer or take the claim on trust.

## Guidance

**The exit status of `git merge-tree --write-tree` is the whole verdict.** Exit
1 means the merge has conflicts, exit 0 means it does not, and nothing else
needs to be parsed. The workflow merges base against head with `--write-tree`,
keeps the tree it writes, and fails on a non-zero status.

**Read the status before the tree is left dirty.** The merge is the thing that
writes conflict markers, so by the time a status is read the working tree is
already modified. Reading the status first is what makes the check a gate rather
than a cleanup.

**On a push or a manual dispatch, the job must succeed rather than be skipped.**
`ci.yml` declares the whole matrix behind `needs: conflicts`. A skipped job
skips everything that needs it, so a job-level
`if: github.event_name == 'pull_request'` would stop the desktop build, the MCP
suite and the gate on every push to `main`. The per-step guard is the correct
shape:

```yaml
- name: Check for merge conflicts
  if: inputs.head_sha != ''
  run: git merge-tree --write-tree HEAD "${{ inputs.base_ref }}"
```

The steps do nothing, the job reports success, and the matrix runs. Nothing was
checked because nothing needed checking: on those triggers the branch is the
default branch, and there is no base to conflict with.

## Why This Matters

A conflict preflight is a claim about the whole branch, so a wrong verdict in
either direction is expensive. A false "conflict" blocks a mergeable branch and
teaches the author to route around the gate. A false "clean" lets the matrix run
to a merge that then fails, which is the twenty minutes the gate exists to save.

The failure mode that matters most is the third one, and it is silent: a gate
that reports success because it stopped looking. Both properties above are what
keep this gate looking. The exit status is the check; the `if` guard keeps the
check reachable on the triggers where it has work to do.

## Architectural Invariants

**A gate's verdict is its exit status; its message is for the human.** A check
that greps its tool's output text couples the gate to that text's formatting,
and the coupling fails silently: the wording changes, the pattern stops matching,
and a conflicted merge reports clean. Bind to the status, keep the message for
the annotation.

**A gate that cannot run may report success only when nothing depends on it
running.** Where downstream jobs are gated on it through `needs:`, the two
outcomes diverge: a _skipped_ job propagates the skip, a _successful_ job lets
the dependents run. Choose the one that matches whether work should proceed,
which is why the guard lives on the steps here and not on the job.

**A coverage claim about a check is measured, not reasoned.** "The exit status
only catches textual conflicts" is a proposition about a tool's conflict classes,
and the way to settle it is to construct the conflict class and run the tool.
The constructed pair is cheap - two commits off a common parent - and the
alternative is a P0 finding that cannot be answered either way.

## When to Apply

- Editing `conflict-check.yml`, `ci.yml`'s `conflicts` job, or anything behind
  `needs:`.
- Adding a preflight that runs before an expensive matrix. Ask what it reports
  when its precondition is absent, and whether a skip would take the matrix with
  it.
- Reviewing a finding that a gate passes vacuously. A gate reporting success off
  its trigger is not automatically a defect; check whether the downstream work
  depends on that job succeeding, and whether there is anything to check.

## Examples

The conflict classes an exit status is claimed to miss, measured on git 2.56.1
with a pair of commits built by `git commit-tree` plumbing over `subtrees.toml`

- one modifying the file, one deleting it:

```text
$ git merge-tree --write-tree <modified-parent> <deleted-parent>
<tree-oid>
100644 <blob> 1	subtrees.toml
100644 <blob> 2	subtrees.toml

CONFLICT (modify/delete): subtrees.toml deleted in <deleted-parent> and modified
in <modified-parent>.  Version <modified-parent> of subtrees.toml left in tree.
MODIFY_DELETE_EXIT=1
```

Modify/delete is a conflict class, it is reported, and its exit status is 1. The
counter-claim - that only same-line textual conflicts flip the code - rests on
observing that two disjoint edits to one file exit 0 with no markers. That is a
correct observation of a _clean_ merge: edits in different regions of a file
merge without a conflict, and a preflight that flagged them would block work
that merges fine.

The gate's own history on this branch is the other half of the evidence. Before
the branch was rebased onto `main`, `git merge-tree --write-tree HEAD origin/main`
exited 1 and named 26 conflicted files, every one of them a file whose content
both sides had rewritten. After the rebase it exits 0. The gate tracked the
branch across a real conflict and a real clean merge.

Gate: `review` - the reviewer reads `conflict-check.yml` and confirms the job
carries no job-level `if` while its steps carry `if: inputs.head_sha != ''`.

## Related

- `docs/solutions/tooling-decisions/turbo-owns-the-task-graph.md` - the other
  half of the same CI change: what the cached task graph does behind this gate,
  and where the cache key names the pull request head rather than `github.sha`.
- `.github/workflows/conflict-check.yml`, `.github/workflows/ci.yml`.
