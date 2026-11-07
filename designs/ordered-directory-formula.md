# Naturally ordered and manually ordered directories

| | |
|---|---|
| **Created** | 2026-11-07 |
| **Author** | Kris Kowal (prompted) |
| **Status** | Proposed |

## What is the Problem Being Solved?

Endo's `directory` formula is a name-to-formula map backed by a `pet-store`.
Its `list()` method sorts names with JavaScript's default string order, so the
directory already has an implicit order, but the contract describes only a
list of names and does not name or version that ordering.
There is no way to put an entry before another entry without changing a name.

Two different abstractions are hiding behind the word "ordered":

- A **naturally ordered directory** derives its order entirely from its names.
  Assigning the names `clip-2` and `clip-10` determines their relative order;
  there is no independent reorder operation.
- A **manually ordered directory** is a keyed sequence.
  New names have insertion positions, and a holder with write authority can
  move an entry without renaming it.

The current formula should be specified as the first kind.
A new `ordered-directory` formula should provide the second kind.
The sequence model also gives Endo a coherent place for bounded reads,
revisioned diffs and patches, operational transforms, and a hashline adapter
instead of growing unrelated methods on each consumer.

## Existing path

The proposal extends the path that already owns this state:

- `DirectoryFormula` in `packages/daemon/src/types.d.ts` contains
  `{ type: 'directory', petStore }`.
- `formulateDirectory` in `packages/daemon/src/manager.js` formulates the
  pet store and directory together.
- `makeDirectoryMaker` in `packages/daemon/src/directory.js` supplies lookup,
  listing, mutation, and observation.
- `makePetStoreMaker` in `packages/daemon/src/pet-store.js` loads the mapping
  from `pet_store_entry`; `list()` and the initial `followNameChanges()`
  snapshot call `.sort()`.
- `makeLocalStoreController` in `packages/daemon/src/store-controller.js`
  couples mapping mutations to formula-graph retention edges.

This path is sufficient for a derived order because names are already durable.
It is insufficient for manual ordering because neither the formula nor
`pet_store_entry` records an entry identity, position, or revision.
The design adds those facts to this path rather than introducing a sidecar
directory or an application-specific ordering service.

## Model

Both directory kinds map unique names to values and retain the existing
capability rule: possession of a writable directory is the authority to change
it, and possession of a value is the authority to insert that value.
There is no caller-identity or owner check.

### Naturally ordered directory

The existing `directory` formula remains the ordinary name hub.
Its sequence is a pure function of the current names under one versioned,
locale-independent comparator.
Replacing a value at an existing name does not move it; renaming may move it;
and a request to reorder without renaming is rejected as unsupported.

The intended comparator family is "natural": digit runs compare as numbers,
so `clip-2` precedes `clip-10`, while non-digit text has a deterministic binary
order.
The exact tokenization, case, normalization, leading-zero, and lone-surrogate
rules are an open question below.
The comparator must not delegate to ambient `Intl.Collator`,
`String.prototype.localeCompare`, or a database locale because Node, XS, Rust,
and different hosts must produce the same order.

### Manually ordered directory

The new formula has type `ordered-directory` and owns an ordered store.
Every entry has a durable opaque key, a unique pet name, a formula identifier,
and a position.
Its initial formula shape is
`{ type: 'ordered-directory', orderedStore: FormulaIdentifier }`, parallel to
the current directory's reference to its pet store.
The key survives rename, value replacement, and movement within that directory;
deletion or a copy-then-remove move to another directory retires it.
The public surface never reveals the formula identifier.

The compatibility behavior of ordinary mutators is:

- storing a new name appends it;
- storing a new value at an existing name replaces in place;
- renaming preserves position;
- removing closes the gap;
- `moveEntries(keys, beforeKey)` moves an ordered group, preserving its relative
  order, before another entry, or to the end when `beforeKey` is absent; and
