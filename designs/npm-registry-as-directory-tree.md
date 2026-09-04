# Package Registries as an Endo Directory Tree

| | |
|---|---|
| **Created** | 2026-08-29 |
| **Author** | Kris Kowal (prompted) |
| **Status** | Complete |
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
Their existing HTTP, `.npmrc`, integrity, MVS (Minimum Version Selection),
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
instead of matching the filesystem vocabulary both already consume (the
shared `has` / `list` / `lookup` readable-tree interface set out below in
§ Tree shape, from [fs-interface-consolidation](fs-interface-consolidation.md)
and [fs-interface-reconciliation](fs-interface-reconciliation.md)).

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

- Reimplementing `RegistryTable`, MVS, `.npmrc` authentication, tarball
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
| `/npm` | Non-enumerable `LookupTree` | No `list` method. `lookup('ses')` returns its version directory; `lookup('@endo')` returns a non-enumerable scope hub; `lookup('@endo/patterns')` is a convenience spelling for the two-segment scoped-package path. |
| `/npm/@<scope>` | Non-enumerable `LookupTree` | No `list` method. `lookup('package')` returns that scoped package's version directory. |
| `/npm/<package>` or `/npm/@<scope>/<package>` | `EnumerableTree` | `list()` returns exact published versions in ascending semver order; `lookup('1.2.3')` selects one version. |
| `.../<version>` | Immutable `SnapshotTree` / `EndoReadableTree` | The package root itself: `lookup('package.json')`, `lookup('src')`, and content identity through `getInfo()` / `sha256()`. |

The `SnapshotTree`, `EndoReadableTree`, `ReadableTreeInterface`, and
`SnapshotTreeInterface` names used here and below come from Endo's
consolidated filesystem-interface hierarchy; see
[fs-interface-consolidation](fs-interface-consolidation.md) and
[fs-interface-reconciliation](fs-interface-reconciliation.md) for that
hierarchy.
The `LookupTree` and `EnumerableTree` capability surfaces that this table
names are the lookup-only and enumerable method-guard layers defined
below in § Non-enumerability is a capability shape.
Every concrete registry node in this table additionally exposes a
`getInfo()` facet layered above its guard: `getInfo().temporal` on every
node (see § Read consistency) and `getInfo().integrity` on the version
leaf (see § Resolver, mapper, and mockability).
The composite each node kind actually presents is named once in
§ Non-enumerability is a capability shape — `RegistryHub` (a
`LookupTree & RegistryNode`) for the npm and scope hubs and
`RegistryDirectory` (an `EnumerableTree & RegistryNode`) for the root and
package directories — so a caller who types against that composite
discovers `getInfo` structurally, at the entry point, rather than only
from later prose.

Scoped names use two path segments because `/` is a tree separator.
The leading `@` makes the intermediate scope hub unambiguous.

`has` and `list` take a path as variadic segments while `lookup` takes a
single `string | string[]` path argument, exactly as the shipped
`readableTreeMethodGuards` in `@endo/platform/fs/lite` types them today
(`has` / `list` as `M.call().rest(NamePathShape)`, `lookup` as
`M.call(NameOrPathShape)`); this design factors that record into lookup
and enumeration layers without restating or widening its argument shapes.
A caller therefore reaches a scoped package through `lookup` either as the
single npm-shaped string `lookup('@endo/patterns')` or as the path array
`lookup(['@endo', 'patterns'])` — the two spellings the reconciled
`string | string[]` vocabulary
[fs-interface-reconciliation](fs-interface-reconciliation.md) already
standardizes on for `lookup`, so no two-argument `lookup('@endo',
'patterns')` form (which the shipped single-argument guard would reject on
arity) is introduced.
Each segment is normally matched literally against the current node's
children.
This follows the standing convention in `packages/daemon/src/mount.js`,
whose `segmentsFromEntryPathArg` reserves slash-splitting for `entry()`
and keeps every other path-bearing method on single-name segment
matching.
So a scoped package is reached by `lookup(['@endo', 'patterns'])` (a
two-segment path array), by a stepwise `lookup('@endo')` then
`lookup('patterns')`, or by the npm hub's scoped-package convenience
spelling `lookup('@endo/patterns')`.
Reaching for the npm-shaped single string (`lookup('@endo/patterns')`),
spelled the way `package.json` and every import specifier already spell
it, is predictable enough to support directly.
The npm hub recognizes exactly one slash-bearing form: one leading-`@`
scope segment, one `/`, and one non-empty package segment.
It normalizes that form to the same two-segment traversal as
`lookup(['@endo', 'patterns'])`; `has` applies the same normalization.
Any other segment that contains `/` rejects with a structured
`@endo/errors` `SyntaxError` — a distinct concrete shape from the
identical not-found `RangeError` a genuinely absent package raises — that
names the offending slash-bearing segment and the accepted scoped-package
or multi-segment forms.
The cross-backend conformance suite asserts this slash-bearing-segment
`SyntaxError` shape separately from the plain not-found shape.
This convenience does not make slash-splitting a general path grammar:
the leading `@` and exactly one slash identify npm's already-atomic scoped
package spelling without ambiguity, while unscoped `foo/bar`, incomplete
`@scope/`, and deeper `@scope/package/path` strings still reject.
Adapters must return the same intermediate scope-hub capability for the
stepwise, multi-segment, and scoped-package convenience forms.

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

