# Compartment Mapper: Auxiliary `package.json` Overrides

## Objective

Honor an **auxiliary `package.json`** — one without a `name` — as a
language-for-extension override scoped to its subdirectory, rather than as the
root of a separate compartment.

Node.js overloads `package.json` with two responsibilities. A descriptor with a
`name` defines a **package**: the unit npm publishes, that others depend on by
name, and that the compartment mapper turns into a compartment with its own
`packageLocation`, `parsers`, alias tables, and policy seat. A descriptor
_without_ a `name` is also sanctioned: Node.js walks upward from a source file
to the nearest enclosing `package.json` to determine the `type` (`"module"` vs
`"commonjs"`) that disambiguates extensions such as `.js`. A package author can
drop a minimal `{"type": "module"}` (or its inverse) into a subdirectory to
scope a small subtree to a different module system — the pattern transpiled
libraries use when they emit a `cjs/` sibling next to an `esm/` sibling and want
`.js` to resolve differently in each.

Such an **auxiliary descriptor** exists only to override resolution rules within
its enclosing named package's subtree; it does not imply a separate compartment.
The single field that classifies a descriptor is the presence of a non-empty
`name`: a named descriptor defines a compartment, an unnamed one contributes only
language-for-extension overrides to the subtree at or below its directory. This
matches Node.js, which consults the nearest enclosing `package.json` for `type`
regardless of whether it has a `name`, but resolves `import 'apackage'` only to
the named one.

## Implemented design

### Two kinds of descriptor

- A **compartment-defining descriptor** has a non-empty `name`. It declares
  dependencies, exports, and parsers and corresponds 1:1 to a compartment node.
  Only this kind seats in `policy`, contributes a `packageLocation`, or appears
  in the package graph.
- An **auxiliary descriptor** has no `name` (or an empty one). It contributes
  only language-for-extension overrides for files at or below its directory,
  scoped within a single compartment-defining ancestor. It contributes no
  exports, dependencies, aliases, conditions, `packageLocation`, label, or
  policy seat; a `name` field, if present, is unused.

### Package-descriptor cache

`package-descriptor-cache.js` factors the `package.json` read-and-memoize logic
(formerly private to one `graphPackages` invocation) into a first-class cache
keyed by directory URL. It memoizes one read per directory and classifies each
descriptor as compartment-defining or auxiliary at insert time, so the upward
walk that finds the enclosing named compartment and the walk that collects
language overrides share I/O and stay consistent.

`mapNodeModules` keeps its public signature and **constructs the cache on demand**
when the caller supplies none, so auxiliary handling is the default — there is no
separate entry point. The `packageDescriptorCache` option survives only so an
advanced caller can share one cache (and its memoization) across calls.
`mapNodeModules`'s relatives (`archive`, `bundle`, `import`) inherit the behavior
by funnelling through the same contract. `importArchive` and any relative that
consumes a fully described compartment map — where every module's language is
already pinned per descriptor — need no cache and are unaffected.

### Lazy per-module override at parse time

The static graph builder does not traverse package subtrees: modules within a
package are discovered lazily at import time, so the override lookup is lazy, not
precomputed per compartment.

For each loaded module, the import hook (`import-hook.js`,
`resolveAuxiliaryLanguageForExtension`) walks upward from the module's location
to the compartment root, reading any intermediate auxiliary `package.json` files
(memoized per compartment, via the same trampoline that serves both the sync and
async hooks). It layers their language-for-extension deltas shallow-to-deep onto
the compartment's base `parsers` map — deeper auxiliaries winning on conflicting
extensions — records one cumulative `{ prefix, languageForExtension }` entry per
auxiliary directory on the compartment descriptor's `languageForExtensionByPrefix`
field (an ordered array, shortest prefix first), and passes the deepest matching
prefix's map to the parser as a per-module override (`map-parser.js`). When no
auxiliary descriptor lies between the module and the compartment root, the hook
returns nothing and the compartment's flat base `parsers` map is used unchanged,
preserving behavior for packages without auxiliary descriptors.

This covers modules reached by relative import within an auxiliary subtree at any
dependency depth; modules reached via package `exports` remain covered by the
existing `readDescriptorUpwards` path, which agrees with this override.

The pure layering and selection helpers live in
`language-for-extension-by-prefix.js`:

- `languageForExtensionOverride(descriptor)` — the language-for-extension delta a
  single descriptor implies (see below), plus any explicit `parsers` field it
  carries.
- `layerLanguageForExtension(base, descriptor)` — overlays one descriptor's delta
  onto a base map, deeper winning, returning a new frozen null-prototype map.
- `selectLanguageForExtension(base, byPrefix, relativeModulePath)` — selects the
  map for the deepest prefix that prefixes the module's path, falling back to
  `base`.

### Type-dependent extensions, mirroring Node.js

Only `.js` and `.ts` are type-dependent. Under `type: "module"` (or when a
`module` field is present) `.js` resolves to `mjs` and `.ts` to `mts`; under
`type: "commonjs"` they resolve to `cjs` and `cts`. Every other extension is
type-independent: `.mjs`/`.mts` are always module languages and `.cjs`/`.cts` are
always CommonJS, regardless of the enclosing `type`, exactly as Node.js treats
them. So an auxiliary descriptor only ever flips `js` and `ts` (plus any explicit
`parsers` field), matching `inferParsers`.

`auxiliary-typescript.test.js` confirms the `ts`/`mts`/`cts` classification
against Node.js's rules over a fixture tree, including the load-bearing
regression that a `{"type":"commonjs"}` auxiliary flips `.ts` to CommonJS (a
`.ts` file using `module.exports` would throw if parsed as a module) while `.mts`
inside that same subtree stays an ECMAScript module.

## Design decisions

1. **Deeper overrides win.** Matches Node.js's `type` convention — the nearest
   enclosing `package.json` decides — and the author's intent that a deeper
   auxiliary is a more specific override.
2. **The named ancestor owns `packageLocation`.** A compartment exists to be
   addressable (policy graph node, `exports` `from` target, compartment-map row);
   an unnamed descriptor cannot be addressed, so it cannot be a compartment.
3. **Auxiliary descriptors contribute language overrides only** — no exports,
   dependencies, aliases, conditions, or policy seat. The conservative scope is
   easy to defend and can broaden if a real use case appears.
4. **The PR 70 diagnostic is the floor.** Only _intermediate_ unnamed descriptors
   are reclassified. When no named ancestor exists at all, the entry's package is
   genuinely anonymous and the mapper still fails loudly with the missing-`name`
   diagnostic. The upward walk ends at the filesystem root or at a `node_modules`
   boundary (matching Node.js's `LOOKUP_PACKAGE_SCOPE`, which never ascends past
   `node_modules`).
5. **Field name `languageForExtensionByPrefix`.** It literally describes the
   structure (an array of records mapping a directory prefix to a
   language-for-extension map) and mirrors the existing flat `parsers` field. The
   unified shape suffices until a reproducer needs a finer
   `module`/`commonjs`-split.
6. **Policy composition is out of scope and a no-op.** Policy is keyed by
   canonical name and an auxiliary descriptor produces none, so the two
   structures never meet.

## Dependencies

| Design / PR                                                                            | Relationship                                                                         |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| [endojs/endo-but-for-bots PR #70](https://github.com/endojs/endo-but-for-bots/pull/70) | Added the loud missing-`name` diagnostic this design replaces in the auxiliary case. |
| [endojs/endo issue #1845](https://github.com/endojs/endo/issues/1845)                  | Upstream tracking issue for the original diagnostic; this design is the deeper fix.  |