- cross-directory `move` retains today's copy-then-remove failure boundary.
  Atomic movement exists only within one ordered directory.

The ordinary `has`, `lookup`, `maybeLookup`, `list`, `listValues`, `remove`,
`copy`, `makeDirectory`, `readText`, and `writeText` methods remain available.
`list()` still returns the complete ordered name array for small callers.

## Revisioned read and edit surface

The sequence methods operate on immediate children.
A caller reaches a nested directory with `lookup` first, preserving the
existing capability boundary instead of accepting an ambient path.

```ts
type DirectoryEntry = {
  key: string; // opaque stable key; the exact name on natural directories
  name: string;
  value: unknown;
};

type DirectoryRange = {
  revision: string; // opaque durable revision token
  start: bigint;
  total: bigint;
  entries: DirectoryEntry[];
  next?: bigint;
};

readRange(request: {
  start?: bigint;
  count: number;
  revision?: string;
}): Promise<DirectoryRange>;

diff(request: {
  from: string;
  to?: string;
}): Promise<DirectoryPatch>;

applyPatch(
  patch: DirectoryPatch,
  options?: { stale?: 'reject' | 'transform' },
): Promise<{ revision: string; transformed: boolean }>;

followPatches(request?: {
  after?: string;
}): PassableReader<DirectoryPatch>;
```

`count` is implementation-bounded and `start` is a non-negative `bigint`.
The result identifies the revision that fixed the page.
A subsequent page may name that revision; if the provider no longer retains a
snapshot or enough history to reconstruct it, the read rejects with
`history-unavailable` rather than silently returning a shifted page.
This makes offsets safe without pretending concurrent insertions did not occur.

The first patch format is structured and passable.
Operations insert entries, remove entries by key, replace a value, rename an
entry, or move a list of keys before another key.
Every patch carries `baseRevision` and an idempotency key.
All names, value capabilities, anchors, and uniqueness constraints validate
before mutation, and one successful `applyPatch` is one database transaction,
one new revision, and one follower event.

With `stale: 'reject'`, a stale base reports the current revision.
With `stale: 'transform'`, the store transforms the patch over every retained
intervening patch.
Concurrent inserts into one gap use the idempotency key as the deterministic
tie-break; edits of a deleted key conflict; moves of surviving keys compose in
accepted revision order.
Retries of an accepted idempotency key return the prior result without applying
the edit twice.
The transform algorithm and change-log retention live with the ordered store,
not in each UI or agent adapter.

Naturally ordered directories may expose `readRange`, `diff`, and
`followPatches`, but do not accept positional moves.
Their patches describe mapping changes, after which order is re-derived.
Whether `applyPatch` belongs on both kinds or only on the manually ordered kind
is part of the ranged-read/edit open question.

## Diff, patch, operational transform, and hashline

`diff` returns the same structured patch shape that `applyPatch` accepts.
The common shape lets a caller snapshot, compare, preview, invert, compose, or
submit a change without teaching every backing a second mutation language.
The prior `exo-git-follow-root-advancement` design supplies the method-call
transaction and precondition precedent; this proposal specializes it to a
directory sequence with stable entry keys.

Operational transform is opt-in conflict handling, not an ambient merge.
The service serializes accepted patches into a revision stream and transforms
only when the caller explicitly selects `stale: 'transform'`.
A caller that needs compare-and-swap semantics selects `reject`.

Hashline is a textual adapter over the structured protocol, not the durable
wire format.
A read adapter can render one directory entry per line with its ordinal and a
short digest of the opaque entry key.
A hashline edit parser resolves those anchors against one named revision and
produces a `DirectoryPatch`; the store then performs the same validation and
atomic commit as any other patch.
New values still arrive as capabilities in a side table keyed by patch-local
labels, so the textual document never embeds formula identifiers or invents
authority.
The exact rendered fields and whether hashline can edit names and values or
only ordering remain open.

