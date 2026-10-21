---
'@endo/module-source': patch
'@endo/parser-pipeline': patch
---

Module analysis now works on Bun. Bun binds the default import of
`@babel/traverse` to the traverse function instead of to `module.exports`, so
`ModuleSource` and the parser pipeline found no traverse function and threw.
