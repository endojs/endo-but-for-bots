---
'@endo/far': major
---

Remove `@endo/far`'s plain re-exports, the removal stage of the inter-package
plain re-exports follow-up (`designs/inter-package-plain-re-exports.md`,
endojs/endo-but-for-bots#548, endojs/endo-but-for-bots#543).

`@endo/far` existed only to re-export `E` (from `@endo/eventual-send`), `Far` /
`getInterfaceOf` / `passStyleOf` (from `@endo/pass-style`), and the `FarRef` /
`ERef` / `EOnly` / `EReturn` / `EResult` types (from `@endo/eventual-send`),
without renaming or adding value. The repoint-and-deprecate stage moved every
in-repository importer onto the originating packages; this stage removes the
now-unreferenced re-exports, leaving `@endo/far` with no exports.

This is a breaking change: removing a plain re-export breaks any importer,
inside this repository or outside it, that still imports a name through
`@endo/far` rather than from its originating package. It therefore takes a major
version bump. Importers should import `E` and the eventual-send types from
`@endo/eventual-send`, and `Far` / `getInterfaceOf` / `passStyleOf` from
`@endo/pass-style`.
