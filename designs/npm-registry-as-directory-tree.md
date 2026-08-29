# Package Registries as an Endo Directory Tree

| | |
|---|---|
| **Created** | 2026-08-29 |
| **Author** | Kris Kowal (prompted) |
| **Status** | Not Started |
| **Supersedes** | [registry-capability](registry-capability.md) |

## Summary

Expose package registries as one read-only directory-tree capability
instead of the bespoke `EndoRegistry.resolve` / `fetch` / `lookup` /
`list` Exo (an exposed object whose methods are constrained by hardened
interface guards).
The root is an enumerable directory of registry names, initially
containing `npm`.
The npm child is a non-enumerable lookup hub: a caller must already know
a package name, just as npm has no endpoint that lists every package.
Each known package resolves to an enumerable directory of exact
published versions, and each version resolves to the existing immutable
CAS (content-addressed store) readable tree containing that package.

The Node Endo daemon and the Rust-hosted Endor daemon expose the same
method shapes and path layout.
Their existing HTTP, npmrc, integrity, MVS (Minimum Version Selection),
SQLite, and CAS machinery remains behind the tree as implementation
detail.

## What is the Problem Being Solved?

The registry mechanics are already tree-shaped at their useful boundary:
a selected `(name, version)` produces an immutable package-content tree.
The bespoke `EndoRegistry` capability nevertheless adds a second
vocabulary for reaching those trees and couples resolution, fetching,
cache diagnostics, and package storage into one interface.
That coupling makes a registry harder to substitute in tests and makes
Node and Endor parity depend on matching a project-specific method API
instead of matching the filesystem vocabulary both already consume.

As of 2026-08-29, the method-call interface has shipped in
`@endo/exo-npm` and the Node daemon.
This design therefore specifies a presentation-layer migration over
working machinery, not a rewrite of the registry proxy.

## Goals

1. One directory-tree shape for Node and Endor, including scoped npm
   packages.
2. Capability-enforced non-enumerability for the package-name hubs, with
   ordinary enumerable directories everywhere enumeration is meaningful.
3. A resolver that consumes a registry tree and can therefore consume a
   fixture tree without SQLite or network powers.
4. Preservation of the implemented npm fetch, integrity, cache, offline,
   workspace, peer, optional-dependency, and execution behavior behind
   adapters.
5. An open root for sibling registries, without an unneeded discovery
   protocol.

## Non-goals

- Reimplementing `RegistryTable`, MVS, npmrc authentication, tarball
  fetching, CAS check-in, assembly, or execution from
  [endor-npm-registry-proxy](endor-npm-registry-proxy.md).
- Listing every npm package.
- Representing semver ranges or npm dist-tags as tree entries.
- Specifying the future `endor:swissnum@hint@hint/version` protocol.
- Requiring every future registry named at the root to use npm
  package-name or semver rules.

## Tree shape

| Path | Capability surface | Enumeration and lookup |
|---|---|---|
| `/` | `EnumerableTree` | `list()` returns configured registry names, initially `['npm']`; `lookup('npm')` returns the npm hub. |
| `/npm` | Non-enumerable `LookupTree` | No `list` method. `lookup('ses')` returns its version directory; `lookup('@endo')` returns a non-enumerable scope hub. |
| `/npm/@scope` | Non-enumerable `LookupTree` | No `list` method. `lookup('package')` returns that scoped package's version directory. |
| `/npm/<package>` or `/npm/@scope/<package>` | `EnumerableTree` | `list()` returns exact published versions in ascending semver order; `lookup('1.2.3')` selects one version. |
| `.../<version>` | Immutable `SnapshotTree` / `EndoReadableTree` | The package root itself: `lookup('package.json')`, `lookup('src')`, and content identity through `getInfo()` / `sha256()`. |

The `SnapshotTree`, `EndoReadableTree`, `ReadableTreeInterface`, and
`SnapshotTreeInterface` names used here and below come from Endo's
consolidated filesystem-interface hierarchy; see
[fs-interface-consolidation](fs-interface-consolidation.md) and
[fs-interface-reconciliation](fs-interface-reconciliation.md) for that
hierarchy.

Scoped names use two path segments because `/` is a tree separator.
The leading `@` makes the intermediate scope hub unambiguous.

`lookup` accepts either an array path (`['@endo', 'patterns']`) or a
single string, and a single string is one path segment matched literally
against the current node's children; it is not split on `/`.
This follows the standing convention in `packages/daemon/src/mount.js`,
whose `segmentsFromEntryPathArg` reserves slash-splitting for `entry()`
and keeps every other path-bearing method on single-name string
matching.
So `lookup('@endo/patterns')` against `/npm` looks for a literal child
named `@endo/patterns`, finds none (the only matching key is the scope
hub `@endo`), and rejects; the scoped package is reached by
`lookup(['@endo', 'patterns'])` or by a stepwise `lookup('@endo')` then
`lookup('patterns')`.
The resolver and every adapter always spell scoped names as array paths
for this reason, and adapters must return the same intermediate scope-hub
capability for the stepwise and array-path forms.

