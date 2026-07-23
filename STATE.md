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
- Commit map:
  - `10a01ca33 test(types): align opt-in tsd contracts` establishes the shared
    runner and opts in six existing suites.
  - `9a1e1f039 chore: update yarn.lock` records the shared runner dependency.

## Decisions

- Treat every deferred diagnostic as an audit item and trace it through the
  emitted declaration before choosing an exact, assignability, source-type, or
  unresolved-contract resolution.
- Keep the PR draft and do not mutate its body, comments, review state, or
  issue #830.

## Pending work

- Install the checked-in dependency graph and reproduce the clean-build Exo,
  Marshal, and Patterns baseline diagnostics.
- Classify and repair the Exo diagnostics, prove changed coverage is
  load-bearing, and commit the coherent package change with refreshed state.
- Classify and repair the Marshal diagnostics, prove changed coverage is
  load-bearing, and commit the coherent package change with refreshed state.
- Audit Patterns by root cause, repair only established contracts, prove
  changed coverage is load-bearing, and either enable or explicitly defer it.
- Run all required type, lint, runtime, formatting, uniformity, freshness, and
  diff gates; measure root `test:types` wall time.
- Package the branch by removing `STATE.md`, confirming it is absent from the
  outgoing diff, committing that removal, and pushing with force-with-lease.

## Hazards and verification

- Exactness diagnostics can mask unwanted `any`; do not weaken assertions until
  source and emitted declarations show the inferred type is intentional.
- A package with an unresolved contract remains excluded until a maintainer
  chooses between the competing types.
- The current worktree is detached, so the final push must explicitly target
  `0xpatrickbot:test/align-tsd-contracts`.
