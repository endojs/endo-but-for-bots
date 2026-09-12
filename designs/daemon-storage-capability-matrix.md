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
daemon *formula types* (the persisted `type` strings on stored capability
records, defined just below) `readable-blob` and `readable-tree` are in fact the
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

## The Matrix

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
  one or the other (`EndoMount` for a live host directory, `EndoDirectory` for
  a daemon-managed collection), not both nested; the matrix names the capability
  shape they share, and the two spellings are called out here precisely because
  the cell carries both. **Backing store** (the content-addressed object store vs.
  the host filesystem) is an *orthogonal third variable*, deliberately out of this
  matrix's scope: `EndoMount` is composition layered over `EndoDirectory`, not a
  distinct guarantee/shape cell of its own. The matrix's two axes are guarantee
  and shape; where a mutable collection is backed is a separate concern, surfaced
  here only because this single cell has the two spellings and a reader must not
  mistake `EndoMount` for a third guarantee level.

- **Readable view.** Write authority is attenuated away, but the view
  *delegates to live backing*, so **content changes behind it are observable**.
  It is a face, not a copy: `file.readOnly()` returns a `ReadableBlob` that is,
  in the daemon's own words, "a write-disabled face over the live file, not a
  snapshot" (`packages/daemon/src/mount.js`, `makeReadableBlobView`);
  `mount.readOnly()` returns the analogous `ReadableTree`
  (`makeReadableTreeView`). No *stable* content identity is offered. The two
  shape columns differ in how that shows up, and the difference is worth stating
  precisely (the mechanism, and an important daemon-vs-type-layer caveat, is
  spelled out in the next subsection): the blob view is built on
  `ReadableBlobRangeInterface` and so *does* expose `getInfo()`, but it hashes
  whatever the backing holds at the moment of the call, a current-state
  fingerprint rather than a fixed address, and carries no `sha256()`; the plain
  `ReadableTreeInterface` at the platform type-tier layer carries **neither
  `getInfo()` nor `sha256()`** (`packages/platform/src/fs/interfaces.js`). So in
  the `@endo/platform/fs` type tiers the `sha256()` method separates snapshot from
  view for bytes, while for collections the mere presence of `getInfo()` already
  does. The daemon's *concrete* exos have not yet fully adopted that split (the
  snapshot-blob exo carries no `sha256()` today), and closing that gap is a named
  migration step; the next subsection states it precisely. Today these views are
  **transient** exos, not persisted formulas. (One in-flight exception for
  collections, the `readable-directory` formula on endojs/endo-but-for-bots#1125,
  is reconciled in § "Reconciliation with the Existing Names".)

- **Snapshot.** Content captured at an instant and frozen. Content-addressed by
  SHA-256; byte-identical on every read for all time; freely dedupable; the
  identity *is* the content. `file.snapshot()` stores the bytes and returns a
  `SnapshotBlob` (`snapshotMountFile` -> `makeReadableBlob(sha256)`);
  `mount.snapshot()` checks the tree into the content store and returns a
  `SnapshotTree` (`snapshotMountTree` -> `makeReadableTree(sha256)`, exo-tagged
  `EndoReadableTree`, carrying `sha256`). These are the `readable-blob` /
  `readable-tree` formulas.

### Why the Read Surface Is Shared but the Guarantee Is Not

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
hash differs: a live view's `getInfo().hash` tracks mutating backing and may
differ between calls, while a snapshot's `sha256()` is fixed for all time and
*is* the cap's identity. So `readOnly` != `snapshot` is a type-level fact (the
`sha256()` method) backed by a semantic one (permanent identity vs. current-state
fingerprint), not merely the presence of a content address.

