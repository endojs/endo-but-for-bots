# Regression evidence

## Principle

Every new test should be **proven load-bearing** by demonstrating
that it fails when the code path it exercises is broken. A test that
passes whether or not the implementation is correct is not a
regression test.

## How

After committing a new test:

1. Temporarily break the smallest unit of the code path the test is
   meant to cover. Examples:
   - For a new lint rule, comment out a branch in the rule's logic
     and confirm one of the rule's `invalid` fixtures starts firing
     differently.
   - For a new visitor, mis-assign one intrinsic / mis-route one
     handler and confirm the test fails with a clear name.
   - For a new diagnostic, remove the new check and confirm the test
     fails with the *old* cryptic error.
2. Run the test. It must fail with a recognizable message.
3. Revert the temporary break.
4. Run the test again. It must pass.
5. Cite the experiment in the PR body or summary comment as
   "regression-test note": describe the temporary change, confirm
   the failure was observed, confirm it was reverted.

## Why

This catches three classes of mistake:

- A test that asserts something already trivially true (e.g.,
  reflexive identity) and never exercises the new code path.
- A test that depends on a side effect already exercised by another
  test, so removing the new code makes the *other* test fail first.
- A test that uses a fixture covering a pattern the new code doesn't
  actually handle.

## Pitfalls

- "Temporarily break" must be small and reversible. A `git stash`
  before the change makes the revert mechanical: `git stash pop`.
- For property-based tests, the regression demonstration is
  statistical: shrink the property to deterministically exercise
  the boundary, or seed the generator.
- An "existing test already covers this area" is not the same as
  "this fix is regression-tested." Async-iterator writers in
  particular have several distinct teardown shapes: resolution with
  `{ done: true }`, resolution with `{ done: false }` from a sink
  that intends to stay open, rejection from a sink that errored
  mid-stream, and `throw()` driven from upstream. A test that
  exercises closure-by-resolution will not catch an unhandled-
  rejection regression on the rejection path, even if both paths
  end with the writer reporting `done`. When borrowing an existing
  test as the regression posture, name which of these shapes it
  covers and confirm the fix's failure mode matches.

## Session example

Used in every implementation PR this session:

- #3052 copyBag rank cover: reverted the `case 'copyBag':` line and
  confirmed the new test fails.
- #2390 harden-exports destructuring: removed the `RestElement`
  branch and confirmed the corresponding fixture failed.
- #1845 bundler no-name diagnostic: removed the new check and
  confirmed the new test fell through to the old cryptic error.
- #3156 pass-style document.all: temporarily broke the new code
  path and confirmed the test failed.
- module-source visitor audit: temporarily mis-assigned
  `%SetIteratorPrototype%` and confirmed the new
  `get-intrinsics.test.js` failed with a clear name.
- @endo/chacha12: temporarily set `ROUNDS = 10` and confirmed all
  four chacha12 vector tests failed.
