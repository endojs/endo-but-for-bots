# Familiar and host run applications over a VFS

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
An application is hosted inside an XS worker (via `endor`) whose only
filesystem reach is one or more `Mount` capabilities the host has handed
it.
Within Case 1, the design's main subject is the fully virtualized
sub-case: when the entry-point is a bare `entry.js` rather than a
prebuilt `compartment-map.json`, the design replaces `node_modules` with
a sqlite-backed module store and constructs the compartment map ad hoc
per run.
The detail of that sub-case lives in `## Case 1` below.

Case 2 is the host-eject path.
The host writes a readable tree to a scratch directory on the real
filesystem and then shells out to a `node` child process that loads the
application from disk, for applications that genuinely need Node.js APIs
and where the guest-side POSIX sandbox is not yet available.

## Relationship to the four-layer `importLocation` stack

Case 1's fully-virtualized sub-case is **not** new territory: it is the
Familiar- and guest-facing consumer of the accepted four-layer
daemon-worker `importLocation` stack, which `designs/README.md` records
as Not Started (accepted 2026-07-10) and whose canonical
dependency-ordered build plan lives in
[daemon-worker-import-from-mount](daemon-worker-import-from-mount.md)
§ *Phased Implementation*. This design does not re-specify that stack; it
composes it, and every Case 1 mechanism below is a use of a layer that
stack owns:

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
  materialised tree for applications that need Node APIs XS cannot
  satisfy.
- **The `endor` (Rust-side) mirror** in `## Endor cross-references`.

Where a term below has a canonical name in the stack (`EndoRegistry`,
`mapSnapshot`, `RegistryResolution`), the stack's name is authoritative;
this design's prose names the same object and defers its exact shape to
the owning layer.

## Glossary

This design reuses vocabulary from existing designs rather than
coining new terms.
**Filesystem mount interface (VFS)**: the `MountInterface` defined by
[daemon-mount](daemon-mount.md) (has / list / lookup / write / remove
/ move / makeDirectory / readOnly / snapshot).
VFS is used as a short name for this interface throughout.
**Readable tree**: the immutable, content-addressed snapshot of a
directory tree per [daemon-checkin-checkout](daemon-checkin-checkout.md);
the shape a `MountInterface.snapshot()` produces.
**Mount**: a capability whose backing is a physical directory subtree
(per `daemon-mount.md`) or any other source that satisfies the
`MountInterface` guard (a `readable-tree`, a sqlite-backed view, an
in-memory tree).
**Scratch space**: the daemon-managed backing storage produced by
`provideScratchMount` (`daemon-mount.md` § Scratch Mount Provisioning
and Lifecycle).
A scratch mount is the case-2 destination.
**Compartment map**: a `CompartmentMapDescriptor` per
`@endo/compartment-mapper`'s `types/compartment-map-schema.ts`; the
graph of compartments, modules, and exit-module entries that
`endor run` consumes today via `compartment-map.json`.
**CAS**: content-addressed store; the blob and tree store described in
[daemon-cas-management](daemon-cas-management.md).
Files are addressed by their content hash, so identical bytes are
deduplicated across packages and across runs.
**`endor`**: the Rust-side daemon and worker host described in
[daemon-endor-architecture](daemon-endor-architecture.md) and
[endor-run-expanded](endor-run-expanded.md).
The `endor run` command is its entry point for running a JavaScript
application against a mount set.
**XS worker**: an XS-engine JavaScript worker hosted by `endor` per
`daemon-endor-architecture.md` § Worker platforms.
XS is the embedded JavaScript engine that Endo uses for confined
execution; an XS worker has no ambient host capabilities beyond what
its host explicitly provides.
**`cap-std`**: the Rust capability-oriented standard-filesystem library
used by `endor`'s host-side `fs` module to back the VFS bindings; see
`daemon-endor-architecture.md` § Host powers.
**Formula**: the persisted, GC-pinned record from which the daemon
incarnates a capability.
A worker formula incarnates a worker; a `mount` formula incarnates a
mount; see `daemon-endor-architecture.md` § Worker formula for the
worker case.
**Lal caplet**: a guest-facing capability granted to a Lal-shaped agent
(per [lal-fae-form-provisioning](lal-fae-form-provisioning.md)) that
exposes a host-mediated action to the agent.
A Lal caplet that wraps `endor run` lets an agent run an application
against a mount set the host authorized.
**Ejection**: producing a host-filesystem layout from a mount such
that an external program (in Case 2, `node`) can read it directly.
Mechanically this is [`endo checkout`](daemon-checkin-checkout.md),
the documented dual of `endo checkin` that "writes a `readable-tree`
from the daemon back to the local filesystem", restricted to a
scratch mount: eject writes to a daemon-managed scratch directory
reclaimed by scratch GC (`## Case 2 § Shape` step 5) rather than to a
caller-named persistent path, and materialises no persistent formula.
"Eject" is used, rather than reusing "checkout" bare, only to mark
that scratch-mount-and-GC restriction; the write mechanism is
`checkout`'s.

