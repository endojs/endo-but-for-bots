# Coverage-driven testing

## When to use

When opening a coverage-improving change for a single package, or
when investigating whether a region of code is reachable at all.

The project uses `c8` to instrument coverage; every package's
`yarn test` script wraps `ava` with it under the standard CI
configuration.

## Procedure

1. **Establish a baseline.** From the package directory:
   ```sh
   cd packages/<name>
   npx c8 --reporter=text --reporter=html-spa ava
   ```
   Note the per-file branch and line percentages. The `html-spa`
   reporter at `coverage/index.html` lets you click into specific
   files and see which lines are uncovered.

2. **Pick one source file at a time.** Don't sweep the whole
   package at once; focus produces sharper tests and cleaner
   diffs.

3. **For each uncovered line or branch, decide one of four:**
   - **Reachable from a public-API entry point.** Write an
     **integration test** that drives the entry point with a
     realistic input and lets the uncovered branch fall out of
     the exercise. The new test must catch a real failure mode;
     see [`regression-evidence.md`](./regression-evidence.md).
   - **Reachable only through a host hook, platform-conditional,
     or other configuration the public API can't trigger.**
     A targeted unit test is acceptable, but document why the
     branch is not reachable from the public surface.
   - **Reachable but only by adversarial inputs.** Hand off to
     the `saboteur` role; coverage isn't the right driver for
     gotcha tests.
   - **Unreachable.** Delete the dead code. Run `grep -rn
     <function-or-symbol-name>` first to confirm no other
     package, no test fixture, and no `// @ts-` directive
     mentions it.

**Prefer integration tests over unit tests.** A public-API
exercise covers more of the package per test, breaks honestly
when internals refactor, and forces the same path a real consumer
would take. Reach for a unit test only when the branch is
genuinely public-API-unreachable per the second bullet above.

4. **Re-run coverage** after each change. The percentage should
   increase; if a new test does not move it, the test isn't
   exercising what you intended.

5. **Iterate per file**, not per percentage point. A package
   that goes from 78% → 92% by adding three meaningful tests is
   better than one that hits 95% with twelve contortion-tests
   that mock half the dependencies.

## Test additions

- Tests live next to the code they cover: `packages/<name>/test/<file>.test.js`.
- Follow the AVA conventions in [`pre-pr-checklist.md`](./pre-pr-checklist.md):
  `t.teardown`, `t.timeout`, `t.throwsAsync(fn, { message: /…/ })`,
  inline assertions over `t.snapshot`.
- A test that requires an elaborate mock or a dependency-
  injection rewrite is a signal that the code under test has the
  wrong shape, not that you need a more elaborate test. Surface
  it; don't paper over it.

## Deletions

- Dead-code deletion is a separate commit from any test addition,
  and should be straightforwardly reviewable: each deleted block
  cited with the grep evidence that nothing references it.
- Conventional-commit message: `chore(<pkg>): remove unreachable
  <thing>`. Do not use `refactor` for pure deletion.
- If a deletion crosses a public-API line, do not delete; ask the
  maintainer. The c8 report does not know whether external
  consumers reach a function.

## Threshold for "dead"

A function or branch is dead when **all** of these hold:

- No call site in the package's own non-test source
  (`src/` or equivalent). **Test-only call sites do not count
  as live callers** — a function whose only caller is a unit test
  in the same package is dead, and the unit test exists to keep
  it alive.
- No call site in any other package in the monorepo (`grep -rn
  <name> packages/ --exclude-dir=test`).
- No `@import` JSDoc reference in any `.js` or `.ts` file.
- The package's exported surface (`index.js` / `package.json`
  `exports`) does not include it.

Anything less than all four is a "covered later" candidate, not
dead.

The grep pattern that distinguishes "live caller" from "test-only
caller":

```sh
grep -rn '<symbol>' packages/<name>/src/        # live callers
grep -rn '<symbol>' packages/<name>/test/       # test-only
grep -rn '<symbol>' packages/ --exclude-dir=test --exclude-dir=node_modules
```

If the first and third are empty and only the second hits, the
symbol is dead, the test is its only reason for existence, and
both should be deleted in the same commit.

## Pitfalls

- **`c8` over-reports as "uncovered" lines that the test runner
  never imported.** A file in `src/` that no test imports shows
  0% coverage even if it works fine. Either add an import-only
  test or accept the gap with a one-line note.
- **Branch coverage on early-return guards.** A function with
  `if (x) return early;` shows the early return as one branch;
  exercising both is required for full branch coverage but the
  payoff is usually small.
- **Coverage that drops after refactoring.** A refactor that
  combines two near-duplicate code paths can lower the line
  count and consequently the absolute number of covered lines,
  even when the percentage went up. Report percentages, not
  absolutes.
- **Unit tests as life-support for dead code.** A unit test that
  imports an internal helper and asserts trivial behavior on it
  is often the cleaner role's signal that the helper has no
  real callers. Resist the impulse to write the test; check the
  caller graph first. If the only caller would be your test,
  delete the helper instead.
- **`ava`'s parallel test workers and `c8`.** Some packages set
  `ava` to run serially. Coverage gathered under a different
  concurrency than CI uses can differ; if numbers look weird,
  run `yarn test` (which uses the project's standard wrapper)
  and compare.
- **Forked packages inherit dead branches.** When a package is
  derived from a sibling (e.g. `@endo/syrups` from
  `@endo/netstring`, with the only behavioral change being
  removal of a trailing-comma check), the small grammar tweak
  often kills branches that were live in the parent. Watch for
  uncovered lines whose surrounding logic, after the tweak,
  contradicts the conditions that lead into them. In syrups the
  parent's strict `buffer.length > remainingDataLength` guard
  became `>=`, which made the inner
  `buffer.length === remainingDataLength` branch a logical
  impossibility. The right fix in the derived package is to
  delete the dead branch (in its own commit, with a comment
  explaining why the guard is no longer needed), not to keep it
  on life support with a contortion test. A grep against the
  parent package will tell you which originally-shared code was
  preserved unchanged.
- **AVA intercepts unhandled rejections.** Code paths whose
  observable behavior is "schedule a microtask that throws and
  let the host's unhandled-rejection bookkeeping surface it"
  (e.g., a default rejection handler in a callback-based
  primitive) are intrinsically hard to test under AVA. Any
  rejection that escapes inside a test file fails the file,
  even with a `process.on('unhandledRejection', ...)` listener
  installed in the test (AVA's own listener also fires and
  fails the file regardless of order). Two paths that work, both
  of which the cleaner should reject as contortion:
  monkey-patching `Promise.resolve` for the test's duration to
  attach a `.catch`, or installing a `process.prependOnceListener`
  that mutates the rejection state before AVA observes it.
  Neither belongs in a coverage-driven test. The honest move is
  to leave the path uncovered with a one-line note in the
  source citing why coverage isn't pursued, and report the gap
  in the cleaner summary as "out of scope: contortion required."
  Encountered on PR #170 (2026-05-10): the
  `HandledPromise.subscribe` default rejection handler in
  `eventual-send/src/handled-promise.js` L502-506; the
  cleaner shipped two clean tests for adjacent gaps and
  documented this one gap as deliberately uncovered.
