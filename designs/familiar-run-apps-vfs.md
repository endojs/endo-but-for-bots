# Familiar / Host Run Applications over a VFS

| | |
|---|---|
| **Created** | 2026-05-13 |
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
Within case 1, the design's main subject is the fully virtualized
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

## Glossary

We reuse vocabulary from existing designs rather than coining new
terms.
**Filesystem mount interface**: the `MountInterface` defined by
[daemon-mount](daemon-mount.md) (has / list / lookup / write / remove
/ move / makeDirectory / readOnly / snapshot).
**Readable tree**: the immutable, content-addressed snapshot of a
directory tree per [daemon-checkin-checkout](daemon-checkin-checkout.md);
the shape a `MountInterface.snapshot()` produces.
**Mount**: a capability whose backing is a physical directory subtree
(per `daemon-mount.md`) or any other source that satisfies the
`MountInterface` guard (a `readable-tree`, a sqlite-backed view, an
in-memory tree).
**Scratch space**: the daemon-managed backing storage produced by
`provideScratchMount` (`daemon-mount.md` § Scratch Mount).
A scratch mount is the case-2 destination.
**Compartment map**: a `CompartmentMapDescriptor` per
`@endo/compartment-mapper`'s `types/compartment-map-schema.ts`; the
graph of compartments, modules, and exit-module entries that
`endor run` consumes today via `compartment-map.json`.
**Ejection**: producing a host-filesystem layout from a mount such
that an external program (in case 2, `node`) can read it directly.
The dual of `endo checkin`.

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
back this; in the confined case `cap-std` is parametrised by the
mount-resolved host paths rather than the daemon's ambient
host-paths power.

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
already records `(name, version) → CAS tree hash`; this design
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
With a CAS-backed module store we can replace both with a Go-style
resolution computed at compartment-map construction time and never
materialised on disk.

The resolution shape mirrors Go's `go.mod`:

- The entry package's `package.json` lists *direct* dependencies as
  it does today (the `dependencies` and `peerDependencies` fields).
  No transitive declarations.
- For each direct dependency, the resolver fetches the package's own
  `package.json` from the module store (or from the registry the
  first time) and reads its direct dependencies.
- The full transitive set is computed by walking this graph from
  the entry package's direct dependencies down.
- Within each `(name, major)` group, the resolver picks the
  *greatest explicitly mentioned minor.patch* per
  `endor-npm-registry-proxy.md` § Minimal Version Selection.
  This is the Go-mod selection rule.
  No lockfile is required: the resolution is a deterministic
  function of the entry package's direct deps plus the registry
  table's contents at resolution time.

The optional follow-up to a lockfile is an `endor lock` command
(see `endor-npm-registry-proxy.md` § Design decision 5) that
snapshots the resolved `(name, version)` set into a file the host
can carry between runs for reproducibility.
The default mode for case 1 is "no lockfile, resolution computed at
each `endor run`."

This design names a possible new manifest shape, `endo.mod`, as
the Go-mod analogue.
The maintainer should decide whether to introduce a new manifest or
to extend `compartment-map.json` itself with the dependency-intent
data; either choice is consistent with the rest of this design.
Open question 1 (below) covers this.

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
Its `MountHandle` set is GC-pinned by the formula that incarnates
it, so a daemon restart can re-create the same confinement.
Mount writes the worker performs land in the backing store of the
underlying mount (a `mount` formula writes through to the host
directory; a `scratch-mount` formula writes to the daemon's state
dir; a CAS-backed read-only mount throws on write).

## Case 2: host-eject to Node.js

### Shape

The host has an application bound to one or more `Mount`s.
The application needs Node.js APIs that XS cannot satisfy (native
modules, the full `node:*` surface, a binary the package's
`postinstall` ran), so confined execution under `endor` is not
viable.
The host instead:

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
4. When the worker exits or the formula is unpinned, the scratch
   mount is reclaimed by the daemon's existing scratch GC.

The host-eject path uses `node`'s native resolver to load the
application: the ejected directory is a normal Node.js source tree
with `node_modules` inside it (ejected from a sub-mount that is
itself the cached output of an earlier `npm install`, or
re-materialised from the CAS-backed module store on demand).

This case is intentionally smaller in scope than case 1.
The compartment-mapper machinery is not exercised; the application
runs under Node's native module resolution.
The confinement against the host filesystem comes entirely from
the scratch directory's containment plus whatever the supervisor
chooses to bind-mount or chroot around it; this design does not
extend the confinement model and defers that to the Posix-sandbox
follow-up (below).

### Re-eject discipline

If the host re-runs the same application without the input mounts
having changed, the scratch directory is re-used; ejection is a
no-op when the destination's `realpath` already matches the input
mount's content hash.
Content equality is computed via the CAS where possible (mounts
backed by `readable-tree` already carry hashes) and via
recursive `stat` + `sha256` otherwise.
This matches the spirit of `daemon-cas-management.md`'s
deduplication.

## Endor cross-references

The Rust design described in `daemon-endor-architecture.md` and
`endor-run-expanded.md` is the case-1 substrate for this design.
The Node.js-side proposal here adapts the same vocabulary
(compartment maps, CAS, registry table, scratch mounts) for code
that runs inside the daemon's manager JS rather than inside Rust.

Alignment:

- The mount-backed import hook in case 1 is the JS-side mirror of
  `endor`'s CAS-backed module loading
  (`endor-run-expanded.md` § Form 3).
  Both read module bytes by hash; the difference is whether the
  hash comes from a mount lookup or directly from a CAS root.
- The sqlite-backed module store (case 1, sub-case "fully
  virtualized") is the same sqlite the Rust side already opens
  via `daemon-endo-rust-sqlite.md`.
  The schema is shared.
- The Go-style resolver in case 1 reuses the algorithm
  `endor-npm-registry-proxy.md` § Minimal Version Selection
  specifies for the Rust side.

Divergence:

- Case 2 (host-eject) has no equivalent in the Rust design.
  `endor` does not shell out to `node`; the Rust supervisor either
  hosts an XS machine or fails.
  Host-eject is a Node.js host concession that exists because
  the Familiar / the Node-side daemon are deployed in places where
  Node.js is the only viable runtime for the unconfined leaf.
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
   per-run scratch dir whose hash collisions across runs we would
   then have to manage.
3. **Use npm's existing maximal version selection (newest within
   range) instead of MVS.** Rejected: aggressive, brings in
   versions no package in the graph has tested against; conflicts
   with Endo's predictability bent.
4. **Author an explicit lockfile (`endor.lock`) and require it for
   every run.** Rejected for default: a lockfile is useful for
   reproducibility but adds operational burden for the
   ad-hoc-application case; offered as a follow-up command
   (`endor lock`) rather than a requirement.
5. **Run case 2 inside the Posix sandbox today (no scratch-mount
   eject step).** Rejected: gated on the Posix sandbox shipping
   on the host platform.
   Listed as the case-2 follow-up below.

## Recommended approach

Land case 1 first, including the sqlite-backed module store and
the Go-style resolver, behind the existing `endor run entry.js`
form-3 entry point.
This lets the daemon's manager JS, the CLI, and any guest with an
appropriate caplet run confined applications out of a mount set
today.
Case 2 (host-eject) lands second, gated on a per-formula opt-in
(`type: 'host-node-app'` or similar) so the maintainer can audit
each application that elects host-Node execution.
The Posix-sandbox follow-up retires case 2's ad-hoc confinement
once the sandbox is available on the deployment target.

## Open questions for the maintainer

1. **New manifest vs. extension of `compartment-map.json` for the
   Go-mod analogue.** Should we introduce an `endo.mod` (or
   similar) file that carries direct-dependency declarations and
   module versions, or extend `compartment-map.json` with a
   `dependencies` block?
   The former matches Go's separation between "intent"
   (`go.mod`) and "compiled output" (the resolved graph); the
   latter keeps a single artifact.
2. **Module-store sharing across daemons.** Should the
   sqlite-backed module store be per-daemon (the
   `{statePath}/registry.sqlite` shape from
   `endor-npm-registry-proxy.md`) or a system-wide cache shared
   across users?
   System-wide is friendlier to Familiar deployments but adds
   permission and migration questions.
3. **Cross-major-version compartment hosting.** The compartment
   map already supports multiple major versions of the same
   package in distinct compartments; should the host-eject case
   (case 2) accept the same multi-major shape, or should host-eject
   require a single-major resolution per package (Node's
   native-resolver constraint)?
4. **`peerDependencies` and `optionalDependencies` in MVS.**
   `endor-npm-registry-proxy.md` § Known gaps already flags these;
   the design should pick a policy before case-1 ships.
   Suggested: treat `peerDependencies` as direct-deps that must be
   provided by the entry package, `optionalDependencies` as
   best-effort and silent on failure.
5. **Eject equality.** Should re-eject equality (case 2) be
   computed by content hash only, or also by mount-formula
   identity?
   The latter is cheaper for `readable-tree`-backed mounts but
   may miss cases where two distinct readable-tree formulas
   happen to point at the same content.

## Follow-up gated on Posix sandbox

When [endo-posix-sandbox](endo-posix-sandbox.md) lands on the host
platform, guests can also run Node.js applications safely via the
case-2 eject-to-scratch path: the host's eject step is unchanged,
but the spawned `node` process runs inside a Posix-sandbox slice
whose only filesystem reach is the scratch directory plus any
mount caps the guest's caplet was authorized to pass through.
The network profile is the sandbox's `private` default
(`endo-posix-sandbox.md` § Network policy ladder).
This converts case 2 from a host-only privilege to a primitive
guests can request.
Detailed flow is out of scope for this design; the dependency
gate is named here so the case-2 ground truth does not bake in
the assumption that host-eject is a host-only path forever.

## Dependencies

| Design | Relationship |
|--------|--------------|
| [daemon-mount](daemon-mount.md) | Provides the `MountInterface` guard the case-1 import hook and the case-2 eject step both consume |
| [endor-run-expanded](endor-run-expanded.md) | Case 1 is the JS-side mirror of Form 3 |
| [endor-npm-registry-proxy](endor-npm-registry-proxy.md) | Provides the sqlite-backed module store and the MVS algorithm reused in case 1 |
| [daemon-cas-management](daemon-cas-management.md) | Provides the CAS that backs the module store |
| [daemon-endo-rust-sqlite](daemon-endo-rust-sqlite.md) | Provides the sqlite host power and the spawn pattern case 2 borrows |
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
> Posix sandbox is the follow-up that lets guests also use the
> eject path.