## Case 1: confined application execution

### Shape

A host (Familiar's main daemon, the CLI's `endor run`, or a Lal
caplet acting on behalf of a guest) names an application by:

- one or more `Mount` capabilities (the application sources, plus any
  data directories the application needs to read or write at
  runtime), and
- an entry-point hint: either a path within one of the mounts that
  points at `compartment-map.json`, or a path that points at an
  `entry.js` whose dependency graph must first be resolved.

The host invokes `endor run` against the mount set.
`endor` runs the application in a confined XS worker whose only
filesystem reach is the mount set the host passed in.
The worker has no ambient host-path power: every `import` resolves
through a hook that reads bytes from a mount, never from the host's
real filesystem outside the mount roots.

The worker's host-side adapter satisfies the `MountInterface` guard
on both directions: the worker reads module sources by calling the
mount's `lookup` and `text()` / `streamBase64()`, and writes runtime
output (logs, generated artifacts, persisted state) through the same
mount surface.
The XS host-powers `fs` module ([daemon-endor-architecture](daemon-endor-architecture.md)
§ Host powers) is the natural home for the cap-std bindings that
back this.
In the confined case `cap-std` is parametrised by the mount-resolved
host paths rather than the daemon's ambient host-paths power.
The exact parametrisation seam is left open: `cap-std`'s public API
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

When the entry-point hint is `entry.js` (not a prebuilt
`compartment-map.json`), the host has no `node_modules` tree to feed
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

`node_modules` exists today partly to materialise a resolved
dependency graph and partly to feed Node's directory-walking
resolver.
With a CAS-backed module store the design replaces both with a
Go-style resolution computed at compartment-map construction time and
never materialised on disk.

The resolution shape mirrors Go's `go.mod`.
In Go's Minimal Version Selection (MVS), each module's `go.mod`
declares the minimum version of each direct dependency it builds
against, and the build picks the greatest of those minimums across
the whole transitive graph.
The design adapts the same shape to npm's `package.json`:

- The entry package's `package.json` lists *direct* dependencies as
  it does today (the `dependencies`, `peerDependencies`, and
  `optionalDependencies` fields).
  No transitive declarations.
  See *peer and optional policy* below for how `peerDependencies` and
  `optionalDependencies` are treated.
- The resolver bootstraps by reading the entry package's
  `package.json` directly from the entry mount (since no module-store
  row exists for the entry package itself); this is the entry-side
  hook described in `endor-run-expanded.md` § Form 3 § Step 1.
- For each direct dependency, the resolver fetches the package's own
  `package.json` from the module store (or from the registry the
  first time, see *ingestion failures* below for the on-miss path)
  and reads its direct dependencies.
- The full transitive set is computed by walking this graph from
  the entry package's direct dependencies down, fetching each newly
  reached package's `package.json` once.
- Within each `(name, major)` group, the resolver picks the
  *highest minimum across the transitive set*: for each
  `(name, major)`, it scans every range any transitive dependency
  declares against that name and major, computes each range's
  minimum, and selects the greatest of those minimums.
  This is Go's MVS rule restated in npm terms, per
  [endor-npm-registry-proxy](endor-npm-registry-proxy.md)
  § Minimal Version Selection.
- **Re-walk to a fixed point.** After selecting a version for each
  `(name, major)` group, the resolver re-walks the dependency graph
  with the *selected* versions and repeats the two steps above,
  repeating until the selection stabilizes (typically 1-2
  iterations). This is step 4 ("Resolve transitively") of the
  reused algorithm in `endor-npm-registry-proxy.md` § Version
  resolution, and it is load-bearing: bumping a `(name, major)` to a
  higher minimum can pull in transitive edges that a lower candidate
  version's `package.json` never declared, so a single downward pass
  would omit modules the actually-selected version requires. The
  earlier bullets describe one pass; this bullet is the convergence
  the algorithm's correctness depends on.
