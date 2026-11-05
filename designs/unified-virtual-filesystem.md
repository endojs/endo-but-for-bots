# Unified Virtual Filesystem and Pet-Name System

| | |
|---|---|
| **Created** | 2026-11-05 |
| **Updated** | 2026-11-05 |
| **Author** | Kris Kowal (prompted) |
| **Status** | Proposed |

## Status and reading guide

This is the normative consolidation of Endo's filesystem-shaped capabilities and
the first draft of their user documentation.
It reconciles the implemented interfaces with prior designs; it does not claim
that the proposed common interface is implemented.

The labels below are normative:

- **Implemented** means the behavior exists on `llm` in `@endo/daemon`,
  `@endo/platform`, or `@endo/exo-*`.
- **Designed** means a reviewed design specifies it, but the behavior is absent
  or incomplete on `llm`.
- **Proposed** means this document introduces or resolves the behavior.

`MUST`, `SHOULD`, and `MAY` apply to the proposed common interface.
Existing interfaces remain compatibility surfaces until the build ladder retires
their divergences.

## The pet-name system for people who know filesystems

An Endo directory is a filesystem directory generalized from "names point to
files" to "names point to capabilities".
A name has meaning only relative to the directory capability the holder received.
Consequently, two holders can use different private names for the same object,
and neither learns the other's names.
This is the pet-name property.

Paths are arrays of pet names, not ambient absolute strings.
Looking up `['src', 'main.js']` asks the holder's current root for `src`, then
asks that capability for `main.js`.
There is no global `/`, current working directory, drive letter, or authority to
walk above the supplied root.

Entries may be mutable files and directories, immutable blobs and trees, block
devices, append-only logs, structured-data stores, or arbitrary capabilities.
A holder can receive a live read-only view, an immutable snapshot, or a view whose
writes a separate controller can enable, disable, or revoke.
These views preserve ordinary filesystem intuitions while making authority and
time explicit.

Snapshots let a consumer compare, patch, merge, and verify content without
sharing mutation authority.
Opaque content identities support compare-and-swap without making one hash
algorithm part of the public contract.
Range readers, search, and reference-level splices let an agent inspect or
assemble large content without putting all of it in its language-model context.

This differs from POSIX in three important ways:

1. Possessing a directory is the authority to name beneath it; paths alone grant
   nothing.
2. Read-only, snapshot, and controlled mutability are distinct capabilities.
3. A directory can name a capability that has no byte representation at all.

## Goals and non-goals

This design standardizes the vocabulary, view algebra, method families, errors,
attenuation points, content identities, and archive round trips.
It also specifies the missing large-result guard and reference-level splice
operations.

It does not turn arbitrary capabilities into POSIX file descriptors, prescribe a
single storage engine, expose public content hashes as identity, or make untrusted
locators safe to open.
Git commits, formula identities, and content-store digests remain distinct from
filesystem content identity.

## Source map

The source designs are linked instead of repeated.
The status in this table describes the relevant slice on `llm`, not necessarily
the status printed in an older document.

