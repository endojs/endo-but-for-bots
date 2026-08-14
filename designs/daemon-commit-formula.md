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
[Git object store design, section 4](https://github.com/kriscendobot/minion.town/blob/609fdd5251a0297ce15355acc8d902f973c99a18/designs/git-remote-capability.md#4-git-objects---cas-two-storage-strategies-behind-one-wire).
That design lets a Git remote answer for an object two ways: **Strategy A**
interns each raw Git object in content-addressed storage and serves the stored
bytes back verbatim, while **Strategy B** holds only CAS-native daemon state
(`readable-blob` and `readable-tree` formulas) and *synthesizes* the Git objects
on demand. Strategy B stays blocked until those synthesized objects are
byte-identical across fetches: the same tree, commit, or tag must reproduce the
same object ID every time. This design answers the
[review request](https://github.com/kriscendobot/minion.town/pull/41#discussion_r3785689633)
with daemon-native formulas for Git commits, trees, and tags, plus a refs view
over the formula DAG, so Strategy B's synthesis is byte-stable. It does not
implement the Minion Town remote.

## Design

### Formula paths

A mutable Git ref names a formula path rather than embedding a Git object ID:

```ts
type FormulaPath = {
  root: FormulaIdentifier;
  path: Name[];
};
```

Resolution starts from `root`, then calls `lookup(component)` for every
component in `path`. Intermediate values may be any daemon *name hub*, meaning
any daemon lookup structure that binds names to values, such as a host, guest,
directory, or pet store. The final value must have the formula type required by
the edge. An empty path names the root formula itself.

The ref store retains the root through an ordinary formula dependency. Every
traversed name hub retains its named child through its existing dynamic
pet-store edge (the name hub's own retained name-to-formula binding). A commit constructor can therefore accept a direct
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
type GitTreeEntry =
  | {
      // Directory, file, and symlink entries resolve to a formula this repo
      // owns.
      mode: '40000' | '100644' | '100755' | '120000';
      nameBase64: string;
      target: FormulaIdentifier;
    }
  | {
      // Submodule gitlink. The OID names a commit in a *different*
      // repository's object set, routinely absent here, so it is carried
      // opaquely as raw bytes rather than a resolvable formula target.
      mode: '160000';
      nameBase64: string;
      gitlinkOidHex: string;
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
symlinks, and gitlinks. Its entries are stored in Git tree sort order. An entry
is rejected if its name, mode, ordering, or target type is invalid. Directory
mode (`40000`) targets a `git-tree` or a `readable-tree`; the file and symlink
modes (`100644`, `100755`, `120000`) target a `readable-blob`.

Mode `160000` is a submodule gitlink, and it is the design's answer for a
reference that points outside the object store this tree owns. A gitlink's OID
names a commit in a *different* repository, which is routinely absent from the
repo being ingested (that is the purpose of a gitlink, not an oversight), so
requiring it to resolve to a formulated `git-commit` would fail ingest for the
ordinary submodule case. A gitlink entry therefore carries its raw OID
(`gitlinkOidHex`) opaquely: the OID is preserved verbatim for byte-stable tree
serialization and is never formulated, resolved, or checked for reachability at
ref-update time. A daemon that also happens to hold the referenced submodule
commit may formulate it separately, but ingest and projection never require it.
Shallow-fetch boundaries are handled the same way: an object outside the fetched
set is only ever referenced, never required to be present.

The default-mode assignment rule for `readable-tree` children (§ Synthetic
orphan commits) applies recursively wherever a directory entry targets a
`readable-tree`: within that subtree and every `readable-tree` nested beneath it,
child trees serialize at `40000` and readable blobs at `100644`. A
`readable-tree` subtree cannot express an executable bit, symlink, or gitlink, so
any tree needing a non-default mode anywhere beneath it must use `git-tree`
formulas all the way down to each such entry rather than mixing in a
`readable-tree` at an intermediate level.

`git-commit` represents author and committer timestamps as explicit decimal
seconds plus a four-digit signed UTC offset. `rawBase64` holds the complete
actor header value and is the sole input to object hashing; the parsed
`nameBase64`, `emailBase64`, `seconds`, and `utcOffset` fields are validated
projections of those bytes, provided for inspection and time-based logic without
reparsing. The two representations are never supplied independently, and they
have one derivation direction fixed at construction: for an ingested commit the
parser derives the parsed fields from `rawBase64`; for a daemon-authored commit
the maker synthesizes `rawBase64` from the structured fields using Git's actor
grammar, `name SP "<" email ">" SP seconds SP offset`, where `name` and `email`
are the decoded `nameBase64`/`emailBase64` bytes, `seconds` is decimal, and
`offset` is a signed four-digit `+HHMM` or `-HHMM`, then derives the parsed
fields back from those bytes. Because hashing reads only `rawBase64` and the parsed fields
are always derived from it, an internally inconsistent record whose raw bytes
and parsed fields disagree cannot be constructed. This preserves unusual but
valid spacing while making timestamps available without reparsing. Parent order is preserved because it is part of
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
  get(ref: string): Promise<FormulaRef | undefined>;
  compareAndSwap(
    ref: string,
    expected: {
      binding: FormulaRef | undefined;
      // Required whenever `binding` is a direct ref: the terminal formula
      // identifier the caller last resolved the path to. `undefined` only
      // when `binding` is absent (creating the ref) or symbolic, cases with
      // no terminal to observe. Never optional for a direct ref.
      terminal: FormulaIdentifier | undefined;
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
with Git's refname rules before storage. `get(ref)` reads a single known
binding, the common shape before a compare-and-swap, without enumerating a
prefix through `list`.

A direct-ref update compares both the stored `FormulaRef` (the *selector*, the
formula path defined above) and the terminal formula identifier the client last
resolved that path to. For a direct-ref expectation `terminal` is mandatory: the
store rejects a direct-ref `compareAndSwap` that omits it rather than silently
degrading to a binding-only comparison. Binding-only CAS is never a caller's
option, because it would miss a name-hub binding that changed beneath an
unchanged path, the exact drift this store exists to detect. The daemon resolves
and updates under its formula-graph lock, so a change to any path component makes
the comparison fail. This `FormulaRefStore` implements the `RefStore`
concurrency contract named in the Minion Town design: the compare-and-swap fails
even when the stored selector has not changed but a name-hub binding beneath it
has.

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
  computeOid(target: FormulaPath, format: 'sha1' | 'sha256'): Promise<string>;
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
byte and yield the same OID.

This interface also admits Strategy A. An implementation may index an interned
raw Git object instead of projecting a formula, while refs still point into the
same formula namespace. The remote can therefore choose stored objects or
formula synthesis per partition without changing smart HTTP.

### Capability construction

`FormulaGitObjectStore` and `FormulaRefStore` are trusted daemon internals, not
guest-facing capabilities. The guest-facing Git caps in
[daemon-git-capability](daemon-git-capability.md) § Capability Construction and
[daemon-git-remotes](daemon-git-remotes.md) are minted through the normative
`await E(host).provideGit(cap, petName, [opts])` entry point, which those designs
state is the only normative form. These two stores are different: they are
constructed by the Minion Town remote adapter (or a daemon-local pack experiment)
from the explicit authorities named under § Security and Lifetime (read
authority for the ref roots served and binding authority for the writable ref
leaves), and there is no `provideX` for either. A guest never holds one directly.
If a later revision exposes object-store or ref-store authority to guests, it
must introduce a `provideX` entry point and restate here the authority bound to
it.

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
- Compare-and-swap a direct ref whose stored selector is unchanged but whose
  terminal formula identifier changed because a traversed name-hub binding was
  rebound, and assert the swap fails (the reader-observed-stale-terminal case),
  distinct from the writer-versus-writer race above.
- Reject payloads that exceed each bound named under § Security and Lifetime:
  an oversized object, an over-deep tree nesting, a tree with too many entries,
  and a commit exceeding the parent-count bound, asserting each is refused
  before formulation rather than accepted or truncated.
- Round-trip a `git-tree` bearing a submodule gitlink (ingest then project) and
  assert the raw gitlink OID bytes survive without formulating the referenced
  commit; assert a malformed gitlink OID is rejected.
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