- **A group with no satisfying version fails closed.** The greatest
  minimum a `(name, major)` group selects must also satisfy every
  range declared against that group; if a dependent pins an upper
  bound below that minimum, so that no single version satisfies all
  declared ranges for the group, the resolver fails closed at
  compartment-map construction time, the same disposition the peer
  policy takes for an unprovided peer (below), raising the
  `IngestionError`-family structured error (`@endo/errors`) naming
  the conflicting `(name, major)` and the incompatible ranges,
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
So that the drift is at least *observable* rather than silent, every
`endor run` logs the resolved `(name, version)` set (the same set
`endor lock` would freeze) to the daemon's run log before spawning
the worker. An operator (or a host comparing successive runs) can
diff the logged set between two runs of the same entry point to see
exactly which transitive selection changed, without having adopted a
lockfile. The default stays "no lockfile, resolution computed each
run"; the log makes the accepted non-determinism auditable when it
fires rather than leaving it undetectable.
A future revision may promote `endor lock` to the default once the
command lands and the operational ergonomics are clear.

**Peer and optional policy.**
`peerDependencies` are treated as direct dependencies of the entry
package: the entry's `package.json` is expected to provide each
peer (declared in its own `dependencies` or `peerDependencies`),
and the resolver fails closed at compartment-map construction
time if a peer is unprovided.
This matches how `peerDependencies` are operationally satisfied in
npm's `node_modules` (the consumer carries the dep) without
inheriting npm's silent-deduplication semantics.
`optionalDependencies` are best-effort: the resolver tries to walk
them but does not fail if the package is unavailable; the
compartment whose require would have resolved into the optional
package instead resolves to a missing-module exit, and the
application receives a runtime error at first use.

**Ingestion failures.**
When `endor run` fetches a package the registry refuses (404, 5xx,
or a checksum mismatch against the registry's manifest), the
resolver raises an `IngestionError` (the existing structured-error
shape from `@endo/errors` per the project's error-handling
convention).
Partial CAS writes from a failed extraction are rolled back: the
CAS is content-addressed and a partial blob has no row in the
registry table, so a re-run sees a clean state.
The registry table does not record failed attempts; a subsequent
`endor run` retries from scratch.
A persistent ingestion failure that blocks resolution surfaces as
the compartment-map build aborting before the worker starts, with
`IngestionError` carrying the offending `(name, version)` pair and
the registry's response.

All three resolver failure paths belong to one family: an unprovided
peer, a `(name, major)` group with no version satisfying all declared
ranges, and a refused ingestion each raise an `@endo/errors`-shaped
structured error at compartment-map construction time. The one
deferred failure is an *optional* dependency that was unavailable:
that surfaces as a runtime missing-module error at first use rather
than a build-time error, and it too is `@endo/errors`-shaped when it
fires.

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
newer patch no package mentioned). If selecting `shared@2.4.0` reveals
that `shared@2.4.0`'s own `package.json` newly declares `tiny: ^1.0.0`
(a dependency `shared@2.1.0` did not have), the re-walk step picks
`tiny` up on the next pass and the selection then stabilizes. Had
`dep-b` instead declared `shared: ">=2.4.0 <2.5.0"` while `dep-a`
declared `shared: "~2.6.0"`, no single version would satisfy both
ranges and the resolver would fail closed on the `(shared, 2)` group.

#### Ad-hoc compartment maps

With direct dependencies declared and transitive resolution
computed, `endor run` builds a `CompartmentMapDescriptor` in
memory:

- One compartment per resolved `(name, version)` pair.
- The entry compartment's `modules` map points at the entry-point
  module's CAS hash.
- Each compartment's `modules` map is populated by walking the
  package's tree in the CAS and recording the hash for each
  `.js`/`.mjs`/`.cjs`/`.json` file.
- Inter-compartment edges follow the resolved version selection:
  a dependency on `lodash` in the entry compartment becomes an
  edge to the specific compartment whose `(name, version)` is the
  resolution result.

This is the case-1 generalisation of `endor-run-expanded.md`'s
Form 3.
The compartment map is never written to disk in the confined case;
it lives in the XS host's memory for the duration of the run.
The CAS-backed module loading path (`endor-run-expanded.md` §
CAS-backed module loading) already accepts in-memory compartment
maps, so no new wire format is needed.

### Sub-case: prebuilt compartment-map.json

