# Retire lockdown-only test selection in `@endo/hardened262`

| | |
|---|---|
| **Created** | 2026-08-27 |
| **Updated** | 2026-08-27 |
| **Author** | endolinbot (prompted) |
| **Status** | Not Started |
| **Source** | Follow-up requested in review 5045929318 on PR #1064 (head `ec37f708d74c64714475c8452145623bf26b004c`) |

## What is the Problem Being Solved?

The maintainer's approving review on PR #1064 asked for a follow-up: *"propose a
change that causes these tests to be run in every environment, removing the
lockdownOnly flag from the run. This may reveal new failures that need
addressing, but moreover will increase clarity for coverage ratchets."*

Fourteen cases in `packages/hardened262/test/` carry an `onlyLockdown`
front-matter flag (the review named it `lockdownOnly`; the token as spelled in
the corpus and as the filter machinery reads it is `onlyLockdown`). That flag
restricts a case to the `lockdown*` half of the scenario cross product, so today
each flagged case is **generated only into lockdown scenarios and is entirely
absent from the non-lockdown ones** — not skipped, not counted, simply missing.
Because the harness executes exactly the `module` and `lockdownModule` scenarios
(`agentRunsScenario`, `scripts/test.js`), the practical effect is: a flagged case
runs in `lockdownModule` for all three agents and appears **nowhere** in the
`module` column.

This is precisely what muddies coverage-ratchet accounting. PR #1064's ratchet
counts "executed passing case-agent-scenarios"; but the `module` column
enumerates a *smaller* case set than `lockdownModule` — shorter by exactly the
`onlyLockdown` cases — so the two wired scenarios have different denominators and
"why is this case in one column but not the other?" is answerable only by reading
front-matter. Removing the flag makes the wired columns enumerate the same case
set (rectangular coverage), and — more importantly — surfaces a real, currently
**hidden** parity divergence between the SES shim and native Hardened
JavaScript, which is the entire reason this package exists (README, *The cross
product*).

This design is the named follow-up review surface. It does **not** fold the
change into PR #1064 (a coverage-ratchet PR); a later builder implements from
here.

## Ground truth (measured on this branch)

### How the flag is consumed

`onlyLockdown` is **not** referenced by name anywhere in `scripts/` or the
golden test `scripts/scenarios.test.js`. It rides the generic only-rule in
`filterOnlyRules` (`scripts/test.js`): any flag matching `^only[A-Z]` maps to the
qualifier obtained by lower-casing its first post-`only` letter, and a case
survives a scenario only if every such qualifier holds. `onlyLockdown` →
qualifier `lockdown`. So the flag is pure data over an existing, generic
mechanism; retiring it is a **corpus edit, not a harness-code change** — there is
no dedicated branch to delete.

### Inventory of the fourteen flagged cases

| Case | Full flags | Post-retirement selection |
|---|---|---|
| `test/harden/property.js` | `onlyLockdown` | every scenario (module + lockdownModule wired) |
| `test/harden/proto.js` | `onlyLockdown` | every scenario |
| `test/harden/getter.js` | `onlyLockdown` | every scenario |
| `test/harden/cycle.js` | `onlyLockdown` | every scenario |
| `test/harden/exists.js` | `onlyLockdown` | every scenario |
| `test/harden/proto-of-property.js` | `onlyLockdown` | every scenario |
| `test/harden/property-of-proto.js` | `onlyLockdown` | every scenario |
| `test/harden/transitive-proto.js` | `onlyLockdown` | every scenario |
| `test/harden/transitive-property.js` | `onlyLockdown` | every scenario |
| `test/lockdown/function-frozen.js` | `onlyLockdown` | every scenario |
| `test/harden/frozen.js` | `onlyStrict, onlyLockdown` | strict + module (module is strict) |
| `test/harden/private-field.js` | `onlyStrict, onlyLockdown` | strict + module |
| `test/harden/stamp.js` | `onlyStrict, onlyLockdown, noSesNode` | strict + module, never `sesNode` |
| `test/Compartment/prototype/Symbol.toStringTag-lockdown.js` | `noSloppy, onlyLockdown, noXs, noSesNode, noSesXs` | strict + module modes, once an agent exclusion is lifted |

### Why the baseline records this case as skipped