## Persistence and recovery

The ordered store is not a second pet store loosely joined to an order table.
One database owner commits mapping, order, revision, change log, and
formula-graph edge effects as one operation.
A normalized starting shape is:

- ordered-store metadata: store number, current revision, format version;
- entries: store number, opaque key, unique name, formula identifier, ordinal;
  and
- retained patches: store number, resulting revision, base revision,
  idempotency key, and canonical patch body.

The SQLite implementation may renumber ordinals inside the transaction.
The public contract does not expose rank encodings, so a later sequence tree or
fractional-key implementation can replace this without changing capabilities.

On restart, the store loads entries in order, restores the durable revision and
idempotency window, seeds formula-graph edges, and resumes at the next revision.
If history was compacted, current reads continue to work while old `diff`,
transform, and revision-pinned range requests fail explicitly.

Recasting an existing directory needs no row rewrite when order remains derived
from names, but changing from code-unit order to natural order is observable.
Historic insertion order cannot be recovered from `pet_store_entry` because it
was never stored.
Converting an ordinary directory to an ordered directory can therefore preserve
only the order visible at conversion time.

## Ownership map

| Boundary | Mechanism owner | Policy owner | Durable state | Commit / discard authority | Value crossing |
|---|---|---|---|---|---|
| Directory exo to store controller | `directory.js` exposes guarded methods and attenuation | The held writable or read-only facet determines admitted operations | None beyond the retained store reference | The exo validates the call, then delegates one edit | Names, value capabilities, ranges, and structured patches |
| Store controller to ordered store | The ordered-store implementation serializes revisions and transforms | Formula and interface version select natural versus manual order | Entries, order, revision, idempotency window, retained patches | One store transaction accepts or rejects the whole edit | Internal formula identifiers plus validated edit intent |
| Ordered store to manager database and formula graph | `manager-database.js` persists rows; graph hooks retain local formulas | Retention follows actual stored identifiers, not presentation order | SQLite rows and formula-graph edges | The database transaction is the durable commit point; failure publishes nothing | Committed row changes and edge additions/removals |
| Text/UI adapters to directory exo | CLI, agent-tool, or Chat adapters render and parse | The adapter chooses hashline, diff preview, or strict/transform mode | No independent authoritative state | Only `applyPatch` commits; closing a preview discards it | Text plus patch-local labels for separately held capabilities |

The ordered store owns persistent state, commit/discard, restart/replay, and
the classification of an accepted edit into one revision.
The directory exo owns capability admission and argument validation.
Adapters own presentation only and cannot commit around the exo.
The inner mechanism is consequently named a directory **edit** or **revision**,
not a file save, UI move, or application transaction: those are outer-layer
lifecycle concepts.

## Phased implementation

1. **Specify natural order.** Add comparator conformance vectors, make the
   ordinary directory contract explicit, and settle migration/versioning.
2. **Ordered formula and store.** Add `ordered-directory`, durable keys,
   ordinals, revisions, restart recovery, and the compatibility mutators.
3. **Bounded reads and followers.** Add `readRange` and revisioned patch
   following to both directory kinds, with read-only attenuation.
4. **Structured diff and patch.** Add atomic patch validation, diff,
   idempotency, strict stale rejection, and conformance tests.
5. **Transform and text adapters.** Add retained-history transforms and the
   hashline renderer/parser after the structured protocol is stable.

## Alternatives considered

**Encode order in numeric name prefixes.**
Useful as an application-local interim, but it makes a presentation change a
rename, churns references and notifications, and cannot support stable entry
anchors.

**Keep the current directory and a separate order side table.**
Rejected as the general Endo mechanism because mapping and order would have
separate commit, recovery, observation, and authority boundaries.

**Make every directory manually ordered.**
Rejected because canonical name-derived order is valuable for reproducible
inventories and requires no order state.
The two abstractions should have different formula types and interfaces.

