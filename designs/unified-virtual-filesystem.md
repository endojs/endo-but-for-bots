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

Entries may be mutable files and directories, immutable blobs and trees, block,
log, map, set, and bag stores, cells, or arbitrary values.
A holder can receive a live read-only view, an immutable snapshot, or a view whose
writes a separate controller can enable, disable, or revoke.
These views preserve ordinary filesystem intuitions while making authority and
time explicit.

Snapshots let a consumer compare, patch, merge, and verify content without
sharing mutation authority.
They also serve as the preconditions of compare-and-swap, so no hash algorithm
becomes part of the public contract.
Range readers, search, and reference-level splices let an agent inspect or
assemble large content without putting all of it in its language-model context.

This differs from POSIX in three important ways:

1. Possessing a directory is the authority to name beneath it; paths alone grant
   nothing.
2. Read-only, snapshot, and controlled mutability are distinct capabilities.
3. A directory can name a capability that has no byte representation at all.

## Goals and non-goals

This design standardizes the vocabulary, view algebra, method families, errors,
attenuation points, snapshot comparison, and archive round trips.
It also specifies the missing large-result guard and reference-level splice
operations.

It does not turn arbitrary capabilities into POSIX file descriptors, prescribe a
single storage engine, expose public content hashes as identity, or make untrusted
locators safe to open.
Git commits, formula identities, and content-store digests remain distinct from
snapshot comparison.

## Source map

The source designs are linked instead of repeated.
The status in this list describes the relevant slice on `llm`, not necessarily
the status printed in an older document.

- **Shared naming and guards**
  - Sources: [name-hub unification](namehub-interface-unification.md), [interface
    reconciliation](fs-interface-reconciliation.md), [interface
    consolidation](fs-interface-consolidation.md)
  - Current status: **Implemented in part:** common readable guards exist; richer mount and
    extended-FS guards remain distinct.
- **Mount model and authority**
  - Sources: [capability filesystem](daemon-capability-filesystem.md), [mount](daemon-mount.md),
    [mount capabilities](daemon-mount-capabilities.md), [visible
    roots](daemon-mount-visible-roots.md)
  - Current status: **Implemented in part:** mounts, entries, snapshots, read-only views, and
    mount-local revocation exist; the controller in this design does not.
- **Search and agent operations**
  - Sources: [stream/glob/grep](mount-stream-glob-grep.md), [agent FS
    tools](agent-tools-mount-fs-tools.md), [CLI edit](cli-edit-verb.md), [endopi
    edit](endopi-edit-tool.md), [Chat edit](chat-view-edit-commands.md)
  - Current status: **Implemented in part:** eager `glob`, `grep`, `glorp`, and hash-line
    primitives exist; bounded streaming and one common tool surface do not.
- **Snapshots and lifecycle**
  - Sources: [checkin/checkout](daemon-checkin-checkout.md), [CAS
    management](daemon-cas-management.md), [content-store GC](daemon-content-store-gc.md),
    [snapshot mapper](snapshot-mapper.md), [make archive](daemon-make-archive.md)
  - Current status: **Implemented in part:** content-addressed stores, checkout, pruning, and
    archive machinery exist; the generic snapshot contract and capability round trip do not.
- **Byte and range access**
  - Sources: [range attenuation](readableblob-range-attenuation.md), [range/tree
    reads](platform-range-and-tree-reads.md), [Endo bytes](endo-bytes.md), [store
    write](store-write-file.md), [store text modes](cli-store-verb-text-modes.md)
  - Current status: **Implemented in part:** blob ranges and byte values exist under multiple
    names; the common bounded materializers are proposed here.
- **Alternate trees**
  - Sources: [npm registry tree](npm-registry-as-directory-tree.md), [FS from
    Git](endo-fs-from-git.md), [Git capability](daemon-git-capability.md),
    [watchers](filesystem-watchers.md), [root advancement](exo-git-follow-root-advancement.md)
  - Current status: **Implemented/designed:** adapters and watchers exist at different maturity;
    transactional root advancement is designed.
- **Consumers**
  - Sources: [formula inspector](formula-inspector.md), [container
    mount](runtime-container-fs-mount.md)
  - Current status: **Designed/implemented in part:** both depend on stable naming and
    attenuation rather than a new tree kind.
