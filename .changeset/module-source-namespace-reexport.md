---
'@endo/module-source': patch
---

Record `export * as foo from './bar.js'` correctly in the analyzed
`__reexportMap__`.
Previously the babel-plugin pushed `[local.name, exported.name]`, but
an `ExportNamespaceSpecifier` has no `local` field, producing entries
keyed by `undefined`.
The plugin now uses the already-computed `importFrom` value (`'*'` for
namespace specifiers), so the export resolves to the source module's
namespace as the ECMAScript spec requires.
