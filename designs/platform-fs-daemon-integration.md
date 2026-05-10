# Daemon Integration for `@endo/platform/fs/node`

| | |
|---|---|
| **Created** | 2026-05-07 |
| **Updated** | 2026-05-10 |
| **Author** | Kris Kowal (prompted) |
| **Status** | Modes 1, 2, 3 implemented in PR 122; follow-ups noted below |

## What is the Problem Being Solved?

`@endo/platform/fs/node` (introduced as Phase 4 of [`platform-fs.md`](platform-fs.md))
ships two new mutable lower-level primitives:

- `makeFile(path)`: text / json / streamBase64 / append / readOnly / snapshot.
- `makeDirectory(path)`: has / list / lookup / write / remove / move / copy /
  makeDirectory / readOnly / snapshot.

These primitives complement (and are **strictly less safe** than) the daemon's
existing `Mount` (yielding an `EndoMountDirectory` exo) from
[`daemon-mount.md`](daemon-mount.md): they accept any absolute path and apply
no symlink-escape clamping, no `..` clamping, and no formula identity. They
are the building blocks the `EndoMountDirectory` exo composes; on their own
they are ambient-authority objects fit only for the host process or for
trusted tooling.

The integration question is therefore narrow but load-bearing: **how does an
agent (a guest, a worker, a caplet, a chat-side bot) obtain a confined
`Directory` or `File` object backed by this new platform module, without
gaining ambient filesystem authority?**

The answer is _not_ "expose `makeFile` / `makeDirectory` over CapTP." That
hands the agent a path string and lets it open anything the daemon process
can open. The answer is to keep the unsafe constructors on the host side of
the membrane and ensure that **every reference an agent ever sees is already
clamped to a confined subtree** by the time it crosses.

## Goals and Scope

`@endo/platform` exists to be the layer the daemon stands on.
Its job is to expose the host's ambient capabilities (filesystem, network,
clock, process) in a shape the daemon can wrap, attenuate, and hand out as
confined exos.
This integration plan is therefore a daemon-side concern: it specifies how
`@endo/daemon` consumes `@endo/platform/fs/node` to produce agent-visible
`Mount` exos, and it does **not** add agent-visible APIs to `@endo/platform`
itself.

## Design

### Layer Cake

```
Agent (guest / worker / caplet / chat bot)
   ^   only ever sees: {File, Directory, ReadOnlyDirectory} exos
   ^   confined by construction
--- daemon-side membrane ---------------------------------
EndoMountDirectory exo  (daemon/src/mount.js)
   - holds confined root path
   - applies path clamping, cap-std-style symlink confinement
   - normalizes ACL-class OS errors to a generic confinement error
   - composes makeDirectory / makeFile under the hood
   ^
Platform primitives  (@endo/platform/fs/node)
   - makeFile(absolutePath)        <- ambient authority
   - makeDirectory(absolutePath)   <- ambient authority
   ^
node:fs
```

The `EndoMountDirectory` exo is the only object that holds an
unclamped `makeDirectory` reference.
Everything an agent sees is either an `EndoMountDirectory` (a clamped
root) or a transient sub-exo derived from a lookup (clamped to a
subdirectory of the same root, with the same confinement rules
applied transitively).

### Mount Composes the Platform Primitives

`packages/daemon/src/mount.js` composes `makeDirectory(currentDir)`
from `@endo/platform/fs/node` once per `EndoMountDirectory` construction
and once per sub-directory lookup, and delegates the unconfined
filesystem work for `has`, `remove`, `removeTree`, `move`, `copy`,
`write`, and `makeDirectory` to that platform exo.
The `clampSegments` helper produces clamped relative segments so a
sub-mount handed to an agent cannot use `..` to traverse back toward
the original mount root.

`list` retains a bespoke implementation because the platform `list`
filters out symlinks unconditionally while the Mount surfaces
internal-pointing symlinks (the symlink-confinement assertion catches
escapes at use time).
`readText`, `writeText`, and `maybeReadText` continue to use
`filePowers` directly, since the platform `Directory` surface does
not expose path-relative text I/O.
`lookup` retains its bespoke transient sub-exo construction; the
clamping policy is local to the Mount layer.

### Three Integration Modes

The integration plan covers three distinct ways an agent comes to hold a
`Directory` / `File` reference.

#### 1. Mount delegates to the platform primitives

