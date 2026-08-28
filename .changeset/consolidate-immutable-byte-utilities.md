---
'@endo/immutable-arraybuffer': minor
'@endo/bytes': major
'@endo/marshal': major
'@endo/ocapn': patch
'@endo/thixotrope': patch
---

Consolidate the immutable byte utilities onto a single shared implementation
exported from `@endo/immutable-arraybuffer`, and rename them to `frozenBytes`
(previously `@endo/bytes`' `bytesToImmutable`) and `thawedBytes` (previously
`bytesFromImmutable`). `frozenBytes` wraps a `Uint8Array` view's contents in a
hardened frozen `Uint8Array` backed by an immutable `ArrayBuffer` (a
`'byteArray'` passable); `thawedBytes` copies such a value back out into a fresh
mutable `Uint8Array`. Importing the package's new main entry installs the shim
as a side effect, since `frozenBytes` depends on it; the bare install remains
the separate `@endo/immutable-arraybuffer/shim.js` export.

Breaking (no backward compatibility is preserved):

- `@endo/bytes` no longer exports `./to-immutable.js` (`bytesToImmutable`) or
  `./from-immutable.js` (`bytesFromImmutable`). Import `frozenBytes` and
  `thawedBytes` from `@endo/immutable-arraybuffer` instead. `@endo/bytes` keeps
  `./concat-immutables.js` (`concatImmutables`), now implemented on the shared
  utilities.
- `@endo/marshal`'s `decodeToJustin` now emits `frozenBytes(decodeHex(...))`
  instead of `bytesToImmutable(decodeHex(...))` for byteArray values, so a
  Justin evaluation environment must bind `frozenBytes` rather than
  `bytesToImmutable`.
