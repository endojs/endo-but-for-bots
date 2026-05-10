# Daemon Integration for `@endo/platform/fs/node`

| | |
|---|---|
| **Created** | 2026-05-07 |
| **Updated** | 2026-05-08 |
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

### Three Integration Modes

The integration plan covers three distinct ways an agent comes to hold a
`Directory` / `File` reference:

#### 1. Replace the Mount-directory exo's internal helpers

Today, `packages/daemon/src/mount.js` implements `has` / `list` / `lookup` /
`write` / `remove` / `removeTree` / `move` / `makeDirectory` directly
against `node:fs`. With `@endo/platform/fs/node` shipped, the
`EndoMountDirectory` exo can delegate the **unconfined** filesystem
work to `makeDirectory(rootPath)` and keep only the **confinement
policy** (path clamping, cap-std-style symlink confinement,
ACL-error normalization, `readOnly` attenuation) in `mount.js`.
This is a pure refactor: agent-visible behaviour is unchanged, but
the duplication between `mount.js` and `platform/fs-node` disappears.

Open question: does `mount.js` retain its bespoke transient sub-exo
construction, or does it reuse `directory.lookup()` from
`@endo/platform/fs/node`? The latter requires `lookup` to accept a
clamping-policy hook; the former keeps the policy and the primitives
separate at the cost of some duplication.

#### 2. Expose a mount-directory as a confined `Directory` to a worker

A worker that wants to use `@endo/platform/fs/node`-shaped APIs (e.g., a
caplet authored against `import { Directory } from '@endo/platform/fs/lite/types'`)
can be handed an `EndoMountDirectory` directly: the exo's interface
guard is `DirectoryInterface`, identical to the platform's
`makeDirectory` exo.
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

This is already possible via `provideMount` on `HostInterface` (see
`packages/daemon/src/host.js:253`). The integration plan is therefore to:

- Document that `EndoMountDirectory` is the agent-visible name for a
  `Directory`-shaped capability whose root is a real filesystem
  subtree.
- Add a `Directory` type alias importable as
  `@endo/platform/fs/lite/types` (the package convention is JSDoc
  typedefs in `.js`; see `packages/platform/src/fs/types.js`) that
  agents can import without dragging in `node:fs`.

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
  already implemented, see `packages/daemon/src/interfaces.js:319`.
- `provideScratchMount(petName, { readOnly })` on `HostInterface`:
  already implemented, see `packages/daemon/src/interfaces.js:323`.

The Agent never sees:

- `makeFile` / `makeDirectory` from `@endo/platform/fs/node`.
- An absolute path string.
- The `node:fs` module.

The Agent _does_ see (post-integration):

- A `Directory`-shaped exo (the `EndoMountDirectory` exo, whose
  interface guard IS `DirectoryInterface` from
  `@endo/platform/fs/lite/interfaces`).
- A `File`-shaped exo (the transient file exo returned by
  `directory.lookup('some-file')`, satisfying the `File` interface guard).
- A `ReadOnlyDirectory`-shaped exo via `directory.readOnly()`.

## Decisions (answered by PR 122 implementation)

1. **Mount delegates to `@endo/platform/fs/node`.** Per PR 122,
   `mount.js` composes `makeDirectory(currentDir)` once per
   `EndoMountDirectory` construction and per sub-directory lookup,
   and delegates `has`, `remove`, `removeTree`, `move`, `copy`,
   `write`, and `makeDirectory` to that platform exo.
   `list` retains a bespoke implementation because the platform `list`
   filters out symlinks unconditionally while the Mount surfaces
   internal-pointing symlinks (the symlink-confinement assertion
   catches escapes at use time).
   `readText` / `writeText` / `maybeReadText` continue to use
   `filePowers` directly, since the platform `Directory` surface does
   not expose path-relative text I/O.
   `lookup` retains its bespoke transient sub-exo construction;
   reusing `directory.lookup()` would require either a clamping-policy
   hook on the platform side or a wrapper that re-clamps every
   returned exo, both out of scope for PR 122.