- **Non-file storage**
  - Sources: [daemon persistent stores](../packages/daemon/designs/daemon-persistent-stores.md),
    [storage matrix PR #1264](https://github.com/endojs/endo-but-for-bots/pull/1264), [mutable
    block storage PR #1265](https://github.com/endojs/endo-but-for-bots/pull/1265)
  - Current status: **Proposed:** the matrix distinguishes live and snapshot views; durable data
    and block capabilities are not common directory entries yet.
- **Platform baseline**
  - Sources: [platform FS](platform-fs.md), [backend seam](endo-fs-backend-seam.md) and
    `../packages/platform/src/fs/{interfaces.js,extended/}`
  - Current status: **Implemented:** lite and extended interfaces, native/in-memory backends,
    bytes, snapshots, ranges, and watches exist.
- **Daemon baseline**
  - Sources: `../packages/daemon/src/{interfaces.js,mount.js,directory.js,hashline.js}`
  - Current status: **Implemented:** pet-name hubs, mounts, search, hash-line validation,
    read-only views, snapshots, and revocation exist.
- **Exo baseline**
  - Sources: `../packages/exo-git/src/{interfaces.js,git.js,git-filesystem.js}` and the
    `@endo/exo-*` capability style
  - Current status: **Implemented:** Git offers rendered diff and repository merge operations;
    these are not generic snapshot diff/merge.

## Core model

### Entries and paths

A `Path` is a frozen array of segments.
One shared guard validates every segment at the facet boundary of every adapter: a
segment is a non-empty Unicode string that contains no `/`, `\`, or NUL and is neither
`.` nor `..`.
This tightens the daemon's implemented `isValidName`, which admits `\`, and that
function's narrower pet-name rules still apply to pet names.
A path therefore has no up-level or current-directory step.
APIs MAY accept one string as shorthand for a one-segment path, but MUST NOT
split a string on `/`.
A native adapter MUST resolve a path one segment at a time beneath its root, and MUST
refuse a symbolic link whose target leaves that root, so host path syntax never
reinterprets a pet-name path.
Portable archives normalize entry names to Unicode NFC and reject duplicate
normalized names, `.` and `..`, NUL, and names their target archive cannot
represent losslessly.

A directory maps each local name to an entry, and every entry has one *kind*, the
category of its content.
Each kind has mutable facets and a snapshot facet:

- `Blob`
  - Mutable facet and authority: `File`: byte mutation.
    `BlockStore`: sized random writes and append.
  - Snapshot facet: `SnapshotBlob`
  - Status: `File` **Implemented**, common shape proposed; `BlockStore` **Proposed** in PR
    #1265, as `BlockStorage`
- `Tree`
  - Mutable facet and authority: `Directory`: tree mutation.
  - Snapshot facet: `SnapshotTree`
  - Status: **Implemented**, common shape proposed
- `Log`
  - Mutable facet and authority: `LogStore`: append records only.
  - Snapshot facet: `SnapshotLog`, an immutable record sequence
  - Status: **Proposed here**; no common design exists
- `Map`, `Set`, `Bag`
  - Mutable facet and authority: `MapStore`, `SetStore`, `BagStore`: typed store operations.
  - Snapshot facet: `SnapshotMap`, `SnapshotSet`, `SnapshotBag`: a pass-by-copy value or immutable
    tree
  - Status: `MapStore` and `SetStore` **Designed** by daemon persistent stores, as data stores;
    `BagStore` **Proposed here**
- `Cell`
  - Mutable facet and authority: `Cell`: replace the referent.
  - Snapshot facet: `SnapshotCell`, a read-only cell over the frozen referent
  - Status: **Proposed here**
- `Value`
  - Mutable facet and authority: None; rebinding the name in its directory replaces it.
  - Snapshot facet: The binding itself
  - Status: **Implemented**: a pet name bound to a formula

Kind and posture are independent.
The kind says what the content is and does not change when an entry is snapshotted.
The facet says what the holder may do with it, by exposing only the methods its
posture and authority allow.
Names such as `File` and `SnapshotBlob` therefore denote facets, not kinds.

Stores and cells differ from a `Value` entry in what changes.
A `Value` entry directly captures any durable value and changes only by modifying the
entry in its directory.
The content of a store or a cell can change without manipulating the directory.

Two operations freeze an entry, and they differ only in what they do with
capabilities:

- `snapshot()` returns immutable content that holds no capability.
  It throws `UNSNAPSHOTTABLE_ENTRY` for any value, in a `Value`, `Cell`, or store, that
  is not a Key or that may hold a remotable, without dereferencing it.
- `capture()` collapses every mutable entry to its immutable variant, such as a
  `BlockStore` to a blob, a `Directory` to a tree, and a `MapStore` to a copy map, and
  preserves all remaining capabilities by reference.
  It freezes the binding to a capability, not the state of that capability.

`NameHub` remains the general pet-name map.
`ReadableTree` is the filesystem-shaped subset whose entries have stable kinds
and path traversal.
`Mount` is a daemon boundary that adds discovery, search, mutation, and
lifecycle.
Adapters SHOULD derive all three from the method families below rather than
copying guards.

### Views by example

A maintainer holds a mutable project directory `x` and gives a reviewer
`view = x.readOnly()`.
The reviewer sees later edits and has no method to make any.
The reviewer keeps `s = await view.snapshot()`, and `s` stays the same while the
maintainer keeps editing.

The maintainer then grants a builder write access to `src` that the maintainer can
withdraw.
The maintainer keeps the controller `k` and the selector `branch`, and the builder
receives only the view `c`:

```js
// Maintainer: mint a controller, a branch over src, and a view of that branch.
const k = await x.makeController();
const branch = await k.makeBranch(['src'], 'read');
const c = await x.controlled(k, branch);

// Builder: reads work, and a write fails under the 'read' policy.
const file = await c.lookup(['main.js']);
const base = await file.snapshot();
await file.writeText(text, { expected: base }); // throws ACCESS_REVOKED

// Maintainer: enable writes; the write commits only if still equivalent to base.
await k.setPolicy(branch, 'write');
await file.writeText(text, { expected: base });

// Maintainer: end the builder's access; every further call throws ACCESS_REVOKED.
await k.setPolicy(branch, 'revoked');
```

### View algebra

For an underlying mutable object `x`, define:

- `R(x) = x.readOnly()`: a live, structurally read-only view.
- `S(x) = await x.snapshot()`: an immutable content snapshot.
- `C(k, b, x) = x.controlled(k, b)`: a view governed by branch `b` of controller
  `k`.

The required laws are:

```text
read(R(x), t) = read(x, t)                 live at time t
write(R(x), ...) = absent                  no mutator is exposed
read(S(x), t1) = read(S(x), t2)            immutable
S(S(x)) = S(x)                             snapshot idempotence
kind(S(x)) = kind(x)                       a snapshot keeps its kind
read(S(x at t1), t2) = read(x, t1)         a snapshot holds the instant it was taken
authority(A(B(x))) <= authority(A(x)) and authority(B(x))
```

`A` and `B` stand for any two attenuations.

`R(x)` is therefore not `S(x)`.
A snapshot can outlive and diverge from its source, whereas a read-only view
observes later source changes.
`capture` obeys the laws of `S`, except that its result can hold capabilities.

Attenuation follows traversal.
`lookup` on a read-only, controlled, narrowed, or rooted view returns each
`File`, `Directory`, `BlockStore`, `LogStore`, `MapStore`, `SetStore`, `BagStore`, and
`Cell` child under the same attenuation.
A `Value` child is returned as it is, because the attenuation governs the binding and
not the value, whose authority is its own.
A minter that must withhold that authority omits `Value` lookup from the facet.

`x.makeController()` mints a controller bound to the provider that owns `x`, and
only a mutable facet of `x` offers it.
`k.makeBranch(path, policy)` journals a new *branch*, a policy slot covering the
entry at `path` beneath `x` with `policy` as its first generation, and returns an
opaque selector for it.
`x.controlled(k, branch)` returns a view rooted at that entry and governed by that
branch; it throws `ACCESS_REVOKED` for a controller or selector the provider did
not mint for `x`.
All views of one branch flip together, separate branches flip independently, and a
view consults only its own branch.

`C(k, b, x)` exposes the methods allowed by its static facet, but every operation
also consults the provider's current policy generation for the view's branch.
That method surface does not change with policy.
A controlled facet exposes its mutators under every generation, including `'read'`, and
each denied call throws `ACCESS_REVOKED`.
A descendant retained through traversal consults the same branch, so a file looked up
under `'read'` can write after a flip to `'write'`.
A static read-only facet is different: it omits its mutators and no flip restores them.
The controller holds the authority to command that policy and owns no other state:
`k.setPolicy(branch, 'read' | 'write' | 'revoked')` resolves to `{ generation }`
only after the provider has journaled the new generation.
The provider sequences policy generations and content commits in one journal, so
it is the single serialization owner of every controlled decision.
A controller can flip a branch in either direction.
A command whose acknowledgment is lost has an unknown outcome until retried; it
sets an absolute value, so a retry is idempotent.
A controller governs one provider, so an administrator spanning several providers
holds one controller for each, issues one command to each, and gets no atomicity
across them.
Only the controller can make a controlled view more permissive.
Other attenuations remain monotonic: a size limit, path root, or omitted method
cannot be raised or restored by the controller.

Revocation or a policy flip linearizes before or after an in-flight transaction.
It MUST NOT expose a partial write.
The controller is separate from the client view and MUST NOT be discoverable by
walking the directory.
The current daemon `MountControl.revoke()` is a mount-local, one-way revocation
mechanism, not this controller.

### Snapshots and compare-and-swap

The common interface proposes:

```js
snapshot(): Promise<Snapshot>
capture(): Promise<Snapshot>
Snapshot.equivalent(other): Promise<boolean>
```

Both return the same `Snapshot` facets, as described above.
A capture that holds no capability is equivalent to a snapshot of the same content.

A snapshot is the identity of its content.
There is no separate identity method or token: a mutator's `expected` takes a
snapshot, and `equivalent` compares two of them.
Obtaining an identity does not inherently require retaining content, but nothing in
this design needs an identity without its content.
Content-addressed storage makes retaining unchanged content free, and every successful
mutator already returns a snapshot.
A caller that must not retain content guards with a revision instead.

Two values do two separate jobs:

- `Revision`
  - Question it answers: Has this provider's root advanced?
  - Valid across: One provider incarnation
  - Retains content: No
- `Snapshot`
  - Question it answers: What is the content, and does another snapshot hold the same content?
  - Valid across: Any provider the caller can bridge
  - Retains content: Yes, while reachable

A snapshot reveals no digest, algorithm, storage address, provider revision, or Git
object ID.
The providers sharing one canonicalization, one private digest algorithm, and one
private brand form a *comparison domain*.
A snapshot reference is live, so a client whose precondition must survive a restart
retains the snapshot durably, for example under a pet name.

`Snapshot.equivalent` is the cross-provider comparison.
Within one domain it MAY compare private digests.
Otherwise the receiver pulls the argument's canonical form over the reference it
was passed and compares it with its own, materializing neither in the caller.

A capability reference cannot be compared this way.
Its locator may be a bearer secret, so locator bytes MUST NOT cross this exchange, and
a digest of them could not establish that the bytes are equal.
The pulled canonical form therefore carries only the entry's kind at that name, and
the same holds for a remotable inside a Key.
A comparison across domains answers `false` if any other part of the operands differs,
and otherwise throws `REFERENCE_INCOMPARABLE`.
It never answers `true` for operands holding a capability reference.
A caller that must compare such trees keeps both captures in one comparison domain.
Only a capture can reach this case, because a result of `snapshot` holds no capability
reference.

A caller holding references to both operands is the connectivity the comparison
needs, so the two providers need no direct connection.
Where CapTP has no direct route between them, the argument reference routes through
the caller's connections, and the caller relays each pull under backpressure without
retaining content.
The caller MUST stay connected until the comparison settles.
If a connection carrying the comparison severs, or an operand's provider incarnation
has ended, `equivalent` throws `SNAPSHOT_UNREACHABLE`.
It never answers `false` for content it did not finish comparing.
A retry with fresh references is safe because snapshots are immutable.

Each operand retains its own content, and the content store owns that retention.
A method that reveals a digest names its algorithm, as `sha256()` does, and names
its encoding too when the digest depends on one, as `treeSha256()` does.
No method returns `{ algorithm, hash }`, so the implemented `TreeRef` and `BlobInfo`
results are retired.
These methods remain diagnostic and content-store locator APIs; new correctness logic
MUST NOT depend on them.

Every entry compares by the canonical form of its kind:

- **Blob**: The exact byte sequence.
  Capacity, block size, and timestamps are excluded.
  - Facets: `File`, `BlockStore`, `SnapshotBlob`
- **Tree**: The set of NFC-normalized names, each with its entry's kind and canonical form.
  Listing order and timestamps are excluded.
  - Facets: `Directory`, `SnapshotTree`
- **Log**: The ordered sequence of exact records.
  A strict prefix is not equivalent.
  - Facets: `LogStore` and its snapshot
- **Map, Set, Bag**: For a store whose values are all Keys, the store kind and its entries in key
  rank order, compared by `keyEQ` from `@endo/patterns`.
  Other stores have no canonical form, as defined under *Stores, cells, and values*.
  - Facets: `MapStore`, `SetStore`, `BagStore`, and their snapshots
- **Cell**: The canonical form of its referent, under the kind `Cell`.
  - Facets: `Cell`, `SnapshotCell`
- **Value**: A value that is a Key compares by `keyEQ`.
  Within one comparison domain, a capability reference compares by the exact bytes of its
  locator, or by object identity if it has none.
  The referent is never dereferenced.
  Across domains a capability reference has no comparable form.

A snapshot keeps its source's kind even when its representation is a
pass-by-copy value or a tree, so comparison is defined for every kind.
Values of different kinds are never equivalent.
Two locators for one referent, or two presences of one object, are not equivalent
either: comparison MAY report a false negative, which fails a compare-and-swap
safely, and MUST NOT report a false positive.

Within a domain, a digest stands in for exact comparison only because the domain's
private digest MUST be collision-resistant.
That is the one assumption behind the no-false-positive rule, and it is why a domain
whose digest stops being trusted is replaced by a new domain rather than extended.
Cross-domain comparison exchanges exact bytes, so it never trusts another domain's
digest.

A mutator taking `{ expected }` accepts a snapshot from any provider the caller can
bridge, and compares it with the complete current target immediately before commit.
The provider pulls and digests a foreign snapshot's canonical form before opening
its transaction, so no remote pull runs inside the transaction.
A foreign capture holding a capability reference throws `REFERENCE_INCOMPARABLE`, a
severed pull throws `SNAPSHOT_UNREACHABLE`, and a mismatch throws `PRECONDITION_FAILED`; none changes the
target.
This is content-equivalence CAS, so an A-to-B-to-A history satisfies a
precondition for A; clients that need history ordering also supply the provider's
incarnation-local revision.

Tree CAS covers the complete visible root, including entry kinds and `Value`
bindings.
File CAS covers the complete byte sequence.
The comparison and mutation are one transaction.
On success a mutator returns `{ snapshot, revision }`, letting the
caller verify the result without rereading it.

A controlled mutation checks the policy generation, performs the CAS, and commits
as one provider transaction in journal order.
If a policy generation that denies it lands first, it throws `ACCESS_REVOKED`.
If a competing commit lands first and leaves the target no longer matching
`expected`, it throws `PRECONDITION_FAILED`.
Otherwise the controlled mutation commits, linearized after whatever landed first.

## Standard method families

The signatures below are the proposed canonical vocabulary.
Passable streams and result capabilities are used where an eager array or string
could be unbounded.

`ResultReader` is the one result shape of every listing and search method: a
`PassableReader` from `@endo/exo-stream` that delivers one record per pull.
These methods have no eager form, pages, or continuation tokens.
The consumer stops early by closing the reader.
Unless the holder's facet carries a result budget, a reader delivers the complete
result.
A reader over a live view is not a consistent cut, so a caller that needs one
iterates a snapshot.

### Readable blobs and files

- `size()`: Exact byte length.
  - Views: live read-only, snapshot, mutable, controlled
- `readBytes()` / `readText()`: Materialize the whole value subject to the result limit; text is
  strict UTF-8 unless an encoding is explicit.
  - Views: all readable views
- `readByteRange(start, end)`: Materialize half-open byte range `[start,end)` subject to the
  limit.
  - Views: all readable views
- `readTextRange(startLine, endLine)`: Materialize half-open zero-based line range, preserving
  terminators.
  - Views: all readable views
- `readHashLines(startLine, endLine)`: Materialize a half-open zero-based line range as an array
  of `{ line, hash, text }` records subject to the limit, `hash` being the line's anchor.
  - Views: all readable views
- `lineByteRange(startLine, endLine)`: Return the `{ start, end }` byte offsets of a half-open
  zero-based line range, without its content.
  - Views: all readable views
- `byteRange(start, end)` / `textRange(startLine, endLine)`: Return a narrowed reader
  capability; ranges compose by intersection.
  - Views: all readable views
- `streamBytes()`: Return a backpressured byte stream.
  - Views: all readable views
- `grep(pattern, options)`: Search strict UTF-8 text and return a `ResultReader` of
  `{ line, text, ranges }` with a zero-based `line`; other content throws `WRONG_ENTRY_KIND`.
  - Views: all readable views
- `grepHashLines(pattern, options)`: `grep` whose records also carry `hash`, the anchor of `line`.
  - Views: all readable views
- `snapshot()` / `capture()`: Freeze the content, which are the same for a blob.
  - Views: all readable views
- `writeBytes(value, options)` / `writeText(value, options)`: Replace content atomically,
  optionally with `expected`.
  - Views: mutable, writable controlled
- `append(value, options)`: Atomically append with an optional expected snapshot.
  - Views: mutable, writable controlled, append storage
- `editHashLines(edits, options)`: Validate line anchors and apply one atomic splice
  transaction.
  - Views: mutable, writable controlled

The existing materializing `text`, `bytes`, `fetch`, `rangeRead`, and
`rangeReadText` spellings remain adapter aliases while callers migrate.
`byteRange` and `textRange` are attenuation constructors; the `read*Range`
methods are their bounded materializing conveniences.

Hash-line edits use a whole-file expected snapshot plus CRC32 line anchors.
An edit needs an anchor for every line it touches, and an anchor's width depends on the
file's line count, so the provider supplies anchors rather than the caller computing
them from text.
`readHashLines` and the `grepHashLines` and `glorpHashLines` searches are how a caller
obtains anchors without materializing the file.
Replace, replace-range, delete, insert-before, insert-after, prepend, and append
are supported.
Literal replacement text is permitted, but reference payloads described below
avoid reading source content into the caller.

### Trees and directories

- `has(path)`, `lookup(path)`, `maybeLookup(path)`: Traverse pet names; `lookup` and
  `maybeLookup` return an entry capability under the view's attenuation.
  - Views: all tree views
- `list(path, options)`, `listTree(path, options)`: Return a `ResultReader` of typed entries.
  - Views: all tree views
- `glob(pattern, options)`: Return a `ResultReader` of matching paths using the corpus glob
  grammar.
  - Views: all tree views
- `grep(pattern, options)`: Search readable text entries and return a `ResultReader` of
  `{ path, line, text, ranges }`.
  - Views: all tree views
- `glorp(globPattern, grepPattern, options)`: Apply `glob`, then `grep` only those matching
  files, returning the same grep records.
  - Views: all tree views
- `grepHashLines(pattern, options)`, `glorpHashLines(globPattern, grepPattern, options)`: `grep`
  and `glorp` whose records also carry `hash`, the anchor of `line`.
  - Views: all tree views
- `snapshot()`, `capture()`: Freeze the whole visible tree.
  - Views: all tree views
- `watch()` / `followChanges(options)`: Follow live transactions; absent on immutable snapshots.
  - Views: live read-only, mutable, controlled
- `makeDirectory`, `makeFile`, `remove`, `move`, `copy`: Mutate one root transactionally,
  optionally with `expected`.
  - Views: mutable, writable controlled

Every traversal method takes one `Path` argument.
The implemented variadic `has(...path)` and `lookup(...path)` remain adapters while
callers migrate.
Path `[]` names the receiver.
`lookup` throws `NOT_FOUND` when a segment has no binding; in that case
`maybeLookup` resolves to `undefined` and `has` to `false`.
All three throw `WRONG_ENTRY_KIND` when a non-final segment names an entry that is
not a tree.
Traversal never passes through a `Cell` or a `Value`, and `has` reports the binding
whether or not its value is reachable.
`lookup` on a `Value` entry returns the value itself or throws `LOCATOR_UNREACHABLE`.

A `Value` entry therefore has no entry capability, and its kind appears only in its
directory's list records.
Every entry capability answers `kind()` with its kind:

```js
kind(): Promise<EntryKind>
// EntryKind: 'Blob' | 'Tree' | 'Log' | 'Map' | 'Set' | 'Bag' | 'Cell' | 'Value'
```

The kind chooses the family of content operations, and a snapshot answers the same
kind as its source.
It does not say whether an entry can be mutated or watched, because the facet decides
that by which methods it exposes.
A caller that needs immutable content calls `snapshot()` rather than testing a kind.

`list` delivers `{ name, kind }` records and `listTree` delivers `{ path, kind }`
records, each `kind` matching what `kind()` answers on that entry.
A record holds no capability, so a caller acts on an entry by looking it up.

Every `path` in a result record, from `listTree`, `glob`, `grep`, or `glorp`, is a
`Path` array relative to the receiver of the call, never a joined string and never
relative to a `path` argument.
`list` returns a local `name` relative to its `path` argument, and only `list` does.
So `root.lookup(record.path)` needs no reconstruction, and after
`root.listTree(['src'])` a record's path is `['src', 'main.js']`.
A glob pattern is matched against a path's segments joined with `/`, which is
unambiguous because no segment can contain `/`.

An adapter preserves the implemented `listTree` field name `type` and its
`'file' | 'directory'` values.

`glorp` is not a new fuzzy-search algorithm.
It is the fused `glob`-then-`grep` operation already implemented by
`../packages/platform/src/fs/search.js` and exposed by `Mount`.
The implemented result is exactly an eager array of `{ file, line, text }`
records.
The common interface renames `file` to `path`, adds match `ranges`, and streams
the same records; an adapter preserves the implemented shape.
Its patterns have the same grammar as the corresponding separate operations.
The current implementation's default 1,000-result cap and silent glob truncation
are replaced by a reader that delivers the complete result under backpressure.
Results are never silently lost.

### Diff, patch, merge, and reference transforms

```js
snapshot.diff(other, options): Promise<Patch>
mutable.applyPatch(patch, { expected }): Promise<MutationResult>
snapshot.merge(base, other, options): Promise<MergeResult>
snapshot.transform(transform): Promise<Snapshot>
mutable.applyTransform(transform, { expected }): Promise<MutationResult>
```

`Patch` is an immutable, streamable capability whose hunks may hold the range
references defined below instead of embedding bytes.
`diff` exists only on immutable snapshots so both operands are stable.
Across domains, `diff` and `merge` throw `REFERENCE_INCOMPARABLE` on reaching a pair of
capability references, because they cannot tell whether the pair changed.
`applyPatch` exists only on mutable or writable controlled views and requires an
expected snapshot unless the caller explicitly chooses last-writer-wins.

`merge` is a pure three-way operation: the receiver is left, `base` is the
common ancestor, and `other` is right.
It returns `{ snapshot, conflicts }`, and writes no conflict-marker text.
`conflicts` is a hardened array of copy records, which hold no capability, so a
caller has nothing to close or dispose:

```js
{
  path, // relative to the receiver
  reason: 'text' | 'bytes' | 'kind' | 'removed',
  left, // text conflicts carry a frame for each side; others omit all four
  base,
  right,
  merged,
}
// frame: { startLine, endLine, first: { line, hash }, last: { line, hash } }
```

A frame is a half-open zero-based line range, bracketed by the hash-line anchors of
its first and last lines, which an empty range omits.
`left`, `base`, and `right` address those three operands, and the caller reads them
with `readTextRange` or `readHashLines`.
The merged snapshot holds the left lines at each conflict, and `merged` frames them
there, so a resolver can pass its anchors to `editHashLines` once the merge is
applied.
The array is a materialized result under the `bytes` limit.
A merge that exceeds it throws `RESULT_TOO_LARGE`, and the caller merges smaller
subtrees.
Applying the result is a separate CAS mutation.

`Transform` is an array of edit scripts, one for each target:

```js
{
  targetPath,
  edits: [
    { op: 'keep', length },
    { op: 'drop', length },
    { op: 'insert', value: bytesOrRangeReference },
  ],
}
```

A script walks its target from byte 0.
`keep` passes `length` bytes through, `drop` omits `length` bytes, `insert` adds
`value`, and the bytes after the last edit are kept.
A `keep` or `drop` past the end of the target, or a second script for one target,
throws `INVALID_RANGE`.

A range reference is `{ source, sourceStart, sourceEnd }`, a half-open byte range of
`source`.
Every `source` MUST be a `SnapshotBlob` facet; any other capability, including a live
or read-only blob, throws `WRONG_ENTRY_KIND` before anything is staged, even though
those blobs also answer `kind()` with `'Blob'`.
Lengths and offsets count bytes, `targetPath` is relative to the receiver, and a
`targetPath` the receiver lacks starts as an empty file.

The provider resolves every source snapshot, validates all ranges and the target
precondition, stages the complete result, and commits once.
It pulls a foreign source before opening its transaction, as it does for a foreign
`expected`.
No operation invokes caller code inside the transaction.
`snapshot.transform` is the pure form: it returns the snapshot a commit would
produce.
Because every source is immutable, the snapshot it returns predicts the result of
`applyTransform` with the same transform on any target equivalent to the receiver,
and `expected` rejects any other target.

### Stores, cells, and values

`BlockStore` has `size`, range reads, `writeRange`, `append`, `truncate`,
and `snapshot`; it deliberately has no middle insertion method.
`LogStore` has `append`, `follow`, `snapshot`, and ranged record reads, with no
rewrite authority.
`MapStore`, `SetStore`, and `BagStore` have the typed store operations from the
persistent-store design, which has no bag store, and `snapshot`, which returns a copy
map, copy set, or copy bag when bounded and an immutable tree otherwise.

A store entry is a strong store, ordered or not, and its values are whatever passables
the persistent-store design admits.
A weak store cannot enumerate its entries, so it has no snapshot, and a directory
names one only through a `Value` entry.
A store whose values are all Keys has the canonical form above.
A store holding any other value, such as a promise, an error, or a copy record
containing one, is still a valid entry with all its typed operations and a `capture`.
It has no canonical form, so `snapshot`, `equivalent`, and any `expected` covering it
or an enclosing tree throw `UNSNAPSHOTTABLE_ENTRY` and change nothing.
A caller guarding such a tree uses the provider's revision instead.
A store guarded to Key values, with `M.key()`, can never reach this case.
Within one domain, a remotable inside a Key compares by its formula identity.

A `Cell` is a level of indirection for an arbitrary value.
It has `get()`, `set(value, { expected })`, `readOnly()`, `snapshot()`, and `capture()`.
Its holder can change the referent without modifying any directory, and the read-only
view and the snapshot are its attenuations.
`get` returns the referent or throws `LOCATOR_UNREACHABLE`, and attenuating a cell does
not attenuate its referent.

Locators currently refer to values only through formula identifiers, so every
expressible value has an implied serialized form.
That form can expand to cover live references in durably journaled workers.

These capabilities compose with directories by being entry values.
They do not inherit file methods merely because a snapshot can become a blob.
A directory pet name grants exactly the entry capability stored there.

## Errors

All failures are passable error records with `name`, stable `code`, `message`,
and a copy-only `details` record.

- `NOT_FOUND`: A named path or range source does not exist.
- `WRONG_ENTRY_KIND`: The entry exists but does not support the operation.
- `READ_ONLY`: The static facet does not expose mutation; adapters may use this during
  migration.
- `ACCESS_REVOKED`: A controller policy or revoker denied the operation.
- `PRECONDITION_FAILED`: The expected snapshot or revision is stale.
- `INVALID_RANGE`: A range is negative, fractional where integral, reversed, or unrepresentable;
  a valid range beyond the source clamps to an empty suffix.
- `MERGE_CONFLICT`: A caller requested conflict-free output but conflicts remain.
- `RESULT_TOO_LARGE`: Materializing or rendering one result exceeds its resource bound.
- `RESULT_BUDGET_EXHAUSTED`: A reader reached the total-result budget granted to its facet; the
  result is incomplete.
- `REFERENCE_INCOMPARABLE`: A comparison across comparison domains found no other difference but
  reached a capability reference, whose exact form it may not exchange.
- `SNAPSHOT_UNREACHABLE`: A connection carrying a foreign snapshot severed, or that snapshot's
  provider incarnation ended, before the operation finished with it.
- `UNSNAPSHOTTABLE_ENTRY`: `snapshot` encountered a capability reference, or an operation
  needing a canonical form reached a store holding a value that is not a Key.
- `RESERVED_CONTENT`: A mutation would commit a blob beginning with the locator file marker.
- `LOCATOR_MALFORMED`: A file beginning with the locator file marker failed validation.
- `LOCATOR_UNREACHABLE`: A restored capability reference cannot presently resolve.
- `ARCHIVE_MALFORMED`: An archive holds duplicate raw member names, names that collide after NFC
  normalization, or names the path rules forbid.
- `ARCHIVE_UNAUTHENTICATED`: An archive's signature, signer, manifest, or member binding failed
  verification.

Static read-only facets SHOULD omit mutators entirely.
The `READ_ONLY` error exists for current uniform extended-FS guards, not as the
desired attenuation mechanism.
A dynamic controller denial throws `ACCESS_REVOKED`.

## Narrowing readers

`view.narrow({ bytes, recordBytes, patchBytes, records })` returns a facet with
lower limits, in the manner of POSIX `nice`: a holder can lower its limits and can
never raise them.
Every component is optional, and each attenuation chain uses the minimum at every
layer.
The minter or administrator chooses the outer policy.

`bytes`, `recordBytes`, and `patchBytes` are resource bounds: `bytes` bounds one
materialized value or range, `recordBytes` bounds one record a `ResultReader`
delivers, and `patchBytes` bounds one rendered patch.
`records` is a result budget, described below.
Changing controlled mutability does not change result limits or budgets.

Before allocating or returning a whole result, the provider determines its
actual encoded size where possible.
An oversized operation throws this shape:

```js
{
  name: 'ResultTooLargeError',
  code: 'RESULT_TOO_LARGE',
  message: 'readText would return 9187342 bytes; limit is 262144 bytes. ' +
    'Use grep to locate relevant lines, then retry with readTextRange or ' +
    'readByteRange.',
  details: {
    operation: 'readText',
    limit: 262144,
    actual: 9187342,
    unit: 'bytes',
    retry: {
      locate: ['grep'],
      read: ['readTextRange', 'readByteRange'],
    },
  },
}
```

If exact size is unknowable before materializing, `actual` is the first observed
size greater than the limit and `details.exact` is `false`.
Materialization stops with the same structured error and MUST NOT buffer past the
smallest necessary chunk.
`streamBytes()` materializes nothing, so its backpressure is its bound.

Backpressure likewise bounds a `ResultReader`, which produces one record per pull,
so no resource bound caps how many records it delivers.
A record larger than `recordBytes` does not end the reader.
Only the `text` field of a grep record can exceed the bound in practice, because every
other record holds only names, kinds, offsets, and range references, which
`recordBytes` does not count.
The provider delivers such a record with `text` removed and
`omitted: { field: 'text', bytes }` added.
The record's `line`, and its `path` for a tree search, are the recovery handle: the
holder looks up `path`, if any, and calls `readTextRange(line, line + 1)`.
A hash-line record keeps its `hash`, so the holder can still anchor an edit to that line.
`Patch` and merged snapshots remain capabilities; only materializing or rendering
them consumes a result budget.

The error deliberately teaches an automated consumer how to recover.
It MUST name the operation, limit, and observed size, and `details.retry` MUST name
only methods the raising facet exposes:

- **Blob or file**
  - `locate`: `grep` and `grepHashLines` find lines
  - `read`: `readTextRange`, `readHashLines`, `readByteRange`
  - `update`, on writable facets only: `editHashLines`
- **Tree**
  - `locate`: `glob` finds paths; `grep`, `glorp`, and their `HashLines` forms find lines
  - `read`: `lookup`, then the blob range methods
  - `update`, on writable facets only: `applyTransform`, `applyPatch`

Other facets list their ranged reads and omit a member they cannot fill.

### Result budgets

A total-result budget is an authority policy, separate from the resource bounds
above, which never make a valid result inaccessible.
A minter grants one when a holder may see only so much of one query, for example to
bound what an agent receives.
Under `narrow({ records })`, each reader of the returned facet delivers at most
`records` records.

Reaching the budget ends that reader with `RESULT_BUDGET_EXHAUSTED` after the earlier
records, so the holder knows the result is incomplete.
The error uses the teaching shape and `details.retry` rules above, with
`unit: 'records'`, `actual` the number of records delivered, and `details.exact`
`false`.
A budget has no continuation, because resuming past it would raise it.
The holder narrows its query or asks the minter for a larger budget.

## Splicing without reading into an agent context

### Move a function between files

An agent snapshots its worktree as `A`, finds the function with `grep`, reads only
the adjacent lines with `readTextRange` to choose where the function ends, and
converts those lines to byte offsets.
It then moves the range without reading it into its context:

```js
const A = await worktree.snapshot();
const oldFile = await A.lookup(['src', 'old.js']);
const newFile = await A.lookup(['src', 'new.js']);

// startLine and endLine come from grep and readTextRange on oldFile.
const { start, end } = await oldFile.lineByteRange(startLine, endLine);

const transform = [
  {
    targetPath: ['src', 'new.js'],
    edits: [
      { op: 'keep', length: await newFile.size() },
      {
        op: 'insert',
        value: { source: oldFile, sourceStart: start, sourceEnd: end },
      },
    ],
  },
  {
    targetPath: ['src', 'old.js'],
    edits: [
      { op: 'keep', length: start },
      { op: 'drop', length: end - start },
    ],
  },
];

const preview = await A.transform(transform);
const { snapshot: committed } = await worktree.applyTransform(transform, {
  expected: A,
});
const verified = await committed.equivalent(preview);
```

The agent compares the committed snapshot with the preview instead of rereading
both files.

### Three-way merge edited snapshots

Given base `B` and independently edited snapshots `L` and `R`, where `L` is a
snapshot of the mutable `root`, the caller merges them and applies the result as a
patch from `L`:

```js
const { snapshot: merged, conflicts } = await L.merge(B, R);
// Review each record from conflicts, reading only its framed lines.

const patch = await L.diff(merged);
await root.applyPatch(patch, { expected: L });
```

The provider reads the snapshots internally, so the agent reviews only conflict
ranges.
If `root` has changed since `L` was taken, `applyPatch` throws `PRECONDITION_FAILED`
before any write.

### Build a file from several blobs

A transform creates `bundle.txt`, copies bytes `[0,120)` from snapshot blob `A`,
`[800,1040)` from snapshot blob `B`, and `[12,90)` from snapshot blob `C`, then
appends one small literal terminator.
The provider validates all three immutable sources, writes one staged target,
and atomically publishes it.
The caller compares the returned snapshot with a preview from `transform` without materializing the bundle.

Hash-line edits are the line-oriented form of the same mechanism.
Their replacement payload MAY be a range reference, and their anchors plus the
whole-file expected snapshot prevent a splice at the wrong location.

## Portable serialization of capability entries

### Locator files

When a pet-name tree is projected onto a Git or physical filesystem, a `Tree` becomes a
directory and a `Blob` becomes a file.
Any other value becomes a *locator file*, which holds a locator for that value.
Version 1 uses this byte layout:

- **0**
  - Length: 16
  - Value: Magic bytes `89 45 4e 44 4f 0d 0a 1a 0a 4f 43 41 50 52 45 46` (`0x89`, `ENDO`, CR LF
    SUB LF, `OCAPREF`)
- **16**
  - Length: 32
  - Value: Format marker `c3 0b d0 66 f5 aa 37 20 a0 b4 17 c3 af 2f 25 af 21 df de 52 84 2d 5e 8b
    d8 ec 86 41 63 51 50 6e`, a constant drawn at random once for this format
- **48**
  - Length: 1
  - Value: Envelope version `0x01`
- **49**
  - Length: 1
  - Value: Signature algorithm `0x01` for Ed25519
- **50**
  - Length: 1
  - Value: Locator encoding `0x01` for strict UTF-8
- **51**
  - Length: 1
  - Value: Flags, zero in version 1
- **52**
  - Length: 8
  - Value: Unsigned big-endian locator byte length `N`
- **60**
  - Length: 64
  - Value: Ed25519 signature (RFC 8032 section 5.1) over ASCII `endo-locator-file-v1`, one zero
    byte, and the exact `N` locator bytes
- **124**
  - Length: `N`
  - Value: Locator bytes, with no delimiter or padding

`N` MUST be at most 1 MiB.
Unknown versions, algorithms, encodings, nonzero reserved flags, trailing bytes,
invalid UTF-8, length mismatch, or a signature failure make a malformed locator file.

The format makes two separate claims.
The marker claims that the file is meant to be a locator: its 256 bits make a chance
collision with an actual file as unlikely as a collision of content hashes.
Every Endo file-writing path enforces that claim.
A mutation whose committed blob would begin with the 48 marker bytes throws
`RESERVED_CONTENT` and changes nothing, whichever method staged those bytes, so no holder
of a `File` can forge a locator file through Endo.

The marker is public, so a writer outside Endo can still produce those bytes.
The signature therefore makes the second claim: that the locator was written by the
peer able to honor the reference.
The verifying key is the locator's `peerKey`, the Ed25519 public key of the peer that
hosts the referent, so the file needs no other key and no trust anchor.
The all-zero `LOCAL_NODE` placeholder is not a key and MUST NOT appear in a locator file.
A file beginning with the marker that fails validation throws `LOCATOR_MALFORMED` on
`lookup`, exposes no bytes as a blob, and mints no reference.

A valid signature does not say the peer is trustworthy or the locator is fresh.
An attacker can sign a locator for an object on the attacker's own peer, which grants
only what that object offers.
A holder that resolves a reference from an untrusted tree first checks `peerKey`, and
a restored reference remains unresolved until then.

### Signed manifest and round trip

An archive combines the envelope with a directory-level manifest, stored at the
archive root as `.endo-manifest` beside its signature, `.endo-manifest.sig`.
Export rejects a tree that already uses either root name.
The manifest is a map in CBOR core deterministic encoding (RFC 8949 section 4.2.1)
holding the archive version, a random 16-byte `archiveId`, and one record for each
other archive member, sorted by normalized path.
Each record binds normalized path, kind, byte length, and the SHA-256 of the
member's exact bytes.
Records cover every member, not only capability references, so a changed, added,
removed, or reclassified member fails verification.

The manifest authenticates a whole archive and does not classify its members, because
a locator file classifies itself and is also valid in a tree with no manifest.
The locator file is the only holder of locator bytes.
A manifest record's kind MUST agree with its member.

Version 1 authenticates the manifest with one Ed25519 signature (RFC 8032 section
5.1).
The signature record is a deterministic-CBOR map of `algorithm`, `keyId` (the
SHA-256 of the public key), and `signature`, computed over ASCII
`endo-archive-manifest-v1`, one zero byte, and the exact manifest bytes.
Export signs through a `signer` capability, so the private key never enters the
archive, and refuses to write an archive without one.

The trust anchor is the argument the restoring holder supplies:

```js
restore(archive, { trustedSigners, references: 'unresolved' | 'strict' | 'inert' })
```

`trustedSigners` is an immutable set of `{ keyId, publicKey }` records.
It has no default, nothing is trusted on first use, and a key carried in the
archive grants nothing.
Rotating or revoking a signer means changing the set.
A valid signature attests only that the key holder exported these bindings; it does
not assert freshness, so a signed older archive still verifies.
A caller that must reject replay tracks `archiveId`.

Restore verifies in this order before installing anything:

1. Enumerate the raw member names, normalize each to NFC, and reject a duplicate raw
   name, a normalization collision, or a name the path rules above forbid.
   This step reads no manifest, so a colliding member the manifest does not name
   still fails, and it throws `ARCHIVE_MALFORMED`.
2. Look up `keyId` in `trustedSigners` and verify the signature over the bytes as
   received, before parsing them.
3. Parse the manifest, rejecting an unknown version or algorithm and any encoding
   that is not deterministic.
4. Match archive members to records one for one, and check each length and digest.
5. Validate every locator file as specified above.

A failure in steps 2 through 5 throws `ARCHIVE_UNAUTHENTICATED`, and nothing is
installed on any failure.
`references: 'inert'` is the one mode that needs no signer: after step 1 it skips these
checks, ignores the manifest, restores every other member as ordinary bytes, omits each
member beginning with the marker, reports the omitted paths, and mints no reference.

Sidecar files were considered but introduce colliding reserved names and make
atomic rename/copy difficult.
Extended attributes avoid visible sidecars but are not portable through ZIP,
Git, object stores, or common copy tools.
A locator file therefore carries its own classification and proof.

Capture and checkin record the reference without dereferencing it.
Checkout and `make-archive` reproduce the exact locator file and manifest entry.
Only the verification above constructs an unresolved reference.
Resolution is a separate authority-bearing operation.

If a locator is unavailable, `references: 'unresolved'` succeeds and preserves the
unresolved reference; opening it throws `LOCATOR_UNREACHABLE` with path and a
non-secret diagnostic.
`references: 'strict'` fails the entire transaction atomically unless every reference is
reachable.

Locators can be bearer capabilities, including secret-bearing HTTPS fragments.
Archives containing them MUST be treated as credential stores: least-readable
permissions, encryption at rest and in transit, no logs, no search indexing, and
explicit export authority.
Neither the signature nor a content-addressed archive makes a locator public or safe,
and a signature or a manifest digest of a locator file gets the same handling as the
locator.

## REST versus CapTP

The common interface defaults to CapTP because every operation exercises held
object authority, returns further capabilities, benefits from pipelining, and
needs revocation and disconnection semantics.
REST appears only where the caller holds no reference yet or cannot speak CapTP.

- **Lookup, read, search, snapshot, mutation, control, watch, diff, patch, merge**
  - Deciding criteria: Holding an object authorizes the call.
    Calls pass and return capabilities and streams.
    The objects keep state, attenuate independently, and yield live results.
  - Transport: **CapTP**
- **Initial archive download or upload**
  - Deciding criteria: CapTP by default, as above.
    A client that cannot speak CapTP may use a one-use bearer URL designating exactly one
    transfer object, never an identity.
  - Transport: **CapTP**, or REST for bytes after CapTP mints the transfer grant
- **Minting or opening the first external locator**
  - Deciding criteria: A client with no session holds no reference yet, so one REST call
    establishes its first reference and every later call uses CapTP.
  - Transport: REST/HTTPS bootstrap; the opened object immediately becomes **CapTP**

There are no REST endpoints that accept a raw pet-name path or bearer capability
string as a substitute for possessing the root.
The locator-opening boundary is a bootstrap exception, not a parallel REST
filesystem API.

## Ownership map

- **Client view -> mutable provider**
  - Mechanism: The view sends one guarded read or staged mutation.
  - Policy: The view's attenuation admits paths, methods, and result sizes; the provider
    validates CAS.
  - Durable state: The provider alone owns bytes, tree metadata, revision, and journal.
  - Lifecycle / commit authority: The provider commits or discards one mutation and recovers its
    journal before publishing a root.
  - Value crossing: Path, operation, expected snapshot, and `MutationResult`, all filesystem
    vocabulary.
- **Controller -> mutable provider**
  - Mechanism: The controller sends an absolute policy command for a branch; the provider
    journals it and acknowledges its generation.
  - Policy: The controller decides read/write/revoked; the provider decides ordering and
    transaction atomicity.
  - Durable state: The provider owns branches, policy generations, and content in one journal;
    the controller owns no durable state.
  - Lifecycle / commit authority: The provider alone commits, restoring policy from its journal
    before facets revive.
  - Value crossing: Branch selector, policy value, and acknowledged generation, controller
    vocabulary.
- **Mutable provider -> snapshot/content store**
  - Mechanism: The provider writes immutable children and a root.
  - Policy: The provider decides when a complete snapshot can publish; store GC decides
    reachability reclamation.
  - Durable state: The content store alone owns immutable objects and reachability metadata.
  - Lifecycle / commit authority: The store publishes complete roots and discards staging; it
    re-indexes private digests after restart.
  - Value crossing: Immutable bytes/tree nodes and their `Snapshot`, snapshot
    vocabulary.
- **Pet-name/formula directory -> provider or value**
  - Mechanism: The directory binds a local name to a typed capability entry; a formula may
    reincarnate it.
  - Policy: The directory owner admits binding changes; it does not decide content mutations.
  - Durable state: The directory/formula store owns bindings and recipes; the target provider
    owns target state.
  - Lifecycle / commit authority: The directory commits bindings and replays recipes before
    lookup; unresolved references remain inert.
  - Value crossing: Name, entry kind, formula ID or locator, outer naming vocabulary.
- **Archive/restore -> directory and locator resolver**
  - Mechanism: Export writes locator files and signs a manifest; restore verifies and mints
    unresolved references.
  - Policy: Explicit export authority admits bearer locators; the restoring holder's
    `trustedSigners` decides whose signature authenticates an archive, and the restoring
    holder chooses the reference mode.
  - Durable state: The archive owner owns archive bytes; the signer owns its private key; the
    restoring holder owns its trust set; the destination owns installed bindings.
  - Lifecycle / commit authority: Export finalizes and signs the manifest last; restore
    atomically installs or discards staging and never owns resolver restart.
  - Value crossing: Manifest record, signature, locator file, and locator, archive vocabulary.
- **Git adapter -> filesystem provider**
  - Mechanism: The adapter reads a root and stages Git objects; the provider offers a filesystem
    transaction.
  - Policy: Filesystem write, Git commit, and push policy remain independent.
  - Durable state: Git owns objects, refs, and stage metadata; the provider owns the working
    root.
  - Lifecycle / commit authority: Each side commits and replays its own state; no filesystem
    mutation implies commit or push.
  - Value crossing: Snapshot root, tentative metadata, Git commit result, each named by its
    owning layer.

**Persistent state.**
The mutable provider owns content, branches, policy generations, and journals.
The content store owns immutable objects, the directory/formula store owns bindings
and recipes, the archive owner owns exported bytes, and Git owns Git objects.
No durable datum has two owners.
Content lives only as long as a reachable snapshot, and the content store owns
that reachability.

**Commit or discard.**
Each provider decides whether its staged mutation publishes; the directory
separately commits bindings, restore separately installs a tree, and explicit Git
operations separately commit and push.

**Restart and replay.**
Each durable owner repairs or replays only its own state before reviving its
facet.
An ephemeral provider starts a new incarnation revision, and a missing locator
resolver leaves an inert unresolved reference rather than replaying an open.

**Execution classification.**
The mutable provider classifies a filesystem operation as committed, rejected,
or failed.
The controller commands policy but does not relabel the outcome, and outer Git,
archive, or formula layers decide what to do about it.

**Inner/outer naming check.**
Inner backends return operation and `MutationResult` values only for their own
filesystem transaction.
They do not return Git commits, formula replays, archive restores, or controller
policy results; those outer lifecycle terms remain at their owning boundaries.

## Inconsistencies and gaps

- **Read-only versus snapshot**
  - Sources: mount capabilities, storage matrix PR #1264, platform interfaces
  - What differs or is missing: Some names and formula types call immutable snapshots
    "readable"; `readOnly()` is live.
  - Recommended resolution: Use `Readable*` for a posture, `Snapshot*` for immutable content,
    and document `R(x) != S(x)`.
- **Content identity**
  - Sources: platform range reads, CAS management, root advancement
  - What differs or is missing: Public SHA-256/tree refs leak an algorithm into CAS, and
    `{ algorithm, hash }` results carry it as a value.
  - Recommended resolution: Use snapshots as CAS preconditions, compare them with `equivalent`,
    and retain hashes only as private fast paths and diagnostics named for their algorithm.
- **Range names**
  - Sources: platform range/tree reads, range attenuation, extended FS
  - What differs or is missing: `fetch`, `rangeRead`, `rangeReadText`, `bytes`, `byteRange`, and
    `textRange` overlap.
  - Recommended resolution: Standardize bounded materializers as
    `readByteRange`/`readTextRange`; keep `byteRange`/`textRange` as attenuating capability
    constructors.
- **NameHub and mount overlap**
  - Sources: name-hub unification, interface consolidation, daemon guards
  - What differs or is missing: Shared methods have different accepted path and result shapes.
  - Recommended resolution: Derive guards from method families; keep explicit adapters for
    entry-as-path overloads.
- **Read-only attenuation**
  - Sources: extended FS, mount capabilities
  - What differs or is missing: One API keeps mutators and rejects calls; another omits
    mutators.
  - Recommended resolution: New static facets omit methods; dynamic controlled facets may reject
    after a flip.
- **Search bounds**
  - Sources: stream/glob/grep, current search implementation
  - What differs or is missing: Design streams; implementation returns eager arrays and silently
    truncates an intermediate glob.
  - Recommended resolution: Return `ResultReader`s that deliver the complete result under
    backpressure; only a granted budget ends one early, with an explicit error; never silently
    truncate.
- **Hash-line CAS**
  - Sources: CLI edit, daemon hash-line implementation
  - What differs or is missing: Anchors use public raw SHA-256 and literal replacement content.
  - Recommended resolution: Accept an expected snapshot and range-reference payloads;
    preserve CRC32 line anchors.
- **Diff, patch, merge**
  - Sources: root advancement, exo-git, agent tools
  - What differs or is missing: Git has operations, but snapshots lack one portable contract.
  - Recommended resolution: Put pure `diff`/`merge` on snapshots and CAS `applyPatch` on mutable
    views.
- **Dynamic mutability**
  - Sources: mount capabilities
  - What differs or is missing: Mount-local control only revokes a whole mount.
  - Recommended resolution: Add a separate branch-policy controller with atomic
    read/write/revoked flips.
- **Non-file storage**
  - Sources: persistent stores, PRs #1264/#1265
  - What differs or is missing: Block and data stores are proposals; no common append-only
    interface exists.
  - Recommended resolution: Add typed directory entry kinds; implement block first, then log,
    map, set, and bag adapters.
- **Store and cell names**
  - Sources: persistent stores, PRs #1264/#1265, mount capabilities
  - What differs or is missing: `BlockStorage`, `DataStore`, and ad hoc capability links follow
    no common pattern, and a link blurs a directory entry with a mutable indirection.
  - Recommended resolution: Name `BlockStore`, `LogStore`, `MapStore`, `SetStore`, `BagStore`, and
    `Cell`, and distinguish a `Cell` from a `Value` entry.
- **Capability serialization**
  - Sources: checkin/checkout, make archive
  - What differs or is missing: Arbitrary capability bindings have no portable archive
    representation.
  - Recommended resolution: Use a versioned locator file signed for its referent's peer, with a
    signed manifest, verified against the restorer's trusted signers, for whole archives.
- **Snapshotting capability slots**
  - Sources: mount and archive designs
  - What differs or is missing: It is unclear whether snapshot freezes a referenced object.
  - Recommended resolution: `capture` freezes the binding only; `snapshot` rejects any capability
    reference without dereferencing it.
- **Watcher vocabulary**
  - Sources: filesystem watchers, mount changes, root advancement
  - What differs or is missing: Event records, ordering, and Promise/reader shapes differ.
  - Recommended resolution: Standardize transaction followers around initial snapshot plus
    revision; adapt path-level events.
- **Large agent reads**
  - Sources: range designs, agent tools
  - What differs or is missing: Ranges exist, but a holder can still materialize an unlimited
    whole file or diff.
  - Recommended resolution: Mint narrowed facets and use the teaching error specified
    above.

## Open questions

- How does a tree that holds a reference hosted by another peer get that peer's signature?
  This design assumes a peer signs a locator as it mints it and the signature travels
  with the locator, which the current locator format and minting path do not do.
- Should an archive keep its signed manifest now that each locator file proves itself?
  This design keeps it, only to detect a changed, added, or removed member.

## Build ladder

Each rung can land independently behind adapters and conformance tests.

1. Publish terminology, result/error records, and tests proving that live
   read-only and snapshot views differ.
2. Add `readByteRange`/`readTextRange` aliases and the `narrow` facet, including
   teaching errors for whole-value and rendered results.
3. Replace eager search truncation with complete `ResultReader`s, add the separate
   result budget and blob `grep`, and make `glorp` conformance explicit.
4. Introduce `Snapshot.equivalent` beside existing hashes, then move hash-line and
   tree CAS preconditions to snapshots.
5. Add `readHashLines`, `grepHashLines`, `glorpHashLines`, reference payloads to
   hash-line edits, and atomic `Transform` edit scripts for one file, then a
   whole-tree transaction.
6. Add portable snapshot `diff`, streamable `Patch`, CAS `applyPatch`, and pure
   three-way `merge`.
7. Split static read-only guards from mutable guards and add the independent
   mutability controller with durable-policy tests.
8. Land `BlockStore`, then `LogStore`, the persistent `MapStore`, `SetStore`, and
   `BagStore` adapters, and `Cell`, as typed directory entries.
9. Add the version-1 locator file and its write refusal, then the signed archive
   manifest and restore-time signer verification, to checkin/checkout and
   `make-archive`, including
   unreachable-reference recovery.
10. Migrate daemon, platform, exo-git, registry, formula inspector, container,
    CLI, Chat, endopi, and agent-tool consumers; retire compatibility spellings and
    every method that returns `{ algorithm, hash }`.

The full ladder is approximately three to five weeks when split across
reviewable PRs.
Rungs 1-3 are the smallest useful first release and do not depend on controller,
archive, or non-file storage work.

## Conformance and acceptance

A shared suite MUST run against in-memory, native, mount, Git-backed, registry,
and remote adapters where applicable.
It covers:

- **Views and paths:** view laws, path confinement, the shared segment guard, symbolic
  links leaving a native root, entry kinds, agreement between `kind()` and list records,
  a `kind()` that survives `snapshot()`, result paths that feed `lookup` unchanged,
  missing-path behavior of `has`, `lookup`, and `maybeLookup`, and `snapshot` versus `capture`.
- **Comparison:** same-domain digest comparison, cross-provider snapshot comparison for every canonical form, comparison relayed
  through the caller, and a severed relay that throws `SNAPSHOT_UNREACHABLE`.
  Across domains, distinct locators whose digests are forced to collide MUST NOT
  compare `true`, a pair of references MUST throw `REFERENCE_INCOMPARABLE`, a difference elsewhere
  MUST answer `false`, and no locator byte or locator digest may appear on the wire.
  A store holding a promise, an error, or a copy record containing one MUST keep its
  typed operations and `capture`, and MUST throw `UNSNAPSHOTTABLE_ENTRY` from
  `snapshot`, `equivalent`, and `expected`, including through an
  enclosing tree.
- **Mutation:** ABA and stale CAS, controller setup and races, retained descendants
  across read, write, and revoked flips, partial-failure atomicity, merge conflict
  frames whose `merged` anchors `editHashLines` accepts,
  reference splices, and rejection of live transform sources.
- **Readers and limits:** range composition, anchors from `readHashLines`,
  `grepHashLines`, and `glorpHashLines` that `editHashLines` accepts, result limits, oversized records that
  leave the reader running, result budgets, reader early close, and recovery advice
  matching the raising facet.
- **Archives:** tampering, unsigned and untrusted-signer restore, inert restore,
  refusal of marker bytes through every mutator, a forged signature, a signature by a
  key other than `peerKey`, secret-locator redaction, and unreachable locators.
  Duplicate raw member names and NFC-normalization collisions, including a manifest
  naming only one colliding member, MUST be rejected before installation.
- **Lifecycle:** restart replay and GC liveness.

Tests MUST demonstrate that no oversized whole result is allocated before the
teaching error, no rejected transaction publishes a partial root, and successful
splices can be verified by snapshot comparison without rereading output.
