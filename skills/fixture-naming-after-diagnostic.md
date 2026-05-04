# Fixture renaming after a new diagnostic surfaces it

## The pattern

When a new validation/diagnostic is added that correctly fires on
the project's own test fixtures, the right fix is usually to **make
the fixture conform** to the validation, not to weaken the
validation.

## How to recognize the case

CI fails on a brand-new error message you just added, against a file
under `packages/<x>/{demo,test/_*,fixtures-*}/`. The error message
mentions the fixture's path, not application code. The fixture's
`package.json` (or whatever) lacks the field your new diagnostic now
requires.

Before assuming the diagnostic is over-eager:

1. Inspect the failing fixture. If it's clearly not real
   application code (e.g., `packages/bundle-source/demo/endo/`,
   `packages/ses/test/_package/`), it's a fixture.
2. Check whether the fixture is fed *through* the new diagnostic in
   normal use, or whether the diagnostic only sees it because the
   fixture is bundled. Only the former requires a fix.

## Fix

Add the missing field, plus `"private": true` to keep the fixture
out of any future publish.

```json
{
  "name": "<package-name>-<purpose>-fixture",
  "private": true,
  "type": "module",
  "dependencies": { … }
}
```

## Pitfalls

- Don't add `"name"` to a fixture that is consumed by direct `node`
  invocation rather than through the bundler. The fixture's own
  `package.json` becoming a "real" package can trigger lint rules
  like `import/no-relative-packages` that break the test for an
  unrelated reason. See PR 70's `packages/ses/test/_package`
  cleanup.
- A fixture with `"name"` that imports relative paths outside its
  own directory (`../../index.js`) will trip
  `import/no-relative-packages`. If you need the relative import,
  leave the fixture nameless and find a different path: either
  weaken the diagnostic (add an exception for unnamed fixtures) or
  refactor the fixture to import via the package name.

## Session example

PR 70 (`#1845 bundler no-name diagnostic`): the new diagnostic
fired on `packages/bundle-source/demo/endo/package.json` (real
fixture consumed by the bundler test). I added `"name":
"endo-marshal-demo"` and `"private": true`, and CI passed. I had
also speculatively added a name to `packages/ses/test/_package/`,
which triggered `import/no-relative-packages` because the fixture
contains `import '../../index.js'`. Reverting that second change
fixed the lint regression.
