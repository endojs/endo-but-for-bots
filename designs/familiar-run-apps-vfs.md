# Familiar and Host Run Applications over a VFS

| | |
|---|---|
| **Created** | 2026-05-13 |
| **Updated** | 2026-08-31 |
| **Author** | kriscendobot (prompted by kriskowal) |
| **Status** | Proposed |

## Purpose

Endo hosts and guests should both be able to run a JavaScript application
out of any tree that implements the Endo filesystem mount interface (the
VFS).
Two cases are in scope.

Case 1 is the confined path.
An application is hosted inside an XS worker (a confined JavaScript
engine with no ambient host capabilities), run via `endor` (the
Rust-side daemon; both terms, and the others this design leans on, are
defined in the Glossary immediately below), whose only filesystem reach
is one or more `Mount` capabilities the host has handed it.
Within Case 1, the design's main subject is the fully virtualized
sub-case: when the entry-point hint is tagged `kind: 'entry'` rather
than `kind: 'compartment-map'` (§ Case 1, Shape), the design replaces
`node_modules` with a sqlite-backed module store and constructs the
compartment map ad hoc per run.
The detail of that sub-case lives in `## Case 1` below.

Case 2 is the host-eject path.
The host writes a readable tree to a scratch directory on the real
filesystem and then shells out to a `node` child process that loads the
application from disk.
This path is for applications that genuinely need Node.js APIs, where
the guest-side POSIX sandbox is not yet available.

## Glossary

This design reuses vocabulary from existing designs rather than
coining new terms.

- **Filesystem mount interface (VFS)**: the `MountInterface` defined by
  [daemon-mount](daemon-mount.md) (has / list / lookup / write / remove
  / move / makeDirectory / readOnly / snapshot). VFS is used as a short
  name for this interface throughout.
- **Readable tree**: the immutable, content-addressed snapshot of a
  directory tree per
  [daemon-checkin-checkout](daemon-checkin-checkout.md); the shape a
  `MountInterface.snapshot()` produces.
- **Mount**: a capability whose backing is a physical directory subtree
  (per `daemon-mount.md`) or any other source that satisfies the
  `MountInterface` guard (a `readable-tree`, a sqlite-backed view, an
  in-memory tree).
- **Scratch space**: the daemon-managed backing storage produced by
  `provideScratchMount` (`daemon-mount.md` § Scratch Mount Provisioning
  and Lifecycle). A scratch mount is the case-2 destination.
- **Compartment map**: a `CompartmentMapDescriptor` per
  `@endo/compartment-mapper`'s `types/compartment-map-schema.ts`; the
  graph of compartments, modules, and exit-module entries that
  `endor run` consumes today via `compartment-map.json`.
- **CAS**: content-addressed store; the blob and tree store described in
  [daemon-cas-management](daemon-cas-management.md). Files are addressed
  by their content hash, so identical bytes are deduplicated across
  packages and across runs.
- **`endor`**: the Rust-side daemon and worker host described in
  [daemon-endor-architecture](daemon-endor-architecture.md) and
  [endor-run-expanded](endor-run-expanded.md). The `endor run` command
  is its entry point for running a JavaScript application against a
  mount set.
- **XS worker**: an XS-engine JavaScript worker hosted by `endor` per
  `daemon-endor-architecture.md` § Worker platforms. XS is the embedded
  JavaScript engine that Endo uses for confined execution; an XS worker
  has no ambient host capabilities beyond what its host explicitly
  provides.
- **`cap-std`**: the Rust capability-oriented standard-filesystem
  library used by `endor`'s host-side `fs` module to back the VFS
  bindings; see `daemon-endor-architecture.md` § Host powers.
- **Formula**: the persisted, GC-pinned record from which the daemon
  incarnates a capability. A worker formula incarnates a worker; a
  `mount` formula incarnates a mount; see
  `daemon-endor-architecture.md` § Worker formula for the worker case.
  A `type` field on the formula selects `endor run`'s dispatch branch
  (Case 1 vs Case 2); see § Recommended approach, "One entry point,
  explicit dispatch".
- **Lal**: the guest-agent identity shape defined in
  [lal-fae-form-provisioning](lal-fae-form-provisioning.md); a
  Lal-shaped agent is a guest the host has provisioned through that
  design's form flow.
- **Lal caplet**: a guest-facing capability, granted to a Lal-shaped
  agent (per `lal-fae-form-provisioning.md`), that exposes a
  host-mediated action to the agent. A Lal caplet that wraps
  `endor run` lets an agent run an application against a mount set the
  host authorized.
