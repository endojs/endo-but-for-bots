# Filesystem & Name-Hub Interface Consolidation

| | |
|---|---|
| **Created** | 2026-06-18 |
| **Updated** | 2026-10-22 |
| **Author** | Aaron (prompted) |
| **Status** | **Complete** |

## Status

This document records the completed reduction of overlap in the ~30
filesystem-shaped and name-hub-shaped `M.interface` guards that existed across
`@endo/platform`, `@endo/platform/fs/extended` (formerly `@endo/endo-fs`), and
`@endo/daemon`.
It builds directly on
[fs-interface-reconciliation.md](fs-interface-reconciliation.md) (which unified
the method *names and signatures* across the three live tree surfaces) and on
[namehub-interface-unification.md](namehub-interface-unification.md) (the
accepted plan for one slice of this, delivered here as C1).

The reconciliation work made the names line up. This document answered the next
question: once `lookup` / `move` / `copy` / `makeDirectory` / `remove` /
`subView` meant the same thing on every tree surface, **which of the duplicated
guards could be collapsed, and what blocked each one.**

No implementation work remains under this design.
Later documentation and test refinements, and adjacent enhancements, are
tracked by their own designs.
The candidate sections below (C1 through C5) are kept as the historical
rationale; each one ends with the decision that shipped.

### Delivery history

