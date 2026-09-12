# Daemon Storage Capability Matrix

| | |
|---|---|
| **Created** | 2026-09-12 |
| **Author** | kriskowal (prompted) |
| **Status** | Not Started |
| **Source** | Review comment on endojs/endo-but-for-bots#1125 (`packages/daemon/src/manager.js` line 6804) |

## What is the Problem Being Solved?

A daemon capability over stored data varies along two independent axes: the
**shape** of the data (a leaf of bytes, or a named collection of entries) and
the **guarantee** the holder is given about mutation (full read/write, a
read-only view, or an immutable snapshot). The current vocabulary confuses two
of the three guarantee levels. The word "readable" is doing double duty: it
names the shared read-only *surface* (`ReadableBlob` / `ReadableTree`), but the
daemon *formula types* `readable-blob` and `readable-tree` are in fact the
**snapshot** (content-addressed, immutable) forms, produced by `snapshot()` and
keyed by SHA-256.

The review comment that prompted this design puts it precisely:

> I note that `readOnly` is not the same as `snapshot`, which would provide a
> further guarantee of immutability behind the read only view.

A `readOnly()` view attenuates write authority but is a *face over live
backing* — content can change behind it, and two reads may differ. A
`snapshot()` captures content at a moment and freezes it — byte-identical on
every read, forever, content-addressed. These are different guarantees wearing
the same read surface, and the formula names give the immutable one the generic
"readable" name, which is exactly the collision.

This design names every cell of the matrix, states each guarantee explicitly,
reconciles the names with the existing `readable-blob` / `readable-tree`
formulas (and the phantom `readable-directory`), and gives an implementable
migration path.

## The matrix

Two axes. **Shape** across the top (leaf bytes vs. named collection); **mutation
guarantee** down the side.

| Guarantee \ Shape | Bytes (leaf) | Collection (container) |
|---|---|---|
| **Mutable** (read + write, live) | **File** (`EndoMountFile`) | **Directory** (`EndoMount`, `directory` formula / `EndoDirectory`) |
| **Readable view** (read-only, live) | **ReadableBlob** view (`file.readOnly()`) | **ReadableTree** view (`mount.readOnly()`) |
| **Snapshot** (read-only, immutable, content-addressed) | **SnapshotBlob** — formula `snapshot-blob` (today `readable-blob`) | **SnapshotTree** — formula `snapshot-tree` (today `readable-tree`) |

The guarantees, stated so a caller knows what it holds:

- **Mutable.** Full read + write over live backing storage. The holder can
  observe and change content. `EndoMountFile` (`writeText` / `append` /
  `writeBytes`), `EndoMount` and the `directory` formula's `EndoDirectory`
  (`write` / `makeFile` / `makeDirectory` / `remove` / `move`).

- **Readable view.** Write authority is attenuated away, but the view
  *delegates to live backing*, so **content changes behind it are observable**.
  It is a face, not a copy: `file.readOnly()` returns a `ReadableBlob` that is,
  in the daemon's own words, "a write-disabled face over the live file, not a
  snapshot" (`packages/daemon/src/mount.js`, `makeReadableBlobView`);
  `mount.readOnly()` returns the analogous `ReadableTree`
  (`makeReadableTreeView`). No content-address is offered, because there is no
  fixed content to address. Today these views are **transient** exos, not
  persisted formulas.

- **Snapshot.** Content captured at an instant and frozen. Content-addressed by
  SHA-256; byte-identical on every read for all time; freely dedupable; the
  identity *is* the content. `file.snapshot()` stores the bytes and returns a
  `SnapshotBlob` (`snapshotMountFile` -> `makeReadableBlob(sha256)`);
  `mount.snapshot()` checks the tree into the content store and returns a
  `SnapshotTree` (`snapshotMountTree` -> `makeReadableTree(sha256)`, exo-tagged
  `EndoReadableTree`, carrying `sha256`). These are the `readable-blob` /
  `readable-tree` formulas.

### Why the read surface is shared but the guarantee is not

The two read-only rows deliberately share the **structural read interface** —
`readableBlobMethodGuards` (`help` / `streamBase64` / `text` / `json`) for
bytes and `readableTreeMethodGuards` (`help` / `has` / `list` / `lookup`) for
collections (`packages/platform/src/fs/interfaces.js`). That sharing is
correct: "can read, cannot write" is a genuine common capability shape, and a
caller that only reads should accept either a live view or a snapshot.

