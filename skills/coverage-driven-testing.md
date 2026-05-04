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

3. **For each uncovered line or branch, decide one of three:**
   - **Reachable but untested.** Write a test that exercises the
     branch with a realistic input. The new test must catch a
     real failure mode; see
     [`regression-evidence.md`](./regression-evidence.md).
   - **Reachable but only by adversarial inputs.** Hand off to
     the `saboteur` role; coverage isn't the right driver for
     gotcha tests.
   - **Unreachable.** Delete the dead code. Run `grep -rn
     <function-or-symbol-name>` first to confirm no other
     package, no test fixture, and no `// @ts-` directive
     mentions it.

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

- No call site in the package itself.
- No call site in any other package in the monorepo (`grep -rn
  <name> packages/`).
- No `@import` JSDoc reference in any `.js` or `.ts` file.
- The package's exported surface (`index.js` / `package.json`
  `exports`) does not include it.

Anything less than all four is a "covered later" candidate, not
dead.

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
- **`ava`'s parallel test workers and `c8`.** Some packages set
  `ava` to run serially. Coverage gathered under a different
  concurrency than CI uses can differ; if numbers look weird,
  run `yarn test` (which uses the project's standard wrapper)
  and compare.
