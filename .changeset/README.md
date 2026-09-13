# Change intents

One file per change. Write them with `pnpm changeset` (interactive) or by hand:

```markdown
---
"llm-wiki": patch
---

Summary that becomes the changelog entry.
```

- An app change ships with an intent here. A PR that touches `apps/desktop/src/**`,
  `apps/desktop/src-tauri/**`, `apps/mcp-server/**`, or `extension/**` fails the
  `Changeset` workflow without one.
- `patch`, `minor`, `major` for app-visible changes; `none` records a change
  that needs no release. A `none` on behaviour a user can see is the silent
  non-release the gate exists to catch.
- `pnpm release:version` consumes the intents: it bumps `apps/desktop/package.json`,
  writes `CHANGELOG.md`, syncs the version copies in `apps/desktop/src-tauri/`,
  and deletes the files it consumed. Releasing finishes by hand: prepend the
  in-app changelog entry (`en` + `zh`) in `apps/desktop/src/lib/changelog.ts`,
  then tag `v<version>` — that tag is what triggers `build.yml`.
- Nothing here publishes to npm. `llm-wiki` is private and
  `llm-wiki-mcp-server` is in `ignore`, so no intent can reach a registry.
- Use `pnpm changeset`. `pnpm change` writes the same format but belongs to
  pnpm's publish-oriented release flow, which skips this private app: it records
  the intent and bumps nothing.