What must **not** be shared is the guarantee. A snapshot advertises its stronger
promise by additionally carrying the content-address accessor: `SnapshotBlob`
and `SnapshotTree` add `getInfo()` / `sha256()` (the `{ algorithm, hash, size }`
identity triple), which a live `readOnly()` view does not and cannot offer. So
the presence of a content address is the observable, type-level witness that
distinguishes "immutable snapshot" from "live read-only view" behind the same
read methods. `readOnly` != `snapshot`, made explicit in the type.

## Reconciliation with the existing names

The good news: the **type layer already models the matrix correctly.**
`@endo/platform/fs` (`packages/platform/src/fs/interfaces.js`) documents each
column as a three-tier family:

- Bytes: `ReadableBlob` (shared read surface) -> `SnapshotBlob` (adds `sha256`)
  -> `File` (adds the write surface).
- Collections: `ReadableTree` (shared read surface) -> `SnapshotTree` (adds
  `sha256`) -> `Directory` (adds the write surface).

The lag is entirely in the **daemon formula-type names**, which predate that
vocabulary:

- **`readable-blob` is a SnapshotBlob.** It is the content-addressed immutable
  blob keyed by SHA-256, incarnated by `makeReadableBlob(sha256)` and produced
  by `file.snapshot()` and the content store. Its name says "readable" (the
  generic surface) where it means "snapshot" (the specific guarantee).

- **`readable-tree` is a SnapshotTree.** Same story: content-addressed immutable
  directory keyed by SHA-256, incarnated by `makeReadableTree(sha256)`,
  exo-tagged `EndoReadableTree`, carrying `sha256`.

- **`readable-directory` does not exist.** There is no such formula in
  `formulaTypes` (`packages/daemon/src/formula-type.js`); a repository-wide grep
  finds no `readable-directory` / `ReadableDirectory`. The live read-only view
  of a directory or mount is the **transient** `ReadableTree` returned by
  `mount.readOnly()`, deliberately not a persisted formula — a live view has no
  fixed content identity to persist and is re-derived from its mutable backing
  each session. (The originating prompt lists `readable-directory` among
  "existing" names; that is the discrepancy this section resolves. The intended
  referent is the transient read-only directory view.)

### Target naming

- Snapshot (immutable, content-addressed) formulas: **`snapshot-blob`**,
  **`snapshot-tree`** (renamed from `readable-blob`, `readable-tree`).
- Mutable formulas / exos keep their names: `directory` (`EndoDirectory`),
  `mount` / `scratch-mount` (`EndoMount`), `EndoMountFile`.
- The shared read surface keeps `ReadableBlob` / `ReadableTree` as
  interface/view names.

In the target scheme there is **no `readable-*` formula at all**: "readable"
names an interface and a transient view, "snapshot" names the immutable formula,
and "file" / "directory" name the mutable exo and formula. The three words then
map one-to-one onto the three guarantee rows, and the double duty is gone.

Renaming also **frees** the `readable-blob` / `readable-tree` names, so if a
*persistable* read-only-but-live handle is ever wanted (a durable attenuation a
holder can store and pass on, distinct from today's transient view), those names
become available for it cleanly. That is a possible future formula, not part of
this change (see Open Questions).

## Migration path

A formula's `type` string is persisted verbatim: `formula-record.js` writes
`type: formula.type`, and incarnation switches on it in two places — the record
parser's `switch` (`serializeFormula` / `deserializeFormula` in
`formula-record.js`) and the maker table (`formulaMakerTable` in `manager.js`,
whose `'readable-blob'` / `'readable-tree'` entries call `makeReadableBlob` /
`makeReadableTree`). A rename is therefore a persisted-data-format change and
must stay backward compatible with formula records already on disk.

The content store is unaffected throughout: a snapshot's identity is its SHA-256
content hash, not its formula-type string, so nothing is re-hashed and no dedup
state churns. Formula *identifiers* are content-number/node-keyed (see
`formatId` / `parseId`), not type-keyed, so an existing snapshot's id is stable
across the rename — a holder's persisted reference keeps resolving.

**Phase 1 — dual-accept (no data change).**
1. Add `snapshot-blob` and `snapshot-tree` to the `formulaTypes` set in
   `formula-type.js`, keeping `readable-blob` and `readable-tree`.
2. Introduce a single canonical alias map (`readable-blob -> snapshot-blob`,
   `readable-tree -> snapshot-tree`) applied at the one parse boundary in
   `formula-record.js`, and register both the old and new keys in the
   `manager.js` maker table and the record serializer `switch`. Every record
   already on disk still incarnates; new records may be written under either
   name.

**Phase 2 — write the new name.**
3. Formulation of a new snapshot writes `type: 'snapshot-blob'` /
   `'snapshot-tree'`. Old on-disk records keep their old string and are read
   through the alias, so **no bulk rewrite is required**.