2. **Shared interface guards live in `@endo/platform/fs/lite/interfaces`.**
   PR 122 adds the package-export entry `./fs/lite/interfaces`
   resolving to `src/fs/interfaces.js`, the cross-realm-safe location
   for `FileInterface`, `DirectoryInterface`, `ReadableBlobInterface`,
   and friends.
   The `@endo/platform` layer keeps the canonical guards; daemon-side
   wrappers (notably `EndoMountDirectory`) implement
   `DirectoryInterface` directly and expose no extra methods that
   would prevent a worker or caplet from accepting them as a
   `Directory`.
   The originally-considered alternative (letting `@endo/daemon` own
   the Exo interfaces and treating `@endo/platform` as
   capability-only) was rejected because the daemon then could not
   declare its mount-backed directory to a worker as a `Directory`
   without the worker also depending on `@endo/daemon`, which defeats
   Mode 2.

3. **`Mount.lookup` returning a transient sub-exo is a documented
   caveat, not a memoization gap.** PR 122 changes nothing here.
   The bespoke construction is required for confinement; agents should
   re-look up on demand and treat reference identity across calls as
   non-stable.

4. **Mount-directory and platform-directory implement the same
   interface.** `EndoMountDirectory` (renamed from `EndoMount`) is
   implemented as an exo whose interface guard is
   `DirectoryInterface` from `@endo/platform/fs/lite/interfaces`,
   identical to the platform `makeDirectory` exo.
   The earlier `Mount.asDirectory()` facet (which adapted Mount's
   lenient `string|string[]` argument convention to the strict
   array-only segments expected by the platform interface) is
   removed.
   `EndoMountDirectory` accepts only the strict array-of-segments
   convention; convenience methods (`readText`, `writeText`,
   `maybeReadText`, `help`) move to a separate side-channel and are
   not part of the `Directory` surface.
   The naming change reflects that an `EndoMountDirectory` is one
   kind of directory among several (alongside the read-only
   `ReadableTree`, the in-memory directory, and the platform's
   `makeDirectory` exo); a `Mount` (the lifecycle concept tied to a
   pet-store entry) yields an `EndoMountDirectory` at its root.

5. **The `remove` capability is split into `remove` (single entry,
   fails on non-empty directory) and `removeTree` (recursive
   subtree).** The earlier shape (a single `remove(path, {
   recursive })` option) collapsed two distinct authorities into
   one method shaped by an option bag.
   Splitting them gives a holder of `remove` strictly less authority
   than a holder of `removeTree`, lets attenuators withhold
   `removeTree` while exposing `remove`, and removes the
   easy-to-overlook `{ recursive: true }` argument that silently
   destroys a subtree.
   The split applies symmetrically to the platform `DirectoryInterface`
   and to `EndoMountDirectoryInterface`; both exos expose both
   methods.

6. **The Mount layer enforces cap-std-style symlink confinement; the
   platform layer intentionally does not.** Per the layer cake,
   `@endo/platform/fs/node`'s `makeDirectory` is an
   ambient-authority attenuator: it accepts any absolute path and
   does not clamp symlinks.
   The `EndoMountDirectory` wrapper enforces the confinement and is
   the only directory-shaped exo an agent ever holds.
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

   The platform `makeDirectory` exo is unchanged; its callers are
   trusted host-side code that benefits from the precise OS error.
   The Mount wrapper substitutes a generic error before the
   confinement boundary.

   Encountered: maintainer review of PR 122
   ([comment 3205540627][]).

[comment 3205540627]: https://github.com/endojs/endo-but-for-bots/pull/122#discussion_r3205540627

