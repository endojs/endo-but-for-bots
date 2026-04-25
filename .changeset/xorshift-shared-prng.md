---
'@endo/xorshift': minor
'@endo/hex': patch
---

The `@endo/xorshift` package replaces the `_xorshift.js` test helpers that had been duplicated under `packages/ocapn/test/` and `packages/hex/test/`.
Both packages now import `makeXorShift` from `@endo/xorshift` for fuzz/benchmark seeding, and the duplicate copies have been removed.

`@endo/xorshift` ships its own ses-ava multi-config test suite (lockdown, unsafe, shims-only) and hardens the returned generator and the `makeXorShift` factory.