| Area | Sources | Current status |
|---|---|---|
| Shared naming and guards | [name-hub unification](namehub-interface-unification.md), [interface reconciliation](fs-interface-reconciliation.md), [interface consolidation](fs-interface-consolidation.md) | **Implemented in part:** common readable guards exist; richer mount and extended-FS guards remain distinct. |
| Mount model and authority | [capability filesystem](daemon-capability-filesystem.md), [mount](daemon-mount.md), [mount capabilities](daemon-mount-capabilities.md), [visible roots](daemon-mount-visible-roots.md) | **Implemented in part:** mounts, entries, snapshots, read-only views, and captive revocation exist; the controller in this design does not. |
| Search and agent operations | [stream/glob/grep](mount-stream-glob-grep.md), [agent FS tools](agent-tools-mount-fs-tools.md), [CLI edit](cli-edit-verb.md), [endopi edit](endopi-edit-tool.md), [Chat edit](chat-view-edit-commands.md) | **Implemented in part:** eager `glob`, `grep`, `glorp`, and hashline primitives exist; bounded streaming and one common tool surface do not. |
| Snapshots and lifecycle | [checkin/checkout](daemon-checkin-checkout.md), [CAS management](daemon-cas-management.md), [content-store GC](daemon-content-store-gc.md), [snapshot mapper](snapshot-mapper.md), [make archive](daemon-make-archive.md) | **Implemented in part:** content-addressed stores, checkout, pruning, and archive machinery exist; the generic snapshot contract and capability round trip do not. |
| Byte and range access | [range attenuation](readableblob-range-attenuation.md), [range/tree reads](platform-range-and-tree-reads.md), [Endo bytes](endo-bytes.md), [store write](store-write-file.md), [store text modes](cli-store-verb-text-modes.md) | **Implemented in part:** blob ranges and byte values exist under multiple names; the common bounded materializers are proposed here. |
| Alternate trees | [npm registry tree](npm-registry-as-directory-tree.md), [FS from Git](endo-fs-from-git.md), [Git capability](daemon-git-capability.md), [watchers](filesystem-watchers.md), [root advancement](exo-git-follow-root-advancement.md) | **Implemented/designed:** adapters and watchers exist at different maturity; transactional root advancement is designed. |
| Consumers | [formula inspector](formula-inspector.md), [container mount](runtime-container-fs-mount.md) | **Designed/implemented in part:** both depend on stable naming and attenuation rather than a new tree kind. |
| Non-file storage | [daemon persistent stores](../packages/daemon/designs/daemon-persistent-stores.md), [storage matrix PR #1264](https://github.com/endojs/endo-but-for-bots/pull/1264), [mutable block storage PR #1265](https://github.com/endojs/endo-but-for-bots/pull/1265) | **Proposed:** the matrix distinguishes live and snapshot views; durable data and block capabilities are not common directory entries yet. |
| Platform baseline | [platform FS](platform-fs.md), [backend seam](endo-fs-backend-seam.md) and `packages/platform/src/fs/{interfaces.js,extended/}` | **Implemented:** lite and extended interfaces, native/in-memory backends, bytes, snapshots, ranges, and watches exist. |
| Daemon baseline | `packages/daemon/src/{interfaces.js,mount.js,directory.js,hashline.js}` | **Implemented:** pet-name hubs, mounts, search, hashline validation, read-only views, snapshots, and revocation exist. |
| Exo baseline | `packages/exo-git/src/{interfaces.js,git.js,git-filesystem.js}` and the `@endo/exo-*` capability style | **Implemented:** Git offers rendered diff and repository merge operations; these are not generic snapshot diff/merge. |

## Core model

### Entries and paths

A `Path` is a frozen array of non-empty Unicode strings.
APIs MAY accept one string as shorthand for a one-segment path, but MUST NOT
split a string on `/`.
Portable archives normalize entry names to Unicode NFC and reject duplicate
normalized names, `.` and `..`, NUL, and names their target archive cannot
represent losslessly.

A directory maps each local name to one of these entry kinds:

| Kind | Mutable authority | Snapshot result | Status |
|---|---|---|---|
| `File` / `Directory` | byte or tree mutation | `SnapshotBlob` / `SnapshotTree` | **Implemented**, common shape proposed |
| `BlockStorage` | sized random writes and append | `SnapshotBlob` | **Proposed** in PR #1265 |
| `AppendLog` | append records only | immutable sequence/tree | **Proposed here**; no common design exists |
| `DataStore` | typed map/set/data operations | pass-by-copy value or immutable tree | **Designed** by daemon persistent stores |
| `CapabilityLink` | authority of the referenced capability | link record, not frozen referent | **Implemented concept**, serialization proposed here |

An arbitrary capability entry is a `CapabilityLink`.
A directory snapshot freezes the binding to that link, not the state of the
referent.
A caller requiring a deep deterministic snapshot MUST request strict mode;
strict mode rejects a non-snapshottable entry with `UNSNAPSHOTTABLE_ENTRY`
instead of silently implying that the referent was frozen.

`NameHub` remains the general pet-name map.
`ReadableTree` is the filesystem-shaped subset whose entries have stable kinds
and path traversal.
`Mount` is a daemon boundary that adds discovery, search, mutation, and
lifecycle.
Adapters SHOULD derive all three from the method families below rather than
copying guards.

### View algebra

For an underlying mutable object `x`, define:

- `R(x) = x.readOnly()`: a live, structurally read-only view.
- `S(x) = await x.snapshot()`: an immutable content snapshot.
- `C(k, x) = x.controlled(k)`: a view governed by controller `k`.
- `I(x) = await x.identity()`: an opaque identity for the complete visible
  content at one instant.

The required laws are:

```text
read(R(x), t) = read(x, t)                 live at time t
write(R(x), ...) = absent                  no mutator is exposed
read(S(x), t1) = read(S(x), t2)            immutable
S(S(x)) = S(x)                             snapshot idempotence
equivalent(I(x), I(S(x))) after S(x) = true
authority(A(B(x))) <= authority(A(x)) and authority(B(x))
```

`R(x)` is therefore not `S(x)`.
A snapshot can outlive and diverge from its source, whereas a read-only view
observes later source changes.

`C(k, x)` exposes the methods allowed by its static facet, but every operation
also consults the controller's current branch policy.
The controller can atomically set a branch to `read`, `write`, or `revoked`, and
can later flip it in either direction.
Only the controller can make a controlled view more permissive.
Other attenuations remain monotonic: a size limit, path root, or omitted method
cannot be raised or restored by the controller.

Revocation or a policy flip linearizes before or after an in-flight transaction.
It MUST NOT expose a partial write.
The controller is separate from the client view and MUST NOT be discoverable by
walking the directory.
The current daemon `MountControl.revoke()` is a captive, one-way precursor, not
this controller.

### Opaque identity and compare-and-swap

The common interface proposes:

```js
identity(): Promise<ContentIdentity>
snapshot(options = {}): Promise<SnapshotBlob | SnapshotTree>
ContentIdentity.equivalent(other): Promise<boolean>
```

`ContentIdentity` is an opaque, non-forgeable description of content
equivalence.
It does not reveal a digest, algorithm, storage address, provider revision, or
Git object ID.
Providers MAY compare a shared private digest as a fast path and MUST fall back
to canonical byte/tree comparison when identities use different algorithms.
Public `sha256()` and `{ algorithm, hash }` methods remain diagnostic and
content-store locator APIs; new correctness logic MUST NOT depend on them.

A mutator taking `{ expected }` compares the current complete target identity
with the supplied snapshot or `ContentIdentity` immediately before commit.
Mismatch throws `PRECONDITION_FAILED` without changing the target.
This is content-equivalence CAS, so an A-to-B-to-A history satisfies a
precondition for A; clients that need history ordering also supply the provider's
incarnation-local revision.

Tree CAS covers the complete visible root, including entry kinds and capability
link records.
File CAS covers the complete byte sequence.
The comparison and mutation are one transaction.
On success a mutator returns `{ snapshot, identity, revision }`, letting the
caller verify the result without rereading it.

A controlled mutation first checks the controller policy, then performs the CAS
and commit under one serialization boundary.
If policy changes first, it returns `ACCESS_REVOKED`; if content changes first,
it returns `PRECONDITION_FAILED`.

## Standard method families

The signatures below are the proposed canonical vocabulary.
Passable streams and result capabilities are used where an eager array or string
could be unbounded.

### Readable blobs and files

| Method | Meaning | Views |
|---|---|---|
| `size()` | Exact byte length. | live read-only, snapshot, mutable, controlled |
| `readBytes()` / `readText()` | Materialize the whole value subject to the result limit; text is strict UTF-8 unless an encoding is explicit. | all readable views |
| `readByteRange(start, end)` | Materialize half-open byte range `[start,end)` subject to the limit. | all readable views |
| `readTextRange(startLine, endLine)` | Materialize half-open zero-based line range, preserving terminators. | all readable views |
| `byteRange(start, end)` / `textRange(startLine, endLine)` | Return a narrowed reader capability; ranges compose by intersection. | all readable views |
| `streamBytes()` | Return a backpressured byte stream. | all readable views |
| `identity()` / `snapshot()` | Capture opaque content identity or immutable content. | all readable views |
| `writeBytes(value, options)` / `writeText(value, options)` | Replace content atomically, optionally with `expected`. | mutable, writable controlled |
| `append(value, options)` | Atomically append with an optional expected identity. | mutable, writable controlled, append storage |
| `editHashlines(edits, options)` | Validate line anchors and apply one atomic splice transaction. | mutable, writable controlled |

The existing materializing `text`, `bytes`, `fetch`, `rangeRead`, and
`rangeReadText` spellings remain adapter aliases while callers migrate.
`byteRange` and `textRange` are attenuation constructors; the `read*Range`
methods are their bounded materializing conveniences.

Hashline edits use a whole-file expected identity plus CRC32 line anchors.
Replace, replace-range, delete, insert-before, insert-after, prepend, and append
are supported.
Literal replacement text is permitted, but reference payloads described below
avoid reading source content into the caller.

### Trees and directories

| Method | Meaning | Views |
|---|---|---|
| `has(path)`, `lookup(path)`, `maybeLookup(path)` | Traverse pet names and return an entry capability. | all tree views |
| `list(path, options)`, `listTree(path, options)` | Return a bounded page or reader of typed entries. | all tree views |
| `glob(pattern, options)` | Enumerate matching paths using the corpus glob grammar. | all tree views |
| `grep(pattern, options)` | Search readable text entries and yield `{ path, line, text, ranges }`. | all tree views |
| `glorp(globPattern, grepPattern, options)` | Apply `glob`, then `grep` only those matching files, yielding the same grep records. | all tree views |
| `identity()`, `snapshot(options)` | Capture the whole visible tree. | all tree views |
| `watch()` / `followChanges(options)` | Follow live transactions; absent on immutable snapshots. | live read-only, mutable, controlled |
| `makeDirectory`, `makeFile`, `remove`, `move`, `copy` | Mutate one root transactionally, optionally with `expected`. | mutable, writable controlled |

`glorp` is not a new fuzzy-search algorithm.
It is the fused `glob`-then-`grep` operation already implemented by
`packages/platform/src/fs/search.js` and exposed by `Mount`.
The implemented result is exactly an eager array of `{ file, line, text }`
records.
The common interface renames `file` to `path`, adds match `ranges`, and streams
the same records; an adapter preserves the implemented shape.
Its patterns have the same grammar as the corresponding separate operations.
The current implementation's default 1,000-result cap and silent glob
truncation become an explicit continuation or `RESULT_TOO_LARGE`, never silent
loss.

### Diff, patch, merge, and reference transforms

```js
snapshot.diff(other, options): Promise<Patch>
mutable.applyPatch(patch, { expected }): Promise<MutationResult>
snapshot.merge(base, other, options): Promise<MergeResult>
mutable.applyTransform(transform, { expected }): Promise<MutationResult>
```

`Patch` is an immutable, streamable capability whose hunks may refer to source
ranges by capability instead of embedding bytes.
`diff` exists only on immutable snapshots so both operands are stable.
`applyPatch` exists only on mutable or writable controlled views and requires an
expected identity unless the caller explicitly chooses last-writer-wins.

`merge` is a pure three-way operation: the receiver is left, `base` is the
common ancestor, and `other` is right.
It returns `{ snapshot, conflicts }`; conflicts are bounded, typed records with
range references, not conflict-marker text silently written to a target.
Applying the result is a separate CAS mutation.

`Transform` contains ordered operations over capability references:

```js
{ op: 'copyRange', source, sourceStart, sourceEnd, targetPath, targetOffset }
{ op: 'deleteRange', targetPath, start, end }
{ op: 'insert', targetPath, targetOffset, value: bytesOrRangeReference }
```

The provider resolves every source snapshot, validates all ranges and the target
precondition, stages the complete result, and commits once.
Overlapping operations use their declared order against the staged value.
No operation invokes caller code inside the transaction.

### Blocks, logs, data, and generic slots

`BlockStorage` has `size`, range reads, `writeRange`, `append`, `truncate`,
`identity`, and `snapshot`; it deliberately has no middle insertion method.
`AppendLog` has `append`, `follow`, `snapshot`, and ranged record reads, with no
rewrite authority.
`DataStore` has the typed map/set operations from the persistent-store design
and `snapshot`; pass-by-copy snapshots are used when bounded, otherwise an
immutable tree is returned.

These capabilities compose with directories by being entry values.
They do not inherit file methods merely because a snapshot can become a blob.
A directory pet name grants exactly the entry capability stored there.

## Errors

All failures are passable error records with `name`, stable `code`, `message`,
and a copy-only `details` record.

| Code | Meaning |
|---|---|
| `NOT_FOUND` | A named path or range source does not exist. |
| `WRONG_ENTRY_KIND` | The entry exists but does not support the operation. |
| `READ_ONLY` | The static facet does not expose mutation; adapters may use this during migration. |
| `ACCESS_REVOKED` | A controller policy or revoker denied the operation. |
| `PRECONDITION_FAILED` | The expected identity or revision is stale. |
| `INVALID_RANGE` | A range is negative, fractional where integral, reversed, or unrepresentable; a valid range beyond the source clamps to an empty suffix. |
| `MERGE_CONFLICT` | A caller requested conflict-free output but conflicts remain. |
| `RESULT_TOO_LARGE` | Materializing or rendering a result exceeds its attenuation. |
| `UNSNAPSHOTTABLE_ENTRY` | Strict deep snapshot encountered a generic live capability. |
| `LOCATOR_UNREACHABLE` | A restored capability link cannot presently resolve. |

Static read-only facets SHOULD omit mutators entirely.
The `READ_ONLY` error exists for current uniform extended-FS guards and dynamic
controller flips, not as the desired attenuation mechanism.

## Size-limited reader attenuation

Every materializing reader can be wrapped with
`reader.limitResults({ bytes, entries, records, patchBytes })`.
The minter or administrator chooses the outer policy.
A holder may derive an equal or lower limit and MUST NOT raise any component;
each attenuation chain uses the minimum at every layer.
Changing controlled mutability does not change result limits.

Before allocating or returning a whole result, the provider determines its
actual encoded size where possible.
An oversized operation throws this shape:

```js
{
  name: 'ResultTooLargeError',
  code: 'RESULT_TOO_LARGE',
  message: 'readText would return 9187342 bytes; limit is 262144 bytes. ' +
    'Use grep, glob, or glorp to locate relevant ranges, then retry with ' +
    'readTextRange or readByteRange and propose changes by reference.',
  details: {
    operation: 'readText',
    limit: 262144,
    actual: 9187342,
    unit: 'bytes',
    retry: {
      locate: ['grep', 'glob', 'glorp'],
      read: ['readTextRange', 'readByteRange'],
    },
  },
}
```

If exact size is unknowable before streaming, `actual` is the first observed
size greater than the limit and `details.exact` is `false`.
The stream terminates with the same structured error and MUST NOT buffer past
the smallest necessary chunk.

`list`, `listTree`, `glob`, `grep`, `glorp`, `diff`, conflict lists, and rendered
merge results are subject to their entry, record, and byte limits.
Their preferred success result is a backpressured reader or continuation-bearing
page, so reaching a page boundary is not an error.
`Patch` and merged snapshots remain capabilities; only materializing or rendering
them consumes a result budget.

The error deliberately teaches an automated consumer how to recover.
It MUST name the operation, limit, observed size, search operations, range
operations, and reference-level update path.

## Splicing without reading into an agent context

### Move a function between files

An agent uses `grep('function parseRequest')` to find the line range in snapshot
`A`, requests only adjacent lines for review, and constructs a transform whose
payload is `{ source: A.lookup(['src','old.js']), start, end }`.
The same transform inserts that range in `src/new.js` and deletes the original
range, with `expected: I(worktree)`.
The result returns `identity` and a snapshot; the agent compares that identity
with the transform's predicted result instead of rereading both files.

### Three-way merge edited snapshots

Given base `B` and independently edited snapshots `L` and `R`, the caller asks
`L.merge(B, R)`.
The provider reads the snapshots internally, returns a merged snapshot plus
range-referenced conflicts, and the agent reviews only conflict ranges.
It applies the chosen merge snapshot to the mutable root with
`expected: I(currentRoot)`; a concurrent edit fails before any write.

### Build a file from several blobs

A transform creates `bundle.txt`, copies bytes `[0,120)` from blob `A`,
`[800,1040)` from blob `B`, and `[12,90)` from blob `C`, then appends one small
literal terminator.
The provider validates all three immutable sources, writes one staged target,
and atomically publishes it.
The caller checks the returned opaque identity against an expected identity or a
signed manifest without materializing the bundle.

Hashline edits are the line-oriented form of the same mechanism.
Their replacement payload MAY be a range reference, and their anchors plus the
whole-file expected identity prevent a splice at the wrong location.

## Portable serialization of capability entries

### Exact loose-file envelope

When a capability link must appear as a file in a format that cannot represent
typed directory entries, version 1 uses this byte layout:

| Offset | Length | Value |
|---:|---:|---|
| 0 | 16 | Magic bytes `89 45 4e 44 4f 0d 0a 1a 0a 4f 43 41 50 52 45 46` (`0x89`, `ENDO`, CR LF SUB LF, `OCAPREF`) |
| 16 | 1 | Envelope version `0x01` |
| 17 | 1 | Digest algorithm `0x01` for SHA-256 |
| 18 | 1 | Locator encoding `0x01` for strict UTF-8 |
| 19 | 1 | Flags, zero in version 1 |
| 20 | 8 | Unsigned big-endian locator byte length `N` |
| 28 | 32 | SHA-256 of ASCII `ocap:` followed by the exact `N` locator bytes |
| 60 | `N` | Locator bytes, with no delimiter or padding |

`N` MUST be at most 1 MiB.
Unknown versions, algorithms, encodings, nonzero reserved flags, trailing bytes,
invalid UTF-8, length mismatch, or digest mismatch are malformed envelopes.
The digest detects accidental or unsophisticated tampering but is not a signature:
an attacker who changes a locator can recompute it.
Authenticity comes from an authenticated archive manifest or signature.

The leading `0x89` cannot begin valid UTF-8 text, so a plain text file never
collides.
Arbitrary binary can collide, therefore restore MUST NOT classify an untrusted
file as a capability solely from these bytes.

### Authoritative manifest and round trip

The recommended archive form combines the envelope with a canonical-CBOR,
directory-level manifest.
For each non-ordinary entry the manifest binds normalized path, entry kind,
envelope digest, and archive version.
The authenticated manifest is authoritative; the in-band envelope preserves a
useful loose-file representation.
An ordinary binary file beginning with the magic remains ordinary unless the
manifest marks it `CapabilityLink`.

Sidecar files were considered but introduce colliding reserved names and make
atomic rename/copy difficult.
Extended attributes avoid visible sidecars but are not portable through ZIP,
Git, object stores, or common copy tools.
A directory-level index is therefore the portable source of truth.

Snapshot and checkin record the link without dereferencing it.
Checkout and `make-archive` reproduce the exact envelope and manifest entry.
Restore validates the manifest, length, encoding, and digest before constructing
an unresolved `CapabilityLink`.
Resolution is a separate authority-bearing operation.

If a locator is unavailable, ordinary restore succeeds and preserves the
unresolved link; opening it throws `LOCATOR_UNREACHABLE` with path and a
non-secret diagnostic.
Strict restore MAY fail the entire transaction atomically when all links must be
reachable.

Locators can be bearer capabilities, including secret-bearing HTTPS fragments.
Archives containing them MUST be treated as credential stores: least-readable
permissions, encryption at rest and in transit, no logs, no search indexing, and
explicit export authority.
Neither the envelope digest nor a content-addressed archive makes a locator
public or safe.

## REST versus CapTP

The common interface defaults to CapTP because every operation exercises held
object authority, returns further capabilities, benefits from pipelining, and
needs revocation and disconnection semantics.

| Surface | Rubric score | Transport |
|---|---|---|
| Lookup, read, search, snapshot, mutation, control, watch, diff, patch, merge | CapTP rows 1, 2, 3, 4, and 6: held-object authority, capability arguments/results, state/streams, independent attenuation, and live results. | **CapTP** |
| Initial archive download or upload | CapTP rows 1 and 4 by default; REST row 5 only for a client that cannot speak CapTP. Override 2 permits a one-use bearer URL designating exactly one transfer object. | **CapTP**, or REST for bytes after CapTP mints the transfer grant |
| Minting or opening the first external locator | REST rows 5 and 7 and override 1: a pre-session client establishes its first reference. | REST/HTTPS bootstrap; the opened object immediately becomes **CapTP** |

There are no REST endpoints that accept a raw pet-name path or bearer capability
string as a substitute for possessing the root.
The locator-opening boundary is the rubric's explicit bootstrap exception, not a
parallel REST filesystem API.

## Ownership map

| Boundary | Mechanism | Policy | Durable state | Lifecycle / commit authority | Value crossing |
|---|---|---|---|---|---|
| Client view -> mutable provider | The view sends one guarded read or staged mutation. | The view's attenuation admits paths, methods, and result sizes; the provider validates CAS. | The provider alone owns bytes, tree metadata, revision, and journal. | The provider commits or discards one mutation and recovers its journal before publishing a root. | Path, operation, expected identity, and `MutationResult`, all filesystem vocabulary. |
| Controller -> mutable provider | The controller supplies branch policy and generation. | The controller decides read/write/revoked; the provider decides transaction atomicity. | The controller owns durable policy; the provider owns content. | The controller restores policy before facets revive; the provider linearizes a write against its generation. | Branch selector and policy generation, controller vocabulary. |
| Mutable provider -> snapshot/content store | The provider writes immutable children and a root. | The provider decides when a complete snapshot can publish; store GC decides reachability reclamation. | The content store alone owns immutable objects and reachability metadata. | The store publishes complete roots and discards staging; it re-indexes private identities after restart. | Immutable bytes/tree nodes and opaque `ContentIdentity`, snapshot vocabulary. |
| Pet-name/formula directory -> provider or capability link | The directory binds a local name to a typed capability entry; a formula may reincarnate it. | The directory owner admits binding changes; it does not decide content mutations. | The directory/formula store owns bindings and recipes; the target provider owns target state. | The directory commits bindings and replays recipes before lookup; unresolved links remain inert. | Name, entry kind, formula ID or link, outer naming vocabulary. |
| Archive/restore -> directory and locator resolver | Export writes a manifest/envelope; restore validates and mints unresolved links. | Explicit export authority admits bearer locators; restore chooses strict or unresolved mode. | The archive owner owns archive bytes; the destination owns installed bindings. | Export finalizes the manifest last; restore atomically installs or discards staging and never owns resolver restart. | Manifest entry, envelope bytes, and locator, archive vocabulary. |
| Git adapter -> filesystem provider | The adapter reads a root and stages Git objects; the provider offers a filesystem transaction. | Filesystem write, Git commit, and push policy remain independent. | Git owns objects, refs, and stage metadata; the provider owns the working root. | Each side commits and replays its own state; no filesystem mutation implies commit or push. | Snapshot root, tentative metadata, Git commit result, each named by its owning layer. |

**Persistent state.**
The mutable provider owns content and journals, the controller owns policy, the
content store owns immutable objects, the directory/formula store owns bindings
and recipes, the archive owner owns exported bytes, and Git owns Git objects.
No durable datum has two owners.

**Commit or discard.**
Each provider decides whether its staged mutation publishes; the directory
separately commits bindings, restore separately installs a tree, and explicit Git
operations separately commit and push.

**Restart and replay.**
Each durable owner repairs or replays only its own state before reviving its
facet.
An ephemeral provider starts a new incarnation revision, and a missing locator
resolver leaves an inert unresolved link rather than replaying an open.

**Execution classification.**
The mutable provider classifies a filesystem operation as committed, rejected,
or failed.
The controller supplies policy but does not relabel the outcome, and outer Git,
archive, or formula layers decide what to do about it.

**Inner/outer naming check.**
Inner backends return operation and `MutationResult` values only for their own
filesystem transaction.
They do not return Git commits, formula replays, archive restores, or controller
policy results; those outer lifecycle terms remain at their owning boundaries.

## Inconsistencies and gaps

| Topic | Sources | What differs or is missing | Recommended resolution |
|---|---|---|---|
| Read-only versus snapshot | mount capabilities, storage matrix PR #1264, platform interfaces | Some names and formula types call immutable snapshots "readable"; `readOnly()` is live. | Use `Readable*` for a posture, `Snapshot*` for immutable content, and document `R(x) != S(x)`. |
| Content identity | platform range reads, CAS management, root advancement | Public SHA-256/tree refs leak an algorithm into CAS; 2026-11-03 direction is opaque `identity()`/`snapshot()`. | Make identity opaque and content-equivalent; retain hashes only as private fast paths and explicit locator diagnostics. |
| Range names | platform range/tree reads, range attenuation, extended FS | `fetch`, `rangeRead`, `rangeReadText`, `bytes`, `byteRange`, and `textRange` overlap. | Standardize bounded materializers as `readByteRange`/`readTextRange`; keep `byteRange`/`textRange` as attenuating capability constructors. |
| NameHub and mount overlap | name-hub unification, interface consolidation, daemon guards | Shared methods have different accepted path and result shapes. | Derive guards from method families; keep explicit adapters for entry-as-path overloads. |
| Read-only attenuation | extended FS, mount capabilities | One API keeps mutators and rejects calls; another omits mutators. | New static facets omit methods; dynamic controlled facets may reject after a flip. |
| Search bounds | stream/glob/grep, current search implementation | Design streams; implementation returns eager arrays and silently truncates an intermediate glob. | Return readers/pages and explicit continuation or `RESULT_TOO_LARGE`; never silently truncate. |
| Hashline CAS | CLI edit, daemon hashline implementation | Anchors use public raw SHA-256 and literal replacement content. | Accept opaque expected identity and range-reference payloads; preserve CRC32 line anchors. |
| Diff, patch, merge | root advancement, exo-git, agent tools | Git has operations, but snapshots lack one portable contract. | Put pure `diff`/`merge` on snapshots and CAS `applyPatch` on mutable views. |
| Dynamic mutability | mount capabilities | Captive control only revokes a whole mount. | Add a separate branch-policy controller with atomic read/write/revoked flips. |
| Non-file storage | persistent stores, PRs #1264/#1265 | Block and data stores are proposals; no common append-only interface exists. | Add typed directory entry kinds; implement block first, append log and data adapters later. |
| Capability serialization | checkin/checkout, make archive | Arbitrary capability bindings have no portable archive representation. | Use an authenticated directory manifest plus the versioned envelope in this design. |
| Snapshotting capability slots | mount and archive designs | It is unclear whether snapshot freezes a referenced object. | Freeze the link only; strict deep snapshot rejects a non-snapshottable referent. |
| Watcher vocabulary | filesystem watchers, mount changes, root advancement | Event records, ordering, and Promise/reader shapes differ. | Standardize transaction followers around initial snapshot plus revision; adapt path-level events. |
| Large agent reads | range designs, agent tools | Ranges exist, but a holder can still materialize an unlimited whole file or diff. | Mint size-limited reader facets and use the teaching error specified above. |

## Build ladder

Each rung can land independently behind adapters and conformance tests.

1. Publish terminology, result/error records, and tests proving that live
   read-only and snapshot views differ.
2. Add `readByteRange`/`readTextRange` aliases and the size-limited reader facet,
   including teaching errors for files, listings, and searches.
3. Replace eager search truncation with continuation-bearing pages/readers and
   make `glorp` conformance explicit.
4. Introduce opaque `ContentIdentity` beside existing hashes, then move hashline
   and tree CAS preconditions to it.
5. Add reference payloads to hashline edits and atomic `Transform.copyRange` for
   one file, then a whole-tree transaction.
6. Add portable snapshot `diff`, streamable `Patch`, CAS `applyPatch`, and pure
   three-way `merge`.
7. Split static read-only guards from mutable guards and add the independent
   mutability controller with durable-policy tests.
8. Land `BlockStorage`, then `AppendLog` and persistent `DataStore` adapters as
   typed directory entries.
9. Add the canonical-CBOR archive manifest and version-1 capability envelope to
   checkin/checkout and `make-archive`, including unreachable-link recovery.
10. Migrate daemon, platform, exo-git, registry, formula inspector, container,
    CLI, Chat, endopi, and agent-tool consumers; retire compatibility spellings.

The full ladder is XL, approximately three to five weeks when split across
reviewable PRs.
Rungs 1–3 are the smallest useful first release and do not depend on controller,
archive, or non-file storage work.

## Conformance and acceptance

A shared suite MUST run against in-memory, native, mount, Git-backed, registry,
and remote adapters where applicable.
It covers view laws, path confinement, entry kinds, opaque cross-provider
identity comparison, ABA and stale CAS, controller races, partial-failure
atomicity, range composition, result limits, search continuation, merge
conflicts, reference splices, archive tampering, binary magic collisions,
secret-locator redaction, unreachable locators, restart replay, and GC liveness.

Tests MUST demonstrate that no oversized whole result is allocated before the
teaching error, no rejected transaction publishes a partial root, and successful
splices can be verified by identity without rereading output.

## Open questions

None.
The first build should follow the recommendations above and surface any
provider-specific impossibility as a focused amendment rather than reopening the
common vocabulary.

## Prompt

Consolidate Endo's pet-name and virtual-filesystem designs into a normative,
documentation-shaped interface.
Cover mutable, snapshot, live read-only, and controlled views; files, blocks,
logs, data, and arbitrary capabilities; opaque CAS identity; search, editing,
diff/patch/merge, range and size attenuation; reference-level splicing;
capability serialization; ownership; inconsistencies; and a small build ladder.