`baseline/zeroCoverage/skipped.txt` is not a list of tests that ran and elected
to skip at runtime.
It is the lossless inventory for source files whose front-matter filters leave
no agent-scenario pair to execute.
Such a file cannot honestly appear under `passed.txt` or `failed.txt`, because
neither outcome was observed.
The harness instead emits one synthetic `zeroCoverage` record so the excluded
file remains visible.

All ten files in that baseline group are `Compartment` or `ModuleSource` tests
whose source front matter records known behavior gaps for the current agents.
Every file carries the complete current-agent exclusion: `noXs` covers bare XS,
and `noSesXs` plus `noSesNode` cover the two SES shim agents.
Their individual source descriptions preserve the more specific disposition:

| Case | Recorded reason it has no eligible current agent |
|---|---|
| `test/Compartment/ModuleSource/bindings/name.js` | The `ModuleSource.prototype.bindings` descriptor check is pending a SES fix. |
| `test/Compartment/ModuleSource/needsImport/name.js` | The `needsImport` descriptor check is known to fail on XS and SES. |
| `test/Compartment/ModuleSource/needsImportMeta/name.js` | The `needsImportMeta` descriptor check is known to fail on XS and SES. |
| `test/Compartment/constructor/resolveHook.js` | The `Compartment` `resolveHook` behavior is pending a SES fix. |
| `test/Compartment/prototype/Symbol.toStringTag-lockdown.js` | The locked-down `Compartment.prototype[Symbol.toStringTag]` descriptor is pending a SES fix. |
| `test/Compartment/prototype/Symbol.toStringTag.js` | The non-lockdown `Compartment.prototype[Symbol.toStringTag]` descriptor is pending a SES fix. |
| `test/Compartment/prototype/import/importHook-separate-errors.js` | Separate error results from concurrent `importHook` consumers are known to fail on XS and SES. |
| `test/Compartment/prototype/importNow/importNowHook-separate-errors.js` | Separate synchronous error results are known to fail in SES and bare XS. |
| `test/Compartment/prototype/importNow/importNowHook-source-parent.js` | Parent-source resolution through `importNowHook` is known to fail in XS and Node.js. |
| `test/Compartment/prototype/importNow/loadNowHook-source-parent.js` | Parent-source resolution through `loadNowHook` is known to fail in XS and SES. |

The `Symbol.toStringTag-lockdown.js` row is the only member of this group that
also carries `onlyLockdown`.
Removing that token broadens its mode eligibility, but deliberately does not
override any environment exclusion: `filterNoRules` still removes all three
agents, so the case remains visible in `zeroCoverage/skipped.txt`.
When support for any excluded agent is implemented, removing that agent's
`no*` flag will move the case into that agent's scenario baseline with an
observed pass or failure.

### The matrix broadening reveals (measured, wired scenarios only)

Running the harness over `test/harden` + `test/lockdown` with `onlyLockdown`
stripped, against the checked-in tree, adds these `module`-scenario outcomes and
removes nothing (every prior `lockdownModule` result is unchanged):

| Agent / new column | passed | failed | Which cases fail |
|---|---|---|---|
| `xs/module` (bare native XS) | +12 | +1 | `function-frozen.js` |
| `sesXs/module` (SES shim on XS) | +12 | +1 | `function-frozen.js` |
| `sesNode/module` (SES shim on Node) | 0 | +12 | all 11 harden cases it runs **+** `function-frozen.js` |

Net: **+24 newly-passing** and **+14 newly-failing** case-agent-scenarios, all in
the previously-empty `module` column; `lockdownModule` is untouched. For the
`xs` agent the `module` column rises to parity with `lockdownModule` (both
enumerate the same harden set), which is the rectangular-coverage win.

### Why each cell lands where it does (root causes, probed directly)

- **Native XS freezes primordials *lazily*, on the first `harden()` call — not
  ambiently at startup.** `Object.isFrozen(Function)` is `false` in a fresh XS
  realm and becomes `true` only after any `harden(...)`. Hence under `xs/module`
  the harden-graph cases **pass** (each calls `harden`, which establishes the
  invariant they then assert), while `function-frozen.js` — which asserts
  `Object.isFrozen(Function)` without ever calling `harden` — **fails**.
