---
'@endo/errors': minor
'@endo/eventual-send': minor
'@endo/harden': minor
'@endo/hex': minor
'@endo/zip': patch
---

Each of `@endo/errors`, `@endo/eventual-send`, `@endo/harden`, and `@endo/hex`
gains a `test-endo-<pkg>` exports condition that exposes per-file or
subpath-pattern entries under `./src/*` (or `./hardened.js` and `./noop.js` for
the flat `@endo/harden` package layout) for use by sibling test packages.
The new condition is invisible to ordinary consumers; only an importer that
resolves with `--conditions=test-endo-<pkg>` sees the additional entries.
The public surface of each package is unchanged.

`@endo/zip` no longer declares `@endo/eventual-send` or `@endo/ses-ava` as
`devDependencies` (its tests were not using either).