Only exact published versions appear below a package.
`list()` on a package directory returns those versions in ascending
semver order, deterministically.
MVS applies semver predicates to the result of `list()` and then looks up
the selected exact version.
Dist-tags such as `latest` remain npm metadata and do not become aliases
in the directory.

Unknown names reject rather than returning `undefined`.
A `lookup` or `list` for an unknown registry, scope, package, or version
rejects with a structured `@endo/errors` error (a `RangeError` naming the
offending path), distinct from the `RegistryOfflineError` that a cache
miss raises when the backend holds no network authority (see § One shape
over both backends).
The cross-backend conformance suite asserts this not-found shape so the
Node and Endor adapters cannot diverge on it.

### Non-enumerability is a capability shape

Split the shared platform method guards so lookup authority is the base
and enumeration is an extension:

```ts
interface LookupTree {
  help(method?: string): string;
  has(...path: string[]): Promise<boolean>;
  lookup(path: string | string[]): Promise<unknown>;
}

interface EnumerableTree extends LookupTree {
  list(...path: string[]): Promise<string[]>;
}
```

`@endo/platform/fs/lite` exports the base method-guard record and
`LookupTreeInterface`.
It also gives the existing `readableTreeMethodGuards` surface a concrete
`EnumerableTreeInterface` name by extending that record with `list`.
The existing `ReadableTreeInterface` further adds `listTree`, while
`SnapshotTreeInterface` adds content identity; neither changes.
This distinction matters at the registry root: it can list registry
names, but a recursive `listTree` would falsely imply authority to
enumerate through the npm hub.
Existing tree, mount, directory, git, and zip implementations remain
source compatible because they already implement the superset.

The npm and scope hubs are Exos guarded only by `LookupTreeInterface`;
the root and package-version directories use `EnumerableTreeInterface`.
They do not implement `list`, so non-enumerability is authority the
holder never receives, not a boolean that asks an enumerable object to
behave.
`LookupTree` is the only genuinely new method shape; `EnumerableTree`
merely names the already exported common guard surface.
All other nodes reuse the consolidated filesystem interfaces.

## One shape over both backends

### Node-hosted Endo daemon

Add `makeNpmRegistryTree` in `@endo/exo-npm` over two injected
operations: list published versions for one known package and provide the
CAS tree for one exact version.
The Node adapter in `packages/daemon/src/registry-user.js` supplies those
operations from its existing packument cache, integrity verifier, tar
reader, and content store.
The existing `registry` formula (the daemon's persistent recipe for
constructing a capability) and its required `HostFormula.registry` field
stay in place, but incarnation (the daemon evaluating that formula to
produce the live capability) returns the registry root tree at
`@registry`.

Package-directory `list()` reads the packument and does not fetch
tarballs.
Version `lookup()` uses the existing idempotent provide path: a table/CAS
hit returns its tree, while a miss fetches, verifies, checks in, records,
and returns the same tree shape.
The root maker accepts a name-to-hub record rather than hard-coding `npm`
as the only possible child.

### Rust-hosted Endor daemon

Keep `rust/endo/src/registry.rs`, `fetch.rs`, `semver.rs`,
`npm_resolve.rs`, `assemble.rs`, `execute.rs`, and `npmrc.rs` as the
mechanics layer.
An XS-hosted adapter wraps narrow Rust host powers for `hasPackage`,
`listVersions`, and `providePackageTree` in the same
`LookupTreeInterface` and `EnumerableTreeInterface` Exos used by Node.
`listVersions` projects cached or freshly fetched packument metadata;
`providePackageTree` projects `RegistryTable::lookup` / `fetch_package`
and returns the existing CAS tree reader.
The callbacks are an implementation boundary, not an alternate public
API.

Online and offline registry trees have the same shape.
Offline is construction policy: the Endor adapter receives
`OfflineClient`, and the Node adapter receives a network-refusing fetch
power.
A cache miss rejects with the existing `RegistryOfflineError`; no
`offline` option is smuggled into generic tree methods.

The Node and Endor adapters run one shared conformance suite over the
same mock packuments and tarballs.
The suite asserts paths, method names, ordering, the not-found error
shape, cache-miss offline errors, content hashes, and the absence of
`list` on both npm and scope hubs.

## Read consistency