One caveat, load-bearing for the migration: this clean `sha256()` split holds at
the `@endo/platform/fs` **type-tier** layer, not yet in the daemon's *concrete*
exos. The daemon's snapshot-blob exo (`makeReadableBlob`, `manager.js`) is guarded
by the daemon's own `BlobInterface` (`packages/daemon/src/interfaces.js`), which
is exactly `readableBlobMethodGuards` plus the range-I/O `rangeReadMethodGuards`
and carries **no** `sha256()` method, reporting the content hash only through
`getInfo().hash`. So at the daemon exo layer a snapshot blob and a live blob view
expose the *same* method set and are **not** distinguished by `sha256()` today.
(For collections the daemon's snapshot-tree exo does carry `sha256()`, via its
`EndoReadableTree` interface.) Realizing the byte-column witness at the daemon
therefore requires an explicit change, called out as a step in Phase 2 below;
until it lands, the byte-column split is semantic (permanent identity vs.
current-state fingerprint) rather than type-level.

## Reconciliation with the Existing Names

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
  `mount.readOnly()`. But #1125 (the review thread this design cites as its own
  **Source**) renames `read-only-directory` to `readable-directory` (commit
  `4743e382b`, "name readable directory formula consistently") and ships it as a
  *real, persisted* formula: `manager.js`'s maker table gains
  `'readable-directory': async ({ directory }, ...) => makeExo('ReadableNameHub',
  ...)`, a write-disabled view wrapping a *live* `directory` capability. That is
  not a snapshot (it is content-address-free and delegates to mutable backing),
  so it belongs in the **Readable view** row of the Collection column, as the
  **persisted** counterpart of the transient `mount.readOnly()` view (exactly the
  "persistable live read-only handle" this design's Open Questions contemplates,
  already being built for collections). One naming wrinkle worth surfacing, since
  unifying this vocabulary is exactly what this design is for: the Readable-view /
  Collection cell is now spelled **three** different ways across its tiers: the
  shared read *interface* is `ReadableTree`, the *transient* `mount.readOnly()`
  view is also tagged `ReadableTree`, but the *persisted* `readable-directory`
  formula incarnates to `makeExo('ReadableNameHub', ...)` (a name inherited from
  the pre-existing name-hub exo it wraps, not coined by #1125). This design does
  **not** propose renaming `ReadableNameHub` (it is #1125's surface and out of
  this rename's blast radius, which is confined to the two *snapshot* formulas),
  but it records the divergence here so a reader who learns "Readable-view tree =
  `ReadableTree`" is not surprised that the persisted view's exo tag reads
  differently; aligning that tag is a candidate follow-up, tracked in Open
  Questions. Two consequences for this design:
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

### Target Naming

- Snapshot (immutable, content-addressed) formulas: **`snapshot-blob`**,
  **`snapshot-tree`** (renamed from `readable-blob`, `readable-tree`).
- Mutable formulas / exos keep their names: `directory` (`EndoDirectory`),
  `mount` / `scratch-mount` (`EndoMount`), `EndoMountFile`.
- The shared read surface keeps `ReadableBlob` / `ReadableTree` as
  interface/view names.

In the target scheme there is **no `readable-*` *snapshot* formula**: "snapshot"
names the immutable formula, "file" / "directory" name the mutable exo and
formula, and "readable" is reserved for the read-only *view* layer: the shared
interface, the transient `readOnly()` view, and (per #1125, above) the persisted
`readable-directory` live-view formula. The double duty that prompted this design
("readable" naming the *immutable snapshot*) is what goes away; "readable"
naming a *live read-only view* is consistent and stays. The words then map onto
the guarantee rows: `snapshot-*` for the immutable row, `file` / `directory` /
`mount` for the mutable row, and `readable-*` (interface, transient view, and the
`readable-directory` formula) for the live read-only row.

Renaming stops *writing* the `readable-blob` / `readable-tree` names, so if a
*persistable* read-only-but-live **blob** or **tree** handle is ever wanted (the
bytes/collection analogs of #1125's `readable-directory`, a durable attenuation a
holder can store and pass on, distinct from today's transient view), the words
themselves become semantically available for it. **But there is a hard
constraint the reader must not miss:** reusing the literal `readable-blob` /
`readable-tree` *strings* for a new live-view formula is **mutually exclusive**
with the permanent read-time alias this design recommends in Phase 3 and Design
decision 4. While that alias is live, any record written `type: 'readable-blob'`
is rewritten to `snapshot-blob` before both incarnation and record-formation, so
a new live-view formula that tried to claim the old string would be silently
incarnated as a *snapshot* and collide in the maker table: the string is not
actually free while the alias exists. The two are therefore genuinely
alternatives, not both-costless recommendations: either (a) keep the permanent
alias (recommended) and give any future live-view blob/tree formula a **new,
distinct name** (e.g. `readable-blob-view` / `readable-tree-view`, or the
`readable-directory`-style spelling extended to the other shapes), never the
retired string; or (b) if the old strings must be *literally* reused, make
retiring the alias (the one-time migration-pass branch of Phase 3, which stops
rewriting old records) a hard precondition first. This design recommends (a).
That future formula is not part of this change (see Open Questions).

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
that sibling `readOnly()` calls across the two shapes return types that are not
spelled alike.

## Migration Path

A formula's `type` string is persisted verbatim: `makeFormulaRecord`
(`formula-record.js`) writes `type: formula.type` into the public
`FormulaRecord`. Its own `switch (formula.type)` does **not** validate the type:
its `default` case is an explicit, commented forward-compatibility fallthrough
that renders an unknown type as an empty-properties record rather than rejecting
it. But the switch is **not** inert on the renamed types: it carries a
`case 'readable-blob':` (`formula-record.js`) that copies `formula.content` into
`properties.content` (the `ReadableBlobFormula.content` field surfaced on the
public record, `types.d.ts`). This is one more `formula.type`-keyed dispatch
site, inside `makeFormulaRecord` itself, alongside the several `manager.js` sites
enumerated below. Because `makeFormulaRecord`'s sole caller (`host.js:2367`) feeds
it a `getFormulaForId` result, the single deserialization-point alias (Phase 1
step 2) already presents it a canonical `snapshot-*` formula, so its `case` must
recognize `snapshot-*`: Phase 1 makes the `case` dual-accept both spellings
(matching an old aliased record and a freshly-minted Phase-1 `readable-blob`
alike), and Phase 2 step 3 narrows it to `'snapshot-blob'` once the writer flips.
Were the `case` left reading `'readable-blob'` after the alias lands, it would
stop matching an aliased old record and silently drop the `content` property to
the empty-record `default`. (There is no matching `readable-tree` case: the
tree column carries no per-record `content` property, so this site is
blob-specific.) The actual validation gate is `assertValidFormulaType` against the
`formulaTypes` set in `formula-type.js`, which Phase 1 step 1 targets.
Incarnation, and every other in-daemon read of the persisted string, flows
through a **single deserialization point**: `getFormulaForId`
(`packages/daemon/src/manager.js:1261`) is the memoizing reader that turns a
`persistencePowers.readFormula` result into the in-memory `Formula` object every
consumer then dispatches on, caching it in the `formulaForId` map it populates
(at `manager.js:1274`, and on the eager-populate path that also calls
`readFormula` at `manager.js:1399`/`1410`). The `formula.type` dispatch sites are
more numerous than "the maker table plus a couple of branches", and enumerating
them exhaustively is what an earlier round of this design got wrong:

- the maker table `makers` (typed `FormulaMakerTable`, in `manager.js`), whose
  `'readable-blob'` / `'readable-tree'` entries call `makeReadableBlob` /
  `makeReadableTree`;
- `getTypeForId` (`manager.js:1281`) and the `getFormulaType` accessor
  (`manager.js:6795`, `id => formulaForId.get(id)?.type`), whose result is
  surfaced out through `directory.js`'s `locate()` / `followNameChanges()` to
  `packages/cli/src/commands/list.js`'s `typeForPetName` (feeding
  `INVENTORY_GROUPS` / `groupForType` for `endo list --grouped`) and to
  `packages/space-chat/src/inventory/tree-source.js`;
- `collectFormulaHashes` (`manager.js:1084`), a `formula.type === 'readable-blob'`
  / `'readable-tree'` test that feeds the content-store GC survivor/candidate
  accounting in `reclaimCollectedStorage` (it decides whether a snapshot's content
  hash is registered as reachable; a miss can sweep a hash a live snapshot still
  needs);
- `getContentIdentityForId` (`manager.js:1300`), backing the
  content-locator / magnet-URN path (`designs/endo-content-locators-magnet-urn.md`),
  which returns `undefined` for any type its `=== 'readable-blob'` /
  `'readable-tree'` tests do not match;
- `extractLabeledDeps` (`manager.js:717`), whose `case 'readable-tree': return [];`
  is harmless *only* because it and the `default` both return `[]` today, but is
  the same class of dispatch that falls out of sync on a rename and so is rekeyed
  in lockstep below; and
- the `case 'readable-blob':` inside `makeFormulaRecord` (`formula-record.js`,
  discussed above) that populates `properties.content`.

The lesson the earlier round missed is that these are not two boundaries to be
patched independently but one invariant to be established once: **the in-memory
`formula.type` must be canonical (`snapshot-*`) for every object in
`formulaForId`, whatever its on-disk vintage.** Aliasing only "before the `makers`
lookup" and "at the top of `makeFormulaRecord`" leaves `getTypeForId` /
`getFormulaType`, `collectFormulaHashes`, and `getContentIdentityForId` reading
the raw on-disk string, so once records carry `snapshot-*` those sites would
mis-group a directory snapshot into the `endo list --grouped` fallback bucket,
drop a new snapshot's content hash from the GC survivor set (a data-loss window
if a legacy sibling shares that hash), and return `undefined` content-identity
for every new snapshot. [proposed-rule, from the panel (critic/skeptic): a rename
of a persisted discriminant string must normalize at the single point the value
is deserialized from persistence, not at each individual dispatch site.]

A rename is therefore a persisted-data-format change and must stay backward
compatible with records already on disk. Because `makeFormulaRecord`'s sole caller
(`host.js:2367`) passes it a `getFormulaForId` result, normalizing at that
deserialization point also makes the public `FormulaRecord.type` it writes
(`type: formula.type`) canonical for old and new records alike, so the string that
escapes the daemon to non-`manager.js` consumers is canonical too. Those consumers
still match on a literal and so must learn the new name in lockstep with the
in-daemon sites: `packages/spaces-util/src/formula-view-registry.js`
(lines 190, 195), `packages/cli/src/commands/list.js` (line 61), and the rest
enumerated in Phase 2 step 5. What changes from the earlier draft is that they
recognize `snapshot-*` (the name they now always receive), not that they need a
*second* normalization boundary of their own.

The content store is unaffected throughout: a snapshot's identity is its SHA-256
content hash, not its formula-type string, so nothing is re-hashed and no dedup
state churns. Formula *identifiers* are content-number/node-keyed (see
`formatId` / `parseId`), not type-keyed, so an existing snapshot's id is stable
across the rename: a holder's persisted reference keeps resolving.

**Phase 1: dual-accept (no data change).**
1. Add `snapshot-blob` and `snapshot-tree` to the `formulaTypes` set in
   `formula-type.js`, keeping `readable-blob` and `readable-tree`.
2. Introduce a single canonical alias map (`readable-blob -> snapshot-blob`,
   `readable-tree -> snapshot-tree`) and apply it at the **single deserialization
   point**, `getFormulaForId` (`manager.js:1261`): rewrite `formula.type` through
   the map on the `persistencePowers.readFormula` result *before* it is stored in
   the `formulaForId` map (at `manager.js:1274`, and identically on the
   eager-populate path that also calls `readFormula` at `manager.js:1399`/`1410`).
   This establishes the invariant that **every object in `formulaForId` carries
   the canonical `snapshot-*` type**, so every reader enumerated above (the
   `makers` lookup, `getTypeForId` / `getFormulaType`, `collectFormulaHashes`,
   `getContentIdentityForId`, `extractLabeledDeps`, and, via its sole caller,
   `makeFormulaRecord`) reads the canonical string off the normalized object with
   no per-site alias of its own. Crucially, the alias and the sites' recognition of
   the name it produces must land **together, in Phase 1**: the moment the alias
   rewrites a deserialized old record to `snapshot-*`, every literal
   `'readable-blob'` / `'readable-tree'` comparison and `case` label that reads it
   must already recognize `snapshot-*`, or an old record would go unmatched. So
   Phase 1 makes all the enumerated sites **dual-accept** both spellings alongside
   introducing the alias (the exhaustive, grep-gated site list is Phase 2 step 5,
   which the Phase 1 dual-accept must cover in full); the later phases only flip the
   *writer* to `snapshot-*` (Phase 2 step 3, after which the `makeFormulaRecord`
   case can read `snapshot-*` alone) and drop the old-name recognition (Phase 3).
   This one deserialization point replaces the earlier draft's two use-site
   boundaries (before the `makers` lookup, and at the top of `makeFormulaRecord`),
   which reached only a subset of readers and left the GC, content-identity, and
   grouping sites reading the raw string.

   Two keys-retention consequences follow from *where* the alias now sits, and both
   differ from the earlier draft's reasoning:
   - The `formula-type.js` validation set must **keep** `readable-blob` and
     `readable-tree` alongside the new names (step 1) throughout Phases 1-2. This
     is *not* because `assertValidFormulaType` sees the raw string (it does not:
     `evaluateFormulaForId` reads the formula via `getFormulaForId` at
     `manager.js:4344` (already aliased) and only then calls
     `assertValidFormulaType(formula.type)` at `manager.js:4346`, so a deserialized
     old record is validated under its `snapshot-*` name). It is because Phase 1 is
     "no data change": freshly-*formulated* records are still minted and persisted
     with the old `readable-*` names (renaming the writer is Phase 2 step 3), and a
     freshly-minted formula enters `formulaForId` directly, not through the
     `readFormula` alias. So during Phases 1-2 both the `formulaTypes` set **and**
     the `makers` table (and the rekeyed literal read sites) must accept *both*
     spellings: `snapshot-*` for deserialized old records and freshly-minted
     Phase-2 records, `readable-*` for freshly-minted Phase-1 records. Only in
     Phase 3, once no `readable-*` record is written and the deserialization alias
     is the sole remaining producer of the old-to-new mapping, may the `readable-*`
     keys be dropped.
   - The records `makeFormulaRecord` *writes* carry only the new names once the
     writer flips (Phase 2 step 3). Every record already on disk still validates
     (under its aliased `snapshot-*` name), still incarnates, and still presents a
     recognized `FormulaRecord.type`, through the one deserialization alias
     (Design decision 4).

**Phase 2: write the new name.**
3. Write new snapshots with `type: 'snapshot-blob'` / `'snapshot-tree'`, and
   rekey the `makeFormulaRecord` `case 'readable-blob':` to `case
   'snapshot-blob':` so the record's `content` property keeps being populated
   under the canonical name (the Phase 1 step 2 entry-point alias already rewrites
   an old on-disk `readable-blob` record to `snapshot-blob` before this switch, so
   the rekeyed case still matches it). Old on-disk records keep their old string
   and are read through the alias, so **no bulk rewrite is required**.
4. Rename the daemon snapshot exo tag `EndoReadableTree` -> `EndoSnapshotTree`.
   This tag is the guard-tag string on the daemon-local `ReadableTreeInterface`
   exported from `packages/daemon/src/interfaces.js` (the snapshot-tree exo's
   interface). That daemon-local interface is **not** the same-named
   `ReadableTreeInterface` exported from `@endo/platform/fs`
   (`packages/platform/src/fs/interfaces.js`, guard tag `ReadableTree`), which
   names the shared read-surface type tier and is **not** renamed here. Name the module path at each reference so an implementer does not
   rename the platform tier by mistake. Give the blob snapshot the matching
   `EndoSnapshotBlob` tag. Give that
   `EndoSnapshotBlob` exo a `sha256()` method as well: its guarding `BlobInterface`
   (`packages/daemon/src/interfaces.js`) carries none today, reporting the hash
   only through `getInfo().hash`, so without this the byte column has no type-level
   snapshot witness. Adding it makes `sha256()` the uniform snapshot witness across
   both shape columns at the daemon exo layer, closing the gap named in § "Why the
   Read Surface Is Shared but the Guarantee Is Not", not just at the platform type
   tiers. This makes
   the two read-only forms distinguishable by exo tag: `mount.readOnly()` keeps
   returning `M.remotable('ReadableTree')` (a live view), while `snapshot()`
   returns the snapshot-tagged exo (interfaces.js `readOnly` / `snapshot`
   method guards). Update the in-tree doc references that say "readable-tree
   capability" in lockstep (for example the `EndoRegistry.fetch` / `lookup`
   comments in `interfaces.js`, and `help.md`). Whether the exo-tag string is
   itself a compatibility surface an external consumer matches on is deferred to
   Open Questions; if so, this step stays behind the alias and keeps the old tag
   reachable rather than renaming in place.
5. Re-key **every** literal-string dispatch on `formula.type` /
   `FormulaRecord.type` to the canonical `snapshot-*` names, in lockstep with the
   Phase 1 step 2 alias (the alias presents `snapshot-*` to all of them, so any
   site left testing `readable-*` would stop matching a deserialized old record the
   moment the alias lands). A repo-wide grep for the literal `'readable-blob'` /
   `'readable-tree'` strings across `packages/` (excluding tests) finds two groups.

   The **in-daemon read sites** in `manager.js`, which read `formula.type` off the
   now-canonical `formulaForId` object and so must test `snapshot-*` (these are the
   sites an earlier draft omitted from the checklist entirely, though the Phase 1
   preamble named them):
   - `collectFormulaHashes` (`manager.js:1084`): the GC survivor/candidate content-
     hash accounting.
   - `getContentIdentityForId` (`manager.js:1300`): the content-locator / magnet-URN
     lookup.
   - `extractLabeledDeps` (`manager.js:717`, `case 'readable-tree':`): rekey to
     `case 'snapshot-tree':` for hygiene even though it and `default` both return
     `[]` today, so the case does not silently drift out of sync.
   - the `makeFormulaRecord` `case 'readable-blob':` is rekeyed in step 3 above.

   The **external literal consumers** of the public `FormulaRecord.type`, all of
   which this step updates:
   - `packages/spaces-util/src/formula-view-registry.js` (lines 190, 195): the
     UI-view lookup table.
   - `packages/cli/src/commands/list.js` (line 61): the `endo list` "Directories"
     grouping set.
   - `packages/space-chat/src/inventory/tree-source.js` (lines 54, 113): the
     chat-space inventory tree-source classification.
   - `packages/space-inventory-graph/src/graph.js` (line 60): the inventory-graph
     node-color map (`'readable-blob'` -> a color).
   - `packages/daemon/src/types.d.ts` (lines 257, 266, 2651): the literal `type`
     union members and the `EndoFormulas` map entry. These are compile-time only,
     but must be renamed (or widened to accept both) so the published types match
     the canonical `snapshot-*` records.

   Every rekeyed site above (in-daemon and external) must accept **both** spellings
   for the duration of Phases 1-2, not the new one alone: the deserialization alias
   presents `snapshot-*` for old on-disk records, but a freshly-minted Phase-1
   record still carries `readable-*` (it enters `formulaForId` at formulation, not
   through the `readFormula` alias, and Phase 2 step 3 is what flips the writer). A
   site rekeyed to test `snapshot-*` *only* would miss those Phase-1 records. The
   old keys are dropped in Phase 3, once no `readable-*` record is written and the
   alias is the sole old-to-new producer. This grep gates the step: any
   *additional* pattern-matching consumer a future re-run of the grep surfaces must
   be added to this list before the rename is considered complete.

**Phase 3: deprecate the old string.**
6. After a release window, stop *writing* the old names entirely (already true
   after Phase 2) and either keep the read-time alias indefinitely (recommended;
   it costs nothing because identity is content-keyed) or run a one-time
   migration pass that rewrites the `type` field of old records in place. The
   alias makes the rewrite optional.

Each phase that touches the exo guards or the maker table needs its own
daemon-test validation pass, per the convention in
[fs-interface-consolidation.md](fs-interface-consolidation.md). The single
most load-bearing case (because the Phase 1 alias *is* the entire backward
compatibility guarantee) is the old-record round-trip: a formula record written
with `type: 'readable-blob'` (the pre-rename on-disk shape) must both incarnate
through the alias to the `snapshot-blob` maker **and** present
`FormulaRecord.type === 'snapshot-blob'` to the view/CLI registries after step 2,
with the same assertion for `readable-tree` / `snapshot-tree`. Add it explicitly
alongside the existing `packages/daemon/test/formula-type.test.js` registered-type
checks (and exercise the record surface via
`packages/daemon/test/formula-record.test.js`) rather than leaving it to the
general convention; the alias has no value that a test does not pin.

The four external literal-string consumers rekeyed in Phase 2 step 5 each need a
pinning test too, because a missed or mistyped key silently mis-groups or
mis-colors a snapshot in the UI with no failing test to catch it, and none is
covered by the daemon round-trip above:

- `packages/spaces-util` (or its nearest test package): assert
  `formula-view-registry.js` resolves a `snapshot-blob` / `snapshot-tree` record
  to the same view it resolved a `readable-blob` / `readable-tree` record to
  before the rename.
- `packages/cli`: assert `endo list` groups a `snapshot-tree` record under
  "Directories" (the grouping set in `commands/list.js`).
- `packages/space-chat`: assert `inventory/tree-source.js` classifies a
  `snapshot-blob` / `snapshot-tree` record into the same inventory bucket as the
  old names.
- `packages/space-inventory-graph`: assert `graph.js` maps `snapshot-blob` to the
  node color previously keyed on `readable-blob`.

Where a package has no runtime test harness for these tables, at minimum keep the
old keys alongside the new (the belt-and-suspenders noted in step 5) and add a
type-level assertion that the `snapshot-*` members exist in the `types.d.ts`
`type` union, so the compiler pins the rename.

## Dependencies

| Design | Relationship |
|---|---|
| [fs-interface-consolidation.md](fs-interface-consolidation.md) | Established the `ReadableBlob`/`SnapshotBlob`/`File` and `ReadableTree`/`SnapshotTree`/`Directory` type-tiers (§ C2/C3/C4) this design elevates to the formula-name layer. |
| [fs-interface-reconciliation.md](fs-interface-reconciliation.md) | Unified the read-method names/signatures the shared surface depends on. |
| [daemon-mount.md](daemon-mount.md), [daemon-mount-capabilities.md](daemon-mount-capabilities.md) | Define `EndoMount` / `EndoMountFile`, `readOnly()`, and `snapshot()`: the live and snapshot producers this matrix names. |
| [readableblob-range-attenuation.md](readableblob-range-attenuation.md) | The range-I/O attenuation of the readable-blob surface; consumer of the blob naming. |
| [npm-registry-as-directory-tree.md](npm-registry-as-directory-tree.md) | Consumes `readable-tree` (SnapshotTree) fixtures; a downstream user of the renamed formula. |
| endojs/endo-but-for-bots#1125 (the Source PR) | Ships the persisted `readable-directory` live-view formula (commit `4743e382b`); an ordering dependency for the migration plan, reconciled in § "Reconciliation with the Existing Names". |

## Design Decisions

1. **Keep the read surface shared; distinguish the guarantee by the `sha256()`
   method.** A snapshot carries `sha256()` (a hash fixed for all time); a live
   read-only view does not. `getInfo()` is *not* the canonical distinguisher: it
   is the uniform content-address accessor, carried by a live *blob* view too
   (where its hash tracks the mutating backing) though absent from the live *tree*
   view, so only `sha256()` separates snapshot from view across both shape
   columns uniformly. This holds cleanly in the `@endo/platform/fs` type tiers;
   at the daemon's concrete exos the snapshot-blob exo carries no `sha256()` yet
   (its `BlobInterface` reports the hash via `getInfo().hash`), so Phase 2 step 4
   adds it to make the witness type-level for bytes at the daemon layer too. This
   makes `readOnly` != `snapshot` a type-level fact rather than a naming
   convention, answering the review comment directly.

2. **Rename the immutable formulas to `snapshot-*`, not the mutable or view
   forms.** The mistake is localized to the two snapshot formula names; File,
   Directory, and the Readable view interfaces are already correct. Minimal,
   targeted rename.

3. **No `readable-*` *snapshot* formula in the target scheme.** "Readable" names
   the read-only *view* layer: an interface, the transient `readOnly()` view,
   and the persisted `readable-directory` live-view formula (#1125). It must not
   *also* name a persisted *immutable snapshot*, because conflating a live view
   with a frozen snapshot is precisely the collision being removed. A persisted
   `readable-*` cap is legitimate when it is a genuine live read-only view (as
   `readable-directory` is); what the rename forbids is a `readable-*` name on the
   content-addressed snapshot forms.

4. **Read-time alias over bulk rewrite.** Because snapshot identity is
   content-keyed, an alias is free and permanent; a destructive rewrite of
   persisted records is neither necessary nor worth its risk.

## Open Questions

- Should a **persistable live read-only handle** exist for *bytes* (and for
  collections beyond #1125's directory case), or does the transient
  `file.readOnly()` view suffice? For directories this is no longer open: #1125's
  `readable-directory` formula *is* exactly such a persisted live read-only view.
  The symmetry question is whether a persisted live-read blob/tree view should
  follow. Note the naming constraint from § "Target Naming": because this design
  recommends a permanent read-time alias, such a formula must take a **new** name
  (e.g. `readable-blob-view`, or the `readable-directory` spelling extended to the
  other shapes), **not** the retired `readable-blob` / `readable-tree` strings,
  which the alias keeps bound to the snapshot forms. Recommendation: keep the blob
  view transient and add the persisted form only when a concrete need appears,
  mirroring `readable-directory`'s *shape* (a live view wrapping a mutable cap)
  under a fresh name if it does.
- Permanent read-time **alias** vs. a one-time **migration pass** for old
  persisted records? Recommendation: permanent alias (identity is content-keyed,
  so there is no functional cost).
- Should the **mutable** rows (`File`, `Directory` / `EndoMount`) expose a
  `getInfo()` fingerprint of their *current* state, so the accessor is uniform
  across all three rows? A partial precedent already exists one row up, on the
  read-only view: `file.readOnly()` returns a live `ReadableBlob` that implements
  `getInfo()` over the current bytes today (`mount.js`, `makeReadableBlobView`),
  and that view delegates to the very mutable `EndoMountFile` this question asks
  about, so the mutable file's current bytes are *already* fingerprintable, just
  through its read-only face rather than on the mutable cap directly. The hazard
  is that treating
  such a fingerprint as a "content address" re-introduces the exact
  state/identity conflation this design removes: a hash that changes with content
  is not an identity. Any uniform accessor must therefore be documented as a
  current-state fingerprint, explicitly distinct from the stable `sha256()`
  snapshot identity, or the collision returns under a new name. Recommendation:
  keep `sha256()` (stable identity) snapshot-only; name any current-state
  fingerprint separately.
- The **mutable** Collection cell carries two capability spellings
  (`EndoDirectory` and `EndoMount`, backing-store variants of the same
  guarantee/shape). The **Readable-view** Collection cell's only *persisted*
  formula, #1125's `readable-directory`, wraps just the `directory` capability. Is
  a mount-backed *persisted* live-read-only-view formula (the read-only analog of
  `EndoMount`) anticipated (and if so, what is it named), or is it deliberately
  out of scope because a mount is host-filesystem-backed and the transient
  `mount.readOnly()` view already suffices there? Recommendation: treat it as out
  of scope for now (the transient view covers the mount case, and backing store is
  the orthogonal third variable this matrix deliberately excludes; see § "The
  Matrix", Mutable bullet), and add a persisted mount-view formula only under the
  same "when a concrete need appears" bar as the blob/tree views above, again
  under a fresh name.
- Should the persisted directory view's exo tag `ReadableNameHub` be aligned with
  the `ReadableTree` interface/transient-view spelling of the same cell (see
  § "Reconciliation with the Existing Names"), or does it stay as inherited from
  #1125? This is out of the current rename's scope but is the one remaining
  spelling divergence in the Readable-view row.
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
