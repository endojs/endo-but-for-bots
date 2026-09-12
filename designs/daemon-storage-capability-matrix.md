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

Throughout, a *formula* is a persisted, on-disk capability record whose `type`
string names the kind of capability; the daemon *incarnates* it (turns the
record back into a live capability) by dispatching on that `type` through a
maker table. An *exo* is the hardened remotable object a formula incarnates to.
Renaming a formula type is therefore a persisted-data concern, not a bare string
swap: records already on disk carry the old `type` string and must keep
incarnating.

The review comment that prompted this design puts it precisely:

> I note that `readOnly` is not the same as `snapshot`, which would provide a
> further guarantee of immutability behind the read only view.

A `readOnly()` view attenuates write authority but is a *face over live
backing*: content can change behind it, and two reads may differ. A
`snapshot()` captures content at a moment and freezes it, byte-identical on
every read, forever, content-addressed. These are different guarantees wearing
the same read surface, and the formula names give the immutable one the generic
"readable" name, which is exactly the collision.

This design names every cell of the matrix, states each guarantee explicitly,
reconciles the names with the existing `readable-blob` / `readable-tree`
snapshot formulas (and with the in-flight `readable-directory` live-view formula
on endojs/endo-but-for-bots#1125), and gives an implementable migration path.

## The matrix

Two axes. **Shape** across the top (leaf bytes vs. named collection); **mutation
guarantee** down the side.

| Guarantee \ Shape | Bytes (leaf) | Collection (container) |
|---|---|---|
| **Mutable** (read + write, live) | **File** (`EndoMountFile`) | **Directory** (`EndoMount`, `directory` formula / `EndoDirectory`) |
| **Readable view** (read-only, live) | **ReadableBlob** view (`file.readOnly()`) | **ReadableTree** view (`mount.readOnly()`) |
| **Snapshot** (read-only, immutable, content-addressed) | **SnapshotBlob**: formula `snapshot-blob` (today `readable-blob`) | **SnapshotTree**: formula `snapshot-tree` (today `readable-tree`) |

The guarantees, stated so a caller knows what it holds:

- **Mutable.** Full read + write over live backing storage. The holder can
  observe and change content. For bytes: `EndoMountFile` (`writeText` /
  `append` / `writeBytes`). For collections the daemon exposes two related
  mutable exos: `EndoDirectory` (the `directory` formula's incarnation) is the
  content-addressed directory capability, and `EndoMount` is the filesystem-backed
  mount that layers on top of it; both carry the same write surface (`write` /
  `makeFile` / `makeDirectory` / `remove` / `move`). A caller typically holds
  one or the other — `EndoMount` for a live host directory, `EndoDirectory` for
  a daemon-managed collection — not both nested; the matrix names the capability
  shape they share, and the two spellings are called out here precisely because
  the cell carries both.

- **Readable view.** Write authority is attenuated away, but the view
  *delegates to live backing*, so **content changes behind it are observable**.
  It is a face, not a copy: `file.readOnly()` returns a `ReadableBlob` that is,
  in the daemon's own words, "a write-disabled face over the live file, not a
  snapshot" (`packages/daemon/src/mount.js`, `makeReadableBlobView`);
  `mount.readOnly()` returns the analogous `ReadableTree`
  (`makeReadableTreeView`). No *stable* content identity is offered. The two
  shape columns differ in how that shows up, and the difference is worth stating
  precisely (the mechanism is spelled out in the next subsection): the blob view
  is built on `ReadableBlobRangeInterface` and so *does* expose `getInfo()`, but
  it hashes whatever the backing holds at the moment of the call, a current-state
  fingerprint rather than a fixed address, and carries no `sha256()`; the tree
  view is built on the plain `ReadableTreeInterface` and carries **neither
  `getInfo()` nor `sha256()`** (`packages/platform/src/fs/interfaces.js`). So for
  bytes the `sha256()` method alone separates snapshot from view, while for
  collections the mere presence of `getInfo()` already does. Today these views
  are **transient** exos, not persisted formulas. (One in-flight exception for
  collections — the `readable-directory` formula on endojs/endo-but-for-bots#1125
  — is reconciled in § "Reconciliation with the existing names".)

- **Snapshot.** Content captured at an instant and frozen. Content-addressed by
  SHA-256; byte-identical on every read for all time; freely dedupable; the
  identity *is* the content. `file.snapshot()` stores the bytes and returns a
  `SnapshotBlob` (`snapshotMountFile` -> `makeReadableBlob(sha256)`);
  `mount.snapshot()` checks the tree into the content store and returns a
  `SnapshotTree` (`snapshotMountTree` -> `makeReadableTree(sha256)`, exo-tagged
  `EndoReadableTree`, carrying `sha256`). These are the `readable-blob` /
  `readable-tree` formulas.

### Why the read surface is shared but the guarantee is not

The two read-only rows deliberately share the **structural read interface**:
`readableBlobMethodGuards` (`help` / `streamBase64` / `text` / `json`) for
bytes and `readableTreeMethodGuards` (`help` / `has` / `list` / `lookup`) for
collections (`packages/platform/src/fs/interfaces.js`). That sharing is
correct: "can read, cannot write" is a genuine common capability shape, and a
caller that only reads should accept either a live view or a snapshot.

What must **not** be shared is the guarantee. A snapshot advertises its stronger
promise by additionally carrying the `sha256()` method. `SnapshotBlobInterface`
and `SnapshotTreeInterface` each add `sha256` (and spread `getInfoMethodGuard`)
in `packages/platform/src/fs/interfaces.js`. The `sha256()` method is therefore
present on both snapshot interfaces and on neither live-view interface. It is the
observable type-level witness that distinguishes "immutable snapshot" from "live
read-only view" behind the same read methods, and it is the one witness that
works uniformly across both shape columns.

`getInfo()` is a weaker and column-dependent signal. interfaces.js calls it the
*uniform* content-address accessor, and for bytes it is carried by a live
read-only blob view too: `file.readOnly()` returns a `ReadableBlob` on
`ReadableBlobRangeInterface` whose `getInfo()` hashes the file's *current* bytes
(`packages/daemon/src/mount.js`, `makeReadableBlobView`). For collections it is
not: the live tree view `mount.readOnly()` is on the plain `ReadableTreeInterface`,
which carries no `getInfo()` at all, so there the mere *presence* of `getInfo()`
already separates a `SnapshotTree` from the view. This asymmetry is why
`sha256()`, not `getInfo()`, is named as the canonical witness: for blobs
`getInfo()` is shared by view and snapshot alike, and only the *meaning* of its
hash differs — a live view's `getInfo().hash` tracks mutating backing and may
differ between calls, while a snapshot's `sha256()` is fixed for all time and
*is* the cap's identity. So `readOnly` != `snapshot` is a type-level fact (the
`sha256()` method) backed by a semantic one (permanent identity vs. current-state
fingerprint), not merely the presence of a content address.

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

- **`readable-directory` is a persisted live read-only directory view, landing
  on the in-flight endojs/endo-but-for-bots#1125.** On this design's base
  (`llm`) there is no such formula in `formulaTypes`
  (`packages/daemon/src/formula-type.js`), and the live read-only view of a
  directory or mount is the **transient** `ReadableTree` returned by
  `mount.readOnly()`. But #1125 — the review thread this design cites as its own
  **Source** — renames `read-only-directory` to `readable-directory` (commit
  `4743e382b`, "name readable directory formula consistently") and ships it as a
  *real, persisted* formula: `manager.js`'s maker table gains
  `'readable-directory': async ({ directory }, ...) => makeExo('ReadableNameHub',
  ...)`, a write-disabled view wrapping a *live* `directory` capability. That is
  not a snapshot — it is content-address-free and delegates to mutable backing —
  so it belongs in the **Readable view** row of the Collection column, as the
  **persisted** counterpart of the transient `mount.readOnly()` view (exactly the
  "persistable live read-only handle" this design's Open questions contemplates,
  already being built for collections). Two consequences for this design:
  - It does **not** collide with the `readable-* -> snapshot-*` rename: that
    rename touches only the two *snapshot* formulas (`readable-blob`,
    `readable-tree`); `readable-directory` is a distinct guarantee (live view, not
    snapshot) and keeps its name.
  - It is an **ordering dependency**: once #1125 merges, `readable-directory` is a
    live formula type on `llm`, so the migration plan's Phase 1 `formulaTypes`
    and alias edits must be written against a tree that already contains it
    (leaving it untouched), and Design decision 3 below is scoped accordingly. If
    this design is picked up before #1125 merges, re-confirm the
    `readable-directory` name and shape against #1125's then-current head before
    editing `formula-type.js`.

### Target naming

- Snapshot (immutable, content-addressed) formulas: **`snapshot-blob`**,
  **`snapshot-tree`** (renamed from `readable-blob`, `readable-tree`).
- Mutable formulas / exos keep their names: `directory` (`EndoDirectory`),
  `mount` / `scratch-mount` (`EndoMount`), `EndoMountFile`.
- The shared read surface keeps `ReadableBlob` / `ReadableTree` as
  interface/view names.

In the target scheme there is **no `readable-*` *snapshot* formula**: "snapshot"
names the immutable formula, "file" / "directory" name the mutable exo and
formula, and "readable" is reserved for the read-only *view* layer — the shared
interface, the transient `readOnly()` view, and (per #1125, above) the persisted
`readable-directory` live-view formula. The double duty that prompted this design
— "readable" naming the *immutable snapshot* — is what goes away; "readable"
naming a *live read-only view* is consistent and stays. The words then map onto
the guarantee rows: `snapshot-*` for the immutable row, `file` / `directory` /
`mount` for the mutable row, and `readable-*` (interface, transient view, and the
`readable-directory` formula) for the live read-only row.

Renaming frees the `readable-blob` / `readable-tree` names specifically, so if a
*persistable* read-only-but-live **blob** or **tree** handle is ever wanted (the
bytes/collection analogs of #1125's `readable-directory`, a durable attenuation a
holder can store and pass on, distinct from today's transient view), those names
become available for it cleanly. That is a possible future formula, not part of
this change (see Open questions).

**A note on the shape-axis root names.** The three-tier family spells its root
differently across the two columns: `File` -> `ReadableBlob` -> `SnapshotBlob`
for bytes, but `Directory` -> `ReadableTree` -> `SnapshotTree` for collections.
So `someFile.readOnly()` yields a `ReadableBlob` (not a `ReadableFile`) and
`someMount.readOnly()` yields a `ReadableTree` (not a `ReadableDirectory`). This
design deliberately does **not** touch that split: it is inherited from the
already-shipped `@endo/platform/fs` type tiers (`Blob`/`Tree` name the *read
surface* over raw bytes and raw entries; `File`/`Directory`/`Mount` name the
*mutable* caps), it is orthogonal to the guarantee-axis collision this design
exists to fix, and renaming it would be a far larger, consumer-breaking change
for no guarantee-clarity gain. It is recorded here so a reader is not surprised
that sibling `readOnly()` calls across the two shapes do not spell similarly.

## Migration path

A formula's `type` string is persisted verbatim: `makeFormulaRecord`
(`formula-record.js`) writes `type: formula.type` into the public
`FormulaRecord`. Its own `switch (formula.type)` does **not** validate the type
— its `default` case is an explicit, commented forward-compatibility fallthrough
that renders an unknown type as an empty-properties record rather than rejecting
it. The actual validation gate is `assertValidFormulaType` against the
`formulaTypes` set in `formula-type.js`, which Phase 1 step 1 targets.
Incarnation then switches on the persisted string in two places. First, the maker
table `makers` (typed `FormulaMakerTable`, in `manager.js`), whose
`'readable-blob'` / `'readable-tree'` entries call `makeReadableBlob` /
`makeReadableTree`. Second, the few direct `formula.type === 'readable-blob'` /
`'readable-tree'` branches in `manager.js`. A rename is therefore a
persisted-data-format change and must stay backward compatible with formula
records already on disk.

The persisted `type` also escapes the daemon unaliased through the public
`FormulaRecord`, and **non-`manager.js` consumers match on the literal string**:
`packages/spaces-util/src/formula-view-registry.js` keys its UI-view lookup table
on `'readable-blob'` / `'readable-tree'` (lines 190, 195), and
`packages/cli/src/commands/list.js` keys the `endo list` "Directories" grouping
set the same way (line 61). An alias applied only *before* the incarnation
dispatch (as Phase 1 scopes it) does not reach these: a *new* record written as
`snapshot-blob` / `snapshot-tree` would carry that string straight through
`FormulaRecord.type` to these registries, which do not recognize it, silently
mis-grouping or defaulting the view for every newly-created snapshot. The
migration plan must therefore normalize at the point where `FormulaRecord.type`
is computed (so every external consumer sees one canonical name regardless of
on-disk vintage) **and** update these two registries; both are called out as
explicit steps below.

The content store is unaffected throughout: a snapshot's identity is its SHA-256
content hash, not its formula-type string, so nothing is re-hashed and no dedup
state churns. Formula *identifiers* are content-number/node-keyed (see
`formatId` / `parseId`), not type-keyed, so an existing snapshot's id is stable
across the rename: a holder's persisted reference keeps resolving.

**Phase 1: dual-accept (no data change).**
1. Add `snapshot-blob` and `snapshot-tree` to the `formulaTypes` set in
   `formula-type.js`, keeping `readable-blob` and `readable-tree`.
2. Introduce a single canonical alias map (`readable-blob -> snapshot-blob`,
   `readable-tree -> snapshot-tree`) and apply it at **both** boundaries where a
   persisted `type` leaves the store:
   - before the `makers` lookup in `manager.js` (and the direct
     `formula.type ===` branches), so an old on-disk record incarnates as the new
     type; and
   - where `makeFormulaRecord` computes `FormulaRecord.type`, so the public
     record always surfaces the canonical `snapshot-*` name regardless of the
     on-disk vintage, and every external consumer (the view registry, the CLI
     listing) sees exactly one name.
   Backward compatibility then rides on this one alias map, not on dual
   key-registration: the `makers` table and the `formula-type.js` set need only
   the new `snapshot-*` keys, and the records `makeFormulaRecord` *writes* carry
   only the new names. Every record already on disk still incarnates, and still
   presents a recognized `FormulaRecord.type`, through the alias.

**Phase 2: write the new name.**
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
   comments in `interfaces.js`, and `help.md`). Whether the exo-tag string is
   itself a compatibility surface an external consumer matches on is deferred to
   Open questions; if so, this step stays behind the alias and keeps the old tag
   reachable rather than renaming in place.
5. Re-key the literal-string consumers of `FormulaRecord.type` to the canonical
   `snapshot-*` names: the view table in
   `packages/spaces-util/src/formula-view-registry.js` (lines 190, 195) and the
   "Directories" grouping set in `packages/cli/src/commands/list.js` (line 61).
   Because step 2's record-side alias already presents the canonical name, these
   consumers need only the new keys; keeping the old keys as well is belt-and-suspenders
   for any record whose `type` somehow bypasses the alias. A repo-wide grep for
   the literal `'readable-blob'` / `'readable-tree'` strings (not just the
   `manager.js` read path) gates this step — any other pattern-matching consumer
   found must be enumerated here before the rename is considered complete.

**Phase 3: deprecate the old string.**
5. After a release window, stop *writing* the old names entirely (already true
   after Phase 2) and either keep the read-time alias indefinitely (recommended;
   it costs nothing because identity is content-keyed) or run a one-time
   migration pass that rewrites the `type` field of old records in place. The
   alias makes the rewrite optional.

Each phase that touches the exo guards or the maker table needs its own
daemon-test validation pass, per the convention in
[fs-interface-consolidation.md](fs-interface-consolidation.md). The single
most load-bearing case — because the Phase 1 alias *is* the entire backward
compatibility guarantee — is the old-record round-trip: a formula record written
with `type: 'readable-blob'` (the pre-rename on-disk shape) must both incarnate
through the alias to the `snapshot-blob` maker **and** present
`FormulaRecord.type === 'snapshot-blob'` to the view/CLI registries after step 2,
with the same assertion for `readable-tree` / `snapshot-tree`. Add it explicitly
alongside the existing `packages/daemon/test/formula-type.test.js` registered-type
checks (and exercise the record surface via
`packages/daemon/test/formula-record.test.js`) rather than leaving it to the
general convention; the alias has no value that a test does not pin.

## Dependencies

| Design | Relationship |
|---|---|
| [fs-interface-consolidation.md](fs-interface-consolidation.md) | Established the `ReadableBlob`/`SnapshotBlob`/`File` and `ReadableTree`/`SnapshotTree`/`Directory` type-tiers (§ C2/C3/C4) this design elevates to the formula-name layer. |
| [fs-interface-reconciliation.md](fs-interface-reconciliation.md) | Unified the read-method names/signatures the shared surface depends on. |
| [daemon-mount.md](daemon-mount.md), [daemon-mount-capabilities.md](daemon-mount-capabilities.md) | Define `EndoMount` / `EndoMountFile`, `readOnly()`, and `snapshot()`: the live and snapshot producers this matrix names. |
| [readableblob-range-attenuation.md](readableblob-range-attenuation.md) | The range-I/O attenuation of the readable-blob surface; consumer of the blob naming. |
| [npm-registry-as-directory-tree.md](npm-registry-as-directory-tree.md) | Consumes `readable-tree` (SnapshotTree) fixtures; a downstream user of the renamed formula. |
| endojs/endo-but-for-bots#1125 (the Source PR) | Ships the persisted `readable-directory` live-view formula (commit `4743e382b`); an ordering dependency for the migration plan, reconciled in § "Reconciliation with the existing names". |

## Design Decisions

1. **Keep the read surface shared; distinguish the guarantee by the `sha256()`
   method.** A snapshot carries `sha256()` (a hash fixed for all time); a live
   read-only view does not. `getInfo()` is *not* the canonical distinguisher: it
   is the uniform content-address accessor, carried by a live *blob* view too
   (where its hash tracks the mutating backing) though absent from the live *tree*
   view, so only `sha256()` separates snapshot from view across both shape
   columns uniformly. This makes `readOnly` != `snapshot` a type-level fact rather
   than a naming convention, answering the review comment directly.

2. **Rename the immutable formulas to `snapshot-*`, not the mutable or view
   forms.** The mistake is localized to the two snapshot formula names; File,
   Directory, and the Readable view interfaces are already correct. Minimal,
   targeted rename.

3. **No `readable-*` *snapshot* formula in the target scheme.** "Readable" names
   the read-only *view* layer — an interface, the transient `readOnly()` view,
   and the persisted `readable-directory` live-view formula (#1125). It must not
   *also* name a persisted *immutable snapshot*, because conflating a live view
   with a frozen snapshot is precisely the collision being removed. A persisted
   `readable-*` cap is legitimate when it is a genuine live read-only view (as
   `readable-directory` is); what the rename forbids is a `readable-*` name on the
   content-addressed snapshot forms.

4. **Read-time alias over bulk rewrite.** Because snapshot identity is
   content-keyed, an alias is free and permanent; a destructive rewrite of
   persisted records is neither necessary nor worth its risk.

## Open questions

- Should a **persistable live read-only handle** exist for *bytes*, reusing the
  freed `readable-blob` name as a live-view formula, or does the transient
  `file.readOnly()` view suffice? For collections this is no longer open: #1125's
  `readable-directory` formula *is* exactly such a persisted live read-only view.
  The symmetry question is whether a persisted `readable-blob` live view should
  follow. Recommendation: keep the blob view transient and add the persisted form
  only when a concrete need appears, mirroring `readable-directory` if it does.
- Permanent read-time **alias** vs. a one-time **migration pass** for old
  persisted records? Recommendation: permanent alias (identity is content-keyed,
  so there is no functional cost).
- Should the **mutable** rows (`File`, `Directory` / `EndoMount`) expose a
  `getInfo()` fingerprint of their *current* state, so the accessor is uniform
  across all three rows? A partial precedent already exists one row up, on the
  read-only view: `file.readOnly()` returns a live `ReadableBlob` that implements
  `getInfo()` over the current bytes today (`mount.js`, `makeReadableBlobView`),
  and that view delegates to the very mutable `EndoMountFile` this question asks
  about — so the mutable file's current bytes are *already* fingerprintable, just
  through its read-only face rather than on the mutable cap directly. The hazard
  is that treating
  such a fingerprint as a "content address" re-introduces the exact
  state/identity conflation this design removes: a hash that changes with content
  is not an identity. Any uniform accessor must therefore be documented as a
  current-state fingerprint, explicitly distinct from the stable `sha256()`
  snapshot identity, or the collision returns under a new name. Recommendation:
  keep `sha256()` (stable identity) snapshot-only; name any current-state
  fingerprint separately.
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
