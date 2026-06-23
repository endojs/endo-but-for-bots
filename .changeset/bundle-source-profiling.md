---
'@endo/bundle-source': patch
'@endo/compartment-mapper': minor
'@endo/evasive-transform': patch
'@endo/module-source': patch
'@endo/zip': patch
---

Improve multi-entry bundle-source performance and add profiling tools.

Adds Chrome trace profiling for `@endo/bundle-source`, trace merge summaries,
and an Agoric SDK bundle profiling helper. Adds profiling spans across
compartment-mapper, evasive-transform, module-source, and zip archive writing.

Improves repeated bundling performance with shared read behavior, optimized
node-modules graph processing, cross-bundle archive parser reuse, and zip writer
path tuning. Adds a zip writer benchmark script.

## Behavior changes

- `.node` and `/index.node` suffixes are no longer included in
  `nodejsConventionSearchSuffixes` in `compartment-mapper`.
  Native Node.js addons cannot be archived or loaded from virtual module
  sources; callers relying on convention-based `.node` suffix expansion will
  resolve differently.
- `nominateCandidates` in `import-hook.js` now skips suffix expansion when the
  specifier already ends with a known suffix (such as `.js`, `.json`,
  `/index.js`, `/index.json`).
  Specifiers like `'./foo.js'` previously generated a five-candidate set
  including `'./foo.js.js'`; they now resolve only to `'./foo.js'`.
- `versionNeeded` in zip local file headers changed from `0` (with a TODO
  noting it was probably too lax) to `10` (matching the STORE compression
  method in use).
  Downstream consumers that pinned the exact bytes of an `endoZipBase64Sha512`
  value will see a hash change after this update.
