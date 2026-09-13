---
title: Changesets version a private app; pnpm's own release flow cannot
date: 2026-09-12
category: tooling-decisions
module: release
problem_type: tooling_decision
component: tooling
severity: medium
applies_when:
  - Changing .changeset/config.json or the version of the app
  - Explaining why pnpm change is not the tool that versions this repo
  - Wiring a release step that reads the app version
tags: [changesets, release, versioning, private-package, tauri]
---

# Changesets version a private app; pnpm's own release flow cannot

## Context

This repo is an app, not a library: nothing publishes to npm. It still needs
versioning and a changelog, so the release flow has to work for a private root
package and for a Tauri bundle that carries its own copy of the version.

pnpm 11 ships `pnpm change` plus `pnpm version -r`, and the sibling
`systemfsoftware/starter` template drives its releases with exactly those, so
the obvious move is to reuse it. It does not work here, and the failure is quiet:
both commands exit 0.

## Guidance

**`pnpm version -r` records an intent for a private package and bumps nothing.**
Give it the intent and ask for the plan:

```text
$ pnpm change --bump patch --summary "..." llm-wiki
Recorded change intent .changeset/three-cows-dress.md
$ pnpm version -r --dry-run
Release plan:
  llm-wiki: 0.6.11 → 0.6.11 (patch, via intent)
```

The version is pinned to itself. pnpm's release management is publish-oriented:
it probes the registry for the version each package currently serves, and a
package npm has never seen — which includes every private package — never enters
the release set. Its default changelog storage is the registry, so no
`CHANGELOG.md` is written either. `.changeset/config.json` is not consulted for
this; `privatePackages` there is a changesets setting.

**`@changesets/cli` versions private packages, by configuration.** The one line
that decides it is in `.changeset/config.json`:

```json
"privatePackages": { "version": true, "tag": false }
```

`version: true` opts the private app into the release plan, so
`pnpm release:version` bumps `apps/desktop/package.json` and writes
`CHANGELOG.md`. `tag: false` keeps `changeset git-tag` away from the app:
releases are tagged `v<version>` by hand, because that is the shape `build.yml`
triggers on.

**The app version has one source, and the copies are written by one script.**
`apps/desktop/package.json` is the source. `apps/desktop/src-tauri/tauri.conf.json`
and `apps/desktop/src-tauri/Cargo.toml` carry copies,
`apps/desktop/src-tauri/Cargo.lock` records the crate version, and `CHANGELOG`
in `apps/desktop/src/lib/changelog.ts` carries the version the app displays.
`scripts/sync-app-version.mjs` rewrites the first three from the app manifest,
and `pnpm release:version` runs it right after `changeset version`, so the
release step is one command plus the in-app changelog entry.

Tauri does accept `"version": "../package.json"` here — `tauri-cli` chdirs to
the config file's directory before deserializing precisely so a version path
resolves, and `tauri-build` parses with the crate directory as cwd. That form was
rejected anyway: `apps/desktop/src/lib/changelog.test.ts` asserts the manifest
version equals
`package.json`'s, and rewriting that assertion to accept a path would trade a
checked invariant for an unchecked one to save one line in a script.

**The MCP server is outside the plan.** `"ignore": ["llm-wiki-mcp-server"]`
keeps it out. It carries an independent version, is not a dependency of the app,
and publishes nowhere.

## Why This Matters

The failure mode this document exists for produces no error. `pnpm change`
writes a well-formed intent, `pnpm version -r` prints a release plan, and the
version never moves. A release train that looks wired and ships nothing is worse
than no release train, because it stops anyone from looking.

## Architectural Invariants

**A release tool's unit of work is a published version.** A tool that sizes its
release set from the registry cannot version a package the registry has never
seen; that is arithmetic, not configuration. An app that never publishes needs a
tool whose unit of work is a file in the tree.

**One version source per artifact.** `apps/desktop/package.json` is the app's.
Anything that needs the version reads it —
`apps/desktop/src-tauri/tauri.conf.json` by path, the release workflow by
syncing it into `extension/manifest.json` — rather than storing a copy that a
release has to remember to update.

**A gate that can pass without its subject is not a gate.** `pnpm version -r`
exiting 0 on an empty release plan is correct for pnpm and useless as a
verification that a release happened. Verify the version moved, not that the
command succeeded.

## When to Apply

- Before adopting a release tool from a publishable-package repo into an app.
- When a release command succeeds and the version is unchanged.
- When adding an artifact that embeds the app version.

## Examples

The end-to-end check, which is the only proof that the flow is wired:

```text
$ pnpm release:version
llm-wiki: 0.6.11 -> 0.6.12
synced 0.6.12 into apps/desktop/src-tauri/tauri.conf.json, apps/desktop/src-tauri/Cargo.toml, apps/desktop/src-tauri/Cargo.lock
$ git diff --stat
apps/desktop/package.json        | 2 +-
CHANGELOG.md                     | 8 ++++++++
apps/desktop/src-tauri/Cargo.lock | 2 +-
apps/desktop/src-tauri/Cargo.toml | 2 +-
apps/desktop/src-tauri/tauri.conf.json | 2 +-
```

The intent files are deleted by that run, so an empty `.changeset/` after
`release:version` is the success shape, not a lost intent. The in-app changelog
entry is the one step left to a human: `apps/desktop/src/lib/changelog.test.ts`
goes red until
`CHANGELOG[0].version` matches the version that was just written.
