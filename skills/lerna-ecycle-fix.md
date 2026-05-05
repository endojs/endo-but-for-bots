# Lerna ECYCLE: detection and fix

## The error

```
lerna ERR! ECYCLE Dependency cycles detected, you should fix these!
lerna ERR! ECYCLE @endo/ses-ava -> @endo/module-source -> @endo/ses-ava
```

Surfaces during the `viable-release` CI step, which runs
`yarn lerna run --reject-cycles --concurrency 1 prepack`. The error
is fatal: the run exits non-zero before any prepack actually runs.

## Not every `viable-release` failure is ECYCLE

`viable-release` runs `prepack` for every package; any per-package
`tsc --build` error also fails the job, often across all three
Node-version matrix slots simultaneously (because the failure is
deterministic and source-only). When you see all three
`viable-release` jobs red, **read one job's log to the bottom
before assuming ECYCLE**. Look for:

- `lerna ERR! ECYCLE` -> follow this skill.
- `error TS<number>` lines -> a TypeScript error in some
  package's `prepack`. Open that package, reproduce with
  `cd packages/<name> && npx corepack yarn prepack`, fix the TS
  error directly. Common in this category: `TS2769 No overload
  matches this call` for `makeExo` when an implementation method
  signature is structurally narrower than the matching
  interface-guard pattern (e.g. impl says `(x: TraceRecord)` but
  guard says `M.record()` which produces `Record<string, any>`).
  Fix by widening the impl param to match the guard and casting
  inside if downstream code needs the narrow type.

## Why it happens

Lerna walks the *combined* `dependencies` + `devDependencies`
graph. A cycle through devDependencies is enough to fail. This bites
when a test file in package A imports package B for test machinery,
and package B already lists package A as a devDep for its own tests.

## Detection

Before pushing a change that adds a `workspace:^` dep:

```sh
# does the new target dep already devDep us?
grep -E '"@endo/<your-package>"' packages/<target>/package.json
```

If yes, you've created a cycle.

## Fix

Three options, in order of preference:

1. **Move the test code to a different package** that doesn't depend
   on the target. E.g., move per-compartment env-options coverage
   from `@endo/ses-ava` (which `@endo/module-source` devDeps) to
   `@endo/marshal` (which already devDeps both).
2. **Restructure the test** to avoid the cross-package import.
   Consume the target via runtime evaluation rather than a static
   import (e.g., compartment-scoped `import` of the source text).
3. **Add a third package** that both depend on, holding the shared
   utility.

## Pitfalls

- Even a `devDependency` cycle fails `--reject-cycles`. Lerna does
  not distinguish runtime from dev edges.
- The error message tells you the cycle **at the package level**
  but not which file/import caused it. Track it down with
  `git diff bots/master <head> -- packages/*/package.json` and
  follow the `workspace:^` additions.
- Not every `viable-release` failure is an ECYCLE.
  A `tsc` error referencing a sibling package's source
  (e.g. `../harden/make-hardener.js(...)`) is usually a TS pin
  skew, not a cycle.
  See [`ts-pin-skew-prepack-fail.md`](./ts-pin-skew-prepack-fail.md).

## Session example

PR 71 (`#2879 per-compartment env-options test`): the original
agent added `@endo/module-source` to `@endo/ses-ava`'s
`devDependencies` because the test needed `ModuleSource`.
`@endo/module-source` already devDeps `@endo/ses-ava`, producing the
cycle. The fix was option 1: revert the ses-ava additions, keep the
parallel marshal test (which already had both packages devDep'd).
Coverage of the per-compartment behavior was preserved because the
marshal test exercises the same code path end-to-end.