- **Ejection (scratch checkout)**: producing a host-filesystem layout
  from a mount such that an external program (in Case 2, `node`) can
  read it directly. Mechanically this is
  [`endo checkout`](daemon-checkin-checkout.md) (the documented dual of
  `endo checkin` that "writes a `readable-tree` from the daemon back to
  the local filesystem"), restricted to a scratch mount: it writes to a
  daemon-managed scratch directory reclaimed by scratch GC when the run
  ends (Case 2 § Shape, final step), not to a caller-named persistent
  path, and materializes no persistent formula. It is a qualified
  variant of `checkout` ("scratch checkout") rather than a new
  operation; "eject" is used only as shorthand for that restricted
  checkout, so the naming stays coherent with the `checkin`/`checkout`
  family of `daemon-checkin-checkout.md`, and the write mechanism is
  `checkout`'s.

## Relationship to the four-layer `importLocation` stack

Case 1's fully-virtualized sub-case is **not** new territory: it is the
Familiar- and guest-facing consumer of the accepted four-layer
daemon-worker `importLocation` stack, which `designs/README.md` records
as Not Started (accepted 2026-07-10) and whose canonical
dependency-ordered build plan lives in
[daemon-worker-import-from-mount](daemon-worker-import-from-mount.md)
§ *Phased Implementation*. This design does not re-specify that stack; it
composes it, and every Case 1 mechanism below is a use of a layer that
stack owns. The table's left column names sections (`## Module store:
npm-to-sqlite`, `## Resolution: Go-mod-shaped`, `## Ad-hoc compartment
maps`) that appear later in this document, under `## Case 1`; a
first-time reader can treat this table as a forward map and read the
detail there. Each row's "Owned by" is the design that is canonical for
the mechanism, so the detail here is deliberately a pointer, not a
restatement:

| This design (Case 1) | Owned by | Canonical shape |
|----------------------|----------|-----------------|
| The sqlite-backed module store (`## Module store: npm-to-sqlite`) | [registry-capability](registry-capability.md) | the `EndoRegistry` capability and `@registry` host special name over the CAS-backed registry table; this design's raw-sqlite framing is that capability's backing, not a second store |
| The Go-style resolver (`## Resolution: Go-mod-shaped`) | [mvs-resolver](mvs-resolver.md) | the JS reference MVS implementation producing a `RegistryResolution` (content-addressed `resolutionHash`); this design reuses that algorithm rather than restating a variant |
| Ad-hoc compartment-map construction (`## Ad-hoc compartment maps`) | [snapshot-mapper](snapshot-mapper.md) | `mapSnapshot`, which turns a `(RegistryResolution, EndoMount)` into a `CompartmentMap` via the archive-precedent peer-directory layout; this design's in-memory descriptor is that mapper's output |
| The `endor run entry.js` integration path | [daemon-worker-import-from-mount](daemon-worker-import-from-mount.md) | the `makeFromPackage`/`makeFromMount` daemon-worker entry that runs a `package.json`-rooted mount through `compartment-mapper.importLocation` |

What this design adds *over* that stack, and why it remains a distinct
document rather than a fifth layer or a supersession:

- **The two-case host/guest framing.** The stack is the confined-import
  substrate (Case 1). This design frames *who* drives it (Familiar's
  daemon, the CLI, and a Lal caplet acting for a guest) and the
  mount-cap authorization surface in front of it.
- **Case 2 (host-eject to Node.js)**, which the four-layer stack does
  not cover at all: shelling out to an unconfined `node` against a
  materialized tree for applications that need Node APIs XS cannot
  satisfy.
- **The `endor` (Rust-side) mirror** in `## Endor cross-references`.

Where a term below has a canonical name in the stack (`EndoRegistry`,
`mapSnapshot`, `RegistryResolution`), the stack's name is authoritative;
this design's prose names the same object and defers its exact shape to
the owning layer.

**On the `endor run` / `endo run` verb.** This design writes
`endor run` throughout because it is written from the Rust-hosted
daemon's vantage, whose CLI is `endor` (glossary). But the
integration path it composes with,
[daemon-worker-import-from-mount](daemon-worker-import-from-mount.md),
is the **Node-hosted** lane, whose CLI is `endo run` and which
"does not depend on a compiled Rust binary being present." The two
are not different dispatches: that lane states the two lanes
"expose the same `EndoRegistry` capability shape, so Node-hosted
and Rust-hosted daemons reach feature parity on this entry point."
Case 1 therefore dispatches through whichever binary hosts the
daemon in a given deployment (`endor run entry.js` on a
Rust-hosted daemon, `endo run entry.js` on a Node-hosted one),
and the two names alias the same mount-rooted, `package.json`-driven
confined-run entry. Read `endor run` below as that entry, not as an
assertion that a compiled Rust binary is required.

## Case 1: confined application execution

### Shape

A host (Familiar's main daemon, the CLI's `endor run`, or a Lal
caplet acting on behalf of a guest) names an application by three
inputs, all three load-bearing for how `endor run` dispatches:

- one or more `Mount` capabilities (the application sources, plus any
  data directories the application needs to read or write at
  runtime);
- an **entry-point hint**, an explicit, discriminated value (not a
  filename convention): either `{ kind: 'entry', path }`, a path within
  one of the mounts pointing at an entry module whose dependency graph
  must first be resolved (conventionally `entry.js`, but the `kind`
  tag, not the filename, is what selects this branch), or
  `{ kind: 'compartment-map', path }`, a path pointing at a prebuilt
  `compartment-map.json`. A caller who names the entry module something
  other than `entry.js`, or hands a manifest under a different name,
  therefore cannot silently mis-dispatch: the sub-case is chosen by the
  `kind` tag the caller sets, never inferred from the path's basename
  (§ Sub-case sections below); and
- the **formula `type`**, the field on the persisted formula (§
  Glossary, *Formula*) that selects the confined-vs-unconfined branch:
  `type: 'confined-app'` (the Case 1 default) runs the confined XS
  path, `type: 'host-node-app'` runs the Case 2 host-eject path. This
  is the one flag gating the confined/unconfined split; it is set only
  by a maintainer audit at formula-creation time and is *not* something
  `endor run` infers from the application's contents (§ Recommended
  approach, "One entry point, explicit dispatch"). Both branches are
  named explicitly so either is discoverable by inspecting the formula.

**Formula-`type` lifecycle.** The `type` is fixed when the formula is
incarnated, before any `endor run` against it, and never changes for
the life of the formula. A host-side caller (Familiar's daemon or the
CLI) sets it by incarnating a formula with that `type`. The default is
`confined-app`, and electing `host-node-app` is the deliberate,
maintainer-audited act (§ Recommended approach). A guest never
incarnates a formula at all: its Lal caplet closes over an
already-incarnated `confined-app` formula (§ Guest access via a Lal
caplet), so a guest can neither set nor change the `type`. The
entry-point hint above is a per-invocation argument to `endor run`; the
`type` is per-formula state that predates the invocation.

The host invokes `endor run` against the mount set.
`endor` runs the application in a confined XS worker whose only
filesystem reach is the mount set the host passed in.
The worker has no ambient host-path power: every `import` resolves
through a hook that reads bytes from a mount, never from the host's
real filesystem outside the mount roots.

The worker's host-side adapter satisfies the `MountInterface` guard
in both directions: the worker reads module sources by calling the
mount's `lookup` and `text()` / `streamBase64()`, and writes runtime
output (logs, generated artifacts, persisted state) through the same
mount surface.
The XS host-powers `fs` module ([daemon-endor-architecture](daemon-endor-architecture.md)
§ Host powers) is the natural home for the cap-std bindings that
back this.
In the confined case `cap-std` is parametrized by the mount-resolved
host paths rather than the daemon's ambient host-paths power.
The exact parametrization seam is left open: `cap-std`'s public API
roots each capability at an `OpenDir` (a real directory descriptor),
so the natural binding is one `OpenDir` per `Mount` whose backing is
a physical directory subtree, opened by the daemon at mount-formula
incarnation and passed into the worker's `fs` host power.
For `Mount`s whose backing is not a physical directory (a
`readable-tree`, a sqlite-backed view, an in-memory tree), the
worker's `fs` shim short-circuits the `cap-std` path and reads from
the mount's `MountInterface` directly, since `cap-std` has no
generic adapter for non-directory backings.
The exact shape of the seam (whether the shim lives in the `fs`
module or behind a thin `MountReadOpenable` trait) is TBD and
should be worked out alongside the case-1 implementation; the
implementation should not assume `cap-std` covers every `Mount`.

### Sub-case: fully virtualized

When the entry-point hint is tagged `kind: 'entry'` (not
`kind: 'compartment-map'`), the host has no `node_modules` tree to feed
the compartment mapper.
This is the sub-case that motivates the rest of the design.

#### Module store: npm-to-sqlite

Endo replaces the `node_modules` directory with a sqlite-backed
module store, building on [endor-npm-registry-proxy](endor-npm-registry-proxy.md)'s
registry table and [daemon-cas-management](daemon-cas-management.md)'s
content-addressed store.
The schema in `endor-npm-registry-proxy.md` § Registry table
already records `(name, version) -> CAS tree hash`; this design
treats that table as the canonical module store.
A package's files are CAS blobs; the registry table indexes them by
the npm name and version that the ingestion run resolved.

Ingestion is one-shot: when `endor run entry.js` encounters an
unsatisfied bare specifier, it fetches the package's tarball from
the configured registry, extracts each file into the CAS, and
inserts a row in the registry table.
Subsequent runs that resolve the same `(name, version)` pair read
from sqlite instead of touching the network.
`--offline` (per `endor-npm-registry-proxy.md` § Offline mode) is
the case where ingestion never fires and resolution depends
entirely on what is already in the table.

