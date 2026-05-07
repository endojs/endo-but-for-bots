# Daemon Integration for `@endo/platform/fs/node`

| | |
|---|---|
| **Created** | 2026-05-07 |
| **Updated** | 2026-05-07 |
| **Author** | Kris Kowal (prompted) |
| **Status** | Modes 1, 2, 3 implemented in PR 122; follow-ups noted below |

## What is the Problem Being Solved?

`@endo/platform/fs/node` (introduced as Phase 4 of [`platform-fs.md`](platform-fs.md))
ships two new mutable lower-level primitives:

- `makeFile(path)` — text / json / streamBase64 / append / readOnly / snapshot.
- `makeDirectory(path)` — has / list / lookup / write / remove / move / copy /
  makeDirectory / readOnly / snapshot.

These primitives complement (and are **strictly less safe** than) the daemon's
existing `Mount` exo from [`daemon-mount.md`](daemon-mount.md): they accept any
absolute path and apply no symlink-escape clamping, no `..` clamping, and no
formula identity. They are the building blocks the `Mount` exo composes; on
their own they are ambient-authority objects fit only for the host process or
for trusted tooling.

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
   ↑   only ever sees: {File, Directory, ReadOnlyDirectory} exos
   ↑   confined by construction
─── daemon-side membrane ─────────────────────────────────
Mount exo  (daemon/src/mount.js)
   - holds confined root path
   - applies path clamping, symlink confinement
   - composes makeDirectory / makeFile under the hood
   ↑
Platform primitives  (@endo/platform/fs/node)
   - makeFile(absolutePath)        ← ambient authority
   - makeDirectory(absolutePath)   ← ambient authority
   ↑