When the entry-point hint points at a `compartment-map.json`, the
machinery above is bypassed: the host reads the manifest from the
mount, the module-source bytes from CAS or from the mount's blobs,
and constructs the in-memory compartment map directly from the
manifest.
This is the existing `endor run <archive>` and `endor run
<directory>` path generalised to read from a mount instead of from
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
  build time with an offline-resolution error naming the first
  unresolvable `(name, version)`.
  Verifies: the failure shape under § Offline mode; that the
  worker is never spawned when resolution fails.
- **Ingestion failure rollback.** Given a registry that returns 5xx
  for one transitive dep, `endor run` raises `IngestionError`,
  leaves no partial registry-table row, and a subsequent run
  against the same entry (with the registry recovered) succeeds.
  Verifies: the rollback story under § Ingestion failures.
- **Prebuilt-compartment-map sub-case parity.** Given a Mount whose
  entry-point hint is a `compartment-map.json`, `endor run`
  bypasses ingestion and resolution and constructs the in-memory
  compartment map directly.
  Verifies: the sub-case branch in `### Sub-case: prebuilt
  compartment-map.json`.
- **Worker confinement.** A test application that calls into a
  mount's `lookup` for a path outside the mount root, or attempts
  ambient host-fs access, receives an authorization failure (not a
  silent fallthrough to the daemon's host fs).
  Verifies: the cap-std parametrisation seam under § Shape.

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
against a materialised tree.

### Shape

The host has an application bound to one or more `Mount`s.
The application needs Node.js APIs that XS cannot satisfy (native
modules, the full `node:*` surface, a binary the package's
`postinstall` ran), so confined execution under `endor` is not
viable.
The *supervisor* here is the daemon-side component that owns the
child process's lifecycle: the same `make-unconfined` worker manager
`daemon-endo-rust-sqlite.md` already uses to spawn and relay for
unconfined workers. It is the daemon (Case 2 has no `endor`-hosted XS
worker to supervise); it spawns the `node` child, relays its fds, and
records its exit. The host instead:

1. Allocates a scratch mount (`provideScratchMount`).
2. Ejects each input mount into a subdirectory of the scratch
   mount.
   Ejection is the dual of `endo checkin`: it walks the
   `MountInterface` and writes each blob and tree to the scratch
   directory's real filesystem path.
3. Spawns `node` (or the bundled Node binary from
   `familiar-electron-shell.md` § Resource paths) with the
   ejected directory as its cwd and the entry-point module as
   its argv.
   The child process is a regular `make-unconfined` worker per
   `daemon-endo-rust-sqlite.md`'s spawn pattern; it speaks CBOR
   envelopes back to the supervisor on fds 3 and 4.
4. Runs the application to completion under Node's native
   module resolution.
   The supervisor relays stdout, stderr, and the worker's CBOR
   envelopes; on exit, the supervisor records the worker's exit
   code and surfaces it to the formula owner.
5. The daemon's existing scratch GC reclaims the scratch mount
   when the worker exits or the formula is unpinned.

The host-eject path uses `node`'s native resolver to load the
application: the ejected directory is a normal Node.js source tree
with `node_modules` inside it (ejected from a sub-mount that is
itself the cached output of an earlier `npm install`, or
re-materialised from the CAS-backed module store on demand).

This case is intentionally smaller in scope than Case 1.
The compartment-mapper machinery is not exercised; the application
runs under Node's native module resolution.
The confinement against the host filesystem comes entirely from
the scratch directory's containment plus whatever the supervisor
chooses to bind-mount or chroot around it; this design does not
extend the confinement model and defers that to the POSIX-sandbox
follow-up (below).

### Re-eject discipline

If the host re-runs the same application without the input mounts
having changed, the scratch directory can be re-used rather than
re-ejected. The scratch directory is named by the source mount's
content hash, so the reuse check is hash-to-hash: ejection is a no-op
when a scratch directory named for the current source-mount content
hash already exists. Mount formulas compute their current content
hash; git filesystems can use their current tree hash directly. This
matches the spirit of `daemon-cas-management.md`'s deduplication.

Reuse is gated on the *destination staying pristine*, not only on the
source hash matching. Case 2 hands the ejected directory to an
unconfined `node` process as a writable cwd (`§ Shape` step 3), so
that process can dirty the directory (a build cache, a config file, a
mutated `node_modules` entry). A directory a prior run wrote into no
longer equals a fresh ejection of the same source hash, so reusing it
would silently break run-to-run isolation. The discipline is
therefore: a scratch directory the child was allowed to write into is
**single-use**; it is marked dirty when the child starts and is
discarded (not reused) at GC, so a later run against the same
unchanged source mount ejects fresh rather than inheriting the prior
run's mutations. Only a scratch directory that was never handed to a
writer (or was mounted read-only for the child) is eligible for the
no-op reuse above.

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
  mounts whose content hash is unchanged, where the prior run did not
  write into the scratch directory, reuses the existing scratch
  directory and performs no re-eject.
  Verifies: the hash-to-hash reuse gate under § Re-eject discipline.
- **Dirtied scratch is not reused.** A run whose child writes into its
  cwd marks the scratch directory single-use; a subsequent run against
  the same unchanged source mount ejects fresh rather than inheriting
  the prior run's mutations.
  Verifies: the destination-mutation gate under § Re-eject discipline.
- **Non-zero exit-code propagation.** A child that exits non-zero
  causes the supervisor to record and surface that exact exit code to
  the formula owner.
  Verifies: the exit-code relay under § Shape step 4.
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
  virtualized") is the same sqlite the Rust side already opens
  via `daemon-endo-rust-sqlite.md`.
  The schema is shared.
- The Go-style resolver in Case 1 reuses the algorithm
  [endor-npm-registry-proxy](endor-npm-registry-proxy.md) § Minimal
  Version Selection specifies for the Rust side, including its
  transitive re-walk to a fixed point (§ Resolution: Go-mod-shaped,
  "Re-walk to a fixed point"), so the two sides converge on the same
  selection rather than diverging on a dropped step.

Divergence:

- Case 2 (host-eject) has no equivalent in the Rust design.
  `endor` does not shell out to `node`; the Rust supervisor either
  hosts an XS machine or fails.
  Host-eject is a Node.js-host concession; the Familiar and the
  Node-side daemon are deployed in places where Node.js is the
  only viable runtime for the unconfined leaf.
- Case 1's compartment-map construction lives in JS (using the
  existing `@endo/compartment-mapper`); the Rust side has its own
  archive loader.
  These can converge later once `endor`'s Form-3 reaches feature
  parity with the JS mapper.