#### Resolution: Go-mod-shaped

`node_modules` exists today partly to materialize a resolved
dependency graph and partly to feed Node's directory-walking
resolver.
With a CAS-backed module store the design replaces both with a
Go-style resolution computed at compartment-map construction time and
never materialized on disk.

**The resolution algorithm itself is owned by
[mvs-resolver](mvs-resolver.md) and
[endor-npm-registry-proxy](endor-npm-registry-proxy.md) § Minimal
Version Selection; this design reuses it by reference rather than
restating it.** The algorithm's steps live there and are not
re-derived here. In outline they are: bootstrap from the entry
`package.json` read off the entry mount (`endor-run-expanded.md` §
Form 3 § Step 1); walk the transitive graph fetching each newly
reached package's `package.json` once; select per `(name, major)`
group the greatest version satisfying every declared range; and
re-walk to a fixed point (`endor-npm-registry-proxy.md` § Version
resolution, step 4 "Resolve transitively"), because a higher selection
can pull in transitive edges a lower candidate never declared.
What this design adds over that
algorithm is only its *backing* (the sqlite/CAS module store above, in
place of a `node_modules` tree) and the *reproducibility patterns*
below; the selection rule and its convergence are the owning layers'.

**Where the "Go-mod-shaped" framing stops.** Go's MVS is built on
`go.mod` requirements being pure minimums with no upper bound, which is
exactly why Go MVS can never fail to find a satisfying version.
npm's `^`/`~`/pinned ranges carry *upper* bounds, which MVS was never
designed to conflict against, so this design does **not** inherit Go
MVS's "a conflict can't happen" guarantee: a `(name, major)` group
whose greatest minimum is forbidden by some dependent's upper bound has
no satisfying version and the resolver **fails closed**. The framing
borrows Go MVS's *selection shape* (greatest of the declared minimums
per major), not its no-conflict guarantee; the fail-closed path below
is where the two part ways, and it is stated here up front rather than
as a buried corollary.

- The entry package's `package.json` lists *direct* dependencies as
  it does today (the `dependencies`, `peerDependencies`, and
  `optionalDependencies` fields), no transitive declarations; see
  *peer and optional policy* below for how `peerDependencies` and
  `optionalDependencies` are treated.
- **A group with no satisfying version fails closed.** The greatest
  minimum a `(name, major)` group selects must also satisfy every
  range declared against that group. If a dependent pins an upper
  bound below that minimum, no single version satisfies all declared
  ranges for the group. The resolver then fails closed at
  compartment-map construction time (the same disposition the peer
  policy takes for an unprovided peer, below), raising a
  `RegistryVersionConflictError` (see *error taxonomy* below) that
  names the conflicting `(name, major)` and the incompatible ranges,
  rather than silently selecting a version some dependent forbids.

The resolution is a deterministic function of the entry package's
direct deps plus the registry table's contents at resolution time.
"Deterministic" here is conditional: two runs that observe the same
registry-table contents at resolution time will produce the same
resolution.
Two runs that resolve the same entry but trigger ingestion of a new
`(name, version)` between them may resolve to different transitive
sets, because the second run sees a row the first did not.
This is a real time-dependence in the no-lockfile default, not a
contradiction: the design takes the position that registry-table
stability is a precondition for reproducibility, and exposes two
operator patterns for guaranteeing it:

- **Snapshot the registry table per reproducibility horizon.** A host
  that needs run-to-run reproducibility freezes the registry table
  (either by configuring `--offline` and pre-populating, per
  `endor-npm-registry-proxy.md` § Offline mode, or by carrying a
  registry-table snapshot in the daemon's state directory) so that
  ingestion cannot fire mid-horizon.
- **Use `endor lock`.** The follow-up to a lockfile is an
  `endor lock` command (see `endor-npm-registry-proxy.md`
  § Design decision 5) that snapshots the resolved
  `(name, version)` set into a file the host can carry between runs.
  A run that resolves against a lock pins the transitive set
  regardless of registry-table state, so ingestion that fires after
  the lock has no effect on the resolution.

The default mode for Case 1 is "no lockfile, resolution computed at
each `endor run`."
This default is appropriate for ad-hoc application execution where a
single horizon spans only one process lifetime; reproducibility-
sensitive deployments should adopt one of the two patterns above.
The failure mode under the default is silent transitive drift: a
run that re-resolves after an unrelated ingestion may pick up a
newer `(name, version)` row, and the run's behavior changes
accordingly.
To make the drift observable rather than silent, and to keep the run
and its audit trail referencing one immutable snapshot, `endor run`
materializes its selection as an explicit in-memory `RegistryResolution`
(the value shape `mvs-resolver.md` defines) before spawning the worker,
rather than re-reading the live registry table at each downstream step.
The compartment map, the run log, and any resolution cache key all
derive from *that* materialized value, not from "whatever the table
held when each step happened to read it," so an ingestion that advances
the table mid-run cannot make the log disagree with the compartment map
the worker actually ran. Every `endor run` logs that resolved
`(name, version)` set (the same set `endor lock` would freeze) to the
daemon's run log before spawning the worker. An operator (or a host
comparing successive runs) can diff the logged set between two runs of
the same entry point to see exactly which transitive selection changed,
without having adopted a lockfile. The default stays "no lockfile,
resolution computed each run"; the log makes the accepted
non-determinism auditable when it fires rather than leaving it
undetectable.
A future revision may promote `endor lock` to the default once the
command lands and the operational ergonomics are clear.

