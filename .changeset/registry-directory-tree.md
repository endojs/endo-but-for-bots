---
'@endo/platform': minor
'@endo/exo-npm': minor
'@endo/daemon': minor
---

Split the portable tree guards into lookup-only and enumerable capability
layers. Existing readable trees retain their full source-compatible surface,
while registries and other non-enumerable hubs can now withhold `list` authority
structurally with `LookupTreeInterface`.

Expose the npm registry at every daemon host's `@registry` name as that
directory-tree capability on both Node and Endor. Package metadata remains
lazy, exact-version leaves retain integrity-checked CAS behavior, and the old
method-call registry remains available only through an explicit compatibility
adapter.

`@endo/exo-npm` gains the directory-tree presentation and its eager MVS
resolver over that tree: new subpath exports `./registry-tree.js` and
`./registry-tree-resolver.js`, the root exports `makeNpmRegistryTree`,
`makePackageRegistryTree`, `makeLookupTreeView`, `makeEndorNpmRegistryTree`,
`resolveRegistryTree`, `lookupPackageVersion`, `makeDeprecatedEndoRegistryAdapter`,
the `RegistryNotFoundError` / `RegistryPathSyntaxError` error factories, and the
`isPackageRegistryError` predicate. Note the breaking option rename on the
already-present snapshot mapper: `mapSnapshot` and `makeMountReadPowers` now take
`registryRoot?: RegistryDirectory` in place of the former
`registry?: { fetch(name, version) }` bag — a caller passing the old key silently
resolves nothing. `@registry`'s guard moves from the `EndoRegistry` method
protocol (`resolve`/`fetch`/`lookup`/`list`) to the directory tree
(`has`/`lookup`/`list`); holders of the superseded method surface migrate through
`makeDeprecatedEndoRegistryAdapter`. That method surface was never released
(see the folded `registry-capability.md` note), so no `@endo/daemon` major is
owed.
