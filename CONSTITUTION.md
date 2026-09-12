# Constitution

Design law for this repo. `AGENTS.md` carries the commands; this document
carries the rules those commands cannot express. Where this document and a gate
disagree about a specific change, the gate wins and the disagreement goes to
whoever owns the instrument — never resolved by editing the gate.

```yaml
rules:
  - id: CONST-E1
    title: Never Edit What Grades Your Work
    gate: review
    do:
      - treat every judgment surface as read-only: `oxlint.config.ts`, `dprint.json`, `commitlint.config.ts`, `.lintstagedrc.js`, `tsconfig*.json`, `.github/workflows/**`, coverage floors
      - hand a needed gate to its owner and wait; say plainly that the work is ungated until then
    dont:
      - add, weaken, retune, or delete a judgment surface in service of the change being graded
      - build the gate your own work will be graded by
    harm: whoever edits the instrument that grades their work reports the score they chose; the green certifies nothing
    check: review — the change and any judgment-surface change name different owners
    example:
      wrong: silence a lint rule in `oxlint.config.ts` so `pnpm lint` passes
      right: fix the code the rule flagged; if the rule's premise is wrong for this stack, raise it with the owner
  - id: CONST-E2
    title: Evidence Before Done
    gate: review
    do: treat done as a gate passed or a test shown, with the command output quoted
    dont: accept a claimed "it works" or a reported score as done
    harm: compliance asserted without evidence is unverifiable, and the failure is silent
    check: review — done names the gate that ran and the result it produced
    example:
      wrong: "the tests should pass"
      right: "`pnpm test:mocks` — 132 files, 1876 tests, 0 failures"
  - id: CONST-T1
    title: The Oracle Is Not the System Under Test
    gate: review
    do: give every assertion an expected value the code under test did not produce — a literal, a fixture not built by importing the module, a law relating two views of the same value
    dont: compute the expected value by calling the implementation under change, or assert collaborator call graphs
    harm: a green suite that cannot fail when the behaviour is wrong
    check: review — each expected value names an independent source
    example:
      wrong: expect(parse(text)).toEqual(parse(text))
      right: expect(parse('a: 1')).toEqual({ a: 1 })
  - id: CONST-T2
    title: Test What a Consumer Observes
    gate: review
    do: assert behaviour, boundaries, transitions, precedence, and real errors
    dont: assert wiring, field copies, defaults, mock echoes, or source text; write a test so the change "has tests"
    harm: the suite pins implementation, then breaks on every refactor and misses every real defect
    check: review — the assertion fails when a plausible bug is introduced
    example:
      wrong: expect(store.setFileContent).toHaveBeenCalledWith('x')
      right: expect(store.getState().fileContent).toBe('x')
```

Everything else is one line, with the gate that enforces it:

- Pure and effectful split by return type, not by folder: a function that owns I/O returns a promise or an effect, a decision takes data and returns data or a typed error. Gate: review.
- `src/lib` holds pure helpers; the React layer reads state and calls them. Gate: `oxlint.config.ts`'s import plugin.
- One failure, one variant: a distinct failure gets a distinct discriminator, never a boolean flag or a string that encodes the case. Gate: review.
- Never cast outside data into a domain type; narrow it or validate it at the boundary. Gate: `oxlint` (`typescript/no-unsafe-type-assertion`, `typescript/no-non-null-assertion`).
- Fire-and-forget is written as `void`, not left bare. Gate: `oxlint` (`typescript/no-floating-promises`).
- Fix the root cause; a guard around a symptom is not a fix. Gate: review.
- Subtract before you add: removal is the default response to duplication; a refactor that adds net lines names what it deleted. Gate: review.
- Break a rule knowingly, and say so in the change that breaks it. A silent bypass is two failures. Gate: review.
