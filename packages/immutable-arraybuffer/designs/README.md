# Designs for `@endo/immutable-arraybuffer`

Composite design documents for the `@endo/immutable-arraybuffer` package.
Each file captures one design topic; new design topics get their own
file rather than extending an existing one.

## Index

- [`immutable-arraybuffer.md`](immutable-arraybuffer.md):
  The drop-the-pseudo-prototype reshape of the ArrayBuffer-side
  emulation.
  Establishes the amplifier-with-this-fallthrough pattern, the
  lib-as-property-record shape, the consolidated `lib.js` file
  topology, and the stage-3 detect-then-skip install policy.
  Renamed from the package-rooted `DESIGN.md` on this branch.
  Intended for: builders and reviewers who need to understand the
  ArrayBuffer-side lib topology before reading the TypedArray-side
  design; also the primary entry point for maintainers reviewing the
  ArrayBuffer-side PR design decisions.
- [`freezable-typedarray.md`](freezable-typedarray.md):
  The TypedArray-side analog explicitly named in
  `immutable-arraybuffer.md` section *Out of scope*.
  Brings the same drop-the-pseudo-prototype reshape to the eleven
  concrete `TypedArray` constructors so a `Uint8Array` backed by an
  emulated immutable `ArrayBuffer` is frozen and immutable at the
  JavaScript surface.
  Depends on the ArrayBuffer-side reshape having merged first.
  Intended for: builders and reviewers working on the TypedArray-side
  emulation; read `immutable-arraybuffer.md` first to understand the
  underlying lib topology this design extends.

## Conventions

- File names are kebab-case slugs of the topic.
  No `DESIGN-` prefix on the basename; the `designs/` directory carries
  that role.
- Each design carries a *Status* table near the top with `Created`,
  `Authors`, `Status` (Proposed / Accepted / Implemented / Superseded),
  and `Depends` / `Affects` / `Replaces` rows where applicable.
- Cross-references between designs in this directory use relative paths
  (for instance, `freezable-typedarray.md` references
  `immutable-arraybuffer.md`, not the full
  `packages/immutable-arraybuffer/designs/immutable-arraybuffer.md`
  path).
- Cross-references from package source (under `src/`, `test/`) to a
  design in this directory use the package-rooted path
  (`designs/immutable-arraybuffer.md`).
- When two design topics within this package would produce the same
  kebab-case slug, add a short qualifier to the second slug to
  distinguish them (for example, appending `-v2` or a scope word
  such as `-typedarray`).
  The qualifier should appear in the filename only; the document's
  heading title uses the full human-readable phrase.