- [PR #467](https://github.com/endojs/endo-but-for-bots/pull/467), merged
  2026-06-19, delivered C2, C3, C5, the original C4 range-I/O surface, and the
  C1 interface records, with `EndoMount.followNameChanges` declared but
  returning `ENOSYS`.
- [PR #277](https://github.com/endojs/endo-but-for-bots/pull/277), merged
  2026-07-01, made `EndoMount.followNameChanges` a live entry-name stream.
- [PR #643](https://github.com/endojs/endo-but-for-bots/pull/643), merged
  2026-07-16, aligned the mount and Git capability contracts: the daemon-owned
  `EndoMountStat` and `MountNameChange` types, the separately composable
  `PathEntryIssuer` contract, and the precise public type of the live
  `followNameChanges()` reader.
- [PR #713](https://github.com/endojs/endo-but-for-bots/pull/713), merged
  2026-07-30, restructured `makeMountExo` (commit `2cb917473`) and carries the
  current `followNameChanges` implementation.
- [PR #1301](https://github.com/endojs/endo-but-for-bots/pull/1301), merged
  2026-09-20, replaced the C4 `getInfo()` / `fetch(offset, length)` pair with
  separate `sha256()` / `size()` / `bytes()` accessors and the `byteRange()` /
  `textRange()` attenuation surface of
  [readableblob-range-attenuation.md](readableblob-range-attenuation.md).

### Shipped scope

The current interface, as delivered by the changes above:

- **C2.** `@endo/platform/fs` exports `readableBlobMethodGuards`
  (help / streamBase64 / text / json) and `readableTreeMethodGuards`
  (help / has / list / lookup) as method-guard records. The lite
  ReadableBlob / SnapshotBlob / File and ReadableTree / SnapshotTree /
  Directory guards spread them instead of repeating the shapes.
- **C3.** `EndoReadableTree` is `{ ...readableTreeMethodGuards, sha256 }`
  (the `SnapshotTree` shape).
- **C4.** `EndoBlob` is aligned *up* to the richer `BlobRef` shape. It is
  `{ ...readableBlobMethodGuards, ...rangeReadMethodGuards,
  ...rangeAttenuationMethodGuards }`:
  - the whole-value `text` / `json` / `streamBase64` accessors;
  - `rangeReadMethodGuards`: `sha256()` (base64 content hash), `size()`
    (bigint byte length), and `bytes()` (a stream of the selected bytes);
  - `rangeAttenuationMethodGuards`: `byteRange(start, end)` and
    `textRange(startLine, endLine)`, which return a new readable blob with
    exactly the authority to read the selected portion, rather than reading a
    byte window.

  `ReadableBlobRangeInterface` is the pre-assembled form of that surface,
  adopted by the platform `LocalBlob`, the git `GitBlob`, and the mount file's
  `readOnly()` view. The extended `BlobRef` carries the same methods (with
  `bytes()` returning a `PassableBytesReader`) plus `text` / `json`;
  `streamBase64` stays daemon-only. The Node/XS powers provide
  `readFileRange` and the content store provides `size` / `readRange` to back
  the range reads.
- **C1.** `EndoNameHub`, `EndoDirectory`, `EndoGuest`, and `EndoHost` all
  share `nameHubMethodGuards`. The shared `readableNameHubMethodGuards`
  (help / has / list / lookup / maybeLookup) and `directoryFileMethodGuards`
  (makeDirectory / readText / maybeReadText / writeText) live in
  `@endo/platform/fs` and standardize on `NameOrPathShape`
  (`string | string[]`). `EndoMount` satisfies that contract by method name and
  **widens** its own `lookup` / `maybeLookup` to `PathArgShape`, so a
  `MountEntry` cap is valid directly as the path argument of `lookup`; `has`
  accepts any rest arguments. `EndoMount.entry(path)` mints such an entry
  from a string path. `EndoGuest` / `EndoHost` spread the record and
  **override** the two `follow*` methods, which return a Promise on agents
  where the bare hub returns the reader synchronously.
  `EndoMount.followNameChanges` is a live
  `PassableReader<MountNameChange, undefined>` backed by the mount watcher; the
  daemon-local change record remains distinct from the platform watcher event
  record.
- **C5.** The dead `ContentStoreInterface` / `SnapshotStoreInterface`
  (re-exported but never implemented) were removed. The remaining lite
  `M.interface` objects all have real consumers (the daemon imports the
  Directory / File guards; the platform implementers use the rest), so they
  keep their job as the assembled guards alongside the exported records.

The extended cap-FS engine's `Directory` / `File` keep their own richer guards
(eref-returning caps, cursors, `lookupStep` / `subView` / `create`): they are a
genuinely different surface and are out of scope for the shared records.

## What is the Problem Being Solved?

The same conceptual capabilities are declared several times under different
names:

- **A "tree of named things"** is declared three times in live code: the
  extended `Directory` (`packages/platform/src/fs/extended/type-guards.js`),
  the daemon `EndoMount` (`MountInterface`), and the daemon `EndoDirectory`
  (`NameHubInterface`). Each redeclares `lookup` / `move` / `copy` /
  `makeDirectory` / `remove` by hand. The daemon already *imports*
  `PlatformDirectoryInterface` and comments "`EndoMount` extends `Directory`"
  (`interfaces.js:540`), but then re-declares the methods rather than deriving
  them — the alignment is by convention and prone to drift.
- **A "minimal vocabulary"** (`@endo/platform/fs/lite`'s `Directory` / `File`)
  exists as guards with **no implementer**. They are the aspirational shape the
  real guards hand-copy.
- **A "handle to immutable bytes"** is declared as `ReadableBlob` (lite),
  `BlobRef` (extended), `SnapshotBlob` (lite), `EndoReadable`, and `EndoBlob`
  (daemon).
- **A "content-addressed immutable tree"** is declared as `ReadableTree` and
  `SnapshotTree` (lite), and `EndoReadableTree` (daemon).

Duplication is not free: it is where drift accumulates (the daemon comment
already worries about it), it forces adapters that would otherwise be
unnecessary (the unbuilt `BlobRef -> SnapshotBlob` adapter, fs-reconciliation
F7/D3, is a *symptom* of two shapes for one concept), and it multiplies the
surface a viewer must learn to dispatch over.

## The load-bearing constraint: signatures diverge, names do not

The reconciliation aligned method *names*. It did **not** make the argument
*shapes* identical, because the live surfaces accept genuinely different
inputs. This is the single most important fact for every phase below, so it is
stated once here.

| Method | `EndoMount` (`MountInterface`) | `EndoDirectory` (`NameHubInterface`) | extended `Directory` | genie `LocalMount` |
|---|---|---|---|---|
| arg shape | `PathArgShape` = `string \| string[] \| MountEntry` | `NameOrPathShape` = `string \| string[]` | `string \| string[]` | `PathArgShape` = `string \| string[]` |
| `lookup` | `M.call(PathArgShape)` | `M.call(NameOrPathShape)` | `M.call(M.or(string, arrayOf string))` | `M.call(PathArgShape)` |
| `move` | `M.call(PathArgShape, PathArgShape)` | `M.call(NamePathShape, NamePathShape)` | `M.call(or(string,array), or(string,array))` | `M.call(PathArgShape, PathArgShape)` |
| `remove` | `M.call(PathArgShape)` | `M.call().rest(NamePathShape)` | `M.call(string)` | `M.call(PathArgShape)` |

So `EndoMount` accepts a `MountEntry` cap as a path argument where the others
do not, and `EndoDirectory.remove` is variadic where the others are not. **A
guard cannot be shared verbatim**: merging onto the narrower shape removes
`EndoMount`'s entry-accepting behavior; merging onto the wider shape makes a
guard advertise inputs its implementation rejects. Every consolidation below
therefore requires a maintainer decision on the *canonical* shape per method,
or a layered guard where the shared record carries the common shape and each
surface widens specific methods.

### A fourth mount-shaped surface: genie `LocalMount` (now folded in)

`packages/genie/src/sandbox/local-powers.js` is a host-backed, in-process
sandbox facet (`provideScratchMount` / `provideHostPath` mint it) that mirrors
the daemon's `Mount` *shape* — `help`, `has`, `list`, `lookup`, `maybeLookup`,
`readText`, `maybeReadText`, `writeText`, `makeDirectory`, `remove`, `move` —
using `string | string[]` path arguments (no `MountEntry` arm: a genie sandbox
never traffics in daemon mount-entry caps). It was the **fourth** independent
definition of the mount vocabulary.

It is **now folded in**: genie took a `@endo/platform` dependency and its local
path shape is exactly the portable `NameOrPathShape`, so `LocalMount` spreads the
portable `readableNameHubMethodGuards` (help / has / list / lookup / maybeLookup)
and `directoryFileMethodGuards` (makeDirectory / readText / maybeReadText /
writeText) from `@endo/platform/fs/lite` — the same records the daemon spreads,
now owned by platform rather than the daemon — declaring only `remove` / `move`
inline (those live in the daemon-side `nameHubMethodGuards`, which carries
registry methods genie does not expose). genie gained `maybeLookup` as part of
the fold-in.

genie's two security gates are **undisturbed** — they key on method names / cap
identity, not the interface object:

- `assertIsMountCap` is a *shape* gate checking for the presence of
  `['readText','writeText','makeDirectory','has','list']` — all still present.
- `provideHostPath` is an *identity* gate keyed on a `WeakSet`/`WeakMap` of
  powers-minted caps, independent of the interface shape.

This is exactly the choice-point that
[namehub-interface-unification.md](namehub-interface-unification.md) anticipated
("make the choice points visible"); the divergence table above is the concrete
form of it.

## Consolidation candidates

### C1 — Name-hub unification

[namehub-interface-unification.md](namehub-interface-unification.md) supplied
the accepted shape: a narrower **`ReadableNameHubInterface`** that both mounts
and name hubs satisfy, `maybeLookup` (the primitive) and `followNameChanges`
added to `EndoMount`, and `identify` / `locate` / `reverseLookup` kept out of
mounts (mount entries have no formulas).

That design was blocked on the name and signature alignment that
[fs-interface-reconciliation.md](fs-interface-reconciliation.md) delivered.
A further constraint surfaced here: `ReadableNameHubInterface` could not be a
single shared method record used verbatim, because `EndoMount` uses
`PathArgShape` (entry-accepting) while the name hub uses `NameOrPathShape`.
Two options were weighed:

- (a) standardize on `NameOrPathShape` and have the mount accept entries only
  through a separate `entry()`-based path;
- (b) define a method record that each surface spreads, then override the
  entry-accepting methods on the mount.

The draft of this document recommended (a).
**Option (b) shipped.** The shared records stay on `NameOrPathShape`, and
`EndoMount` overrides `lookup` / `maybeLookup` with `PathArgShape`, so callers
may pass a `MountEntry` straight to `lookup`. The rationale for (b) is
compatibility: existing mount callers pass entries as path arguments, and
narrowing the mount guard would reject them. No separate run measured the
breakage; the decision rests on that compatibility argument. The shared
contract remains honest because it is a documentation contract keyed on method
names (namehub Decision 3), and the widening is visible as an explicit override
in `MountInterface`.

*Blast radius:* `daemon/src/interfaces.js`, `mount.js`, and the consumers that
discriminate by `__getMethodNames__` (chat inventory tree, `endo locate` /
`endo list`). Daemon gateway + mount tests.

### C2 — One source of truth for the shared `Directory` method shapes

The lite `Directory` / `File` guards were unimplemented and hand-copied by the
extended `Directory` and (via comments) by `EndoMount`. The plan was to extract
the *shared-shape* methods into exported **method-guard records** (not just
`M.interface` objects) so the extended `Directory`, `EndoMount`, and
`EndoDirectory` spread one definition and override only where they genuinely
widen it (per the divergence table).

The prerequisite was that `@endo/platform/fs/lite` export the raw method-guard
records (it had exported only the assembled `M.interface` guards).
**Shipped in PR #467:** the records are exported and the lite and daemon read
surfaces spread them, so the hand-copy drift the daemon comment warned about is
structurally prevented.

*Blast radius:* `platform/src/fs/interfaces.js` (export records),
`platform/src/fs/extended/type-guards.js`, `daemon/src/interfaces.js`. This was
the structural fix that prevents the overlap from re-growing, delivered
alongside C1 so both consume the same records.

### C3 — Collapse the immutable-tree caps

`ReadableTree` (lite: `has` / `list` / `lookup`), `SnapshotTree` (lite:
`+ sha256` / `store` / `fetch`), and `EndoReadableTree` (daemon: `help` /
`sha256` / `has` / `list` / `lookup`) were three spellings of
"content-addressed immutable directory snapshot." `EndoReadableTree` and the
catalog `SnapshotTree` were nearly identical (both carry `sha256`).
**Shipped in PR #467:** the daemon guard spreads the platform record and adds
`sha256`.

*Blast radius:* `platform/src/fs/interfaces.js`, `daemon/src/interfaces.js`, and
the `checkin` / `readable-tree` / git-tree formulas. Lower risk than C1/C2
because the read surface is small and stable, but still daemon-deep.

### C4 — Collapse the readable-bytes caps

`ReadableBlob` (lite), `BlobRef` (extended), `SnapshotBlob` (lite: `+ sha256`),
`EndoReadable`, and `EndoBlob` (daemon: `help` / `text` / `json`) were all "a
handle to immutable bytes you can read or stream."

**Direction (maintainer decision):** align *up* to the **richer `BlobRef`
shape**, not down to the whole-value `SnapshotBlob`. The daemon read-surface
convergence (`EndoBlob` spreads `readableBlobMethodGuards`) is the whole-value
half. The other half gives the content-addressed blob the surface that makes
remote reads efficient: identity and length without reading bytes, and partial
reads without streaming the whole blob.

`SnapshotBlob`'s `text` / `json` / `streamBase64` are whole-value conveniences
layered on top; the unified rich blob keeps them. The earlier "retire `BlobRef`
onto `SnapshotBlob`" framing (and the D3/F7 note) is **superseded**: `BlobRef`
is the strictly richer shape, and the daemon and lite blobs were brought up to
it.

**First version (PR #467, superseded).** PR #467 delivered the range surface as
`getInfo() -> { algorithm, hash, size }` plus a windowed
`fetch(offset, length)`, and removed the separate `EndoBlob.sha256()`.

**Current version (PR #1301).**
[readableblob-range-attenuation.md](readableblob-range-attenuation.md)
replaced that pair. `getInfo()` and `fetch(offset, length)` no longer exist on
any blob guard. The shipped surface is:

- `rangeReadMethodGuards`: `sha256()` returns the base64 content hash,
  `size()` returns the bigint length, and `bytes()` streams the selected bytes.
- `rangeAttenuationMethodGuards`: `byteRange(start, end)` returns a new
  readable blob over the half-open byte interval and reads no bytes;
  `textRange(startLine, endLine)` returns a promise for a readable blob over the
  selected LF-delimited lines. Ranges compose (a range of a range intersects),
  and the result can be handed to anything that accepts a readable blob.

The layers, as built:

1. *Powers / content store:* the store's `fetch(sha256)` also surfaces `size`
   (a `stat` on the storage file) and a range-capable `readRange(offset,
   length)`; the Node/XS `FilePowers` provide `readFileRange` (Node `fs.open`
   plus positional `read`).
2. *Hash format:* **base64 is the single canonical public encoding.** Every
   public `sha256()` accessor (`EndoBlob`, `BlobRef`, `SnapshotBlob`,
   `SnapshotTree`, `EndoReadableTree`) returns base64. Hex survives only as the
   internal `store-sha256/<hex>` address and the tree-manifest child
   references; callers convert base64 to hex via `@endo/hex` and
   `@endo/base64` at the store boundary.
3. *Blob exos:* the range and attenuation methods are implemented by the
   persisted and transient daemon blobs, the mount file and its `readOnly()`
   blob view (`mount.js`), and the platform `LocalBlob` / git `GitBlob`.
4. *Interface:* `ReadableBlobRangeInterface` pre-assembles
   `readableBlobMethodGuards`, `rangeReadMethodGuards`, and
   `rangeAttenuationMethodGuards` so implementers adopt the surface without
   re-spreading. The extended `BlobRef` carries the same methods plus `text` /
   `json`. The `BlobRef -> SnapshotBlob` adapter is unnecessary because the
   shapes converge from below.

*Blast radius:* the widest: content-store powers, the CAS cache, every blob exo
across daemon / platform / git, plus the daemon integration suite (~15 min).
It was sequenced after C3's tree decision (a tree snapshot yields blob
snapshots).

### C5 — Retire the unimplemented `lite` vocabulary, or give it a job

Once C2 made the lite `Directory` / `File` the *source* of the shared method
records (rather than a parallel unimplemented guard), the remaining question was
whether the assembled `lite` `M.interface` objects still earned their keep or
whether the **catalog document** (fs-interface-reconciliation.md) should be the
vocabulary, with the code shipping only records plus the real extended guard.
**Shipped in PR #467:** the dead store guards were removed and the remaining
assembled guards were kept because each has a consumer.

## Result-shape inconsistencies (record/value alignment)

C1 through C5 aligned method *names and argument shapes*. A separate audit found a
class of "same concept, different **result** shape" divergences — the same
logical value spelled differently depending on which surface returns it. The
flagged ones and their resolutions:

| Concept | Divergence | Resolution |
|---|---|---|
| **File stat** | Daemon `EndoMountStat` `{ kind, sizeBytes: number, modifiedMs: ms }` vs extended platform `NodeStat` `{ size: bigint, mtime: bigint ns, atime }` — and `getInfo().size` (now `size()`) is bigint, colliding with `stat().sizeBytes` within the daemon mount | **Fields aligned, ownership remains separate:** daemon `EndoMountStat` is `{ kind, size: bigint, mtime: bigint ns, atime: bigint }`; platform owns `NodeStat`, while the daemon owns the named mount-stat record because no platform operation consumes it; `kind` is kept (the mount stats a path); XS approximates `atime <- mtime` (host stat lacks it). |
| **Content hash** | `EndoBlob` exposed both `sha256()` (hex) and `getInfo().hash` (base64); blob vs tree hash encodings differed | **Every public hash accessor is base64; hex is internal-only.** PR #467 first removed `EndoBlob.sha256()` in favor of `getInfo().hash`; PR #1301 then removed `getInfo()` and restored `sha256()` as the single hash accessor, now returning base64. `EndoBlob`, `BlobRef`, `SnapshotBlob`, `SnapshotTree`, and `EndoReadableTree` all report the content hash through `sha256()` in base64. Hex survives only as the on-disk `store-sha256/<hex>` address and the tree-manifest child references; callers convert base64 to hex via `@endo/hex` + `@endo/base64` where the store key is needed. |
| **Dir-change record** | NameHub `{ add, value: idRecord }` vs mount `{ add, type }` vs extended `WatchEvent { kind, name }` — three shapes | **Live mount feed, separate record.** `followNameChanges` returns the daemon-local `{ add, type } \| { remove }` reader; a common record remains deferred until a shared operation establishes common semantics. |
| **Listing** | daemon/lite `list()` -> `string[]` vs extended `Cursor`/`DirEntry[]` (name + qid) | **Intentional layer split** (the reconciliation chose names for lite/daemon, rich `Cursor` for the cap-FS engine). Not aligned. |

Other audited items (`getStat`/`getAttrs` narrow-vs-wide, `mkdir`/`unlink`
aliases, `Qid` vs `getInfo` (now `sha256()` / `size()`), `has`/`exists`, symlink scoping) are
documented-intentional divergences, not accidental inconsistencies.

## Consolidated inventory

After C1 through C5 the fs/name-hub interface set is:

- **Tree surfaces:** one shared `Directory` method record (C2); `EndoMount` and
  `EndoDirectory` satisfy `ReadableNameHubInterface` by method name and add
  their own extensions, with `EndoMount` widening `lookup` / `maybeLookup` to
  accept a `MountEntry` (C1); extended `Directory` is the record plus cap-FS
  extensions. `PathEntryIssuer` is a separate portable authority composed by
  `EndoMount` and writable Git worktrees, not added to every `Directory`.
  `DirectoryWriteSource` names the portable blob-or-tree payload accepted by
  the runtime's remotable guard, so the TypeScript contract no longer
  advertises arbitrary `unknown` writes.
- **Immutable trees:** one `SnapshotTree` / `ReadableTree` shape (C3).
- **Immutable bytes:** one rich shape (C4): the whole-value accessors plus
  `sha256()` / `size()` / `bytes()` and the `byteRange()` / `textRange()`
  attenuation surface, pre-assembled as `ReadableBlobRangeInterface`. The
  convergence went the other way from the early "retire `BlobRef`" framing:
  `BlobRef` was the richest shape, so the daemon and lite blobs aligned **up**
  to it. The `BlobRef -> SnapshotBlob` adapter was never needed because the
  shapes converge from below; `BlobRef` itself remains (enriched with `text` /
  `json`).
- **Vocabulary:** records exported from `lite`; the catalog doc is the prose
  vocabulary (C5).

Net: roughly a third fewer fs-shaped guards, no hand-copied method shapes, and
no `BlobRef -> SnapshotBlob` adapter.

## Sequencing (historical)

The plan sequenced the candidates as below. In practice C1 through C5 landed
together in PR #467, and the later C1 and C4 changes listed under
§ Delivery history followed.

1. **C1**: name-hub unification; fixed `ReadableNameHubInterface` and the
   canonical-shape decision.
2. **C2**: export shared `Directory` records and consume them in C1's
   interfaces (1 and 2 were planned as one PR).
3. **C3**: immutable-tree convergence.
4. **C4**: readable-bytes convergence, after C3.
5. **C5**: `lite` vocabulary cleanup, falling out of C2.

## Design decisions

- **Runtime protocol, static refinement.** `MountInterface` remains in the
  daemon package as the canonical Exo / CapTP contract that interchangeable
  mount backends implement.
  `EndoMount` is the current implementation's more precise TypeScript surface.
  Runtime patterns can validate promise and remotable envelopes but cannot
  encode their semantic payload types, so one construction-boundary assertion
  and focused compile-time/runtime conformance tests pin the relationship.
  The runtime guard stays free of current-backend implementation types.

- **Records, not inheritance.** `M.interface` has no native `extends`; the
  mechanism throughout is *exported method-guard records spread into multiple
  `M.interface()` calls*, with per-surface overrides where the divergence table
  requires. This is the only way to share shapes without a runtime introspection
  surface, and it matches namehub Decision 3 (the narrower interface is a
  documentation contract; runtime discrimination stays structural via
  `__getMethodNames__`).
- **Canonical shape = the narrower one + an explicit widener.** Per the
  divergence table, the shared record is standardized on `NameOrPathShape`
  (`string | string[]`). A surface that accepts more overrides the specific
  methods in its own guard: `EndoMount` widens `lookup` / `maybeLookup` to
  `PathArgShape` (accepting a `MountEntry`) and mints entries with
  `EndoMount.entry()`. The shared contract stays honest because the override
  is explicit in `MountInterface` rather than hidden in the shared record.
- **No big-bang (planned).** Unlike the reconciliation's D3, the plan
  sequenced C1 through C5 because each phase was independently validatable and
  the blast radii differ by an order of magnitude (C1 is daemon-local; C4
  touches the CAS path). The phases nonetheless landed together in PR #467.

## Dependencies

| Design | Relationship |
|---|---|
| [fs-interface-reconciliation.md](fs-interface-reconciliation.md) | Prerequisite — aligned the names/signatures this builds on. |
| [namehub-interface-unification.md](namehub-interface-unification.md) | C1 *is* this design's accepted plan; delivered here. |
| [filesystem-watchers.md](filesystem-watchers.md) | Supplies `followNameChanges` on `EndoMount`, a C1 input. |
| [platform-fs.md](platform-fs.md) | Owns the `lite` vocabulary that C2/C5 refactored. |
| [readableblob-range-attenuation.md](readableblob-range-attenuation.md) | Replaced the C4 `getInfo()` / `fetch()` pair with `sha256()` / `size()` / `bytes()` and `byteRange()` / `textRange()` (PR #1301). |

## Known gaps and TODOs

- [x] C1: unify `EndoNameHub` + `EndoDirectory` on `nameHubMethodGuards`.
- [x] C1: define `ReadableNameHubInterface` + `readableNameHubMethodGuards`
      (canonical shape: `NameOrPathShape`); `EndoMount` satisfies it by
      method name, widening `lookup`/`maybeLookup` to `PathArgShape`; add
      `EndoMount.maybeLookup`.
- [x] C1: align `EndoGuest` / `EndoHost` on `nameHubMethodGuards` (spread +
      two-line `follow*` override for the agent promise shape).
- [x] C1: declare `EndoMount.followNameChanges` (PR #467) and implement it as a
      live `PassableReader<MountNameChange, undefined>` over the mount watcher
      (PR #277; types aligned in PR #643).
- [x] C1: add `help` to `readableNameHubMethodGuards`; extract
      `directoryFileMethodGuards` (makeDirectory / readText / maybeReadText /
      writeText) consumed by EndoDirectory / EndoGuest / EndoHost / genie;
      remove the dead `NameHubInterface`.
- [x] C1: fold genie's `LocalMount` onto the shared records (+ `maybeLookup`),
      keeping its security gates intact.
- [x] C2: export `readableBlobMethodGuards` / `readableTreeMethodGuards` from
      `@endo/platform/fs/lite`; consume them in the lite + daemon read surfaces.
- [x] C3: `EndoReadableTree` converged onto the shared records + `sha256`
      (the `SnapshotTree` shape).
- [x] C4: align the daemon `EndoBlob` *up* to the richer `BlobRef` shape:
      `EndoBlob` is `{ ...readableBlobMethodGuards, ...rangeReadMethodGuards,
      ...rangeAttenuationMethodGuards }`, with `sha256()` (base64) / `size()` /
      `bytes()` and `byteRange()` / `textRange()` (PR #467, reshaped by
      PR #1301). Node/XS powers provide `readFileRange`; the content store
      provides `size` / `readRange`. Hex survives only as the internal
      content-store address.
- [x] C4: mirror the whole-value `text`/`json` conveniences onto the extended
      `BlobRef` (interchangeable with `EndoBlob` across `sha256` / `size` /
      `bytes` / `byteRange` / `textRange` / `text` / `json`; `streamBase64`
      stays daemon-only because `bytes()` is the common streaming primitive).
- [x] C4: extend `LocalBlob` (platform) and `GitBlob` to the rich shape via the
      shared `ReadableBlobRangeInterface`.
- [x] C4: extend the daemon mount-file `readOnly()` view: `FilePowers` gains
      `sha256`, and `EndoMountFile` plus the `EndoMountReadableBlob` view carry
      the range and attenuation surface over the *live* file (a write-disabled
      face, not a snapshot: content changes are observed, only writes are
      refused).
- [x] C1 layering: hoist `readableNameHubMethodGuards` /
      `directoryFileMethodGuards` from `@endo/daemon` to `@endo/platform/fs`;
      genie now imports them from platform (no daemon-internals reach).
- [x] C5: remove the dead `ContentStore` / `SnapshotStore` / `NameHubInterface`
      guards.

## Prompt

> where's the doc that describes what interfaces exist and how they relate to
> each other. are there good candidates for reducing overlap and simplifying the
> inventory of interfaces? … do all