## Alternatives considered

1. **Continue requiring `node_modules` on disk for all unconfined
   runs.** Rejected: defeats the case-1 confinement story and
   forces every Familiar deployment to ship or build a real
   `node_modules` tree.
2. **Materialise a `node_modules` tree from the CAS lazily into a
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
Case 2 (host-eject) lands second, gated on a per-formula opt-in
(`type: 'host-node-app'` or similar) so the maintainer can audit
each application that elects host-Node execution.
The POSIX-sandbox follow-up retires Case 2's ad-hoc confinement
once the sandbox is available on the deployment target.

**One entry point, explicit dispatch.** `endor run` remains the sole
caller-facing verb for both cases; a caller never picks a case by
reaching for a different command. `endor run` dispatches on the
formula's `type`: a default formula runs the confined Case 1 path,
and a formula carrying the `host-node-app` opt-in runs the Case 2
host-eject path. Because the opt-in is an explicit, maintainer-audited
per-formula flag (not something `endor run` infers from the
application's contents), `endor run` against an application that needs
Node APIs but lacks the opt-in fails closed with an error naming the
`host-node-app` opt-in as the required next step, rather than silently
falling back to host-eject. The two cases are thus reachable from the
one entry point a caller starts at, and the path between them is a
named flag, not a second command.

**Cross-major-version semantics.** Case 1 and Case 2 both host
multiple major versions of the same package in distinct
compartments. Moving an application between paths therefore does
not change its dependency semantics.

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
3. **Case 2 preserves multi-major semantics.** As in Case 1, an
   application may host multiple major versions of a package in
   distinct compartments.
4. **MVS dependency policy is confirmed.** `peerDependencies` are
   direct dependencies that the entry package must provide, failing
   closed while building the compartment map. `optionalDependencies`
   are best effort: an unavailable optional module exits as missing,
   and use fails at runtime. `endor-npm-registry-proxy.md` § Known
   gaps records the underlying ambiguity.
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
| [daemon-endo-rust-sqlite](daemon-endo-rust-sqlite.md) | Provides the sqlite host power and the spawn pattern Case 2 borrows |
| [daemon-endor-architecture](daemon-endor-architecture.md) | Case 1's confined worker is a regular `endor` worker |
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
