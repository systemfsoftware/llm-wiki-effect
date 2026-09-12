---
title: Replacing effect-setState with a render-phase guard, and the write it forbids
date: 2026-09-12
category: design-patterns
module: ui-state
problem_type: design_pattern
component: frontend
severity: medium
applies_when:
  - "React reports react(set-state-in-effect) on an effect whose body only syncs state from props or other state"
  - "Converting such an effect to the render-phase form"
  - "Restoring a ref write that an effect used to perform"
tags: [react, hooks, state, oxlint, refs, render]
---

# Replacing effect-setState with a render-phase guard, and the write it forbids

## Context

The oxlint gate runs `react(set-state-in-effect)` as an error. Its message names
the fix: "Derive the value during render, initialize state directly, or update it
from the event that caused the change." Where the state is a reset keyed on a
value change, the first option is the one that fits, and the app now uses it in
nine places across seven components.

The pattern is the one React documents as "adjusting some state when a prop
changes". It is not a workaround: it re-renders before children render, so the
stale value never reaches a child or the screen, and it removes the extra commit
an effect plus its follow-up render would cost.

## Guidance

Store the value you last acted on, compare it during render, and write both the
derived state and the stored value together:

```tsx
const [prevConversationId, setPrevConversationId] = useState(activeConversationId)
if (prevConversationId !== activeConversationId) {
  setPrevConversationId(activeConversationId)
  setContextDetailReferences(null)
  setReferencePreview(null)
}
```

Three constraints decide whether the rewrite is correct.

**The guard must be one-shot.** It compares the stored value with the current
one and writes both, so the re-render it triggers finds them equal and stops.
Two shapes satisfy this: a stored previous value (`prevConversationId`), and a
stored key (`sourceQueryProjectId`, `limitNodes`, `hasMountedSources`). Comparing
the derived value against the state it writes — `wiki-editor`'s normalized draft
against `draftMarkdown` — is the same thing with the comparison inverted.

**Only the rendering component's own state may be written.** React discards the
render output when a component updates its own state during render; updating a
different component's state during render is an error.

**A ref write during render is forbidden, and the gate says so.** An effect that
did `ref.current = derived` next to `setState(derived)` cannot carry that line
into the render body:

```text
x react(refs): Cannot access refs during render
  --> src/components/editor/wiki-editor.tsx
   = Cannot update ref value during render
```

Before dropping such a line, check every reader of the ref. It is safe to drop
only when each one is unreachable in the state where the write happened. In
`wiki-editor`, all readers sit behind `if (mode !== 'edit') return`, so the write
the read-mode sync used to perform could not be observed. A ref that a reachable
path reads has to keep its update, and that update belongs in an effect: writing
it during render is the thing React rejects, not the update itself.

## Why This Matters

The pattern moves a value change out of the commit phase. Two failure modes
follow when it is applied mechanically: a missing write to the stored value makes
the guard fire on every render, and a ref write smuggled into the render body is
either a gate failure or a value React is free to discard. Both are invisible in
a code review that reads only the diff, and neither shows up in a test that does
not drive the state transition.

## Architectural Invariants

**A guard that writes its own input must write it in the same branch.** The
stored value and the derived state are one update; splitting them reopens the
loop the guard exists to close.

**State that renders may be adjusted during render; state that instruments may
not.** Refs are for values the render does not read. That boundary is what the
`react(refs)` rule enforces, and it decides where a write goes, not whether it is
needed.

**A rewrite of a sync effect must enumerate the effect's writes.** An effect like
this one does more than set state — it may reset a ref, clear a sibling, or bump
a counter. Each write needs a home before the effect is deleted.

## When to Apply

- An effect body that only derives state from props or other state, and the gate
  reports `react(set-state-in-effect`.
- Reviewing a conversion: check the guard's one-shot property and enumerate what
  the deleted effect wrote.
- Restoring a ref write: check every reader's reachability first.