4. Rename the daemon snapshot exo tag `EndoReadableTree` -> `EndoSnapshotTree`
   and give the blob snapshot the matching `EndoSnapshotBlob` tag. This makes
   the two read-only forms distinguishable by exo tag: `mount.readOnly()` keeps
   returning `M.remotable('ReadableTree')` (a live view), while `snapshot()`
   returns the snapshot-tagged exo (interfaces.js `readOnly` / `snapshot`
   method guards). Update the in-tree doc references that say "readable-tree
   capability" in lockstep (for example the `EndoRegistry.fetch` / `lookup`
   comments in `interfaces.js`, and `help.md`).

**Phase 3 — deprecate the old string.**
5. After a release window, stop *writing* the old names entirely (already true
   after Phase 2) and either keep the read-time alias indefinitely (recommended;
   it costs nothing because identity is content-keyed) or run a one-time
   migration pass that rewrites the `type` field of old records in place. The
   alias makes the rewrite optional.

Each phase that touches the exo guards or the maker table needs its own
daemon-test validation pass, per the convention in
[fs-interface-consolidation.md](fs-interface-consolidation.md).

## Dependencies

| Design | Relationship |
|---|---|
| [fs-interface-consolidation.md](fs-interface-consolidation.md) | Established the `ReadableBlob`/`SnapshotBlob`/`File` and `ReadableTree`/`SnapshotTree`/`Directory` type-tiers (§ C2/C3/C4) this design elevates to the formula-name layer. |
| [fs-interface-reconciliation.md](fs-interface-reconciliation.md) | Unified the read-method names/signatures the shared surface depends on. |
| [daemon-mount.md](daemon-mount.md), [daemon-mount-capabilities.md](daemon-mount-capabilities.md) | Define `EndoMount` / `EndoMountFile`, `readOnly()`, and `snapshot()` — the live and snapshot producers this matrix names. |
| [readableblob-range-attenuation.md](readableblob-range-attenuation.md) | The range-I/O attenuation of the readable-blob surface; consumer of the blob naming. |
| [npm-registry-as-directory-tree.md](npm-registry-as-directory-tree.md) | Consumes `readable-tree` (SnapshotTree) fixtures; a downstream user of the renamed formula. |

## Design Decisions

1. **Keep the read surface shared; distinguish the guarantee by the content
   address.** A snapshot carries `getInfo()` / `sha256()`; a live read-only view
   does not. This makes `readOnly` != `snapshot` a type-level fact rather than a
   naming convention, answering the review comment directly.

2. **Rename the immutable formulas to `snapshot-*`, not the mutable or view
   forms.** The mistake is localized to the two snapshot formula names; File,
   Directory, and the Readable view interfaces are already correct. Minimal,
   targeted rename.

3. **No `readable-*` formula in the target scheme.** "Readable" is an interface
   and a transient view; it should not also be a persisted formula-type,
   precisely because that is the collision being removed.

4. **Read-time alias over bulk rewrite.** Because snapshot identity is
   content-keyed, an alias is free and permanent; a destructive rewrite of
   persisted records is neither necessary nor worth its risk.

## Open Questions

- Should a **persistable live read-only handle** exist (reusing the freed
  `readable-blob` / `readable-tree` names as live-view formulas), or does the
  transient `readOnly()` view suffice? Recommendation: keep the view transient
  and add a persistable readable formula only when a concrete need appears.
- Permanent read-time **alias** vs. a one-time **migration pass** for old
  persisted records? Recommendation: permanent alias (identity is content-keyed,
  so there is no functional cost).
- Should the **mutable** rows (`File`, `Directory` / `EndoMount`) gain a
  `getInfo()`-style content address of their *current* state, so the identity
  accessor is uniform across all three rows (a live blob would report the hash
  of its bytes right now)? This would let a caller content-address any handle
  without feature-detecting snapshot vs. live, at the cost of a hash on demand
  over mutable backing.
- Is `EndoSnapshotBlob` / `EndoSnapshotTree` the desired exo-tag spelling, or
  should the tags stay `EndoReadable*` for compatibility with any external
  consumer that matches on the tag string?

## Prompt

> Design and name the daemon capability matrix spanning readable views,
> immutable snapshots, and mutable forms of files/blobs and trees/directories.
> Make the distinct guarantees explicit: a read-only view attenuates write
> authority but may observe changes behind it, while a snapshot guarantees
> immutable captured content. Reconcile the terminology with existing
> `readable-blob`, `readable-tree`, and `readable-directory` formula names and
> identify an implementable migration path.
>
> Source: trusted maintainer review comment
> endojs/endo-but-for-bots#1125 (`packages/daemon/src/manager.js` line 6804).
