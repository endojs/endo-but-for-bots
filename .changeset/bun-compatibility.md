---
'ses': patch
'@endo/module-source': patch
'@endo/parser-pipeline': patch
'@endo/pass-style': patch
---

`lockdown()` now succeeds on Bun.
`ModuleSource` and parser-pipeline module analysis now work on Bun.
Errors carrying JavaScriptCore and Bun source-location properties are now passable.
