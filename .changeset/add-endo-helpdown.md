---
'@endo/helpdown': minor
'@endo/exo-git': minor
'@endo/daemon': patch
---

Add `@endo/helpdown`, the Markdown help scanner and `help()` factory that Endo
capabilities share. Helpdown reads a Markdown document structurally — a level-1
header opens an entity, a level-2 header opens a method, body text belongs to
the header above it — and headers inside fenced code blocks and blockquotes stay
content rather than structure.

The package is split by lifetime rather than by topic. `@endo/helpdown` exports
the pure `parseHelpdown` scanner and the `makeHelp` factory, and its module
graph imports no host builtin, so it loads under XS and in any SES realm.
`@endo/helpdown/tools.js` exports the `loadHelpTextFile` and
`readHelpTextFileSync` loaders and is the only module in the package that
imports `node:fs`; a package that compiles its `help.md` to a checked-in data
module reaches for it from a generator script and never from its sources.

`@endo/daemon` and `@endo/exo-git` now take their scanner and `makeHelp` from
this package. `@endo/exo-git` no longer carries its own copy of `makeHelp`, and
its help generator no longer reaches into `@endo/daemon`'s internals by relative
path. Both packages' exported surfaces are unchanged: `makeHelp` is still
exported from `@endo/daemon`'s `src/help-text.js` and from `@endo/exo-git`.

The fallback wording a capability shows when it has no documentation for what
was asked — `No documentation available for this interface.` and
`No documentation available for method "<name>".` — now has one definition,
pinned by a test, so it cannot drift between capabilities.