7. **Both "from path" and "from directory" interfaces are exposed in
   parallel for mount creation and `makeDirectory`.** Per maintainer
   review of PR 122 ([comment 3212520373][]), the design commits to
   exposing both forms because Rust `cap-std` will eventually let the
   host hold an inode handle and offer less-racy, more-ocap-correct
   semantics for the directory-handle form.
   Today on node:fs the two forms are functionally equivalent;
   tomorrow on cap-std the directory-handle form gains the race-free
   guarantee.

   The dual surfaces:

   - **Mount creation.**
     - `provideMount(absolutePath, petName, { readOnly })`: from
       path; current. Convenient for agents holding a host-side
       absolute path string.
     - `provideMount(parentMount, relativePath, petName, { readOnly })`:
       from mount; new sub-mount overload to be added in a
       follow-up PR. Composes naturally with `Mount.lookup()`
       confinement and lets a holder of a parent Mount mint a new
       pet-store entry for a sub-tree without ambient-authority
       leakage.
   - **Directory creation within an existing Directory.**
     - `directory.makeDirectory(pathSegments)`: at relative path
       (multi-segment path arithmetic); current.
     - `directory.makeDirectoryHere(name)`: in directory (single
       name, operates on the receiver's inode handle); added in
       PR 122 to both `DirectoryInterface` (platform) and
       `MountDirectoryInterface` (daemon).

   The single-name `makeDirectoryHere` and the path-segment
   `makeDirectory` are functionally equivalent on the current node:fs
   backend.  The distinction is that `makeDirectoryHere` names a
   strictly-narrower authority: it binds to the receiver's identity
   and admits no traversal, so a future cap-std host can implement it
   race-free using the inode handle the receiver already holds.
   Callers that have a Directory reference and want a specific
   sub-name should prefer `makeDirectoryHere(name)`; callers
   composing a relative path from segments stay with
   `makeDirectory(segments)`.

   The mount-from-mount (`provideMount(parentMount, relativePath,
   ...)`) overload is left for a follow-up PR; this design commits
   to its shape so the API consumer can plan around it now.

[comment 3212520373]: https://github.com/endojs/endo-but-for-bots/pull/122#discussion_r3212520373

## Open Questions

1. **Streaming back-pressure between platform-fs primitives and
   daemon workers.** The `streamBase64()` returned by `makeFile` is
   an async iterable; the daemon's `EndoReadable` adapter wraps it.
   Today the wrap is straightforward, but a worker-side caplet that
   holds a `File` reference and reads it across CapTP needs the
   back-pressure protocol from `@endo/platform/fs/lite/reader-ref` to
   apply end-to-end.
   PR 122's Mode 2 facet does not exercise the streaming case
   end-to-end; confirmation needed before a worker is handed a
   `File`-shaped capability and asked to stream large content.
   Per maintainer review of PR 122
   ([comment on design line 195][comment 3204494183]): the long-term
   direction is to refactor the streaming surface to use a future
   `@endo/exo-stream` package once it lands (paralleling the
   `@endo/exo-playwright` pattern that wraps an underlying
   capability behind an Exo).
   This question therefore resolves to "defer to `@endo/exo-stream`
   when ready"; PR 122 ships the straightforward wrap and the
   refactor is tracked as a follow-up keyed off that package's
   arrival.
   kriskowal: re-checked against direction comment, treated as
   resolved-by-deferral.

[comment 3204494183]: https://github.com/endojs/endo-but-for-bots/pull/122#discussion_r3204494183

2. **Reuse of `directory.lookup()` for sub-exo construction.** PR 122
   keeps Mount's bespoke transient sub-exo construction.
   The alternative (having `directory.lookup()` accept a
   clamping-policy hook so Mount can reuse it) would eliminate the
   remaining bespoke traversal code at the cost of widening the
   platform API.
   Defer until a second consumer of the policy hook appears.
   kriskowal: re-checked, still open.

3. **Cap-std-style overwrite-replaces-symlink semantics.** The
   confinement rules in Decision 6 say "Overwrite paths may replace
   such a symlink with new content; the symlink ceases to exist
   after the write." PR 122 implements the **read-side** confinement
   (invisible from `list`, denied from `lookup` / `has` /
   `readText`) and the **remove-side** confinement (`remove()` acts
   on the symlink entry itself, since `fs.rm` does not follow
   symlinks).
   The **overwrite-side** is partial: `writeText` and `write`
   currently call `fs.writeFile` which **follows** the symlink.  For
   a broken symlink with an absolute target (e.g.
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
   Out of scope for PR 122 because it requires extending
   `FilePowers` with `lstat` (or moving Mount to `node:fs`
   directly).
   Surfaced here for follow-up; see also the test in
   `endo.test.js` that exercises the read-side and remove-side but
   not the overwrite-side.
   kriskowal: re-checked, still open.

4. **Closing the `MountFile` / `FileInterface` gap.** The MountFile
   exo returned by `EndoMountDirectory.lookup(filename)` exposes
   `text`, `streamBase64`, `json`, `writeText`, `writeBytes`, and
   `readOnly`: a strict subset of the platform `FileInterface`,
   missing `append` and `snapshot`.
   For Mode 2 to be complete, MountFile should either grow these
   methods (delegating to a platform `makeFile` instance with
   confinement-aware path) or be replaced by the platform `File` exo
   wrapped in a confinement-checking adapter.
   Out of scope for PR 122.
   kriskowal: re-checked, still open.

## Implementation Notes (PR 122)

What landed:

- **Mode 1.** `packages/daemon/src/mount.js` composes
  `makeDirectory(currentDir)` from `@endo/platform/fs/node` and
  delegates the unconfined filesystem work for `has`, `remove`,
  `removeTree`, `move`, `copy`, `write`, and `makeDirectory`.
  The new `clampSegments` helper produces clamped relative segments
  (rather than the prior `resolveSegments` which produced absolute
  paths and clamped at `confinementRoot`).
  This is a confinement strengthening for sub-mounts: a sub-mount
  handed to an agent can no longer use `..` to traverse back toward
  the original mount root.
  No tests exercised the prior weaker behavior.

- **Mode 2 prereq.** New package export
  `@endo/platform/fs/lite/interfaces` resolves to
  `packages/platform/src/fs/interfaces.js`, where `FileInterface`,
  `DirectoryInterface`, `ReadableBlobInterface`, etc. already lived.

- **Mode 2.** `EndoMountDirectory` (renamed from `EndoMount`)
  implements `DirectoryInterface` directly; there is no facet method.
  A worker or caplet that has been written against
  `import { Directory } from '@endo/platform/fs/lite/types'`
  accepts an `EndoMountDirectory` instance with no adaptation.
  The exo accepts only the strict array-of-segments convention;
  convenience methods (`readText`, `writeText`, `maybeReadText`,
  `help`) live on a separate side-channel exo and are out of the
  `Directory` surface.

- **Mode 3.** New `File` and `Directory` JSDoc typedefs in
  `packages/platform/src/fs/types.js`, importable as
  `@endo/platform/fs/lite/types`.
  `EndoMountDirectory` is documented (in `mount.js`) as the
  agent-visible directory exo whose root is a confined real
  filesystem subtree; a `Mount` (the lifecycle concept) yields one
  of these at its root.

- **Cap-std symlink confinement.** The Mount layer filters out
  symlinks whose targets exit the mount root (absolute targets,
  relative `..` escapes, broken targets) from `list()` and rejects
  them from `lookup()`, `has()`, and the read paths.
  Overwrite paths replace such symlinks atomically with new
  in-mount content.
  ACL-class OS errors (`EACCES`, `EPERM`, `EROFS`) are normalized to
  a generic confinement error before crossing the boundary so the
  agent observes "operation not permitted within mount" rather than
  the OS-specific failure detail.

- **`remove` / `removeTree` split.** Replaces the earlier
  `remove(path, { recursive: true })` shape on both the platform
  `DirectoryInterface` and the daemon `EndoMountDirectoryInterface`.
  `remove` fails on a non-empty directory; `removeTree` recursively
  removes a subtree.

- **`MountFile` does not satisfy `FileInterface`.** Surfaced as Open
  Question 4 above.
  `EndoMountDirectory.lookup()` resolves a file path to a
  `MountFile`, which lacks `append` and `snapshot`.
  A worker-side caplet declaring
  `import { File } from '@endo/platform/fs/lite/types'`
  and accepting any conforming exo observes the gap as missing
  methods at call time.

- **`fs/lite/types.d.ts` vs. JSDoc-in-.js.** The original design
  copy referred to `fs/lite/types.d.ts`.
  The package convention is JSDoc typedefs in `.js` plus an export
  entry in `package.json`.
  PR 122 follows the convention; the design copy is corrected here.

## Out of Scope

- Implementation. This document is a design-only deliverable; the actual
  daemon-side wiring is a follow-up PR pending feedback on the open
  questions above.
- Browser / non-Node hosts. The `"browser"` and `"endo-go"` / `"endo-rust"`
  conditions in `@endo/platform/fs` package exports are reserved for
  future work and do not affect the daemon-side integration plan.
- Sub-mount Phase 4 of `daemon-mount.md` itself. That phase is tracked in
  its own document; this design assumes Phase 4 either lands first or
  arrives as a sibling design that this document references.
- A "lookup formula" mechanism that would derive a new pet-name-bearing
  formula from an arbitrary `Directory` reference (analogous to how
  `link(namePath, resultName)` would let a holder of a value mint a
  named formula for it).
  Without such a mechanism there is no way to symbolically retain a
  reference to a specific transient sub-directory across sessions.
  This is a known gap and warrants a future companion design (paralleling
  the `link(namePath, resultName)` follow-on noted on the workers-panel
  PR thread); it is not in scope here.
