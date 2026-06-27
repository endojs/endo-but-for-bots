# Cross-Package Plain Re-Exports

| | |
|---|---|
| **Created** | 2026-06-27 |
| **Author** | Mark S. Miller (prompted) |
| **Status** | Not Started |
| **Source** | endojs/endo-but-for-bots#543 |

## Summary

Many endo packages re-export names that originate in other packages.
Issue #543 calls such a pass-through a **plain re-export**:
a re-export that does not rename and adds no value to an importer over
importing the name from the package that originally exports it.
`@endo/far` is the canonical example.
It exists only for the convenience of a shorter import path, and its
`src/index.js` re-exports names that `@endo/eventual-send` and `@endo/pass-style`
already export:

```js
export { E } from '@endo/eventual-send';
export { Far, getInterfaceOf, passStyleOf } from '@endo/pass-style';
```

This design states the *cross-package* rule that follows from #543, gives its
rationale, and lays out the deprecate-then-remove staging the issue requests.
It is the inter-package companion to the intra-package design in #544;
the two share #543's vocabulary and staging shape but operate at different
granularities.

## The rule

> Import a name from the package that originally exports it, never from another
> package that merely re-exports it unchanged.

A **plain re-export** is a package-level re-export
(`export { name } from '@other/package'`, or `export *`) that does not rename
`name` and adds nothing an importer could not get by importing `name` straight
from the package that defines it.

A re-export that *adds value* is not a plain re-export and is out of scope:
renaming, narrowing a type, wrapping with additional behavior, or consolidating
a package's own modules into its public entry barrel all leave the re-export in
place.
The rule targets only the convenience pass-through that gives importers a
pointless second source for the same name.

## Rationale

The rationale is #543's, recorded here so the design is self-contained.

- **Tooling disambiguation.**
  This convenience was worth it back when much code was written in pre-IDE
  editors like vi or emacs.
  Today most code is written in an IDE, with AI assistance, or both.
  Given that, a plain re-export is an anti-convenience: a support tool that sees
  a use-occurrence of a name needing an import now faces a pointless choice of
  which exporting package to import from.
  It either hazards a poor choice or interrupts the author to choose.
  A single canonical source per name removes the choice.

- **Smaller bundles.**
  An import through a plain re-exporter can pull the re-exporting module (and
  whatever else it references) into a bundle that a direct import would have
  left out.
  Importing from the originating package keeps the dependency graph minimal and
  honest.

- **Readable layering.**
  A clean import list tacitly reminds code readers of the actual layering of
  concepts.
  When every import names the package that owns the concept, the import list
  documents the system's structure.

- **Clearer genuine choices.**
  The rule does not suppress true collisions: two packages may each be the
  *originally exporting* package for the same name, meaning two separate things.
  Those choices matter and should remain.
  Removing the pointless choices makes the remaining ones legible, so an IDE
  bothers the author to choose only when the choice actually carries meaning.

## Relationship to the intra-package case (#544)

This work and the intra-package design in #544 are symmetric siblings.
They share the *plain re-export* vocabulary and the deprecate-then-remove
staging, but this one operates across package boundaries while #544 operates
among modules within a single package.
The maintainer's follow-up on #543 explicitly decoupled the intra-package work;
neither blocks nor depends on the other, and either can land first.

## Staging

The issue requests this work as two stacked PRs.
Mirroring the design-and-guidance-first shape used for #544:

1. **This PR — articulate and discourage (no behavior change).**
   Land this design and a `CONTRIBUTING.md` `Coding Style` entry so new
   cross-package importers are discouraged from importing through a plain
   re-exporter from the start.
   No re-exports are removed and no importers move yet.
   This gives reviewers a single place to settle the rule before any churn.

2. **Follow-up PR — deprecate, repoint, and remove (mechanical).**
   Mark surviving plain re-exporters as deprecated so tooling steers new
   importers away during the transition, repoint existing cross-package
   importers at the originating package, then remove the plain re-exports that
   become unreferenced (retiring convenience-only aggregators such as
   `@endo/far` where nothing of value remains).
   This is deliberately separate because it is broad, mechanical, and reviewed
   most easily one package at a time.

Because this is `endojs/endo-but-for-bots`, both stages may be merged here once
ready and approved.
The removal stage **must not** be merged into `endojs/endo` until we are
adequately confident there are no outstanding importers that depend on a
cross-package plain re-export, in this repository or in others.

## Examples in the current tree

These are illustrative starting points for the follow-up removal pass, not an
exhaustive inventory.

- `@endo/far` is the canonical plain re-exporter.
  Its `src/index.js` re-exports `E` from `@endo/eventual-send` and
  `Far`, `getInterfaceOf`, and `passStyleOf` from `@endo/pass-style` without
  adding value, alongside a value-adding `export *` of its own `./exports.js`.
  The removal pass repoints importers of the re-exported names at their
  originating packages; whether `@endo/far` survives at all depends on whether
  anything of its own value remains once the pass-throughs are gone.

The follow-up PR enumerates these mechanically, package by package, across the
workspace.

## Open questions

- **`export *` re-exporters.**
  A non-renaming `export *` from another package is a plain re-export for this
  rule's purposes.
  A package's own public-entry `export *` over *its own* modules is a deliberate
  API surface and is the intra-package concern of #544, not this rule.

- **Type-only re-exports.**
  A re-export used purely for `@import` types carries the same tooling-ambiguity
  cost as a value re-export and is in scope, but its repoint is type-position
  only and never changes runtime bundling.

- **Telling plain from value-adding.**
  The removal pass must judge each re-export: a rename, a type narrowing, or a
  documented seam adds value and stays; a bare non-renaming pass-through does
  not and goes.
  Borderline cases (a re-export whose only value is a stable import path that
  external code already depends on) are decided per case during removal.
