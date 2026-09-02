# @endo/exo-npm

Package registries presented as Endo directory trees, together with eager MVS
resolution and snapshot mapping.

The registry root is enumerable and initially contains `npm`. The npm and scope
hubs are deliberately lookup-only capabilities: they have no `list` method.
Package directories enumerate exact published versions, and an exact version
is the immutable content-addressed package tree.

## Main exports

- `makeNpmRegistryTree(operations)` adapts narrow `listVersions` and
  `providePackageTree` mechanics to the npm lookup hub.
- `makeEndorNpmRegistryTree(hostPowers)` presents the identical surface over
  Endor's Rust host powers.
- `makePackageRegistryTree({ npm })` builds the stable registry-family root.
- `resolveRegistryTree(entryPackageJson, registryRoot, options)` performs an
  eager, same-vat MVS walk and emits a reusable `RegistryResolution`.
- `makeLookupTreeView(tree)` attenuates an enumerable fixture tree for
  production-shape tests.
- `makeDeprecatedEndoRegistryAdapter(root, options)` is the explicitly obtained
  compatibility path for the old `lookup(name, version)` and `list()` protocol.

The tree reports its read consistency through `getInfo().temporal`: `stable` at
the configured root, `live` at package-name and version-listing nodes, and
`immutable` at an exact package version. A version leaf also reports the npm
`dist.integrity` used by `RegistryResolution.resolutionHash`, separately from
the leaf's CAS content hash.

The original `makeNpmReferenceRegistry` and `makeMvsResolveHook` exports remain
available during migration. New integrations should use the directory tree and
the ordinary `resolveRegistryTree` function.

See
[`designs/npm-registry-as-directory-tree.md`](../../designs/npm-registry-as-directory-tree.md)
for the capability, error, locality, and compatibility contracts.