- **The SES shim on XS (`sesXs`) rides native `harden`.** `harden` is present
  pre-lockdown, so the harden-graph cases pass under `sesXs/module` exactly as
  under bare XS; the shim-vs-native distinction *collapses* pre-lockdown on XS.
  `function-frozen.js` still fails because the shim's realm has replaced
  `Function` with an evaluator wrapper that is not frozen until `lockdown()`.
- **The pure-JS SES shim on Node (`sesNode`) gates `harden` on `lockdown()`.**
  Before `lockdown()`, `harden` is *not defined* (`ReferenceError`); every
  harden-graph case throws at its `harden(...)` call, and `function-frozen.js`
  fails because `Function` is not frozen pre-lockdown. This is the one agent
  where the divergence is real and load-bearing, and it is exactly what
  `onlyLockdown` hides today.

## Design

### 1. Retire the flag globally (corpus edit)

Delete the `onlyLockdown` token from all fourteen cases, collapsing the flags
list (`[onlyStrict, onlyLockdown]` → `[onlyStrict]`; a lone `[onlyLockdown]` →
`[]`, which `test262-stream` normalizes away). No `scripts/` change is required;
no golden-test change is required (`scenarios.test.js` pins only the generic
`onlyStrict`/`onlyModule`/`no*`/`raw` machinery, never `onlyLockdown`).

### 2. Add a guard so the flag cannot silently return

"Retire globally" should be enforceable, not merely done once. Add a cheap
assertion to `scripts/scenarios.test.js` (or a lint rule) that the corpus
contains **no** `onlyLockdown` front-matter flag. This converts the retirement
into a standing invariant: a future case that reaches for lockdown-only
selection trips a test with a message pointing here, rather than silently
re-hiding itself from the non-lockdown column. (Tracking anchor for the guard: to
be filed as an issue on `endojs/endo-but-for-bots` at implementation time if the
builder prefers a lint over a golden-test assertion.)

### 3. Regenerate and re-baseline; classify every new failure

Run `yarn test262:update` to accept the broadened matrix, then classify each
newly-visible `module` outcome. The harness baseline is *lossless by design* and
records `failed` as a first-class, reviewable outcome (README: it "reports
per-scenario pass/fail … a failing case is printed, not a non-zero exit, so
cases the native surface has not yet reached are visible rather than fatal").
The baseline is therefore the correct ledger for acknowledged divergence.

Three classes, and how each should be represented after retirement:

```mermaid
flowchart TD
  A[newly-visible module outcome] --> B{passes?}
  B -->|yes| C[Class 1: genuine broadened coverage<br/>xs/module + sesXs/module harden = +24<br/>record as passed, no action]
  B -->|no| D{failure cause}
  D -->|harden undefined pre-lockdown<br/>sesNode shim| E[Class 2: unsupported combination<br/>shim harden is a lockdown product<br/>record as failed - acknowledged, NOT a defect]
  D -->|invariant not yet established<br/>Function not frozen pre-lockdown| F[Class 3: lockdown postcondition<br/>true in no agent pre-lockdown<br/>record as failed - genuine semantic fact]
```

- **Class 1 — genuine broadened coverage (24).** The harden-graph cases passing
  under `xs/module` and `sesXs/module` are real, previously-uncounted coverage
  proving native (and shim-on-XS) `harden` is ambient before lockdown. Record as
  `passed`. No further action; this is the payoff.
- **Class 2 — unsupported harness/environment combination (11).** The
  `sesNode/module` harden failures are not defects in SES: the pure-JS shim
  *correctly* installs `harden` only at `lockdown()`; "harden before lockdown on
  the Node shim" is an operation outside the shim's contract. Record as `failed`
  baseline entries and document them as acknowledged divergence, not regressions
  to fix. Their *value* is documentary: they pin, as reviewable data, that the
  Node shim's hardened surface is lockdown-gated while XS's is ambient — the
  parity signal the package exists to measure.
- **Class 3 — lockdown postcondition (`function-frozen.js`, 3 agents).**
  `assert(Object.isFrozen(Function))` is a lockdown/harden *postcondition*, false
  in every agent's fresh non-lockdown realm (native XS: until first `harden`;
  both shims: until `lockdown()`). Its uniform `module`-column failure across all
  three agents is a genuine semantic statement about pre-lockdown state, not an
  agent divergence. Record as `failed`.

