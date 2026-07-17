# Designs for `@endo/immutable-arraybuffer`

Composite design documents for the `@endo/immutable-arraybuffer` package.
Each file captures one design topic; new design topics get their own
file rather than extending an existing one.

## Index

- [`immutable-arraybuffer.md`](immutable-arraybuffer.md):
  the drop-the-pseudo-prototype reshape of the ArrayBuffer-side
  emulation.
  Establishes the amplifier-with-this-fallthrough pattern, the
  lib-as-property-record shape, the consolidated `lib.js` file
  topology, and the stage-3 detect-then-skip install policy.
  Renamed from the package-rooted `DESIGN.md` on this branch.
- [`freezable-typedarray.md`](freezable-typedarray.md):
  the TypedArray-side analog explicitly named in
  `immutable-arraybuffer.md` section *Out of scope*.
  Brings the same drop-the-pseudo-prototype reshape to the eleven
  concrete `TypedArray` constructors so a `Uint8Array` backed by an
  emulated immutable `ArrayBuffer` is frozen and immutable at the
  JavaScript surface.
  Depends on the ArrayBuffer-side reshape having merged first.

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
