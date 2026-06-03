---
'@endo/daemon': patch
---

Apply the SES censorship-evasion transform on the Node-worker archive
load path.

The previous workflow ran `@endo/evasive-transform` at bundle time
inside `@endo/bundle-source`'s `endoZipBase64` path. After the pivot
to source-only ZIP archives via `@endo/compartment-mapper`'s
`makeArchive`, the transform was no longer applied anywhere, and any
caplet whose source contained a TypeScript JSDoc `import()`
annotation (the cleanest trigger) or that retained `@endo/errors`
(whose source contains the same JSDoc shape) failed to load with an
SES SyntaxError.

The fix is on the Node-worker side only: `makeArchive` and
`makeFromTree` now parse module sources through a wrapper that
applies `evadeCensor` to `mjs` and `cjs` bytes before the
compartment sees them. The archive itself remains untransformed,
which keeps the Rust supervisor's load path unchanged; the
transform happens in memory on the way to the compartment.