node:fs
```

The `Mount` exo is the only object that holds an unclamped `makeDirectory`
reference. Everything an agent sees is either a `Mount` (a clamped root) or a
transient sub-exo derived from a `Mount` lookup (clamped to a subdirectory of
the same root).

### Three Integration Modes

The integration plan covers three distinct ways an agent comes to hold a
`Directory` / `File` reference:

#### 1. Replace the `Mount` exo's internal helpers

Today, `packages/daemon/src/mount.js` implements `has` / `list` / `lookup` /
`write` / `remove` / `move` / `makeDirectory` directly against `node:fs`. With
`@endo/platform/fs/node` shipped, the `Mount` exo can delegate the
**unconfined** filesystem work to `makeDirectory(rootPath)` and keep only the
**confinement policy** (path clamping, symlink resolution, `readOnly`
attenuation) in `mount.js`. This is a pure refactor: agent-visible behaviour
is unchanged, but the duplication between `mount.js` and `platform/fs-node`
disappears.

Open question: does `mount.js` retain its bespoke transient-sub-exo
construction, or does it reuse `directory.lookup()` from
`@endo/platform/fs/node`? The latter requires `lookup` to accept a
clamping-policy hook; the former keeps the policy and the primitives
separate at the cost of some duplication.

#### 2. Expose a mount as a confined `Directory` to a worker

A worker that wants to use `@endo/platform/fs/node`-shaped APIs (e.g., a
caplet authored against `import { Directory } from '@endo/platform/fs/node'`)
can be handed an exo that **conforms to the `Directory` interface guard** but
is implemented by a `Mount`. The agent imports the type (a structural
contract), the daemon hands it an instance (a confined implementation).
This requires:

- A shared interface guard, ideally exported from
  `@endo/platform/fs/lite/interfaces.js`, that both `Mount` and
  `makeDirectory` satisfy.
- A worker-side surface that accepts any object satisfying the guard and
  doesn't try to `import { makeDirectory } from '@endo/platform/fs/node'`
  directly (which would fail in a confined worker realm anyway).

#### 3. Pet-store-named directory caps

Agents that are confined-but-host-adjacent (chat bots, the Familiar) need a
named handle to a confined directory: `endo provide-mount ~/projects/foo
foo-mount`. The pet-store entry `foo-mount` resolves to the `Mount` exo. The
agent then `provideMount('foo-mount')` from its host or guest reference and
holds a `Directory`-shaped capability.

This is already possible via `provideMount` on `HostInterface` (see
`packages/daemon/src/host.js:253`). The integration plan is therefore to:

- Document that `Mount` is the agent-visible name for a `Directory`-shaped
  capability whose root is a real filesystem subtree.
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

- `provideMount(absolutePath, petName, { readOnly })` on `HostInterface` —
  already implemented, see `packages/daemon/src/interfaces.js:319`.
- `provideScratchMount(petName, { readOnly })` on `HostInterface` —
  already implemented, see `packages/daemon/src/interfaces.js:323`.

The Agent never sees:

- `makeFile` / `makeDirectory` from `@endo/platform/fs/node`.
- An absolute path string.
- The `node:fs` module.

The Agent _does_ see (post-integration):

- A `Directory`-shaped exo (the `Mount` exo, satisfying the
  `@endo/platform/fs/lite` `Directory` interface guard).
- A `File`-shaped exo (the transient file exo returned by
  `directory.lookup('some-file')`, satisfying the `File` interface guard).
- A `ReadOnlyDirectory`-shaped exo via `directory.readOnly()`.

## Decisions (answered by PR 122 implementation)

1. **Mount delegates to `@endo/platform/fs/node`.** Per PR 122,
   `mount.js` composes `makeDirectory(currentDir)` once per Mount
   construction and per sub-Mount lookup, and delegates `has`,
   `remove`, `move`, `copy`, `write`, and `makeDirectory` to that
   platform exo.
   `list` retains a bespoke implementation because the platform `list`
   filters out symlinks unconditionally while Mount surfaces
   internal-pointing symlinks (the symlink-confinement assertion
   catches escapes at use time).
   `readText` / `writeText` / `maybeReadText` continue to use
   `filePowers` directly, since the platform `Directory` surface does
   not expose path-relative text I/O.
   `lookup` retains its bespoke transient-sub-exo construction;
   reusing `directory.lookup()` would require either a clamping-policy
   hook on the platform side or a wrapper that re-clamps every
   returned exo, both out of scope for PR 122.

2. **Shared interface guards live in `@endo/platform/fs/lite/interfaces`.**
   PR 122 adds the package-export entry `./fs/lite/interfaces`
   resolving to `src/fs/interfaces.js`, the cross-realm-safe location
   for `FileInterface`, `DirectoryInterface`, `ReadableBlobInterface`,
   and friends.
   The `@endo/platform` layer keeps the canonical guards; daemon-side
   wrappers (notably `Mount`) declare structural superset behavior and
   expose strict `Directory` facets via `Mount.asDirectory()`.
   The originally-considered alternative — letting `@endo/daemon` own
   the Exo interfaces and treating `@endo/platform` as
   capability-only — was rejected because the daemon then could not
   declare its `Mount` to a worker as a `Directory` without the
   worker also depending on `@endo/daemon`, which defeats Mode 2.

3. **`Mount.lookup` returning a transient sub-exo is a documented
   caveat, not a memoization gap.** PR 122 changes nothing here.
   The bespoke construction is required for confinement; agents should
   re-look up on demand and treat reference identity across calls as
   non-stable.

## Open Questions

1. **Should `provideMount` accept a `Mount` reference instead of an
   absolute path?** Sub-mounting (Phase 4 of `daemon-mount.md`) wants
   a parent-mount-relative path; today's signature only accepts an
   absolute path. A second overload — `provideMount(parentMount,
   relativePath, petName, { readOnly })` — composes naturally with
   the `Mount.lookup()` confinement and would let agents create new
   pet-store entries from sub-trees of mounts they already hold.
   Out of scope for PR 122.

2. **Streaming back-pressure between platform-fs primitives and
   daemon workers.** The `streamBase64()` returned by `makeFile` is
   an async iterable; the daemon's `EndoReadable` adapter wraps it.
   Today the wrap is straightforward, but a worker-side caplet that
   holds a `File` reference and reads it across CapTP needs the
   back-pressure protocol from `@endo/platform/fs/lite/reader-ref` to
   apply end-to-end.
   PR 122's Mode 2 facet does not exercise the streaming case
   end-to-end; confirmation needed before a worker is handed a
   `File`-shaped capability and asked to stream large content.

3. **Reuse of `directory.lookup()` for sub-exo construction.** PR 122
   keeps Mount's bespoke transient sub-exo construction.
   The alternative — having `directory.lookup()` accept a
   clamping-policy hook so Mount can reuse it — would eliminate the
   remaining bespoke traversal code at the cost of widening the
   platform API.
   Defer until a second consumer of the policy hook appears.

4. **Closing the `MountFile` / `FileInterface` gap.** The MountFile
   exo returned by `Mount.lookup(filename)` exposes `text`,
   `streamBase64`, `json`, `writeText`, `writeBytes`, and `readOnly` —
   a strict subset of the platform `FileInterface`, missing `append`
   and `snapshot`.
   For Mode 2 to be complete, MountFile should either grow these
   methods (delegating to a platform `makeFile` instance with
   confinement-aware path) or be replaced by the platform `File` exo
   wrapped in a confinement-checking adapter.
   Out of scope for PR 122.

## Implementation Notes (PR 122)

What landed:

- **Mode 1.** `packages/daemon/src/mount.js` composes
  `makeDirectory(currentDir)` from `@endo/platform/fs/node` and
  delegates the unconfined filesystem work for `has`, `remove`, `move`,
  `copy`, `write`, and `makeDirectory`.
  The new `clampSegments` helper produces clamped relative segments
  (rather than the prior `resolveSegments` which produced absolute
  paths and clamped at `confinementRoot`).
  This is a confinement strengthening for sub-Mounts: a sub-Mount
  handed to an agent can no longer use `..` to traverse back toward
  the original mount root.
  No tests exercised the prior weaker behavior.

- **Mode 2 prereq.** New package export
  `@endo/platform/fs/lite/interfaces` resolves to
  `packages/platform/src/fs/interfaces.js`, where `FileInterface`,
  `DirectoryInterface`, `ReadableBlobInterface`, etc. already lived.

- **Mode 2.** New `Mount.asDirectory()` method returns a confined
  exo satisfying the platform `DirectoryInterface` exactly.
  The facet adapts Mount's lenient `string|string[]` path-argument
  conventions to the platform's strict array-only segments and
  re-wraps sub-directories so the consumer never observes a
  `Mount`-shaped exo from a `Directory`-shaped one.
  Mount also grows `write(segments, value)` and `copy(from, to)` and
  accepts the optional `{ recursive }` second argument on `remove` so
  the Mount surface itself is a structural superset of
  `DirectoryInterface`.

- **Mode 3.** New `File` and `Directory` JSDoc typedefs in
  `packages/platform/src/fs/types.js`, importable as
  `@endo/platform/fs/lite/types`.
  `Mount` is documented (in `mount.js`) as the agent-visible name
  for a `Directory`-shaped capability whose root is a confined real
  filesystem subtree.

### Platform-design reshapes forced by the integration

- **Mount as structural superset, with a strict facet for cross-realm
  use.** The original design anticipated `Mount` "satisfying" the
  `DirectoryInterface` guard.
  In practice, MountInterface and DirectoryInterface differ in
  argument shapes (Mount accepts `string|string[]`, Directory
  requires `string[]`), in `readOnly`'s return type guard
  (Mount returns `M.remotable()`, Directory requires
  `M.remotable('ReadableTree')`), and in method-name set
  (Mount has `readText`/`writeText`/`maybeReadText`/`help`, Directory
  has `write`/`copy`).
  The implementation resolves this by making Mount a structural
  superset (adding `write`/`copy`/`{ recursive }` on `remove`) and
  exposing the strict facet via `Mount.asDirectory()`.
  This is a non-trivial reshape: agents that want a `Directory`-shaped
  reference must call `asDirectory()`, not pass the `Mount` directly,
  unless their guard is permissive about extra methods.

- **`MountFile` does not satisfy `FileInterface`.** Surfaced as Open
  Question 4 above.
  Mode 2's facet round-trips files through `MountFile`, which lacks
  `append` and `snapshot`.
  A worker-side caplet declaring `import { File } from '@endo/platform/fs/lite/types'`
  and accepting any conforming exo would observe the gap as missing
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
