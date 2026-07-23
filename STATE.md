# STATE.md

## Deliverable contract

Audit and repair the existing Exo, Marshal, and Patterns `tsd` suites on draft
PR #840, explicitly enable each suite whose public contract can be established,
verify the result, and push focused commits to
`0xpatrickbot:test/align-tsd-contracts`.
The final packaging step owns the push and must remove this file first.
`STATE.md` must not appear in the pull-request diff.

## Work completed

- Branch: detached worktree for `0xpatrickbot:test/align-tsd-contracts`.
- Base: `origin/llm` at `e1271728e`.
- Existing PR head: `9a1e1f039`.
- The mandatory pre-follow-up rebase is a no-op because the PR head already
  contains the current base.
- Installed the immutable dependency graph, ran `yarn clean`, and rebuilt all
  declarations with `yarn build:types`.
- Reproduced the posting-time baseline exactly: Exo has four diagnostics,
  Marshal has three diagnostics, and Patterns has 24 diagnostics.
- Audited and repaired all 24 Patterns diagnostics. Eight shorthand and typed
  collection diagnostics came from lossy `any`/intersection inference; two
  deep-record diagnostics came from contextual widening; and the bare-return
  diagnostic exposed a default generic widened to `any` inside an interface.
  The remaining 13 fixture sites were stale exact expectations or used the
  wrong concrete-remotable spelling; one diagnostic was the literal-narrowing
  assertion itself.
- A clean composite build followed by the focused Patterns shared-runner command
  is green.
- Audited and repaired all three Marshal diagnostics. The two `AtomStyle`
  literals are narrower expressions whose contract is assignability. The
  `fromCapData` result was a genuine `any` leak: `CapData` does not encode its
  decoded value type, so the public result is now `unknown` as the existing
  fixture and original type-design commit intended.
- Updated Marshal's `parse` declaration and the two CapTP protocol decode
  boundaries that knowingly refine `fromCapData` output. A clean composite
  build and the focused Marshal shared-runner command are green.
- Audited and repaired all four Exo diagnostics. The `PromiseLike<any>` and
  defaulted optional `bigint` mismatches were stale exact expectations. The kit
  parameter was a stale contextual-inference assumption: the public declaration
  intentionally requires an implementation annotation to preserve consumer
  method types, now verified on the returned facet. The `Promise<any>` result
  was the same bare-return defect corrected in the Patterns commit and now
  remains exactly `Promise<void>` in Exo's vstorage fixture.
- The focused Exo shared-runner command is green after the clean composite
  build.
- Commit map:
  - `10a01ca33 test(types): align opt-in tsd contracts` establishes the shared
    runner and opts in six existing suites.
  - `9a1e1f039 chore: update yarn.lock` records the shared runner dependency.
  - `b5c94da10 fix(patterns): align inferred type contracts (#840)` removes
    three inference defects, aligns stale fixture expectations, and opts the
    Patterns suite into the shared runner.
  - `4d0fcec59 fix(marshal): remove decoded value any leak (#840)` returns
    `unknown` from untyped CapData decoding, narrows trusted protocol consumers,
    aligns `AtomStyle` assignability checks, and opts in Marshal.

## Decisions

- Treat every deferred diagnostic as an audit item and trace it through the
  emitted declaration before choosing an exact, assignability, source-type, or
  unresolved-contract resolution.
- Keep the PR draft and do not mutate its body, comments, review state, or
  issue #830.
- Preserve concrete non-InterfaceGuard remotable types with
  `CastedPattern<T>`; `M.remotable<T>()` intentionally resolves non-interface
  payloads to `any` for compatibility.
- Validate `splitRecord` fields through a mapped intersection so inline nested
  pattern values remain narrow while non-Pattern values are still rejected.

## Pending work

- Commit the coherent Exo fixture and package opt-in change with this refreshed
  state.
- Run all required type, lint, runtime, formatting, uniformity, freshness, and
  diff gates; measure root `test:types` wall time.
- Package the branch by removing `STATE.md`, confirming it is absent from the
  outgoing diff, committing that removal, and pushing with force-with-lease.

## Hazards and verification

- Baseline commands used the shared runner directly with `index.d.ts`: Exo and
  Patterns used `test/*.test-d.ts`; Marshal used `src/*.test-d.ts`.
- Exactness diagnostics can mask unwanted `any`; do not weaken assertions until
  source and emitted declarations show the inferred type is intentional.
- A package with an unresolved contract remains excluded until a maintainer
  chooses between the competing types.
- The current worktree is detached, so the final push must explicitly target
  `0xpatrickbot:test/align-tsd-contracts`.