A version leaf (`.../<version>`) is immutable and content-addressed: its
tree is a value, identical on every read.
A package directory's `list()` (`/npm/<package>`) reads an external set
that npm keeps growing as new versions publish, so it is a live,
place-oriented read, not a value.
The two share the directory-tree vocabulary but not this temporal
contract, and this design states the contract rather than letting the
shared spelling imply one.

`list()` is a live read at the moment it is called.
A single `resolveRegistryTree` pass walks `list()` once per
transitively-discovered dependency, so those calls land at different
wall-clock moments, and a version published mid-resolution may be seen by
a later dependency's `list()` and not an earlier one; a resolution is not
guaranteed to observe one coherent point-in-time snapshot of the whole
registry.
Reproducibility comes from the resolution output, not from a frozen
input: `RegistryResolution` pins exact `(name, version)` selections and
package-tree content hashes, and re-running the mapper against that eager
resolution replays the pinned versions with no fresh `list()`.
A caller that needs a reproducible resolution therefore retains and
reuses the `RegistryResolution`, not the live tree.
This mirrors the superseded
[registry-capability](registry-capability.md) design's "snapshot before
resolve; do not stream live reads" law: the snapshot here is the emitted
`RegistryResolution`, and per-import live reads are what the eager
closure exists to avoid.

## Resolver, mapper, and mockability

Move graph resolution out of the capability and expose it as an ordinary
library function in `@endo/exo-npm`:

```ts
resolveRegistryTree(entryPackageJson, registryRoot, options)
  => Promise<RegistryResolution>
```

The algorithm from [mvs-resolver](mvs-resolver.md) changes only at its
source adapter.
For every dependency it traverses `npm`, looks up the package or
scope/package path, lists versions, selects by MVS, looks up the selected
content tree, and reads that tree's `package.json` before continuing.
Workspace lookup remains a higher-priority local-tree source and is not
inserted under `/npm`.

`resolveRegistryTree` and the `registryRoot` tree it walks are colocated:
the resolver runs in the same vat as the registry adapter and reaches the
tree through in-process calls, not eventual-send (`E()`) across a worker
or vat boundary.
The per-dependency traversal (`lookup` the package or scope, `list`
versions, `lookup` the selected version, read its `package.json`) is
therefore local dispatch, not one bus round trip per node, so a live
graph of hundreds of packages costs no per-dependency transport.
This is the same locality the [mvs-resolver](mvs-resolver.md) design
secures with caller-supplied `getPackument` / `getTarball` hooks: the
tree adapter replaces those hooks with tree methods on the same side of
the boundary, so that design's Non-goal that "the worker does not emit
per-import `resolvePackage` calls" is preserved for the resolver's own
traversal, not only for the mapper.
On the Rust-hosted Endor backend the adapter's XS-hosted callbacks into
narrow Rust host powers are likewise in-process to the XS-hosted adapter,
so a dependency walk does not cross the XS/Rust boundary once per node.

