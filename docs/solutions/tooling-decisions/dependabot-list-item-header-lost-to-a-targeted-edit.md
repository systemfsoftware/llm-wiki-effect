---
title: A targeted edit to a YAML sequence can delete a list-item header and no formatter will say so
date: 2026-09-13
category: tooling-decisions
module: ci
problem_type: tooling_decision
component: tooling
severity: high
root_cause: sequence-item-header-lost-in-targeted-edit
symptoms:
  - "A `package-ecosystem` entry disappears from `.github/dependabot.yml` after an edit that only re-pointed `directory` values."
  - "A strict YAML parser reports duplicate mapping keys on the preceding entry; a lenient one last-write-wins and says nothing."
  - "Dependabot silently stops opening PRs for one ecosystem while the others keep working."
resolution_type: source_fix
tags: [dependabot, yaml, duplicate-keys, silent-failure, gate-blind-spot, monorepoify]
related:
  - repos/constitution/docs/solutions/architecture-patterns/the-vacuous-pass-gate-input-sets.md
  - docs/solutions/tooling-decisions/the-conflict-preflight-is-the-merge-tree-exit-status.md
---

# A targeted edit to a YAML sequence can delete a list-item header and no formatter will say so

## Problem

While monorepoifying the workspace — moving the desktop app and the MCP server
under `apps/` — the `updates` list in `.github/dependabot.yml` was re-pointed
with targeted line edits. The `- package-ecosystem: "cargo"` header line was
lost while its body keys survived. They were absorbed into the preceding npm
list item as duplicate mapping keys: the cargo ecosystem silently vanished, and
no repo gate noticed.

Gate: `review` caught it — six reviewers, two reporting it independently; no
automated gate in `pnpm check:ci` did, before or after.

## Symptoms

- Rust dependency updates stop. There is no error — the absence of a Dependabot
  PR is indistinguishable from "nothing to update yet".
- The corrupted state is one npm list item with a cargo-shaped tail inside it:

  ```yaml
  - package-ecosystem: "npm"
    directory: "/apps/mcp-server"
    schedule:
      interval: "weekly"
      day: "monday"
    groups:
      other-minor-patch:
        patterns: ["*"]
        update-types: ["minor", "patch"]

    directory: "/apps/desktop/src-tauri" # duplicate key: clobbers the npm directory
    schedule: # duplicate key: clobbers the npm schedule
      interval: "weekly"
      day: "monday"
    groups: # duplicate key: clobbers the npm groups
      cargo-minor-patch:
        patterns: ["*"]
        update-types: ["minor", "patch"]
  ```

- A strict parser rejects the duplicate keys; a lenient one keeps the last
  value of each and reports nothing. Either way no cargo entry exists in the
  parsed document.

## What Didn't Work

- **`pnpm format:check`.** dprint ships the `pretty_yaml` wasm plugin and does
  format `.github/**`, so it read the corrupted file and still exited 0: a
  format pass rewrites bytes by style rules and never parses the document. Its
  exit status carries no structural information.
- **`pnpm gate:tasks` / `pnpm gate:dist`.** Both passed. No turbo task reads
  Dependabot config, and oxlint's surface is TypeScript/JS.
- **Reading the diff.** The migration plan enumerated exactly this edit
  ("cargo `directory: /apps/desktop/src-tauri`"), and the diff did contain that
  line, changed, under a plausible-looking block. Checking that the changed
  lines sat under their own `- package-ecosystem:` header was not part of any
  verification step.

## Solution

Restore the list-item header so the cargo block is its own sequence entry —
`- package-ecosystem: "cargo"` immediately before
`directory: "/apps/desktop/src-tauri"` — leaving every entry a unique
`(package-ecosystem, directory)` pair, with cargo present:

```yaml
- package-ecosystem: "npm"
  directory: "/apps/mcp-server"
  # ...

- package-ecosystem: "cargo" # <- the restored header: this IS the item
  directory: "/apps/desktop/src-tauri"
  schedule:
    interval: "weekly"
    day: "monday"
  groups:
    cargo-minor-patch:
      patterns: ["*"]
      update-types: ["minor", "patch"]
```

Landed on branch `monorepoify` (commit `92fa109`); PR pending at the time of
writing.

## Why This Works

In a YAML sequence of mappings, the `- key:` marker line _opens_ an item; every
sibling key at that indentation belongs to whichever item the last marker
opened. Deleting a header while keeping the body does not remove a field — it
merges the body into the item above, and because that body re-declares keys the
item above already has, the merge produces duplicate mapping keys. A parser
that rejects duplicates errors; one that last-write-wins keeps whichever value
it saw last and reports nothing. The header is not a label on the entry; it is
the entry.

The corruption is legal-looking YAML, which is what makes it dangerous. A
targeted value edit (`/apps/mcp-server` → `/apps/desktop/src-tauri`) is exactly
the shape that deletes a neighboring header without touching the value it was
told to change.

## Prevention

**Gate: parse the file and recompute the claim from its bytes.** Presence of a
line in the diff is not presence of an entry in the parsed document. After any
edit to a YAML sequence of mappings, assert structure, not values:

```sh
node -e '
const yaml = require("./apps/desktop/node_modules/js-yaml");
const fs = require("fs");
const seen = new Set();
for (const e of yaml.load(fs.readFileSync(".github/dependabot.yml", "utf8")).updates) {
  const key = e["package-ecosystem"] + " " + e.directory;
  if (seen.has(key)) throw new Error("duplicate update entry: " + key);
  seen.add(key);
}
console.log(seen.size + " unique (package-ecosystem, directory) entries");
'
```

Assert uniqueness and expected membership, not a hardcoded count — the count is
an author-supplied value, and keying a gate on it repeats the defect one level
up. Run the same assertion against a known-bad input once (the corrupted file)
to prove the gate can fail. Measured after the API-server extraction: the script
reports `9 unique (package-ecosystem, directory) entries` — the two new npm
entries are `/apps/api-server` and `/packages/protocol`.

**A format pass is not a structure pass.** dprint reads and rewrites YAML and
cannot flag a missing sequence marker; any config an external service consumes
must be explicitly parsed by some gate in the same change that edits it.

**Prefer structural edits in a sequence of mappings.** Replace a whole item
(header + body) or append a new item rather than splicing values under an
existing header; when a targeted edit is unavoidable, re-read the surrounding
`- package-ecosystem:` lines afterward.

## Related

- `repos/constitution/docs/solutions/architecture-patterns/the-vacuous-pass-gate-input-sets.md`
  — the general law this instance proves from one more surface: a gate can go
  green because it stopped looking; here the set that silently shrank was the
  `updates` list itself.
- `docs/solutions/tooling-decisions/the-conflict-preflight-is-the-merge-tree-exit-status.md`
  — the counterweight: a gate reporting success off its trigger is not
  automatically a defect; distinguish "nothing to check" from "never looked".
- `docs/solutions/tooling-decisions/the-lint-surface-excludes-vendored-subtrees.md`
  — owns the inventory of what `pnpm check:ci` actually reads; this defect is
  the proof that the inventory has no YAML-structure member.