`EndoMountDirectory` keeps the **confinement policy** (path clamping,
cap-std-style symlink confinement, ACL-error normalization, `readOnly`
attenuation) in `mount.js` and delegates the **unconfined** filesystem
work to a `makeDirectory(rootPath)` instance from
`@endo/platform/fs/node`.
Agent-visible behaviour is unchanged from the prior all-`node:fs`
implementation; the duplication between `mount.js` and `platform/fs-node`
is gone.

#### 2. Expose a mount-directory as a confined `Directory` to a worker

A worker that wants to use `@endo/platform/fs/node`-shaped APIs (e.g., a
caplet authored against `import { Directory } from '@endo/platform/fs/lite/types'`)
is handed an `EndoMountDirectory` directly: the exo's interface guard is
`DirectoryInterface`, identical to the platform's `makeDirectory` exo.
The agent imports the type (a structural contract), the daemon hands
it an instance (a confined implementation).
This requires:

- A shared interface guard, exported from
  `@endo/platform/fs/lite/interfaces.js`, that both
  `EndoMountDirectory` and the platform `makeDirectory` exo
  implement.
- A worker-side surface that accepts any object satisfying the guard and
  doesn't try to `import { makeDirectory } from '@endo/platform/fs/node'`
  directly (which would fail in a confined worker realm anyway).

#### 3. Pet-store-named directory caps

Agents that are confined-but-host-adjacent (chat bots, the Familiar) need a
named handle to a confined directory: `endo provide-mount ~/projects/foo
foo-mount`. The pet-store entry `foo-mount` resolves to the
`EndoMountDirectory` exo at the mount root.
The agent then `provideMount('foo-mount')` from its host or guest
reference and holds a `Directory`-shaped capability.

This is enabled by `provideMount` on `HostInterface` (see
`packages/daemon/src/host.js:253`).
The integration plan therefore:

- Documents that `EndoMountDirectory` is the agent-visible name for a
  `Directory`-shaped capability whose root is a real filesystem
  subtree.
- Adds a `Directory` type alias importable as
  `@endo/platform/fs/lite/types` (the package convention is JSDoc
  typedefs in `.js`; see `packages/platform/src/fs/types.js`) that
  agents can import without dragging in `node:fs`.

### Shared Interface Guards

`FileInterface`, `DirectoryInterface`, `ReadableBlobInterface`, and
their siblings live in `packages/platform/src/fs/interfaces.js` and
are exported as `@endo/platform/fs/lite/interfaces`.
The `@endo/platform` layer holds the canonical guards; daemon-side
wrappers (notably `EndoMountDirectory`) implement `DirectoryInterface`
directly and expose no extra methods that would prevent a worker or
caplet from accepting them as a `Directory`.

### `EndoMountDirectory` as a `Directory`

`EndoMountDirectory` is implemented as an exo whose interface guard is
`DirectoryInterface` from `@endo/platform/fs/lite/interfaces`,
identical to the platform `makeDirectory` exo.
It accepts only the strict array-of-segments path convention; the
convenience methods (`readText`, `writeText`, `maybeReadText`, `help`)
live on a separate side-channel exo and are out of the `Directory`
surface.

