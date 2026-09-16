# Mutable Blob Formulas

| | |
|---|---|
| **Created** | 2026-09-16 |
| **Author** | Kris Kowal (prompted) |
| **Status** | Proposed |

## Problem

The daemon's `readable-blob` formula is an immutable, content-addressed value.
Its formula stores a SHA-256 content key and its bytes live in
`<statePath>/store-sha256/`. That is the right shape for snapshots, but not for
a durable file-like block whose bytes can be overwritten or whose length can
change without replacing the capability.

The daemon needs a mutable binary value with stable capability identity. It
also needs a precise answer for reads concurrent with resize: a read-only
facet must not become a snapshot merely because it has no write methods, but a
single read must not combine bytes from different sizes. Append-only storage
is a useful narrower authority and admits a materially cheaper persistence
strategy than general mutation.

## Design

Adopt the three formula types `readable-blob`, `blob`, and
`appendable-blob`.

- `readable-blob` remains the immutable, content-addressed snapshot.
- `blob` owns mutable, resizable block storage.
- `appendable-blob` owns storage whose committed prefix never changes and can
  only grow.

The evidence favors all three as formula types, not merely three interfaces.
An append-only formula can commit a new tail without copying or replacing its
prefix, while a general mutable formula needs a new generation for atomic
overwrite and resize. A `blob` can still mint an append-only attenuation when
the caller needs narrower authority; the separate `appendable-blob` formula is
what lets the persistence implementation exploit the stronger invariant.

### Formula and capability surfaces

The two new persisted formula records contain no host path or current size:

```ts
type BlobFormula = { type: 'blob' };
type AppendableBlobFormula = { type: 'appendable-blob' };
```

Like `scratch-mount`, the formula number selects daemon-owned storage. The
formula is a stable recipe for finding that storage, not a log of every content
revision. Neither formula has dependencies in the formula graph.

All three types implement the shared readable-blob surface. The new mutation
surfaces are:

```ts
interface Blob extends ReadableBlob {
  replace(source: ReadableBlob): Promise<void>;
  write(offset: bigint, source: ReadableBlob): Promise<void>;
  resize(size: bigint): Promise<void>;
  append(source: ReadableBlob): Promise<bigint>;
  readOnly(): ReadableBlob;
  appendOnly(): AppendableBlob;
  snapshot(): Promise<ReadableBlob>;
}

interface AppendableBlob extends ReadableBlob {
  append(source: ReadableBlob): Promise<bigint>;
  readOnly(): ReadableBlob;
  snapshot(): Promise<ReadableBlob>;
}
```

`replace` atomically replaces the whole value. `write` overwrites starting at
`offset`, preserves bytes outside the written interval, extends when necessary,
and reads as zero bytes through any gap beyond the old end. `resize` truncates
or zero-extends. `append` atomically adds one source as one contiguous extent
and returns its starting offset. Concurrent mutations have a total order; an
operation that rejects has no visible effect. Implementations spool a remote
source before committing, so a stalled or failed CapTP reader does not hold the
mutation lock or expose a partial write. Offsets and sizes are non-negative
`bigint` values and use the same backing-safe range validation and `EINVAL`
behavior as `fetch`.

`readOnly` is a live attenuation over the same formula, not a snapshot.
`appendOnly` is likewise a live attenuation of a `blob`: it exposes the exact
`AppendableBlob` method set and no overwrite or resize authority. `snapshot`
captures one committed version in the existing content store and returns an
immutable `readable-blob`. Derived facets share the originating formula's
lifetime and are not separately persisted.

The host and guest naming surfaces gain `makeBlob(name, source?)` and
`makeAppendableBlob(name, source?)`, backed by corresponding daemon-core
formulators and deferred pet-name insertion. An omitted source means empty
content. Existing `storeBlob(reader, name)` keeps its current meaning: create
an immutable `readable-blob`. Creation commits the initial backing state before
making the formula visible; failure removes the incomplete backing directory.

### Read epochs: compatibility with `readable-blob`

Every read operation captures exactly one committed generation when the daemon
begins servicing that operation. The operation reads only that generation,
even if a writer commits a resize before the operation finishes. A later
operation on the same live facet sees whichever generation is committed when
that later operation begins. Thus a reader holding `readOnly()` across a shrink
or growth keeps the same capability identity, an in-flight read finishes from
the old bytes, and the reader's next call observes the new bytes.