Deciding whether a package name is *known* at the `/npm` hub (so
`lookup(name)` can choose between entering its version directory and
rejecting not-found) needs the same packument truth a package
directory's `list()` fetches over the network.
Determining existence is therefore itself a fetch, and an offline hub
must not conflate "does not exist" with "cannot be checked right now".
That three-valued answer (present / genuinely-absent / undecidable
offline) is carried by `lookup(name)` alone, because only `lookup`'s
error channel can distinguish the last two: when the packument required
to decide existence is not cached and the backend holds no network
authority, a hub-level `lookup(name)` rejects with `RegistryOfflineError`
(can't tell), never with the not-found `RangeError` (which asserts
non-existence), and the not-found `RangeError` is reserved for the case
where the truth is reachable and the name is genuinely absent.
`has(name)` keeps the platform-wide no-throw boolean contract every other
tree (mount, git, zip, directory) honors: it never rejects, so a caller
writing `if (await hub.has(name))` cannot meet an unhandled rejection.
A `has` that cannot confirm presence offline folds "can't tell" into
`false` rather than rejecting; a caller that needs to tell a genuinely
absent name from an unreachable one uses `lookup(name)` and handles its
`RangeError`-versus-`RegistryOfflineError` outcomes, the one surface where
that distinction is contractually pinned.
The cross-backend conformance suite asserts this hub-level `lookup`
offline distinction alongside the version-tree offline miss, so neither
adapter reports a false not-found for an unreachable name, and asserts
that `has` on the same uncached-offline name resolves to `false` rather
than rejecting.

### Non-enumerability is a capability shape

Split the shared platform method guards so lookup authority is the base
and enumeration is an extension:

```ts
interface LookupTree {
  help(method?: string): string;
  // `has` takes variadic segments and `lookup` a single `string | string[]`
  // path, matching the shipped `readableTreeMethodGuards` argument shapes
  // in `@endo/platform/fs/lite` verbatim (`.rest(NamePathShape)` versus
  // `M.call(NameOrPathShape)`); this design factors that record, it does
  // not restate or widen those shapes.
  has(...path: string[]): Promise<boolean>;
  lookup(path: string | string[]): Promise<unknown>;
}

interface EnumerableTree extends LookupTree {
  list(...path: string[]): Promise<string[]>;
}

// Every concrete registry node carries a `getInfo` facet above its guard
// (§ Read consistency, § Resolver, mapper, and mockability). Naming the
// composite once means a caller types against the surface it actually
// holds — including `getInfo` — rather than discovering that method only
// from prose. `integrity` is present on the version leaf alone.
interface RegistryNode {
  getInfo(): { temporal: 'stable' | 'live' | 'immutable'; integrity?: string };
}
type RegistryHub = LookupTree & RegistryNode;          // /npm, /npm/@<scope>
type RegistryDirectory = EnumerableTree & RegistryNode; // /, /npm/<package>
// the version leaf is the shipped SnapshotTree, whose own getInfo() this
// design widens with `integrity` (§ Resolver, mapper, and mockability).
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
The npm and scope hubs do not implement `list`, so non-enumerability is
authority the holder never receives, not a boolean flag that asks an
otherwise-enumerable object to behave as if it had no `list`.
A caller that probes enumerability by invoking `list()` on a
`LookupTree`-only hub therefore hits the platform interface guard's own
absent-method rejection (a `TypeError` naming the method the guard does
not expose), which is a third failure shape distinct from both the
structured not-found `RangeError` and the `RegistryOfflineError`; this is
the shape a caller most often meets when discovering non-enumerability at
the call site rather than by reading this document, so the cross-backend
conformance suite asserts it on both npm and scope hubs.
`LookupTree` is the only genuinely new method shape; `EnumerableTree`
merely names the already exported common guard surface.
All other nodes reuse the consolidated filesystem interfaces.

### One error family, distinct shapes

The three registry-*originated* structured failures — not-found
(`RangeError`), malformed slash-bearing segment (`SyntaxError`), and
offline-can't-tell (`RegistryOfflineError`) — reuse familiar native
constructors that JavaScript itself also throws for unrelated programmer
mistakes, so a caller discriminating this surface's failures from an
incidental bug cannot rely on the constructor alone.
Each of the three therefore carries a shared `@endo/errors` discriminant
(a common `errorName` tag the concrete shapes agree on, the `@endo/errors`
analogue of a shared base class), so a caller can catch "a registry
lookup failed in a documented way" as one family through that tag while
each concrete shape stays independently pinned by the cross-backend
conformance suite.
The lookup-only hub's absent-method rejection is deliberately *outside*
this family: it is the platform interface guard's own generic `TypeError`
for calling a method the guard does not expose (the same rejection any
`LookupTree`-only cap raises), not a registry-contract outcome, so it
keeps the platform's shape rather than being retagged as a registry error.
A caller that wants the whole four-way space still checks that `TypeError`
separately, but the three contract failures it will actually branch on
share one discriminant.

## One shape over both backends

### Node-hosted Endo daemon

Add `makeNpmRegistryTree` in `@endo/exo-npm` over two injected
operations: list published versions for one known package and provide the
CAS tree for one exact version.
The Node adapter in `packages/daemon/src/registry-user.js` supplies those
operations from its existing packument cache (a packument is npm's
per-package document listing that package's published versions and their
metadata), integrity verifier, tar reader, and content store.
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
An XS-hosted adapter (XS is the JavaScript engine Endor embeds to run
adapter code alongside its Rust host powers) wraps narrow Rust host
powers for `hasPackage`, `listVersions`, and `providePackageTree` in the
same `LookupTreeInterface` and `EnumerableTreeInterface` Exos used by
Node.
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
shape, the slash-bearing-segment error shape, the absent-method
rejection shape when `list` is invoked on a lookup-only hub, the shared
registry-error discriminant the three contract failures agree on,
cache-miss offline errors including a hub-level `lookup` on an uncached
name rejecting `RegistryOfflineError` while `has` on that same name
resolves to `false` rather than rejecting, content hashes, and the
absence of `list` on both npm and scope hubs.

## Read consistency

A version leaf (`.../<version>`) is immutable and content-addressed: its
tree is a value, identical on every read.
A package directory's `list()` (`/npm/<package>`) reads an external set
that npm keeps growing as new versions publish, so it is a live,
place-oriented read, not a value.
The two share the directory-tree vocabulary but not this temporal
contract, and this design states the contract rather than letting the
shared spelling imply one.

Because both a growing package directory and the fixed-configuration
root are typed `EnumerableTree`, the temporal contract must be
discoverable structurally and not only in this prose.
`getInfo` is not part of the shared `readableTreeMethodGuards` /
`EnumerableTreeInterface` surface today (only `SnapshotTreeInterface`
adds it), and this design does not add it there: doing so would force
every existing platform tree, mount, directory, git, and zip
implementation to grow a `getInfo` method and would break the source
compatibility § Non-enumerability relies on.
Instead the four registry node kinds are purpose-built Exos that carry
`getInfo` as a registry-node facet layered above their `LookupTree` /
`EnumerableTree` guard, so the `temporal` descriptor has a concrete home
without widening any shared platform guard.
Every node kind reports one:

| Node | `getInfo().temporal` | Why |
|---|---|---|
| `/` root | `'stable'` | the registry-name set is fixed configuration. |
| `/npm`, `/npm/@<scope>` hubs | `'live'` | a `has` or `lookup` for a given name can begin succeeding as packages or scopes publish, even though the hub is non-enumerable. |
| `/npm/<package>` directory | `'live'` | the version set grows as npm publishes. |
| `.../<version>` leaf | `'immutable'` | content-addressed and identical on every read, the same identity `getInfo()` / `sha256()` already report. |

A caller can therefore tell a frozen enumeration from a live one, and a
mutable lookup hub from an immutable leaf, by reading any node's
`getInfo().temporal` rather than by knowing this document, and the
cross-backend conformance suite asserts the descriptor each of the four
node kinds reports.

`list()` is a live read at the moment it is called.
A single `resolveRegistryTree` pass (defined below in § Resolver, mapper,
and mockability) issues `list()` a small constant number of times per
transitively-discovered dependency — once when it selects the version and
again inside `makeVersionLeaf` when it re-reads the published-version list to
validate the selected version — not exactly once. Both reads hit the backend's
memoized packument (a table read, not a fresh network fetch), so the cost is
re-sorting the version list, not repeated egress; the per-dependency `provide`
(tarball fetch + CAS write) is what the round-trip budget bounds, and it stays
at one. Those `list()` calls land at different
wall-clock moments, and a version published mid-resolution may be seen by
a later dependency's `list()` and not an earlier one; a resolution is not
guaranteed to observe one coherent point-in-time snapshot of the whole
registry.
Reproducibility comes from the resolution output, not from a frozen
input: `RegistryResolution` (the eager, mapper-facing resolution output
defined below in § Resolver, mapper, and mockability, carried over from
[mvs-resolver](mvs-resolver.md)) pins exact `(name, version)` selections
and package-tree content hashes, and re-running the mapper against that
eager resolution replays the pinned versions with no fresh `list()`.
A caller that needs a reproducible resolution therefore retains and
reuses the `RegistryResolution`, not the live tree.
This mirrors the superseded
[registry-capability](registry-capability.md) design's "snapshot before
resolve; do not stream live reads" law: the snapshot here is the emitted
`RegistryResolution`, and per-import live reads are what the eager
resolution exists to avoid.

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

`resolveRegistryTree` must run in the same vat as the `registryRoot` tree
it walks, so its per-dependency traversal is in-process dispatch and not
eventual-send (`E()`) across a worker or vat boundary.
This colocation is a load-bearing constraint of the design, not an
incidental property, and it fixes where the resolver executes per backend:

- Node: the registry adapter and the `@registry` root tree live in the
  daemon manager (host) process (`packages/daemon/src/registry-user.js`),
  while the snapshot mapper's `makeFromPackage` runs in the out-of-process
  Node worker (see
  [daemon-worker-import-from-mount](daemon-worker-import-from-mount.md)).
  `resolveRegistryTree` therefore runs daemon-side, colocated with the
  tree, and only the emitted `RegistryResolution` crosses once to the
  worker.
  Building the tree-walk resolver in the worker instead (the process
  where the mapper already lives) would turn each `lookup` and `list`
  into an `E()` round trip back to the daemon and regress the single
  coarse `EndoRegistry.resolve()` call this design replaces into
  O(dependency count) round trips.
  The design deliberately does not move the traversal into the worker.
- Endor: `resolveRegistryTree` itself, the `@endo/exo-npm` tree Exos it
  walks, and the shared resolver logic all run inside the single XS
  engine the Endor daemon embeds (not in a separate Rust or Endor
  process), so the traversal is same-vat dispatch within XS.
  That XS engine's `hasPackage` / `listVersions` / `providePackageTree`
  callbacks reach the Rust mechanics through in-process host powers rather than a
  cross-process bus, so a dependency walk crosses the XS/Rust boundary at
  most when a version leaf must be checked in, never once per `lookup` or
  `list`.

Either way the per-dependency traversal (`lookup` the package or scope,
`list` versions, `lookup` the selected version, read its `package.json`)
is local dispatch, not one bus round trip per node, so a live graph of
hundreds of packages costs no per-dependency transport.

Because `resolveRegistryTree` is an ordinary mockable library function
with no brand check that would catch a future caller wiring it against a
remote (`E()`-wrapped) tree, this colocation is primarily a **design
constraint**, reinforced — not fully proven — by test.
The resolver test harness injects a tree whose methods count their
invocations and asserts the resolver drives a multi-dependency traversal to
completion through direct same-vat dispatch over a local root.
That guard is honest about its limit: it reddens if the resolver stops
traversing the tree directly, but it cannot by itself catch the specific
erosion below (a worker-side resolver over an `E()`-wrapped Presence), because
the local fixture it hands the resolver is not a remote Presence.
Catching that erosion mechanically would require a Presence/`E()`-observable
fixture; until one exists, the constraint rests on the design statement here
plus review of any change that relocates the resolver across a vat boundary.
This test guards specifically against the change the platform's own
invariants would *not* already surface loudly.
A naive relocation that called a tree method directly on a genuine
remote Presence without `E()` would throw at first use under Endo's
ocap dispatch model (a Presence rejects synchronous method application),
so that mistake announces itself and needs no test.
The silent path is the *correct-looking* refactor: constructing
`resolveRegistryTree` in the worker and consuming `@registry` as the
`registryP` remote Presence the worker already holds, wrapping every
`lookup` / `list` in `E()`.
That version compiles, returns the right resolution, and satisfies every
existing dispatch invariant (eventual-send across a worker or vat
boundary is legal, not an error) while quietly issuing one bus round
trip per dependency instead of zero.
Because nothing in the platform flags a legal-but-remote `E()`, the
invocation-counting harness is what catches it: it asserts the traversal
issued zero eventual-sends, which the `E()`-wrapped worker-side variant
cannot satisfy.
This is the same locality the [mvs-resolver](mvs-resolver.md) design
secures with caller-supplied `getPackument` / `getTarball` hooks: the
tree adapter replaces those hooks with tree methods on the same side of
the boundary, so that design's Non-goal that "the worker does not emit
per-import `resolvePackage` calls" is preserved for the resolver's own
traversal, not only for the mapper.

`RegistryResolution` remains the mapper-facing eager resolution, so
[snapshot-mapper](snapshot-mapper.md) does not gain per-import registry
round trips.
Snapshot-mapper's late-bind fallback replaces `registry.fetch(name,
version)` with the same package/version tree traversal helper.
That fallback runs on the same side of the worker boundary the mapper's
`makeFromPackage` already runs on, so where it fires it walks the tree by
local dispatch, not `E()` round trips — the same colocation constraint
`resolveRegistryTree` carries, applied to the fallback for the same
reason.
It also does not carry `resolveRegistryTree`'s hot per-dependency
round-trip budget, because it is a cold miss path: the eager
`RegistryResolution` already pins every dependency the mapper needs, and
the fallback fires only for a package the eager resolution did not
pin (a genuine late binding, not the per-import steady state).
Its traversal cost is therefore bounded by the count of late-bound
packages, which is normally zero, rather than by total dependency count,
so it needs no separate round-trip accounting beyond inheriting the same
colocation guarantee.
`resolutionHash` continues to fold each canonical package key together with
that package's npm `dist.integrity`, as [mvs-resolver](mvs-resolver.md)
specifies, but its **preimage format changes** in this migration.
`resolutionHashPreimage` in `packages/exo-npm/src/mvs-resolver.js` now hashes a
`JSON.stringify` of the `[key, integrity]` pairs rather than the former
`${key}\t${integrity}` newline-join: package keys and integrity strings are
registry-controlled and may contain the `\t`/`\n` the join delimited on, so the
old preimage was non-injective and two distinct closures could collide onto one
content-addressed cache key (substituting one closure's trees for another's).
Because the preimage bytes differ, this migration does **not** produce
byte-identical `resolutionHash` values: any pinned `RegistryResolution`,
reproducibility record, or `resolutionHash`-keyed cache entry recomputes under
the new format — a one-time cache miss, not a correctness regression. The
changeset records this cache-invalidation obligation.
For this byte-identical guarantee to hold, `resolveRegistryTree` must be
able to read each selected version's `dist.integrity` through the tree
interface, because that npm packument attestation is distinct from the
CAS content-identity hash the version leaf's `getInfo()` / `sha256()`
already report (the two hash different things: the published tarball
versus the assembled tree).
The version leaf's registry-node `getInfo()` facet therefore carries an
`integrity` field alongside `temporal`, populated from the packument's
`dist.integrity` for that exact version, and `resolveRegistryTree` reads
it as `getInfo().integrity` on the selected leaf and feeds it to
`hashResolution` unchanged.
This keeps `dist.integrity` on the read-only info facet rather than
making it an enumerable tree entry: the tree presentation changes how a
package tree is reached, not what the resolution hashes over, and
`dist.integrity` stays the hashed fetch attestation.
The cross-backend conformance suite asserts the version leaf reports the
packument `integrity` its `getInfo()` facet promises, so the Node and
Endor adapters cannot diverge on the value that feeds `resolutionHash`.
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
   On the Node backend the resolver runs daemon-side, in the
   registry-owning vat, with only the emitted `RegistryResolution`
   crossing to the worker; it is not moved into the worker beside
   `makeFromPackage` (see § Resolver, mapper, and mockability for why that
   would regress per-dependency round trips).
   This is a change to the worker dispatch surface, not only to the
   category of call site: today `makeFromPackage` runs registry
   resolution worker-side, driven by a `registry` `FormulaIdentifier`
   slot on `MakeFromPackageFormula` and a `registryP` argument on the
   worker dispatch signature (both documented in
   [daemon-worker-import-from-mount](daemon-worker-import-from-mount.md)
   § Worker dispatch, where `makeFromPackage` calls
   `mapSnapshot({registry, mount, entry})`).
   Relocating resolution daemon-side removes that formula slot and that
   dispatch argument, so `daemon-worker-import-from-mount` itself needs a
   companion revision rather than this being a pure integration-caller
   swap.
3. Re-incarnate the existing `@registry` formula as the root tree without
   changing its formula identifier or `HostFormula.registry` slot.
   Callers reach this capability by the `@registry` host special name,
   not only by importing a factory, and the shipped call shape differs
   from the tree's.
   The shipped shape: `packages/daemon/test/registry-endo.test.js` calls
   `E(registry).lookup(name, version)` with two positional strings that
   the shipped registry reads as a package name and a version to resolve,
   and `E(registry).list()` as a top-level enumeration returning `[]`
   before any fetch.
   The tree shape: the root reads `lookup`'s arguments as path segments
   (its top-level `lookup('npm')` enters the npm hub) and its `list()`
   returns `['npm']`.
   The `@registry` special name is re-incarnated *unconditionally* as the
   new root tree: every caller reaching `@registry` receives the tree, and
   the deprecated adapter of step 4 is a separate, explicitly obtained
   capability rather than something that keeps sitting at `@registry` for
   some callers.
   The re-incarnation audits every in-repo reader of `@registry` by
   special name (not only direct importers of `makeNpmReferenceRegistry`)
   and migrates each to the tree call shape or to the separately-named
   deprecated adapter.
   An externally held pre-migration reference the repo's audit cannot see
   (a pet name in a running daemon, a script, or another vat) resolves
   to the new tree at the same identifier, so the reference's shape
   changes under the holder; this is a bounded, loud change rather than a
   silent misresolve.
   A stale two-string `E(registry).lookup(name, version)` from such a
   holder walks `name` as a top-level registry segment, and unless `name`
   happens to equal a configured registry family (`npm`) it finds no such
   child and rejects with the structured not-found `RangeError`; even the
   degenerate `lookup('npm', version)` enters the npm hub and then rejects
   at the `version` segment (no package named `version`).
   One residual risk is accepted rather than proven away: the
   `lookup('npm', version)` rejection assumes no published npm package is
   ever literally named after the version-shaped string a stale caller
   passes, so a stale `name === 'npm'` caller whose `version` argument
   happened to match a real package name would receive that package's
   version directory instead of a rejection.
   This collision is vanishingly unlikely (a version-shaped string is a
   poor package name) and is scoped as an accepted residual risk rather
   than being pinned by a conformance assertion, unlike the design's
   other exhaustively-proven failure shapes.
   The `list` arity collision is different and does not surface as a
   rejection at all: the shipped `E(registry).list()` returned `[]` before
   any fetch, whereas the new root's zero-argument `list()` returns
   `['npm']`, so a stale caller that consumed the always-empty shipped
   shape (for example by checking `list().length === 0`) silently reads a
   changed value rather than an error.
   This is the one migration exposure that is a changed value rather than
   a loud rejection; it is bounded (the value is the fixed one-element
   registry-name set, not arbitrary data) and a caller that must preserve
   the old `[]` shape reaches it through the separately-named deprecated
   adapter of step 4, whose `list()` still returns `[]`.
   The `lookup` arity collision therefore surfaces as a diagnosable
   rejection at the first stale call rather than a wrong object returned,
   while the `list` arity collision instead surfaces as the silently
   changed value described just above; so for `lookup` an unaudited holder
   learns of the migration by a clean error rather than by silently
   receiving the wrong protocol.
4. Retain a deprecated method-call-to-tree adapter, obtained under its own
   explicit name rather than at `@registry`, for callers that still need
   the old `EndoRegistry.lookup` / `list` call shape (whether they
   directly imported `makeNpmReferenceRegistry` or reached the old
   `@registry`); remove it after repository call sites and review branches
   no longer use it.
   The shipped `EndoRegistry.lookup(name, version)` returns `undefined`
   on a miss (`packages/daemon/test/registry-endo.test.js` asserts
   `t.is(missing, undefined, ...)`), whereas the new tree rejects on an
   unknown name, so the adapter must reconcile that shape difference to
   preserve the compatibility surface it exists for: it catches the
   tree's structured not-found `RangeError` and returns `undefined` to
   the old caller, translating only that not-found shape and re-throwing
   every other error (offline, integrity, and the rest) unchanged.
   The shipped `lookup` also accepts a scoped package as one opaque string
   with an embedded slash (`@scope/pkg`, per the `encodeURIComponent(name)`
   packument-URL construction in `packages/daemon/src/registry-user.js` and
   `backend.fetchVersions('@scope/pkg')` in
   `packages/daemon/test/registry-node-backend.test.js`).
   The primary npm hub's scoped-package convenience spelling accepts that
   opaque name and normalizes it to the same two-segment traversal, so the
   adapter can delegate it unchanged and an old caller resolving any
   `@endo/*`-style scoped package keeps resolving to the same tree it got
   yesterday.

The mechanics-layer review work for peer and optional dependencies,
workspaces, `.npmrc` authentication, package `imports`, and execution
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
  `list` method and invoking `list()` on it raises the interface guard's
  absent-method rejection.
- Shared path tests cover unscoped and scoped packages, unknown scopes,
  packages, and versions (asserting the structured not-found `RangeError`),
  the scoped-package convenience spelling `lookup('@endo/patterns')`
  returning the same capability as the path array
  `lookup(['@endo', 'patterns'])`, and
  malformed slash-bearing names such as `lookup('endo/patterns')` and
  `lookup('@endo/patterns/extra')` rejecting with the distinct
  `SyntaxError` diagnostic, separate from not-found.
  They also cover the
  `temporal` descriptor `getInfo()` reports on each of the
  four node kinds (`'stable'` root, `'live'` npm and scope hubs, `'live'`
  package directory, `'immutable'` version leaf), the version leaf's
  `getInfo().integrity` matching the packument `dist.integrity` that feeds
  `resolutionHash`, ascending version ordering, and exact version leaves.
- Node adapter tests cover metadata-only listing, lazy tarball fetch,
  integrity failure, cache hit, eviction/refetch, a version-tree offline
  miss, and a hub-level offline `lookup(name)` on an uncached name
  rejecting with `RegistryOfflineError` rather than a false not-found.
- Endor adapter tests run the same cases over `RegistryTable`, the CAS,
  and online/offline HTTP powers.
- Resolver tests run the same MVS, peer, optional, workspace, and
  multi-major fixtures against a plain fixture tree and each live
  adapter, and one instruments the injected tree to assert the resolver
  issues only synchronous same-vat dispatch (no eventual-send crossing a
  worker or vat boundary) across a multi-dependency graph, so a future
  relocation of the traversal into the worker fails mechanically.
- Deprecated-adapter tests assert that an old-shape
  `E(registry).lookup(name, version)` two-string call still returns the
  resolved version tree and `undefined` on a miss, that a scoped old-shape
  call spelled as one slash-bearing string
  (`E(registry).lookup('@endo/patterns', version)`) still resolves the
  scoped package tree rather than rejecting, and that `E(registry).list()`
  still returns `[]`, while resolving through the new directory tree
  underneath.
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
| [daemon-worker-import-from-mount](daemon-worker-import-from-mount.md) | Node integration reads the root tree from `@registry`, and — because relocating resolution daemon-side removes the `registry` `FormulaIdentifier` slot on `MakeFromPackageFormula` and the `registryP` worker-dispatch argument that design documents — needs a companion revision to that document, not a pure caller swap (tracked in § Migration and compatibility, step 2). |
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