`RegistryResolution` remains the mapper-facing eager closure, so
[snapshot-mapper](snapshot-mapper.md) does not gain per-import registry
round trips.
Snapshot-mapper's late-bind fallback replaces `registry.fetch(name,
version)` with the same package/version tree traversal helper.
`resolutionHash` is derived from canonical package keys and package-tree
content hashes; npm `dist.integrity` remains an internal fetch
attestation rather than public resolution data.
Retention links continue to pin the returned CAS trees.

A fixture registry is an ordinary readable layout.
For example, it can contain `/npm/fixture-package/1.0.0/package.json` and
`index.js`, plus `/npm/@fixture/scoped-package/2.0.0/package.json` and
`index.js`.

Tests may expose this with `makeLocalTree`, an in-memory tree, or an
exo-zip tree.
A small `makeLookupTreeView` attenuator hides `list` on `npm/` and scope
nodes for exact production-shape tests; algorithms also accept an
ordinary readable-tree superset and never enumerate those nodes.
Checking each version leaf in to an in-memory CAS supplies the same
content identity expected in production.
No SQLite schema, registry HTTP server, tarball builder, or bespoke
registry fake is required for resolver and mapper tests.

## Migration and compatibility

1. Land `LookupTreeInterface`, the two backend tree adapters, and the
   cross-backend conformance suite alongside the existing `EndoRegistry`
   exports.
2. Change the MVS resolver and snapshot-mapper late-bind path to consume
   the tree, then change daemon and Endor integration callers.
3. Re-incarnate the existing `@registry` formula as the root tree without
   changing its formula identifier or `HostFormula.registry` slot.
   Callers reach this capability by the `@registry` host special name,
   not only by importing a factory, and the shipped call shape differs
   from the tree's: `packages/daemon/test/registry-endo.test.js` calls
   `E(registry).lookup(name, version)` with two positional strings and
   `E(registry).list()` as a top-level enumeration returning `[]` before
   any fetch, whereas the root tree's `lookup(path)` takes one path and
   its `list()` returns `['npm']`.
   The re-incarnation therefore audits every existing reader of
   `@registry` by special name (not only direct importers of
   `makeNpmReferenceRegistry`) and migrates each to the tree call shape
   or routes it through the deprecated adapter of step 4.
4. Retain a deprecated method-call-to-tree adapter for callers that
   directly import `makeNpmReferenceRegistry` or reach `@registry` by
   special name; remove it after repository call sites and review
   branches no longer use it.

The mechanics-layer review work for peer and optional dependencies,
workspaces, npmrc authentication, package `imports`, and execution
refinements remains valid.
Those changes operate before a package tree is returned or after the
selected CAS graph is assembled.
Only branches that call `EndoRegistry.resolve` / `fetch` directly, reach
`@registry` by its old call shape, or construct its test double must move
to the tree adapter.

## Other registries

The root is the complete discovery mechanism for now: `list()` names
configured registry families and `lookup(name)` enters one.
Adding a sibling later is a root-configuration change, not a change to
npm or to existing consumers.
The sibling's internal path grammar requires its own design; this
document standardizes only `npm` and does not reserve names beyond
requiring one path-safe root segment.

## Testing plan

- Platform guard tests prove every existing `ReadableTree` satisfies
  `EnumerableTree` and `LookupTree`, while an npm hub advertises no
  `list` method.
- Shared path tests cover unscoped and scoped packages, unknown scopes,
  packages, and versions (asserting the structured not-found error),
  ascending version ordering, and exact version leaves.
- Node adapter tests cover metadata-only listing, lazy tarball fetch,
  integrity failure, cache hit, eviction/refetch, and offline miss.
- Endor adapter tests run the same cases over `RegistryTable`, the CAS,
  and online/offline HTTP powers.
- Resolver tests run the same MVS, peer, optional, workspace, and
  multi-major fixtures against a plain fixture tree and each live
  adapter.
- Snapshot-mapper tests prove identical `RegistryResolution`, compartment
  maps, and module bytes for fixture, Node, and Endor roots.
- Existing fresh-state `endor run`, offline replay, and `registry verify`
  demonstrations remain green, proving the presentation change did not
  replace the mechanics.

## Dependencies

| Design | Relationship |
|---|---|
| [registry-capability](registry-capability.md) | Superseded capability shape; retained as the migration record for the shipped method-call interface. |
| [mvs-resolver](mvs-resolver.md) | Keeps the algorithm and changes its registry input adapter from packument/fetch methods to tree traversal. |
| [snapshot-mapper](snapshot-mapper.md) | Continues consuming an eager `RegistryResolution`; only its late-bind fallback changes. |
| [daemon-worker-import-from-mount](daemon-worker-import-from-mount.md) | Node integration reads the root tree from `@registry`. |
| [endor-npm-registry-proxy](endor-npm-registry-proxy.md) | Implemented Rust mechanics wrapped by the Endor tree adapter; otherwise unchanged. |
| [endor-registry-proxy-worker](endor-registry-proxy-worker.md) | XS-hosted seam where Rust powers become the common directory-tree Exos. |
| [fs-interface-consolidation](fs-interface-consolidation.md) | Owns the shared method-guard records this design factors into lookup and enumeration layers. |
| [fs-interface-reconciliation](fs-interface-reconciliation.md) | Supplies the common `has` / `list` / `lookup` vocabulary and feature-detection precedent. |
| [exo-zip-package](exo-zip-package.md) | Precedent for adapting a new source to the platform readable-tree interface and for fixture reuse. |

## Open questions

- When the future `endor:swissnum@hint@hint/version` protocol is
  designed, should its resolver select a sibling registry node under this
  root, or should a separate locator layer translate the address into a
  tree traversal?
  (A swissnum is the ocap-tradition unguessable identifier that names a
  capability.)
  This tree leaves both choices open: a sibling can be added without
  changing `npm`, while a translator can consume the same root
  capability.
  The protocol's grammar, authority, hint semantics, and version meaning
  remain explicitly out of scope here.

## Prompt

> On 2026-08-25, kriskowal directed that the npm registry be modeled as
> an Endo directory tree rather than a bespoke Exo: an extensible
> registry root containing a non-enumerable npm package hub, enumerable
> per-package version directories, and package-content trees at exact
> versions.
> The Node Endo daemon and Rust-hosted Endor daemon must expose the
> identical shape, the registry must be trivial to mock with a readable
> tree, and the design must preserve room for other registries and a
> future `endor:swissnum@hint@hint/version` protocol without specifying
> that protocol now.