The naming `EndoMountDirectory` reflects that it is one kind of
directory among several (alongside the read-only `ReadableTree`, the
in-memory directory, and the platform's `makeDirectory` exo); a
`Mount` (the lifecycle concept tied to a pet-store entry) yields an
`EndoMountDirectory` at its root.

### Symlink Confinement at the Mount Layer

`@endo/platform/fs/node`'s `makeDirectory` is an ambient-authority
attenuator: it accepts any absolute path and does not clamp symlinks.
The `EndoMountDirectory` wrapper enforces the confinement and is the
only directory-shaped exo an agent ever holds.
Confinement rules (modeled after Rust `cap-std`):

- **Listing.** `list()` filters out absolute-target symlinks,
  relative-target symlinks that exit the mount, and broken
  symlinks; they are invisible.
- **Read.** `lookup()`, `has()`, `readText()`, and `maybeReadText()`
  deny access to the same set of symlinks; even direct lookup by
  name fails as if the entry did not exist (or with a generic
  confinement error for `lookup`).
- **Overwrite.** `write()`, `writeText()`, `move()` (target side),
  `copy()` (target side), and `makeDirectory()` may replace such
  a symlink with new content; the symlink ceases to exist after
  the write, and the new entry is a regular file or directory
  inside the mount.
- **Errors.** When the underlying OS rejects an overwrite with an
  ACL error (`EACCES`, `EPERM`, `EROFS`, immutable-bit, etc.),
  the Mount layer surfaces a generic confinement error rather
  than the OS-specific code; specific filesystem structure
  ("immutable file at /etc/hostname") would betray host detail
  that an agent has no business observing.

The platform `makeDirectory` exo applies none of these rules; its
callers are trusted host-side code that benefits from the precise OS
error.
The Mount wrapper substitutes a generic error before the confinement
boundary.

### `remove` and `removeTree` are Distinct Capabilities

`DirectoryInterface` exposes `remove` (single entry, fails on a
non-empty directory) and `removeTree` (recursive subtree) as separate
methods.
A holder of `remove` has strictly less authority than a holder of
`removeTree`; attenuators can withhold `removeTree` while exposing
`remove`.
The split applies symmetrically to the platform `DirectoryInterface`
and to `EndoMountDirectoryInterface`; both exos expose both methods.

### Dual "From Path" and "From Directory" Forms

Both forms are exposed in parallel for mount creation and for
`makeDirectory`.
Today on `node:fs` the two forms are functionally equivalent;
tomorrow on Rust `cap-std` (where the host can hold an inode handle)
the directory-handle form gains race-free, more-ocap-correct
semantics.

The dual surfaces:

- **Mount creation.**
  - `provideMount(absolutePath, petName, { readOnly })`: from
    path. Convenient for agents holding a host-side absolute path
    string.
  - `provideMount(parentMount, relativePath, petName, { readOnly })`:
    from mount; new sub-mount overload to be added in a follow-up
    PR. Composes naturally with `Mount.lookup()` confinement and
    lets a holder of a parent Mount mint a new pet-store entry for
    a sub-tree without ambient-authority leakage.
- **Directory creation within an existing Directory.**
  - `directory.makeDirectory(pathSegments)`: at relative path
    (multi-segment path arithmetic).
  - `directory.makeDirectoryHere(name)`: in directory (single
    name, operates on the receiver's inode handle). Both
    `DirectoryInterface` (platform) and `MountDirectoryInterface`
    (daemon) expose it.

The single-name `makeDirectoryHere` and the path-segment
`makeDirectory` are functionally equivalent on the current `node:fs`
backend.
The distinction is that `makeDirectoryHere` names a strictly-narrower
authority: it binds to the receiver's identity and admits no
traversal, so a future cap-std host can implement it race-free using
the inode handle the receiver already holds.
Callers that have a Directory reference and want a specific sub-name
should prefer `makeDirectoryHere(name)`; callers composing a relative
path from segments stay with `makeDirectory(segments)`.

The mount-from-mount form (`provideMount(parentMount, relativePath,
...)`) is left for a follow-up PR; this design commits to its shape
so the API consumer can plan around it now.

### `Mount.lookup` Returns a Transient Sub-Exo

`EndoMountDirectory.lookup()` constructs a fresh sub-exo on each call.
Reference identity across calls is intentionally non-stable; the
construction is bespoke because confinement policy lives at the Mount
layer.
Agents should re-look up on demand and treat the returned reference as
transient.

### Lifecycle

| Phase | Owner | Notes |
|-------|-------|-------|
| Creation | Host (via `endo mount` / `endo mktmp`, or programmatic `provideMount`) | Returns a `Mount` formula identifier; the underlying `makeDirectory(absolutePath)` is invoked once, on the daemon side. |
| Lookup | Agent (via pet name) | The daemon resolves the pet name to the `Mount` formula and returns the exo reference. |
| Sub-lookup | Agent (via `directory.lookup('subdir')`) | Returns a transient sub-exo. Not a new formula, not a new pet-store entry. |
| Snapshot | Agent (via `directory.snapshot()`) | Stages content into a content-addressed `readable-tree` formula (see `daemon-mount.md` Phase 4). |
| Revocation | Host (via `endo remove foo-mount`) | The pet-store entry is dropped; outstanding exo references continue to work until GC because the formula is still reachable via outstanding refs. |
| Garbage collection | Daemon | When the formula is unreachable from any pet store and any outstanding ref, the formula and (for `scratch-mount`) its backing directory are deleted. |

The CLI verb is `endo mktmp` for familiarity with the POSIX `mktemp` convention.
The noun for the resulting temporary space inside the daemon's store is
"scratch" (as in `scratch-mount` and `provideScratchMount`).
The verb names the user-facing action; the noun names the persistent thing it
creates.

### Capability Surface Summary

The Daemon exposes:

- `provideMount(absolutePath, petName, { readOnly })` on `HostInterface`:
  see `packages/daemon/src/interfaces.js:319`.
- `provideScratchMount(petName, { readOnly })` on `HostInterface`:
  see `packages/daemon/src/interfaces.js:323`.

The Agent never sees:

- `makeFile` / `makeDirectory` from `@endo/platform/fs/node`.
- An absolute path string.
- The `node:fs` module.

The Agent _does_ see:

- A `Directory`-shaped exo (the `EndoMountDirectory` exo, whose
  interface guard IS `DirectoryInterface` from
  `@endo/platform/fs/lite/interfaces`).
- A `File`-shaped exo (the transient file exo returned by
  `directory.lookup('some-file')`, satisfying the `File` interface guard).
- A `ReadOnlyDirectory`-shaped exo via `directory.readOnly()`.

## Open Questions

1. **Streaming back-pressure between platform-fs primitives and
   daemon workers.** The `streamBase64()` returned by `makeFile` is
   an async iterable; the daemon's `EndoReadable` adapter wraps it.
   Today the wrap is straightforward, but a worker-side caplet that
   holds a `File` reference and reads it across CapTP needs the
   back-pressure protocol from `@endo/platform/fs/lite/reader-ref` to
   apply end-to-end.
   The Mode 2 facet does not exercise the streaming case end-to-end;
   confirmation needed before a worker is handed a `File`-shaped
   capability and asked to stream large content.
   The long-term direction is to refactor the streaming surface to use
   a future `@endo/exo-stream` package once it lands (paralleling the
   `@endo/exo-playwright` pattern that wraps an underlying capability
   behind an Exo); see [comment 3204494183][].
   This question therefore resolves to "defer to `@endo/exo-stream`
   when ready"; the straightforward wrap ships now and the refactor
   is tracked as a follow-up keyed off that package's arrival.

[comment 3204494183]: https://github.com/endojs/endo-but-for-bots/pull/122#discussion_r3204494183

2. **Reuse of `directory.lookup()` for sub-exo construction.** The
   alternative (having `directory.lookup()` accept a clamping-policy
   hook so Mount can reuse it) would eliminate the remaining bespoke
   traversal code at the cost of widening the platform API.
   Defer until a second consumer of the policy hook appears.

3. **Cap-std-style overwrite-replaces-symlink semantics.** The
   confinement rules above say "Overwrite paths may replace such a
   symlink with new content; the symlink ceases to exist after the
   write."
   The current implementation handles the **read-side** confinement
   (invisible from `list`, denied from `lookup` / `has` / `readText`)
   and the **remove-side** confinement (`remove()` acts on the
   symlink entry itself, since `fs.rm` does not follow symlinks).
   The **overwrite-side** is partial: `writeText` and `write`
   currently call `fs.writeFile` which **follows** the symlink.
   For a broken symlink with an absolute target (e.g.
   `link -> /etc/secret`), this would create a regular file at the
   absolute target, escaping confinement.
   `assertConfinedOrAncestor` blocks this for already-resolvable
   escaping symlinks (where `realpath` returns the outside target),
   but does not catch broken absolute symlinks (where `realpath`
   throws and the walk-to-parent confines the symlink's parent
   inside the mount).
   The fix is to `lstat` the destination before writing, and if it
   is a symlink, `unlink` it first so the subsequent `writeFile`
   creates a regular file at the symlink's name.
   Out of scope for the current PR because it requires extending
   `FilePowers` with `lstat` (or moving Mount to `node:fs`
   directly).
   See also the test in `endo.test.js` that exercises the
   read-side and remove-side but not the overwrite-side.

4. **Closing the `MountFile` / `FileInterface` gap.** The MountFile
   exo returned by `EndoMountDirectory.lookup(filename)` exposes
   `text`, `streamBase64`, `json`, `writeText`, `writeBytes`, and
   `readOnly`: a strict subset of the platform `FileInterface`,
   missing `append` and `snapshot`.
   For Mode 2 to be complete, MountFile should either grow these
   methods (delegating to a platform `makeFile` instance with
   confinement-aware path) or be replaced by the platform `File` exo
   wrapped in a confinement-checking adapter.
   A worker-side caplet declaring
   `import { File } from '@endo/platform/fs/lite/types'`
   and accepting any conforming exo observes the gap as missing
   methods at call time.

## Alternatives Considered

### `Mount.asDirectory()` facet (deprecated)

An earlier shape exposed an `asDirectory()` facet on `Mount` that
adapted Mount's lenient `string|string[]` argument convention to the
strict array-only segments expected by the platform `Directory`
interface.
Rejected in favour of having `EndoMountDirectory` itself implement
`DirectoryInterface` directly: the facet was extra surface that
worked around a paper-cut in argument conventions, and the
straight-through implementation eliminates the paper-cut by adopting
the strict convention everywhere.

### `EndoMount` exo name (deprecated)

The exo was originally named `EndoMount`; renamed to
`EndoMountDirectory` because it is one kind of directory among
several (alongside the read-only `ReadableTree`, the in-memory
directory, and the platform's `makeDirectory` exo).
The shorter name conflated the lifecycle concept (a `Mount` tied to a
pet-store entry) with the directory exo it yields at its root.

### Single `remove(path, { recursive })` method (deprecated)

The earlier shape collapsed entry removal and recursive subtree
removal into a single method shaped by an option bag.
Rejected because it conflated two distinct authorities under one
method, made the easy-to-overlook `{ recursive: true }` argument
silently destructive, and prevented attenuators from withholding
recursive removal while preserving single-entry removal.
Split into `remove` and `removeTree`.

### `@endo/daemon` owning the Exo interfaces (deprecated)

An alternative placed `FileInterface`, `DirectoryInterface`, and
friends in `@endo/daemon` rather than `@endo/platform`, treating
`@endo/platform` as capability-only.
Rejected because the daemon could then not declare its mount-backed
directory to a worker as a `Directory` without the worker also
depending on `@endo/daemon`, which defeats Mode 2.
The canonical guards therefore live in `@endo/platform`.

### `resolveSegments` returning absolute paths (deprecated)

The prior `resolveSegments` helper produced absolute paths and
clamped at `confinementRoot`.
Replaced by `clampSegments`, which produces clamped relative
segments.
The change is a confinement strengthening for sub-mounts: a sub-mount
handed to an agent can no longer use `..` to traverse back toward the
original mount root.

### `fs/lite/types.d.ts` rather than JSDoc-in-`.js` (deprecated)

The original design copy referred to `fs/lite/types.d.ts`.
The package convention is JSDoc typedefs in `.js` plus an export
entry in `package.json`; the design follows the convention and the
type alias is exported as `@endo/platform/fs/lite/types` resolving to
`packages/platform/src/fs/types.js`.

### Single-form mount creation and `makeDirectory` (deprecated)

An earlier shape exposed only one form of each: `provideMount` from
absolute path, and `directory.makeDirectory(pathSegments)` from
multi-segment relative path.
Both forms are now exposed in parallel ([comment 3212520373][]):
the path form is convenient on `node:fs`, and the directory-handle
form (`provideMount(parentMount, relativePath, ...)` and
`makeDirectoryHere(name)`) gains race-free, more-ocap-correct
semantics on a future Rust `cap-std` host.

[comment 3212520373]: https://github.com/endojs/endo-but-for-bots/pull/122#discussion_r3212520373

### Surfacing the OS-specific ACL error (deprecated)

An earlier draft considered surfacing the underlying OS error code
(`EACCES`, `EPERM`, `EROFS`, immutable-bit) directly to the agent.
Rejected because the OS-specific failure detail betrays host structure
("immutable file at `/etc/hostname`") that an agent has no business
observing.
The Mount layer normalizes ACL-class errors to a generic confinement
error before the boundary; the platform `makeDirectory` exo is
unchanged for trusted host-side callers.
See [comment 3205540627][].

[comment 3205540627]: https://github.com/endojs/endo-but-for-bots/pull/122#discussion_r3205540627

## Out of Scope

- Browser / non-Node hosts. The `"browser"` and `"endo-go"` /
  `"endo-rust"` conditions in `@endo/platform/fs` package exports are
  reserved for future work and do not affect the daemon-side
  integration plan.
- Sub-mount Phase 4 of `daemon-mount.md` itself. That phase is tracked
  in its own document; this design assumes Phase 4 either lands first
  or arrives as a sibling design that this document references.
- A "lookup formula" mechanism that would derive a new
  pet-name-bearing formula from an arbitrary `Directory` reference
  (analogous to how `link(namePath, resultName)` would let a holder
  of a value mint a named formula for it).
  Without such a mechanism there is no way to symbolically retain a
  reference to a specific transient sub-directory across sessions.
  This is a known gap and warrants a future companion design
  (paralleling the `link(namePath, resultName)` follow-on noted on
  the workers-panel PR thread); it is not in scope here.