The recommended end state: **remove the flag, broaden the matrix, and record the
observed outcomes in the baseline verbatim** — passes where the invariant holds,
failures where it does not. This maximizes the maintainer's stated goals
(run-in-every-environment + coverage-ratchet clarity) and keeps the baseline
honest. None of the fourteen require a change to SES or XS; the "failures that
need addressing" are addressed by *acknowledgment in the baseline*, which is what
this harness's baseline is for.

## Migration sequence (for the builder)

1. Strip `onlyLockdown` from the fourteen cases (§Design 1); collapse flag lists.
2. Add the anti-reintroduction guard (§Design 2).
3. `yarn --cwd packages/hardened262 build` then
   `MODDABLE_VERSION=<pinned> yarn --cwd packages/hardened262 test262:update` to
   regenerate `baseline/` (needs `xst` on `PATH` for the `xs`/`sesXs` agents).
4. Review the baseline diff: it must show **only** additions to `*/module/*.txt`
   (+24 `passed`, +14 `failed` across the wired columns) and **no** change to any
   `lockdownModule` file. Any `lockdownModule` movement is a red flag — the flag
   removal must not perturb lockdown scenarios.
5. Update the classification of the recorded `module` failures in the PR body (or
   a short note in `README.md`'s coverage section) so a reviewer reading
   `failed.txt` knows the entries are acknowledged divergence, keyed to this
   design.
6. `yarn --cwd packages/hardened262 test` (golden/harness tests) and `lint`.

## Verification plan

- **Rectangularity check:** after re-baselining, the wired `module` and
  `lockdownModule` columns for each agent enumerate the same case set for the
  harden/lockdown family (spot-check: `xs/module` and `xs/lockdownModule` both
  contain all twelve harden cases).
- **No-regression check:** `git diff` on `baseline/` touches only `*/module/`
  paths; every `lockdownModule` outcome is byte-identical.
- **Guard check:** temporarily re-adding `onlyLockdown` to one case makes the new
  guard test fail with the pointer message; remove it again.
- **Determinism:** two consecutive `test262:update` runs on the pinned XS binary
  produce identical baselines (the harness sorts outcomes; `test-xs` CI already
  pins this).
- **CI:** the repository's `test-xs` job runs `test262:baseline`; a green run on
  the regenerated baseline is the acceptance gate.

## Rollback boundary

The change is confined to `packages/hardened262/`: fourteen `test/**.js`
front-matter edits, the regenerated `baseline/` tree, one guard assertion, and an
optional `README.md` note. No `scripts/` logic, no SES or XS code, no other
package. Rollback is a single revert of that commit; because the flag rode a
generic filter and no code was deleted, reverting restores the exact prior
selection with no residue. The blast radius touches only this private test
instrument (`@endo/hardened262` is not published; PR #1064 confirms "no
production upgrade or changeset is required").

## Open questions

- **Should the Class-2 `sesNode/module` harden failures be recorded as `failed`
  (recommended here — visible divergence, honest ledger) or converted to
  `skipped` via a new "requires harden / needs lockdown" precondition qualifier
  in the harness?** A skip would keep `failed.txt` reserved for surprises while
  still keeping the coverage matrix rectangular and visible (unlike the old flag,
  which filtered entirely). The cost: a skip re-hides the shim-vs-native
  divergence the maintainer wanted surfaced, and re-introduces per-precondition
  filtering logic this change otherwise removes. The maintainer's "may reveal new
  failures that need addressing" reads as a preference for visible failures,
  which is why `failed` is recommended — but the choice is theirs.
- **Should `function-frozen.js` be broadened at all, or split?** It is a pure
  lockdown postcondition with no cross-agent divergence, so its `module`-column
  contribution is a uniform failure that carries less information than the harden
  cases' tri-agent contrast. An alternative is to split it into an
  ambient-expectation case and a post-lockdown case. Recommendation: broaden it
  as-is (uniform failure is still honest data and the simplest end state), but
  flag the split as available if the maintainer prefers the `module` column to
  carry only meaningful-difference cases.
- **Guard mechanism: golden-test assertion vs. lint rule?** Both enforce "no
  `onlyLockdown` in the corpus"; the builder should pick whichever matches the
  package's existing conventions (the golden test already lives at
  `scripts/scenarios.test.js` and needs no new tooling).