This is the temporal rule that preserves readable-blob semantics: each
operation behaves exactly as if it had been invoked on an immutable
`readable-blob` containing the captured generation. Mutability is observable
between operations, never within one. Concurrent operations are linearizable
at generation capture or mutation commit; no method returns a torn mixture.

The common surface and the corresponding guarantee are explicit:

| Method | Same semantics on all three formula types |
|---|---|
| `help(method?)` | Describes the same method vocabulary; a mutable view additionally says that it is live between calls. |
| `text()` | Decodes the complete captured bytes with the existing non-fatal UTF-8 behavior. A resize cannot change the string mid-call. |
| `json()` | Parses exactly the text of one captured generation; it cannot hash/read one size and parse another. |
| `streamBase64(sync)` | Emits, with the existing pump protocol and cancellation behavior, exactly the captured bytes through captured EOF. Growth after capture is excluded; shrink does not shorten the stream. |
| `getInfo()` | Returns `{ algorithm: 'sha256', hash, size }` for the same captured bytes. The hash and size are coherent with each other, although another call may report a later generation. |
| `fetch(offset, length)` | Applies the existing validation and EOF clamping to one captured generation and returns the selected bytes through the existing one-use reader. |
| `lines(options?)` | When the companion lines design lands, its indices, terminators, buffering, cancellation, and errors are unchanged. The finite reader uses one captured generation, so appends after capture are read by a later `lines` call, not by the open reader. |
| `range(start, end)` | When range attenuation lands, the returned readable facet holds fixed byte coordinates over the live source. Each operation captures the then-current generation and clamps those coordinates at its EOF; shrinking can hide bytes and later growth can reveal bytes in the authorized interval, but never outside it. |
| `textRange(startLine, endLine)` | The line scan that creates the attenuation uses one captured generation and fixes the resulting byte interval. Reads through the returned facet follow the same live, fixed-byte-interval rule as `range`; later edits do not silently widen its authority by moving line boundaries. |

