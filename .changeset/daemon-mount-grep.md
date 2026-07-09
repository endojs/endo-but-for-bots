---
'@endo/daemon': minor
---

Add `grep(pattern, options?)` to `EndoMount`.

`grep(pattern, options?) -> Promise<Array<{ file, line, text }>>` searches file
contents within the mount face's confined root. `pattern` is an ECMAScript
regular-expression source evaluated as `new RegExp(pattern)` with no flags; both
platforms run this same `mount.js` (V8 under Node, XS under the Rust
supervisor), so the engine dialect is ECMA-262 on both sides.

Files are selected through `glob(options.glob)` (default `'**/*'`), inheriting
its confinement, deny filtering, and UTF-16 ordering; directories and files
whose text read fails (a binary file XS refuses to decode, a permission error,
or a path that vanished mid-scan) are skipped silently. Content splits on `\n`
with a trailing `\r` stripped from each matched line (CRLF normalization, a
documented divergence from #127), line numbers are 1-based, and each matching
line yields one `{ file, line, text }` record. `options.maxResults` (default
1000) caps the number of records returned.

The change extends the shared, cross-language test artifacts with a grep variant
case table (`test/mount-grep-cases.json`) over the same
`test/mount-fixture-manifest.json` fixture, which a Rust/XS-side runner will
consume to assert Node/Rust parity.