**Expose only integer indexes.**
Rejected for edits because concurrent changes shift indexes.
Indexes are appropriate for a revision-pinned range; mutations use stable entry
keys.

## Test plan

- Run one comparator vector corpus under Node, XS, and Rust/Endor, covering
  digit runs, leading zeroes, case, non-ASCII text, combining characters, and
  lone UTF-16 surrogates admitted by current pet-name validation.
- Verify ordinary directory listing, initial followers, rename, and restart all
  use exactly the selected natural order.
- Verify ordered insertion, replacement-in-place, rename-in-place, removal,
  grouped move, same-directory atomicity, and restart preservation.
- Exercise range boundaries, maximum page size, exact-revision pagination,
  concurrent mutation, and explicit `history-unavailable` failure.
- Round-trip `diff` through `applyPatch`; test inversion and composition;
  reject duplicate names, unknown keys, invalid capabilities, and stale bases
  without partial writes.
- Submit concurrent inserts, deletes, renames, and moves in both acceptance
  orders and assert transform convergence and idempotent retry.
- Render a range as hashline, apply a valid edit, then reject stale, duplicate,
  and forged anchors.
- Verify read-only facets omit every mutator and that formula-graph retention
  follows values through move, replace, delete, collection, and restart.

## Dependencies

| Design | Relationship |
|---|---|
| [fs-interface-consolidation](fs-interface-consolidation.md) | Owns the shared directory/name-hub vocabulary and read-only attenuation that the new methods must extend without widening every backing accidentally. |
| [platform-range-and-tree-reads](platform-range-and-tree-reads.md) | Establishes bounded read conventions and the distinction between a convenience result and a streaming primitive. |
| [exo-git-follow-root-advancement](exo-git-follow-root-advancement.md) | Establishes revisions, method-call transactions, lossless followers, and structured high-level patches over mutable trees. |
| [cli-edit-verb](cli-edit-verb.md) | Supplies the hashline, whole-value precondition, and parse-to-structured-patch precedent. |

## Open questions

1. **How should existing directories migrate?**
   Should every existing `{ type: 'directory' }` change in place from UTF-16
   code-unit order to the selected natural order, should its formula acquire a
   persisted collation version with legacy instances pinned to code-unit order,
   or should a new natural-directory formula be introduced?
   This blocks Phase 1 because current insertion history cannot be recovered.
2. **What are the exact collation rules for "natural" sort?**
   Are digit runs limited to ASCII `0`-`9`; how do leading zeroes, case,
   normalization, punctuation, non-ASCII digits, and lone surrogates compare;
   and is the tie-break raw UTF-16 code-unit order or UTF-8 byte order?
   The answer must become a versioned cross-runtime vector corpus, not an
   `Intl.Collator` option.
3. **How should ranged reads interact with edit methods?**
   Should `readRange`, `diff`, `followPatches`, and `applyPatch` be one shared
   optional interface on both directory kinds, or should natural directories
   expose only reads and mapping diffs while ordered directories alone expose
   positional patches and transforms?
   Should revision-pinned reads reconstruct retained snapshots or reject as
   soon as the live revision changes?
4. **How much revision history is retained?**
   Is retention count-, byte-, or time-bounded, and can a holder request a
   durable checkpoint for long-lived diff or transform work?
5. **What does the hashline adapter edit?**
   Is its first contract order-only, or may it rename and replace values using
   separately supplied capability labels?

## Prompt

> From Kris Kowal's 2026-11-06 review of
> [`ordered-gutter-context-menu.md`](https://github.com/kriscendobot/minion.town/pull/247#discussion_r4488820497):
> propose an ordered-directory formula, recasting the current directory as a
> naturally sort ordered directory whose implicit order comes from assigned
> names, distinct from an insertion-ordered, manually reorderable directory.
> The file-like ordered form should account for ranged reads, operational
> transforms, diff and patch, and hashline edits.
