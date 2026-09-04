---
'@endo/platform': minor
'@endo/exo-npm': major
'@endo/daemon': minor
'@endo/agent-tools': minor
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

The platform `ReadableTree` split also regenerates `@endo/agent-tools`'
published code-mode declarations: `MountReadableTree` and `GitLiteReadableTree`
gain an optional `help?` facet in the `fs`/`git` subpath exports — a
user-observable published-type change.

`@endo/exo-npm` gains the directory-tree presentation and its eager MVS
resolver over that tree: new subpath exports `./registry-tree.js` and
`./registry-tree-resolver.js`, the root exports `makeNpmRegistryTree`,
`makePackageRegistryTree`, `makeLookupTreeView`, `makeEndorNpmRegistryTree`,
`resolveRegistryTree`, `lookupPackageVersion`, `makeDeprecatedEndoRegistryAdapter`,
the `RegistryDirectoryInterface` / `RegistryHubInterface` /
`RegistrySnapshotTreeInterface` guards, the new `RegistryNotFoundError` /
`RegistryPathSyntaxError` error factories and the `isPackageRegistryError`
predicate (the `RegistryMissingPackageError` / `RegistryNetworkError` factories
were already root exports).

Breaking: the `mvs-resolver` resolution-hash preimage format changes.
`resolutionHashPreimage` (newly exported from `./mvs-resolver.js`) now hashes a
`JSON.stringify` of the `[key, integrity]` pairs instead of the former
`${key}\t${integrity}` newline-join, because registry-controlled keys and
integrity strings could contain the `\t`/`\n` the join delimited on — a
non-injective preimage that let two distinct closures collide onto one
content-addressed cache key. `RegistryResolution.resolutionHash` is the key for
resolution reuse, so **every previously computed `resolutionHash` changes**: any
pinned resolution, reproducibility record, or `resolutionHash`-keyed cache entry
recomputes once under the new format (a one-time cache miss, not a correctness
regression).

Breaking: the snapshot mapper's option rename. `mapSnapshot` and
`makeMountReadPowers` now take `registryRoot?: RegistryDirectory` in place of the
former `registry?: { fetch(name, version) }` bag — a caller passing the old key
silently resolves nothing.

`@registry`'s guard moves from the `EndoRegistry` method protocol
(`resolve`/`fetch`/`lookup`/`list`) to the directory tree
(`has`/`lookup`/`list`); holders of the superseded method surface migrate
through `makeDeprecatedEndoRegistryAdapter`. That adapter is a **partial**
compatibility path, not a drop-in: `list()` is a permanent empty stub (the tree
exposes no registry-wide enumeration), `lookup(name, version)` now materializes
a version leaf and throws offline where the old surface returned `undefined`,
and `resolve` requires an injected resolver.

Backend caveat: the `offline` posture is enforced at tree-construction time
(`registryPowers.offline`), not per `resolve` call — the directory-tree resolver
takes no per-call `offline` knob. On the Node daemon `makeRegistryNodePowers`
leaves it `false`, so a caller cannot currently demand no-egress through the
tree path; the daemon guard still admits the option.
