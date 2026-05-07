# Daemon Integration for `@endo/platform/fs/node`

| | |
|---|---|
| **Created** | 2026-05-07 |
| **Updated** | 2026-05-07 |
| **Author** | Kris Kowal (prompted) |
| **Status** | Not Started |

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
- Add a `Directory` type alias in `@endo/platform/fs/lite/types.d.ts` that
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

## Open Questions

1. **Should `Mount` literally compose `makeDirectory(rootPath)` from
   `@endo/platform/fs/node`?** The pure-refactor option (mode 1 above) reduces
   duplication but couples mount-policy code to platform-fs internals. The
   alternative is to leave `mount.js` as the canonical implementation and
   treat `@endo/platform/fs/node` as a parallel API surface for non-daemon
   contexts (test harnesses, scripts, future non-Node hosts that want the
   same surface shape). Maintainer preference?

2. **Where do the shared `Directory` / `File` / `ReadOnlyDirectory`
   interface guards live?** Options:
   - `packages/platform/src/fs/interfaces.js` (today's home for some
     interfaces; would need new exports).
   - `packages/daemon/src/interfaces.js` (the home for `MountInterface`
     today; adding agent-visible aliases there couples agents to daemon).
   - A new `@endo/platform/fs/interfaces` subpath.
   The first option keeps the membrane clean; recommend that unless the
   maintainer sees a reason against.

3. **Does `Mount.lookup()` returning a transient sub-exo break the
   `Directory` interface?** The `Mount` exo's transient sub-exos do not
   round-trip through pet names; they are equality-distinct on every
   lookup. If agent code expects sub-directory references to be stable
   (e.g., for memoization), this is a behavioural difference from
   `makeDirectory`'s sub-lookup which returns the same identity for the
   same path within a process. May warrant a documented caveat or a
   memoization layer.

4. **Should `provideMount` accept a `Mount` reference instead of an
   absolute path?** Sub-mounting (Phase 4 of `daemon-mount.md`) wants a
   parent-mount-relative path; today's signature only accepts an
   absolute path. A second overload — `provideMount(parentMount,
   relativePath, petName, { readOnly })` — composes naturally with the
   `Mount.lookup()` confinement and would let agents create new
   pet-store entries from sub-trees of mounts they already hold.

5. **Streaming back-pressure between platform-fs primitives and daemon
   workers.** The `streamBase64()` returned by `makeFile` is an async
   iterable; the daemon's `EndoReadable` adapter wraps it. Today the
   wrap is straightforward, but a worker-side caplet that holds a
   `File` reference and reads it across CapTP needs the back-pressure
   protocol from `@endo/platform/fs/lite/reader-ref` to apply
   end-to-end. Current state of `reader-ref`'s CapTP behaviour needs
   confirmation before this integration mode is committed to.

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