**Peer and optional policy.**
`peerDependencies` follow the reused resolver's semantics exactly
(`mvs-resolver.md` § JS reference implementation shape, the peer
cross-check): a peer requirement is recorded from *every* importer
in the transitive graph (not just the entry package) as the walk
encounters it, and each recorded requirement is satisfied when
*some* selected `(name, version)` in the resolved closure meets its
range, whichever package in the closure supplied that dependency.
A peer may therefore be satisfied transitively by any package in the
closure (e.g. a `react` peer required by `dep-a` and provided by
`dep-b`'s own `react` dependency), not only by the entry package's
own `dependencies`/`peerDependencies`.
The resolver fails closed at compartment-map construction time only
when a recorded peer is met by no entry in the closure, raising a
`RegistryMissingPackageError`, the same class `mvs-resolver.md`
already raises for an unmet peer (§ *error taxonomy* below).
This inherits the reused algorithm's cross-check rather than npm's
silent-deduplication semantics.
`optionalDependencies` are best-effort: the resolver tries to walk
them but does not fail if the package is unavailable; the
compartment whose require would have resolved into the optional
package instead resolves to a missing-module exit, and the
application receives a runtime error at first use.

**Ingestion failures.**
When `endor run` fetches a package the registry refuses, the failure
maps onto the registry layer's existing class by cause: a package the
registry has no such `(name, version)` for raises
`RegistryMissingPackageError`; a transient transport failure (5xx, a
bus/registry-host network error) raises `RegistryNetworkError`; a
tarball whose hash does not match the registry's `dist.integrity`
raises `RegistryTamperedError`.
Partial CAS writes from a failed extraction are rolled back: the
CAS is content-addressed and a partial blob has no row in the
registry table, so a re-run sees a clean state.
The registry table does not record failed attempts; a subsequent
`endor run` retries from scratch.
A persistent ingestion failure that blocks resolution surfaces as
the compartment-map build aborting before the worker starts, with the
raised class carrying the offending `(name, version)` pair and the
registry's response.

**Error taxonomy, reconciled with the owning layers.** This design
does not invent a parallel error vocabulary. Every failure it raises is
one of the structured `@endo/errors`-shaped classes owned by the
resolver/registry layers it composes
([registry-capability](registry-capability.md) § Failure surface and
[mvs-resolver](mvs-resolver.md)), so a caller who reads those designs
and one who reads this one build error-handling against a single set of
names. The mapping is exact:

| Failure condition (this design) | Class | Owned by |
|---|---|---|
| Ingestion: registry has no such `(name, version)` (404) | `RegistryMissingPackageError` | `registry-capability.md` § Failure surface |
| Ingestion: transient transport failure (5xx, bus/host network error) | `RegistryNetworkError` | `registry-capability.md` § Failure surface |
| Ingestion: tarball hash does not match `dist.integrity` | `RegistryTamperedError` | `registry-capability.md` § Failure surface |
| `--offline` and a needed package is not in the table | `RegistryOfflineError` | `registry-capability.md` § Failure surface |
| Unmet `peerDependencies` (no closure entry satisfies) | `RegistryMissingPackageError` | `mvs-resolver.md` (the peer cross-check) |
| `(name, major)` group with no version satisfying all declared ranges | `RegistryVersionConflictError` | *proposed addition to* `registry-capability.md` § Failure surface (below) |

The one condition the owning layer does not yet name is the npm-specific
version conflict: a group whose greatest minimum is forbidden by some
dependent's upper bound, which Go MVS cannot produce and so
`registry-capability.md`'s current list does not cover. This design
contributes `RegistryVersionConflictError` back to that layer's
failure-surface taxonomy (a sibling of the four existing
`Registry*Error` classes, `@endo/errors`-shaped, carrying the
conflicting `(name, major)` and the incompatible ranges) rather than
coining an unrelated name; the class belongs to `registry-capability.md`
once both land, and this design names it only to state the mapping.

For a caller, the retry boundary follows the class, not a second
vocabulary: `RegistryNetworkError` (a transient outage may clear) is
retryable, while `RegistryMissingPackageError`,
`RegistryTamperedError`, `RegistryOfflineError`, and
`RegistryVersionConflictError` require a `package.json`, registry, or
mode change rather than a bare retry. The one deferred failure is an
*optional* dependency that was unavailable: it surfaces as a runtime
missing-module error at first use rather than a build-time error, and
is `@endo/errors`-shaped when it fires.

`package.json` is the Go-mod analogue: it carries direct-dependency
intent. The resolved `compartment-map.json` is a deterministic
output, and therefore content-addressable, *for a given
`package.json` together with a fixed registry-table state*. It is not
a pure function of `package.json` alone: as the conditional-determinism
paragraph above states, an ingestion that advances the table between
two runs of the same `package.json` can change the resolution, so any
cache keyed on this output must key on `(package.json, registry-table
snapshot identity)`, not on `package.json`'s hash alone.

**Worked example.** The entry package declares `dep-a: ^1.2.0` and
`dep-b: ^1.0.0`. `dep-a@1.2.0` declares `shared: ^2.1.0`;
`dep-b@1.0.0` declares `shared: ^2.4.0`. The `(shared, major 2)` group
sees two ranges; their minimums are `2.1.0` and `2.4.0`, and the
resolver selects the greatest, `2.4.0` (the highest minimum, never a
newer patch that no package mentioned). If selecting `shared@2.4.0` reveals
that `shared@2.4.0`'s own `package.json` newly declares `tiny: ^1.0.0`
(a dependency `shared@2.1.0` did not have), the re-walk step picks
`tiny` up on the next pass and the selection then stabilizes. Had
`dep-b` instead declared `shared: ">=2.4.0 <2.5.0"` while `dep-a`
declared `shared: "~2.6.0"`, no single version would satisfy both
ranges and the resolver would fail closed on the `(shared, 2)` group.

**Phantom-dependency compatibility is a deliberate cost, not an
oversight.** Retiring `node_modules` and resolving purely off declared
`dependencies`/`peerDependencies`/`optionalDependencies` edges means a
package's declared manifest is treated as a *complete* map of what it
imports at runtime. Classic `npm install`'s flattened `node_modules`
hoists transitive packages into a shared directory, so a package can
today `require`/`import` a sibling it never declared: a "phantom"
dependency that happens to resolve because some other package pulled it
in. Under this design that import fails to resolve: there is no
flattened directory for it to fall through to, and a specifier with no
declared edge has no compartment to bind to. This is a real
compatibility cost of dropping `node_modules`, borne by any application
(or any transitive dependency, including ones the author does not
control) that relies on a phantom import. The design accepts it
deliberately: treating an undeclared import as a resolution failure is
the same fail-closed, declared-edges-only discipline the Go-style
resolver exists to enforce, and the remedy is to declare the missing
dependency in the offending package's `package.json`. A phantom import
surfaces as the missing specifier having no compartment at
compartment-map construction time (a build-time `RegistryMissingPackageError`
naming the undeclared specifier), or, for a specifier the mapper cannot
statically see, as a runtime missing-module error at first use, never
as a silent fallthrough to an undeclared package. The test catalog
exercises this explicitly (§ Test catalog, "Phantom (undeclared) import
fails closed").

#### Ad-hoc compartment maps

With direct dependencies declared and transitive resolution
computed, `endor run` builds a `CompartmentMapDescriptor` in
memory:

- One compartment per resolved `(name, version)` pair.
- The entry compartment's `modules` map points at the entry-point
  module's CAS hash.
- Each compartment's `modules` map is populated the same way
  `@endo/compartment-mapper` maps a package today: gated by the
  package's `package.json` `exports`/`main` and conditional-exports
  semantics, resolving CAS hashes for the files those fields make
  importable, **not** by a blind file-tree walk. This design reuses
  the mapper's existing exports-aware resolution (via `mapSnapshot`,
  which [snapshot-mapper](snapshot-mapper.md) owns) rather than a
  narrower ad-hoc walk: a package that restricts its importable paths
  through `exports`, or routes one specifier to different files by
  `import`-vs-`require` condition, resolves under those rules here
  exactly as it would under a `node_modules`-backed map. The only
  thing "ad hoc" about the construction is that the descriptor is
  built in memory from the CAS-backed store per run rather than read
  from a `compartment-map.json` on disk; the resolution semantics
  inside each package are the mapper's, unchanged.
- Inter-compartment edges follow the resolved version selection:
  a dependency on `lodash` in the entry compartment becomes an
  edge to the specific compartment whose `(name, version)` is the
  resolution result.

This is the case-1 generalization of `endor-run-expanded.md`'s
Form 3.
The compartment map is never written to disk in the confined case;
it lives in the XS host's memory for the duration of the run.
The CAS-backed module loading path (`endor-run-expanded.md` §
CAS-backed module loading) already accepts in-memory compartment
maps, so no new wire format is needed.

### Sub-case: prebuilt compartment-map.json

When the entry-point hint is tagged `kind: 'compartment-map'` (its
`path` pointing at a `compartment-map.json`), the machinery above is
bypassed: the host reads the manifest from the mount, the
module-source bytes from CAS or from the mount's blobs, and constructs
the in-memory compartment map directly from the manifest.
This is the existing `endor run <archive>` and `endor run
<directory>` path generalized to read from a mount instead of from
a host filesystem path.

### Lifecycle

The confined XS worker is a regular `endor` worker per
`daemon-endor-architecture.md` § Worker platforms.
Its `MountHandle` set (the per-`Mount` capability references the
worker holds, one handle per `Mount` in the mount set the host passed
in) is GC-pinned by the formula that incarnates the worker, so a
daemon restart can re-create the same confinement.
Mount writes the worker performs land in the backing store of the
underlying mount (a `mount` formula writes through to the host
directory; a `scratch-mount` formula writes to the daemon's state
dir; a CAS-backed read-only mount throws on write).

### Guest access via a Lal caplet

The three hosts in § Shape (Familiar's daemon, the CLI, and a Lal
caplet acting for a guest) reach `endor run` identically; only the
guest case adds an authorization surface, and that surface is
**owned by [lal-fae-form-provisioning](lal-fae-form-provisioning.md)**,
not re-specified here. This design's contract with it is narrow: a
guest never holds a host-path power and never calls `endor run`
directly. It holds only a caplet the host granted, and that caplet
closes over a fixed mount set (the exact `Mount` capabilities the
host chose to expose, no more) plus the entry-point hint; the
caplet's sole action is "run this application against *these*
mounts." The guest cannot widen the mount set or reach the host
filesystem outside it, because the mount caps are the only
filesystem reach the confined worker is given (§ Shape). How the
host mints and hands over that caplet, and why a guest cannot mint
one for itself, is the host-mediated grant of
`lal-fae-form-provisioning.md` § Processing Form Submissions and its
§ Architectural Constraint: Guest Cannot Create Guests (Options B/C,
the manager-follows-the-form / host-power grant); this design adds
nothing to that mechanism beyond fixing what the caplet closes over
(the mount set + entry hint).

**A guest caplet reaches only the confined Case 1 path.** The caplet
closes over a mount set and an entry hint, never a formula `type`, and
the host grants it only against a `type: 'confined-app'` (Case 1)
formula. It cannot
name a `host-node-app` (Case 2) formula, so a guest cannot use it to
trigger the unconfined `node` child of § Case 2. Case 2's host-eject
path stays host-only: the `host-node-app` opt-in is a
maintainer-audited per-formula flag (§ Recommended approach, "One entry
point, explicit dispatch") that a guest's caplet has no way to set or
select. This is what preserves the "a guest never holds a host-path
power" promise above even though `endor run` dispatches on formula
`type`: the dispatch branch a guest can reach is fixed at grant time to
the confined one. Opening Case 2 to guests is explicitly deferred to
the POSIX-sandbox follow-up (§ Follow-up gated on POSIX sandbox), which
is what makes a guest-requestable host-eject confineable; until then no
caplet reaches it.

### Test catalog

Case 1 lands with at least the following integration tests, all
exercised against a real `endor` worker spawned by the daemon:

- **Fresh CAS run.** Given an `entry.js` Mount with no module-store
  rows pre-populated, `endor run` ingests every transitive package
  from the configured registry, builds the compartment map, and
  runs the application to a clean exit.
  Verifies: ingestion path, MVS resolution against newly written
  rows, ad-hoc compartment-map construction, CAS-backed module
  load.
- **Partially-populated CAS, ingestion on miss.** Given a module
  store pre-populated with the entry's direct deps but missing one
  transitive dep, `endor run` resolves the populated rows from
  sqlite without network, ingests the missing transitive only, and
  runs to clean exit.
  Verifies: the on-miss boundary; that the resolver does not refetch
  already-resolved rows.
- **`--offline` against empty CAS fails predictably.** Given an
  `entry.js` Mount and `--offline`, with no module-store rows for
  the entry's direct deps, `endor run` fails at compartment-map
  build time with a `RegistryOfflineError` naming the first
  unresolvable `(name, version)`.
  Verifies: the failure shape under § Offline mode and § Ingestion
  failures; that the worker is never spawned when resolution fails.
- **Ingestion failure rollback.** Given a registry that returns 5xx
  for one transitive dep, `endor run` raises `RegistryNetworkError`,
  leaves no partial registry-table row, and a subsequent run
  against the same entry (with the registry recovered) succeeds.
  Verifies: the rollback story and error-taxonomy mapping under
  § Ingestion failures.
- **Prebuilt-compartment-map sub-case parity.** Given a Mount whose
  entry-point hint is tagged `kind: 'compartment-map'`, `endor run`
  bypasses ingestion and resolution and constructs the in-memory
  compartment map directly.
  Verifies: the sub-case branch in `### Sub-case: prebuilt
  compartment-map.json`.
- **Worker confinement.** A test application that calls into a
  mount's `lookup` for a path outside the mount root, or attempts
  ambient host-fs access, receives an authorization failure (not a
  silent fallthrough to the daemon's host fs).
  Verifies: the cap-std parametrization seam under § Shape.
- **Re-walk to a fixed point.** Given an entry whose direct deps
  select a `(name, major)` group whose chosen higher-minimum
  version declares a transitive dependency that the lower candidate
  version's `package.json` did *not* (the § Resolution worked
  example's `shared@2.4.0` -> `tiny` shape), `endor run` picks up
  the newly-revealed transitive on the re-walk pass and the
  application imports it successfully.
  Verifies: the re-walk-to-a-fixed-point convergence step under
  § Resolution: Go-mod-shaped; that a single downward pass would
  have omitted the module.
- **Unsatisfiable `(name, major)` group fails closed.** Given an
  entry where two dependents pin incompatible ranges against one
  `(name, major)` group so that no single version satisfies both
  (the worked example's `>=2.4.0 <2.5.0` vs `~2.6.0` shape),
  `endor run` fails at compartment-map build time with a
  `RegistryVersionConflictError` naming the conflicting
  `(name, major)` and the incompatible ranges, and never spawns the
  worker.
  Verifies: the fail-closed disposition under § Resolution:
  Go-mod-shaped, "A group with no satisfying version fails closed."
- **Unprovided peer fails closed.** Given an entry whose transitive
  graph records a `peerDependencies` requirement that no entry in
  the resolved closure satisfies, `endor run` fails at
  compartment-map build time with a `RegistryMissingPackageError` and
  never spawns the worker; the companion case where a *different*
  package in the closure supplies the peer resolves cleanly.
  Verifies: the peer cross-check and fail-closed path under § Peer
  and optional policy.
- **Missing optional dependency defers to runtime.** Given an entry
  with an `optionalDependencies` entry that is unavailable in the
  store and un-ingestible, compartment-map construction succeeds
  (the optional does not fail closed), the worker spawns, and the
  application receives a `@endo/errors`-shaped missing-module error
  only at the first `require`/`import` of the optional.
  Verifies: the best-effort optional path under § Peer and optional
  policy; that an optional miss is a runtime error, not a build-time
  one.
- **Phantom (undeclared) import fails closed.** Given an entry whose
  transitive graph includes a package that `require`/`import`s a
  sibling it does *not* declare in its own
  `package.json` (an import that would resolve only under classic
  `node_modules` hoisting), `endor run` does not silently bind it:
  a statically-visible undeclared specifier fails at compartment-map
  construction time with a `RegistryMissingPackageError` naming the
  undeclared specifier, and a dynamically-computed one fails as a
  runtime missing-module error at first use, never as a fallthrough
  to an undeclared package.
  Verifies: the declared-edges-only discipline under § Resolution:
  Go-mod-shaped, "Phantom-dependency compatibility."

The test catalog above is the minimum acceptance set; the
implementation may add more.
Tests are AVA-shaped per the project convention and run under the
daemon's existing integration-test harness.

## Case 2: host-eject to Node.js

Case 1 covers applications that fit inside the XS worker's confined
surface; Case 2 covers the remainder, where the application needs
Node.js APIs that XS cannot satisfy.
The two cases share the mount-cap front end but diverge sharply at
the execution boundary: Case 1 stays inside the daemon's
`endor`-hosted worker, Case 2 shells out to a Node child process
against a materialized tree.

### Shape

The host has an application bound to one or more `Mount`s.
The application needs Node.js APIs that XS cannot satisfy (native
modules, the full `node:*` surface, a binary the package's
`postinstall` ran), so a confined XS worker under `endor` is not
viable. The host instead:

1. Allocates a scratch mount (`provideScratchMount`).
2. Ejects each input mount into a **read-only** tree under the scratch
   mount, named by the source mount's content hash.
   Ejection is the `endo checkout` operation (the documented dual of
   `endo checkin`, per [daemon-checkin-checkout](daemon-checkin-checkout.md)
   and the Glossary) restricted to a scratch mount: it walks the
   `MountInterface` and writes each blob and tree to the scratch
   directory's real filesystem path.
   The daemon never hands this hash-named tree to the child for
   writing (§ Re-eject discipline), so it stays a faithful
   materialization of the source hash and is reusable across runs.
3. Allocates a **per-run writable working directory** layered over
   that read-only tree (an overlay whose lower layer is the hash-named
   tree, or a fresh copy-on-write scratch subdirectory) and spawns
   `node` (or the bundled Node binary from
   `familiar-electron-shell.md` § Resource paths) with that working
   directory as its cwd and the entry-point module as its argv.
   The child may write freely into its cwd (a build cache, a config
   file, a mutated `node_modules` entry); those writes land in the
   per-run working directory, never in the reusable read-only tree.
   The child process is an unconfined Node worker spawned through
   the `"node"` worker platform of
   [daemon-endor-architecture](daemon-endor-architecture.md)
   § Worker platforms (`NODE_BIN`/`node`, "required for unconfined
   caplets that depend on Node.js APIs"); it speaks CBOR envelopes
   back to the supervisor on fds 3 and 4, as that section's
   separate-spawning path specifies.
4. Runs the application to completion under Node's native
   module resolution.
   The supervisor relays stdout, stderr, and the worker's CBOR
   envelopes; on a clean (zero) exit it returns normally, and on a
   non-zero exit it surfaces an `@endo/errors`-shaped failure whose
   payload carries the numeric exit code (and captured stderr) to
   the formula owner, matching Case 1's structured-error failure
   shape (§ Recommended approach, "Uniform failure shape") rather
   than a bare exit code.
5. The daemon's existing scratch GC reclaims the scratch mount
   when the worker exits or the formula is unpinned.

The *supervisor* here is the daemon-side component that owns the
child process's lifecycle. It is the host-side `makeUnconfined` /
`makeUnconfinedFromTree` manager of
[daemon-make-archive](daemon-make-archive.md) §§ Phase 6/8 (the
scratch-staging bridge that runs Node's unconfined loader against
a staged tree, explicitly a host-only capability an XS worker
never gets), driving the `"node"` worker platform above. There is
no `endor`-hosted XS worker to supervise in Case 2; the supervisor
spawns the `node` child, relays its fds, and records its exit.

The host-eject path uses `node`'s native resolver to load the
application: the ejected directory is a normal Node.js source tree
with `node_modules` inside it (ejected from a sub-mount that is
itself the cached output of an earlier `npm install`, or
re-materialized from the CAS-backed module store on demand).

These two sourcing paths do **not** have the same scope. The
`npm install` sub-mount is the general path: it is real npm output, so
compiled binaries are present, any `postinstall` has already run, and
phantom (undeclared-but-hoisted) imports resolve exactly as they did
at install time. It fully covers Case 2's motivating workload (native
modules and postinstall-built binaries). The CAS re-materialization
path is *narrower*, and cannot cover that same workload. The module
store's ingestion path (§ Module store: npm-to-sqlite) only fetches
and extracts tarball files: it names no `postinstall` step, so it
materializes no compiled binaries, and its resolver is
declared-edges-only, so any phantom dependency a package relies on
still fails closed (§ "Phantom-dependency compatibility"). The CAS
variant is therefore usable only for **source-only packages with no
native/`postinstall` step and no phantom-import reliance**. A Case 2
leaf that needs native modules or postinstall-built state must take
the `npm install` sub-mount path. Selecting the CAS variant for a
native-dependent package is a configuration error, not a silent
fallback.

This is *not* the CAS-to-`node_modules` materialization that
`## Alternatives considered` #2 rejects. That rejection is scoped
to **Case 1**: materializing a tree only to run **XS** against it
keeps directory-walking resolution *in place of* the Go-style
resolver (the resolver's whole point is to retire it), and leaves a
per-run scratch dir whose reuse the daemon has no discipline for. In
Case 2, directory-walking resolution is the *requirement*, not a
regression: the leaf runs under Node precisely because it needs
Node's native resolver, so nothing is being retired here. And the
per-run scratch dir is exactly what § Re-eject discipline governs:
the read-only hash-named tree plus the separate per-run writable
working directory give the daemon the reuse discipline the rejected
Case 1 variant lacked. The two rejection reasons therefore do not
carry over.

This case is intentionally smaller in scope than Case 1.
The compartment-mapper machinery is not exercised; the application
runs under Node's native module resolution.
The confinement against the host filesystem comes entirely from
the scratch directory's containment plus whatever the supervisor
chooses to bind-mount or chroot around it; this design does not
extend the confinement model and defers that to the POSIX-sandbox
follow-up (below).

### Re-eject discipline

Ejection keeps two directories with two different identities, so that
reuse stays unconditional rather than gated on bookkeeping. The
**read-only tree** is named by the source mount's content hash (mount
formulas compute their current content hash; git filesystems can use
their current tree hash directly), and the daemon never opens it for
writing. Because a hash-named tree is therefore always a faithful
materialization of that hash, re-ejecting is a no-op whenever a
read-only tree for the current source hash already exists: the reuse
check is pure hash-to-hash equality, matching the spirit of
`daemon-cas-management.md`'s deduplication.

The child's writes go to a **separate per-run writable working
directory** (§ Shape step 3), never into the hash-named tree. Since
the reusable tree is never written, a prior run cannot dirty it, and
the "reuse when the hash matches" invariant never has to be qualified
by a dirty-or-single-use flag. The per-run working directory is
discarded at scratch GC when the worker exits; the read-only tree
survives for the next run against the same source hash. This keeps
content identity (the hash-named tree) and run-local mutable place
(the working directory) as two separate objects, rather than
complecting them into one writable hash-named directory whose
"hash implies content" invariant a write would silently break.

### Test catalog

Case 2 lands with at least the following integration tests, mirroring
Case 1's acceptance-set shape, all exercised against a real spawned
`node` child:

- **Fresh eject and run.** Given input `Mount`s and a `type:
  'host-node-app'` formula, the host allocates a scratch mount, ejects
  every input mount to disk, spawns `node` with the ejected cwd, and
  runs the application to a clean (zero) exit.
  Verifies: the eject write path, `node` spawn, fd relay, exit-code
  capture.
- **Re-eject no-op on unchanged source.** A second run against input
  mounts whose content hash is unchanged reuses the existing read-only
  hash-named tree and performs no re-eject, even though the prior run's
  child wrote into its own per-run working directory.
  Verifies: the hash-to-hash reuse gate under § Re-eject discipline;
  that the read-only tree stays reusable regardless of prior-run
  writes.
- **Child writes are isolated to the per-run working directory.** A run
  whose child writes into its cwd (a build cache, a mutated
  `node_modules` entry) leaves the read-only hash-named tree unchanged;
  a subsequent run against the same source mount reuses that tree and
  the second child sees none of the first child's mutations.
  Verifies: the read-only-tree / per-run-working-directory split under
  § Re-eject discipline (§ Shape steps 2-3).
- **Non-zero exit-code propagation.** A child that exits non-zero
  causes the supervisor to surface an `@endo/errors`-shaped failure
  whose payload carries that exact exit code to the formula owner,
  catchable the same way a Case 1 build-time failure is.
  Verifies: the exit-code relay and uniform failure shape under
  § Shape step 4 and § Recommended approach, "Uniform failure shape."
- **Scratch GC reclaim.** When the worker exits or the formula is
  unpinned, the daemon's scratch GC reclaims the scratch mount.
  Verifies: § Shape step 5.

Tests are AVA-shaped per the project convention and run under the
daemon's existing integration-test harness.

## Endor cross-references

The Rust design described in `daemon-endor-architecture.md` and
`endor-run-expanded.md` is the case-1 substrate for this design.
The Node.js-side proposal here adapts the same vocabulary
(compartment maps, CAS, registry table, scratch mounts) for code
that runs inside the daemon's manager JS rather than inside Rust.

Alignment:

- The mount-backed import hook in Case 1 is the JS-side mirror of
  `endor`'s CAS-backed module loading
  (`endor-run-expanded.md` § Form 3).
  Both read module bytes by hash; the difference is whether the
  hash comes from a mount lookup or directly from a CAS root.
- The sqlite-backed module store (Case 1, sub-case "fully
  virtualized") is the JS lane's backing for the same
  `EndoRegistry` capability the Rust side exposes. The two lanes
  do **not** share a schema: per
  [registry-capability](registry-capability.md) § Non-Goals, each
  lane owns its own registry-table representation and resolver
  internals, and they meet only at the `EndoRegistry` capability
  shape and at the content-addressed CAS contents (shareable by
  hash), never at the SQLite schema.
- The Go-style resolver in Case 1 reuses the algorithm
  [endor-npm-registry-proxy](endor-npm-registry-proxy.md) § Minimal
  Version Selection specifies for the Rust side, including its
  transitive re-walk to a fixed point (§ Resolution: Go-mod-shaped),
  so the two sides converge on the same selection rather than
  diverging on a dropped step.

Divergence:

- Case 2 (host-eject) is *not* new to the Rust design: it wraps
  the existing `"node"` worker platform
  [daemon-endor-architecture](daemon-endor-architecture.md)
  § Worker platforms already documents (a Node.js child spawned via
  `NODE_BIN`/`node`, "required for unconfined caplets that depend on
  Node.js APIs"). What Case 2 adds on top is the eject-to-scratch
  materialization and the re-eject discipline (§ Shape, § Re-eject
  discipline), so that a mount-bound application (not just a
  pre-staged tree) reaches that `"node"` platform. Case 2 is a
  Node.js-host concession in the sense that the confined XS path
  cannot run these leaves; it does not claim `endor` lacks a Node
  worker. The Familiar and the Node-side daemon are deployed in
  places where Node.js is the only viable runtime for the
  unconfined leaf.
- Case 1's compartment-map construction lives in JS (using the
  existing `@endo/compartment-mapper`); the Rust side has its own
  archive loader.
  These can converge later once `endor`'s Form-3 reaches feature
  parity with the JS mapper.

## Alternatives considered

1. **Continue requiring `node_modules` on disk for all unconfined
   runs.** Rejected: defeats the case-1 confinement story and
   forces every Familiar deployment to ship or build a real
   `node_modules` tree. Its one genuine advantage (that classic
   flattened `node_modules` tolerates *phantom* (undeclared) imports
   that a declared-edges-only resolver rejects) is weighed and
   accepted as a cost in § Resolution: Go-mod-shaped,
   "Phantom-dependency compatibility": the declared-edges discipline is
   the point, and the remedy is to declare the missing edge, not to
   retain the hoisted tree.
2. **Materialize a `node_modules` tree from the CAS lazily into a
   scratch mount, then run XS against it (no Go-style
   resolution).** Rejected: keeps the directory-walking
   resolution that the Go-style resolver retires, and produces a
   per-run scratch dir whose hash collisions across runs the daemon
   would then have to manage.
3. **Use npm's existing maximal version selection (newest within
   range) instead of MVS.** Rejected: aggressive, brings in
   versions no package in the graph has tested against; conflicts
   with Endo's predictability bent.
4. **Author an explicit lockfile (`endor.lock`) and require it for
   every run.** Rejected for default: a lockfile is useful for
   reproducibility but adds operational burden for the
   ad-hoc-application case; offered as a follow-up command
   (`endor lock`) rather than a requirement.
5. **Run Case 2 inside the POSIX sandbox today (no scratch-mount
   eject step).** Rejected: gated on the POSIX sandbox shipping
   on the host platform.
   Listed as the case-2 follow-up below.

## Recommended approach

Land Case 1 first, including the sqlite-backed module store and
the Go-style resolver, behind the existing `endor run entry.js`
form-3 entry point.
This lets the daemon's manager JS, the CLI, and any guest with an
appropriate caplet run confined applications out of a mount set
today.
Case 2 (host-eject) lands second, gated on the per-formula
`type: 'host-node-app'` opt-in (as against the Case 1 default
`type: 'confined-app'`) so the maintainer can audit each application
that elects host-Node execution.
The POSIX-sandbox follow-up retires Case 2's ad-hoc confinement
once the sandbox is available on the deployment target.

**One entry point, explicit dispatch.** `endor run` remains the sole
caller-facing verb for both cases; a caller never picks a case by
reaching for a different command. `endor run` dispatches on the
formula's `type`, and both branches are named explicitly: a
`type: 'confined-app'` formula (the default) runs the confined Case 1
path, and a `type: 'host-node-app'` formula runs the Case 2
host-eject path. Because the opt-in is an explicit, maintainer-audited
per-formula flag (not something `endor run` infers from the
application's contents), `endor run` against an application that needs
Node APIs but lacks the opt-in fails closed with an error naming the
`host-node-app` opt-in as the required next step, rather than silently
falling back to host-eject. The two cases are thus reachable from the
one entry point a caller starts at, and the path between them is a
named flag, not a second command. Because that flag lives on the
formula and is set only by a maintainer audit, it is not something a
guest's Lal caplet can set or select (§ Guest access via a Lal
caplet): a guest reaches the Case 1 dispatch branch only, and Case 2
stays host-only until the POSIX-sandbox follow-up.

**Uniform failure shape across the two cases.** Because both cases
share the one `endor run` entry point, they also share one failure
shape: a caller writing generic error handling against `endor run`
must get an `@endo/errors`-shaped structured failure whichever case
`endor run` dispatched to. Case 1's build-time and runtime failures
are already
that shape (§ Resolution: Go-mod-shaped, § Ingestion failures, § Peer
and optional policy). Case 2's leaf-process failures are made to
match: when the ejected `node` child exits non-zero, the supervisor
does not surface a bare exit code: it wraps the exit code (and
captured stderr) in an `@endo/errors`-shaped failure whose payload
carries the numeric code, so both cases catch the same way. The
raw exit code remains available on that error for callers that want
it. A caller therefore never has to branch its error handling on
which case ran.

**Cross-major-version semantics.** Both cases let an application
depend on multiple major versions of the same package at once, but by
different mechanisms with different isolation strength. Case 1 hosts
each major in a distinct SES compartment, each with its own module
registry. Case 2 hosts them through Node's native nested `node_modules`
resolution: the majors coexist as ordinary nested directory installs,
without a separate module registry per compartment. Moving an
application between the two paths therefore does not change *which*
versions resolve, but Case 2 does not provide Case 1's per-compartment
registry isolation, so the two paths are not interchangeable where that
isolation matters.

## Resolved design decisions

1. **`package.json` remains the Go-mod analogue.** It declares the
   application's direct dependencies. The `compartment-map.json` is a
   deterministic output for a given `package.json` *together with a
   fixed registry-table state* (§ Resolution: Go-mod-shaped,
   conditional determinism), so it can be cached by content address,
   but the cache key is `(package.json, registry-table snapshot
   identity)`, not `package.json`'s hash alone, and the cache is
   invalidated whenever ingestion advances the table. Keyed on
   `package.json` alone it would return a stale map after an unrelated
   ingestion, reintroducing the silent transitive drift that section
   names. It carries no second source of dependency intent.
2. **The module store is per daemon.** The sqlite-backed store lives
   at `{statePath}/registry.sqlite`, as in
   `endor-npm-registry-proxy.md`; no system-wide shared cache is
   introduced.
3. **Case 2 preserves multi-major hosting.** An application may host
   multiple major versions of a package under Case 2 too, but through
   Node's native nested `node_modules` resolution, not SES compartments
   (which Case 2 does not exercise). This is a materially weaker
   isolation property than Case 1's per-compartment module registries;
   § Recommended approach, "Cross-major-version semantics" names the
   gap.
4. **MVS dependency policy is confirmed.** A `peerDependencies`
   requirement is recorded from *every* importer in the transitive
   graph and is satisfied when *some* package in the resolved closure
   meets its range, whichever package supplied it (not only the entry
   package's own dependencies); the resolver fails closed while
   building the compartment map only when no entry in the closure
   satisfies a recorded peer (§ Peer and optional policy states the
   full cross-check). `optionalDependencies` are best effort: an
   unavailable optional module exits as missing, and use fails at
   runtime. `endor-npm-registry-proxy.md` § Known gaps records the
   underlying ambiguity.
5. **Re-eject equality is content-hash equality.** Mount formulas
   compute their current content hash. Git filesystems can use their
   current tree hash directly.

## Follow-up gated on POSIX sandbox

When [endo-posix-sandbox](endo-posix-sandbox.md) lands on the host
platform, guests can also run Node.js applications safely via the
case-2 eject-to-scratch path: the host's eject step is unchanged,
but the spawned `node` process runs inside a POSIX-sandbox slice
whose only filesystem reach is the scratch directory plus any
mount caps the guest's caplet was authorized to pass through.
The network profile is the sandbox's `private` default
(`endo-posix-sandbox.md` § Network policy ladder).
This converts Case 2 from a host-only privilege to a primitive
guests can request.
Detailed flow is out of scope for this design; the dependency
gate is named here so the case-2 ground truth does not bake in
the assumption that host-eject is a host-only path forever.

## Dependencies

| Design | Relationship |
|--------|--------------|
| [daemon-mount](daemon-mount.md) | Provides the `MountInterface` guard the case-1 import hook and the case-2 eject step both consume |
| [endor-run-expanded](endor-run-expanded.md) | Case 1 is the JS-side mirror of Form 3 |
| [endor-npm-registry-proxy](endor-npm-registry-proxy.md) | Provides the sqlite-backed module store and the MVS algorithm reused in Case 1 |
| [daemon-cas-management](daemon-cas-management.md) | Provides the CAS that backs the module store |
| [daemon-endo-rust-sqlite](daemon-endo-rust-sqlite.md) | Provides the sqlite host power backing Case 1's module store |
| [daemon-endor-architecture](daemon-endor-architecture.md) | Case 1's confined worker is a regular `endor` worker; Case 2's unconfined leaf is its `"node"` worker platform (fd 3/4 CBOR relay) |
| [daemon-make-archive](daemon-make-archive.md) | Provides the host-side `makeUnconfined`/`makeUnconfinedFromTree` manager (Phase 6/8) Case 2's supervisor drives to spawn and relay the `node` leaf |
| [endo-posix-sandbox](endo-posix-sandbox.md) | Gates the case-2 follow-up that opens host-eject to guests |
| [familiar-electron-shell](familiar-electron-shell.md) | Case 2 uses the bundled Node binary the Familiar already carries |

## Prompt

> Hosts and guests should both be able to run a JavaScript
> application out of anything that implements the Endo filesystem
> mount interface. In the confined case, the host wires up one or
> more Mount caps and runs the app under endor against the mount
> set; the app's only filesystem reach is the caps the host
> passed in. In the fully-virtualized-and-confined sub-case, npm
> packages live in a sqlite-backed module store fed from CAS, and
> the compartment map is constructed ad hoc per run using
> Go-style transitive dependency resolution against that store
> (no node_modules, no lockfile by default). The Go-style
> resolution is the avoid-the-lockfile move: direct deps in the
> entry package's package.json, transitives computed at build
> time, minimum-version selection per (name, major). In the
> host-eject case, the host writes a readable tree to a scratch
> mount and shells out to node; this is the small subcase.
> POSIX sandbox is the follow-up that lets guests also use the
> eject path.