The first six rows are the current daemon `BlobInterface`. The last three
record the obligations introduced by
[ReadableBlob range attenuation](readableblob-range-attenuation.md) and the
ReadableBlob lines proposal (PR #832) without making those unmerged methods a
prerequisite: a builder implements the shared surface present at build time and
must not give mutable producers divergent meanings when the companion methods
land.

`getInfo().hash` is the content identity of its captured generation, not the
identity of the mutable formula. Consequently `locateContent` and magnet
content locators continue to accept only `readable-blob` and `readable-tree`.
A caller snapshots first when it needs stable content identity.

### Persistence and recovery

Formula records remain in `<statePath>/endo.sqlite`. Binary state is outside
SQLite, in formula-number-keyed directories:

```text
<statePath>/mutable-blobs/<formulaNumber>/
<statePath>/appendable-blobs/<formulaNumber>/
```

The first implementation uses an atomic `HEAD` manifest in each directory.
For `blob`, `HEAD` names an immutable generation file and its length. A mutation
copies or reflinks the current generation to staging, applies the change,
syncs and renames the completed generation, then atomically replaces and syncs
`HEAD`. Readers that already opened the prior generation can finish while new
readers open the new one. Superseded generations are removed after their read
leases close and are also swept at startup.

For `appendable-blob`, the backing file is a stable prefix and `HEAD` records
the committed length. An append is first spooled, then writers serialize:
truncate any uncommitted tail, append and sync the new bytes, and finally
atomically advance and sync `HEAD`. A reader captures the committed length and
never reads beyond it. A crash before the `HEAD` replacement leaves an ignored
tail; a crash after it leaves the complete appended extent because data is
synced first. This layout is deliberately distinct so append does not copy the
old prefix. A later platform may replace the file with immutable segments or
another append-optimized representation without changing the formula or
capability contract.

On startup, a formula with no valid committed `HEAD` is reported as corrupt;
it is never reincarnated as empty. Backing directories with no corresponding
formula are incomplete creations or completed collections and are removed by
an orphan sweep. Formula collection removes the formula record first so the
value cannot reincarnate, revokes derived facets and drains their backend
leases, then removes the formula-specific directory. A crash during cleanup
therefore leaves an orphan, not a formula with missing state. As with
content-store collection, failures are retryable cleanup work rather than
permission to expose partial state.

### Substitutability and authority

The interfaces form a narrowing chain, but callers should receive an explicit
attenuation so excess methods do not accidentally grant excess authority.

| Expected authority | Values that can satisfy it |
|---|---|
| `ReadableBlob` | A `readable-blob`; `blob.readOnly()`; `appendableBlob.readOnly()` |
| `AppendableBlob` | An `appendable-blob`; `blob.appendOnly()` |
| `Blob` | A `blob` only |

A full `blob` structurally contains the append and read methods, and a full
`appendable-blob` structurally contains the read methods, but passing either
full capability would disclose additional methods under CapTP introspection.
The attenuation methods make the intended substitution explicit. The reverse
directions are invalid: immutability cannot supply append, and append-only
authority cannot supply overwrite or resize.

## Implementation plan

1. Add the two formula unions, formula-type validation, inspector records,
   maker-table cases, daemon-core formulators, Host/Guest guards and types, and
   help text. Keep `readable-blob` and `storeBlob` unchanged.
2. Add a backend abstraction that opens read epochs and commits mutations, with
   the two layouts above. Implement `BlobInterface`, `AppendableBlobInterface`,
   read-only and append-only facets, and immutable snapshots. Cache hashes only
   by committed generation; never reuse one after mutation.
3. Extend formula collection and startup reconciliation for both directory
   classes. Ensure cancellation closes source readers, staging writers, and
   generation leases before reclamation.
4. Run one shared readable-blob conformance suite against immutable, mutable,
   append-only, and attenuated views. Add mutation tests for overwrite,
   zero-extension, shrink/grow, replacement, failed sources, concurrent append
   offsets, and method-set attenuation.
5. Add deterministic barriers around generation capture and commit to verify
   read-during-resize, coherent `getInfo`, finite streams, range behavior across
   shrink/growth, restart recovery at every commit boundary, orphan cleanup,
   collection with active readers, and Node/Rust-supervisor interoperability
   over the same state directory.

## Alternatives considered

- Reuse `scratch-mount` and return a mount file. Rejected: that couples a
  single binary value to directory/path authority and host filesystem
  semantics instead of giving it formula-owned storage and a portable block
  contract.
- Store the current content hash in the formula and rewrite the formula after
  every mutation. Rejected: formulas are stable reconstruction recipes; making
  the formula row a mutable data pointer complicates formula-graph observation,
  CAS reclamation, and atomicity across SQLite and the content store.
- Use only `blob` plus an append-only facet. The facet remains useful for
  authority attenuation, but using it as the only append-only representation
  forfeits the no-copy, prefix-stable persistence strategy. This is why the
  evidence supports the trio.

## Dependencies

| Design | Relationship |
|---|---|
| [fs-interface-consolidation.md](fs-interface-consolidation.md) | Owns the shared readable-blob guards and the requirement that common methods have common semantics. |
| [readableblob-range-attenuation.md](readableblob-range-attenuation.md) | Defines fixed range authority and live-source range behavior that mutable read facets preserve. |
| [daemon-content-store-gc.md](daemon-content-store-gc.md) | Supplies the collection precedent; mutable backing directories are formula-owned rather than content-addressed. |
| [daemon-256-bit-identifiers.md](daemon-256-bit-identifiers.md) | Supplies formula-number persistence and state-directory naming conventions. |

## Open questions

1. Should read-during-resize use the operation-scoped generation semantics
   specified here, or should streams expose live-file behavior and possibly
   observe a concurrent truncate or append? The operation-scoped model is
   recommended because it is the only option that makes every shared method
   behave as a read of one immutable value, keeps `getInfo` coherent, and makes
   Node and Rust backends testable against the same contract. This decision is
   blocking: it changes observable stream and `lines()` results.
2. Should `appendable-blob` remain a distinct persisted formula as recommended,
   or should the public trio collapse to two formulas with append-only
   available only as `blob.appendOnly()`? A separate formula buys prefix-stable
   storage and cheap crash-safe append; the two-formula alternative reduces
   schema surface but requires the general mutable backend even when stronger
   authority is never granted.

## Prompt

> Design a new Endo daemon formula type for mutable block storage of a file,
> such that the storage block can be resized. This would be in contrast to
> readable blobs, but should have the same semantics for methods they have in
> common. It might follow that we should support append-only files as well,
> which the platform would be free to optimize differently, such that we have
> readable-blob, blob, and appendable-blob.
