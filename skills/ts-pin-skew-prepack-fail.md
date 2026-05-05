# TypeScript pin skew: viable-release prepack failure

## The error

```
../harden/make-hardener.js(437,21): error TS2578: Unused '@ts-expect-error' directive.
```

Surfaces during the `viable-release` step (`yarn lerna run --reject-cycles --concurrency 1 prepack`) on a single package's `tsc --build tsconfig.build.json`, but the **failing file is not in the package being prepacked**.
The error path crosses a workspace boundary
(`../<other-package>/<file>.js`).

## Why it happens

A package pins `typescript` to a version older than the workspace
catalog version (e.g. `~5.9.2` against `catalog:dev` resolving to
`~6.0.2`).
With `allowJs: true` in `tsconfig.build.json`, the older `tsc`
follows `dependencies` into other workspace packages and type-checks
their `.js` files using its own (older) ruleset.
A `@ts-expect-error` directive that the newer compiler considers
load-bearing (because the surrounding code triggers a real type
error) the older compiler may consider unused (because its narrowing
is weaker).
Result: TS2578 fires in the dependency package's source while
prepacking the dependent.

## Detection

1. The error path starts with `../<sibling-package>/`, not the
   current package's own files.
2. The package has a non-catalog typescript pin:
   `grep '"typescript"' package.json` shows a literal version
   (e.g. `~5.9.2`) instead of `catalog:dev`.
3. The dependency in the path **does** use the catalog (so its own
   prepack passes; only the dependent's prepack fails).

## Fix

Align the offending package's typescript pin with the catalog:

```diff
   "devDependencies": {
     ...
-    "typescript": "~5.9.2"
+    "typescript": "catalog:dev"
   }
```

Then regenerate the lockfile (separate commit per CLAUDE.md):

```sh
npx corepack yarn install
git add packages/<name>/package.json
git commit -m 'fix(<name>): align typescript pin with catalog (~5.9.2 -> catalog:dev)'
git add yarn.lock
git commit -m 'chore: Update yarn.lock'
```

## Why packages pin TS at all

Some packages in the tree intentionally pin `~5.9.2`
(`chat`, `familiar`, `lal`, `markmdown`, `platform`, `sandbox`,
`trampoline`).
Most of them have `prepack: exit 0` (no tsc invocation in
prepack), or zero `@endo/*` dependencies, so they never visit
sibling sources at the older TS.
A new package added with `tsc --build` in prepack **and** any
`@endo/*` dep should default to `catalog:dev` unless there is a
specific reason to pin lower.

## Pitfalls

- The failing line/column is in someone else's source.
  Don't try to "fix" the directive in `make-hardener.js` to please
  TS 5.9; the right TS version (the catalog) already accepts it.
- `chat`, `familiar`, `platform`, etc. all pin 5.9.2 today and
  have green CI, but only because their prepack does not run tsc
  across workspace boundaries.
  This is fragile: any future change to their prepack scripts or
  the harden source could re-trip the same skew.
- A `viable-release` failure on **all** Node versions
  (18/20/24 ubuntu) of the same job class is a strong signal of a
  deterministic non-runtime cause; do not retry as a flake.

## Session example

PR 29 (`feat(syrups): add @endo/syrups package`):
the original `feat(syrup-frame)` commit copied a `~5.9.2` pin
from one of the sibling packages.
The package depends on `@endo/harden` (which uses TS 6.0.2) and
runs `tsc --build` in prepack with `allowJs: true`.
TS 5.9.2 reported `make-hardener.js(437,21): error TS2578: Unused
'@ts-expect-error' directive.` against a directive TS 6.0.2 sees
as required.
Fix was a one-line bump to `catalog:dev` plus a lockfile regen.
