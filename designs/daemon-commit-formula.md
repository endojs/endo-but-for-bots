# Daemon-Native Git Commit Formula

| | |
|---|---|
| **Created** | 2026-08-14 |
| **Author** | Kris Kowal (prompted) |
| **Status** | Proposed |

## What is the Problem Being Solved?

The daemon can retain immutable file content as `readable-blob` and
`readable-tree` formulas, but a readable tree is only Git's checked-out content.
It does not carry tree modes, parents, author and committer stamps, commit
messages, signatures, annotated tags, or mutable refs. Reconstructing a Git
commit from only that tree would invent metadata on every fetch and change the
commit object ID.

This blocks Strategy B in Minion Town's
[Git object store design, section 4](https://github.com/kriscendobot/minion.town/blob/609fdd5251a0297ce15355acc8d902f973c99a18/designs/git-remote-capability.md#4-git-objects---cas-two-storage-strategies-behind-one-wire):
Git objects synthesized from CAS-native state must be byte-identical across
fetches. This design answers the
[review request](https://github.com/kriscendobot/minion.town/pull/41#discussion_r3785689633)
with daemon-native formulas for Git commits, trees, and tags, plus a refs view
over the formula DAG. It does not implement the Minion Town remote.

## Design

### Formula paths

A mutable Git ref names a formula path rather than embedding a Git object ID:

```ts
type FormulaPath = {
  root: FormulaIdentifier;
  path: Name[];
};
```

Resolution starts by providing `root`, then calls `lookup(component)` for every
component in `path`. Intermediate values may be any daemon name hub. The final
value must have the formula type required by the edge. An empty path names the
root formula itself.

The ref store retains the root through an ordinary formula dependency. Every
traversed name hub retains its named child through its existing dynamic
pet-store edge. A commit constructor can therefore accept a direct
`readable-tree`, or accept a host, guest, directory, or other name hub followed
by a lookup path that ends at a `readable-tree` or `git-tree`.

The path is an authority-bearing lookup recipe, not an object identity. A
consumer resolves all paths to terminal formula identifiers at the beginning of
an object-store transaction. A formula constructor likewise resolves its inputs
once and stores the terminal identifiers, never the mutable paths. Those
resolved identifiers form the immutable snapshot used for hashing and pack
generation. A later name-hub mutation is a later ref state, not a mutation of an
existing commit.

### Object formulas

Blob content continues to use `readable-blob`. Git's blob object ID is the hash
of the Git object header and those exact content bytes, so a second blob formula
would add no information.

```ts
type GitTreeEntry = {
  mode: '40000' | '100644' | '100755' | '120000' | '160000';
  nameBase64: string;
  target: FormulaIdentifier;
};

type GitTreeFormula = {
  type: 'git-tree';
  entries: GitTreeEntry[];
};

type GitActor = {
  rawBase64: string;
  nameBase64: string;
  emailBase64: string;
  seconds: string;
  utcOffset: string;
};

type GitHeader = {
  name: string;
  valueBase64: string;
};

type GitCommitFormula = {
  type: 'git-commit';
  tree: FormulaIdentifier;
  parents: FormulaIdentifier[];
  author: GitActor;
  committer: GitActor;
  extraHeaders: GitHeader[];
  message: FormulaIdentifier; // readable-blob
  headerOrder?: Array<
    | 'tree'
    | { parent: number }
    | 'author'
    | 'committer'
    | { extra: number }
  >;
};

type GitTagFormula = {
  type: 'git-tag';
  object: FormulaIdentifier;
  objectType: 'blob' | 'tree' | 'commit' | 'tag';
  tagBase64: string;
  tagger?: GitActor;
  extraHeaders: GitHeader[];
  message: FormulaIdentifier; // readable-blob, including an appended signature
  headerOrder?: Array<
    | 'object'
    | 'type'
    | 'tag'
    | 'tagger'
    | { extra: number }
  >;
};
```

`git-tree` carries the information `readable-tree` omits: raw path bytes, modes,
symlinks, and gitlinks. Its entries are stored in Git tree sort order and are
rejected if names, modes, ordering, or target types are invalid. Mode `160000`
targets a `git-commit`; directory mode targets `git-tree` or `readable-tree`;
the remaining modes target `readable-blob`.

`git-commit` makes author and committer timestamps explicit decimal seconds
plus a four-digit signed UTC offset. `rawBase64` is the authoritative complete
actor header value; the parsed fields are validated indexes for inspection and
construction. This preserves unusual but valid spacing while making timestamps
available without reparsing. Parent order is preserved because it is part of
merge commit identity. The message is a readable blob so arbitrary bytes and
the presence or absence of a trailing newline survive round trips.
`extraHeaders` retains `encoding`, multiline `gpgsig`, `mergetag`, and unknown
extension headers as exact bytes. `headerOrder` preserves nonstandard imported
header ordering. It is omitted for daemon-created commits, whose serializer uses
the field order shown above. A signature is never regenerated during fetch.

`git-tag` represents annotated tag objects. Lightweight tags are refs directly
to another object and need no formula. A tag's signed message remains exact in
its message blob.

The implementation adds these types to the `Formula` union, formula-type
registry, maker table, dependency extractor, formula inspector, and persistence
tests. The maker returns a narrow immutable Git object capability suitable for
inspection and object-store projection. Formula identifiers remain daemon
identities and must never be exposed as Git object IDs.

### Synthetic refs tree

A partition's ref database is a map whose leaves are formula paths:

```ts
type FormulaRef =
  | { kind: 'direct'; target: FormulaPath }
  | { kind: 'symbolic'; target: string };

type FormulaRefStore = {
  list(prefix: string): Promise<Record<string, FormulaRef>>;
  compareAndSwap(
    ref: string,
    expected: {
      binding: FormulaRef | undefined;
      terminal?: FormulaIdentifier;
    },
    replacement: FormulaRef | undefined,
  ): Promise<boolean>;
};
```

For example, `refs/heads/main` may point at `{ root: hostId, path:
['projects', 'site', 'release'] }`. The synthetic directory presented to Git is
therefore:

```text
refs/heads/main -> hostId / projects / site / release
```

The first component is always an arbitrary formula identifier. Remaining
components are name-hub lookups. The terminal may be a `git-commit`, `git-tag`,
`git-tree`, or `readable-tree`. Ref names and symbolic-ref targets are validated
with Git's refname rules before storage. A direct-ref update compares both the
stored `FormulaRef` and the terminal formula identifier observed by the client.
The daemon resolves and updates under its formula-graph lock, so a change to any
path component makes the comparison fail. This matches the `RefStore`
concurrency contract in the Minion Town design even when a stored selector has
not changed but a name-hub binding beneath it has.

The initial adapter accepts only selectors whose terminal name hub supports a
daemon-internal compare-and-swap binding operation. Read-only paths through
arbitrary `NameHub` implementations remain fetchable but cannot be push targets.
This keeps ref mutation atomic without granting the Git adapter ambient write
authority over every traversed hub.

### Synthetic orphan commits

A direct ref to a `readable-tree` or `git-tree` has no Git commit to advertise.
The adapter envelopes it in a synthetic orphan commit with:

- the resolved tree's synthesized Git tree ID;
- no parents;
- author and committer with the exact header value
  `Endo Synthetic <endo@invalid.local> 0 +0000`;
- the exact message bytes `Endo synthetic tree\n`;
- no extra headers or signature.

No wall clock, host name, formula identifier, ref name, or traversal path enters
the payload. Two refs to the same projected tree therefore produce the same
orphan commit ID. A `readable-tree` projection assigns `40000` to child trees
and `100644` to readable blobs. It rejects other terminal capabilities. A caller
that needs executable bits, symlinks, or gitlinks must use a `git-tree` formula.

The orphan envelope is a projection result and need not be persisted. Persisting
it as a `git-commit` is permitted when a caller wants to name or parent it.

### Byte-stable object projection

`FormulaGitObjectStore` implements the object-store side of the Minion Town
Strategy A/B seam:

```ts
type FormulaGitObjectStore = {
  resolve(target: FormulaPath): Promise<FormulaIdentifier>;
  oidFor(target: FormulaPath, format: 'sha1' | 'sha256'): Promise<string>;
  readObject(oid: string): Promise<{
    type: 'blob' | 'tree' | 'commit' | 'tag';
    payload: Uint8Array;
  }>;
  ingestObject(type: string, payload: Uint8Array): Promise<FormulaPath>;
};
```

Projection follows Git's byte grammar:

1. Resolve every ref formula path to a terminal formula identifier and pin that
   formula plus its immutable formula dependencies for the transaction.
2. Serialize blobs from their exact CAS bytes. Serialize trees from binary entry
   tuples. Serialize commits and tags from their ordered fields without newline,
   Unicode, timestamp, or signature normalization.
3. Compute the object ID over `type + " " + decimalLength + NUL + payload` using
   the partition's declared object format.
4. Memoize by object format and resolved terminal formula identifier. Record the
   reverse OID-to-formula index needed for `readObject` and negotiation.

`ingestObject` parses and validates the payload, interns blob and message bytes,
formulates its referenced objects bottom-up, and records every raw field needed
to serialize the same payload. It rejects dangling references at ref-update
time. Ingest followed by projection must reproduce the input payload byte for
byte and the same OID.

This interface also admits Strategy A. An implementation may index an interned
raw Git object instead of projecting a formula, while refs still point into the
same formula namespace. The remote can therefore choose stored objects or
formula synthesis per partition without changing smart HTTP.

## Security and Lifetime

A formula path conveys only authority already reachable from its root. The
object-store adapter receives explicit read authority for roots and explicit
binding authority for writable ref leaves. It does not acquire a general host
directory or formula-graph enumeration capability.

Static formula edges and dynamic name-hub edges keep reachable object formulas
alive. A fetch pins its resolved snapshot until pack generation ends. A
successful ref compare-and-swap installs the new retention edge before releasing
the old edge, so garbage collection cannot observe a gap.

Object parsing enforces size, depth, entry-count, and parent-count limits before
formulation. Hash verification alone is not a resource bound.

## Implementation Phases

1. Add the `git-tree`, `git-commit`, and `git-tag` formula schemas, makers,
   dependency extraction, inspector records, and round-trip serializers.
2. Add `FormulaGitObjectStore`, OID indexes, SHA-1 and SHA-256 golden vectors,
   and deterministic orphan projection for readable trees.
3. Add the synthetic `FormulaRefStore` view, symbolic refs, atomic updates, and
   fetch-snapshot pinning.
4. Connect the interfaces to a daemon-local pack protocol experiment. Minion
   Town integration remains in its separately chained follow-up.

## Dependencies

| Design | Relationship |
|---|---|
| [daemon-checkin-checkout](daemon-checkin-checkout.md) | Supplies content-addressed `readable-blob` and `readable-tree` formulas. |
| [daemon-git-capability](daemon-git-capability.md) | Supplies the existing local Git capability and `ReadableTree` historical projection. |
| [namehub-interface-unification](namehub-interface-unification.md) | Defines the lookup vocabulary traversed by formula paths. |
| [daemon-content-store-gc](daemon-content-store-gc.md) | Owns content and formula collection while refs and fetch snapshots retain objects. |
| [formula-inspector](formula-inspector.md) | Displays the new formula fields and references. |

## Test Plan

- Parse real blob, tree, commit, signed-commit, annotated-tag, and signed-tag
  fixtures, ingest them, project them, and compare payload bytes and OIDs with
  `git cat-file` and `git hash-object` under SHA-1 and SHA-256 repositories.
- Cover merge parent order, negative and non-hour UTC offsets, messages without
  trailing newlines, multiline signatures, unknown headers, non-UTF-8 tree
  names, executable files, symlinks, gitlinks, and empty trees.
- Fetch the same unchanged ref twice and assert identical advertisements,
  object IDs, and pack contents.
- Mutate a traversed name-hub binding during a fetch and assert the in-flight
  fetch keeps its pinned snapshot while the next fetch sees the new terminal.
- Race two compare-and-swap ref updates and assert exactly one wins without a GC
  retention gap.
- Project the same readable tree through two refs and assert one identical
  synthetic orphan commit; assert unsupported readable-tree children fail.

## Design Decisions

1. **Formula paths compose commits with existing name hubs.** A root formula ID
   plus lookup path reuses the daemon's DAG and retention model instead of
   introducing a parallel repository namespace.
2. **Commit metadata is data, not a fetch-time default.** Exact actor stamps,
   parent order, messages, headers, and signatures make identity reproducible.
3. **Git tree metadata gets its own formula.** A readable tree stays the simple
   content snapshot it is today; Git-only modes and binary names do not widen
   every filesystem consumer's contract.
4. **Refs remain mutable store entries.** Commit, tree, blob, and tag formulas
   are immutable DAG nodes. Compare-and-swap ref leaves are the only mutable Git
   boundary.
5. **Synthetic commits are deterministic or rejected.** The adapter never uses
   current time or ambient identity to make a readable tree fetchable.

## Open Questions

- Should the first implementation support both SHA-1 and SHA-256 object formats,
  or land SHA-1 with SHA-256 golden fixtures held pending the remote's negotiated
  object-format support?
- Should writable formula refs require a new generic compare-and-swap NameAdmin
  method, or remain a private operation on daemon-managed pet stores?

## Prompt

> Design a daemon-native "commit" formula so the daemon's formula DAG can
> faithfully reflect the full Git object model (commits, trees, blobs, tags,
> refs), not only readable-trees. Elaborate the fields and composition over
> readable-trees and name-hubs, refs as formula-identifier roots plus lookup
> paths, synthetic orphan commits, and byte-stable commit identity across
> fetches. Cross-reference Minion Town's git-remote Strategy A/B object-store
> interface and the originating review comment.
