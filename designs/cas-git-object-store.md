# CAS-backed Git Object Store

| | |
|---|---|
| **Created** | 2026-08-18 |
| **Author** | gardener (prompted) |
| **Status** | In Progress |
| **Source** | Delivery item G1 of the garden design `cas-git-package-substrate` |

## Motivation

Git repositories are already content-addressed Merkle stores.
The Endo daemon already has a content-addressed blob store
(`@endo/daemon-cas`) keyed by sha256 of raw bytes.
G1 puts git objects into that CAS and exposes a pure
`GitObjectStore` so log, tree walk, and commit-to-commit diff can run
without a git subprocess on the read path.

This document is the repository-local implementation design for G1.
The cross-project plan lives in the garden design of record; binding
decisions below follow that plan's G1 section as refined by the
delivery brief.

## Binding decisions

1. **Content without header.**
   Store each git object's *content* bytes as one CAS blob, without the
   `<type> <length>\0` framing header.
   The header is deterministic from `(type, content.length)`, so
   canonical bytes for oid verification are reconstructed on demand.
   Rationale: a git blob and the same file arriving as a readable-tree
   entry or package tree must be byte-identical CAS blobs.

2. **Oid index as derived cache.**
   Keep an index mapping `(hash algorithm, git object id)` to
   `(object type, CAS hash)`.
   It is reconstructible by a reachability walk from known roots and
   needs no durability story of its own.
   Host form: SQLite table; tests and isolates may use an in-memory
   index with the same contract.

3. **Hash-agnostic from the start.**
   Tree codec parameterizes oid length (20 or 32 bytes) from the
   repository's object format.
   Index keys on `(algorithm, oid)`.
   A repository is one hash or the other; no sha1/sha256 interop.

4. **Hand-rolled loose codecs only.**
   Commit and tag are line-oriented text; tree is a small binary
   record; blob is passthrough.
   No packfile parsing, no delta resolution, no wire-protocol code.

5. **Batched reads are contract.**
   The store exposes `readObjects(oids)` alongside `readObject`,
   `writeObject`, and `hasObject` from day one.
   A naive log is one dependent read per commit; over object-storage
   latency that is unusable, so the batch verb is not an optimization.
   Each store instance caps one index/content batch at 1024 objects
   (default 64), so a caller cannot turn one capability call into an
   unbounded message.

## Package

New package `@endo/git-object-store`.

Naming note: `@endo/mem-cas` reserves `@endo/git-cas` for the *inverse*
direction (a CAS backed by git's object store).
This package is git objects backed by the daemon CAS, so the name
follows the `GitObjectStore` contract.

## Object-store contract

```ts
type GitHashAlgorithm = 'sha1' | 'sha256';
type GitObjectType = 'blob' | 'tree' | 'commit' | 'tag';

type GitObjectId = string; // lowercase hex, length 40 or 64

interface GitObject {
  type: GitObjectType;
  content: Uint8Array;
  oid: GitObjectId;
}

interface GitObjectStore {
  hasObject(oid: GitObjectId): Promise<boolean>;
  readObject(oid: GitObjectId): Promise<GitObject>;
  readObjects(oids: GitObjectId[]): Promise<(GitObject | undefined)[]>;
  writeObject(type: GitObjectType, content: Uint8Array): Promise<GitObjectId>;
  getHashAlgorithm(): GitHashAlgorithm;
}
```

`writeObject` stores content bytes in the CAS, computes the oid from
reconstructed canonical bytes, and records the index entry.
`readObject` / `readObjects` look up the index, fetch content from the
CAS, and return typed objects.
Missing oids: `readObject` throws; `readObjects` returns `undefined`
in the corresponding slot so a batch can tolerate sparse results.

Constructor powers:

```ts
makeGitObjectStore({
  contentStore,   // @endo/platform ContentStore
  oidIndex,       // OidIndex (memory or SQLite)
  hashAlgorithm,  // 'sha1' | 'sha256'
  digest,         // (algorithm, bytes) => Uint8Array
  maxBatchSize,   // optional read cap, clamped to [1, 1024]
})
```

`digest` is injected so the package stays free of a Node/Web/XS crypto
binding; Node tests wire `node:crypto`.

## Codec formats

### Framing (not stored)

Canonical bytes for hashing:

```
<type> SP <decimal-length> NUL <content>
```

`type` is one of `blob`, `tree`, `commit`, `tag`.
`length` is the content byte length in ASCII decimal.

### Blob

Content is the raw file bytes.
Parse and serialize are identity.

### Tree

Binary concatenation of entries, each:

```
<mode-ascii> SP <name> NUL <oid-bytes>
```

- `mode-ascii`: `40000` (tree), `100644` / `100755` (blob),
  `120000` (symlink), `160000` (gitlink).
- `name`: path segment, no embedded NUL or `/`.
- `oid-bytes`: raw digest, length 20 (`sha1`) or 32 (`sha256`).

Entries are sorted by the byte string `name` with a trailing `/`
appended for tree modes (git's tree sort).
The codec parameterizes oid length from `hashAlgorithm`.

### Commit

UTF-8 text, headers then blank line then message:

```
tree <oid>
parent <oid>          # zero or more
author <ident>
committer <ident>
encoding <name>       # optional
gpgsig <...multiline> # optional; continuation lines start with SP

<message>
```

`ident` is `<name> <email> <unix-seconds> <tz>`, where `<email>` is
wrapped in `<` `>`.

### Tag

UTF-8 text:

```
object <oid>
type <object-type>
tag <name>
tagger <ident>

<message>
```

## Oid index schema

```sql
CREATE TABLE IF NOT EXISTS git_oid_index (
  algorithm TEXT NOT NULL,
  oid TEXT NOT NULL,
  object_type TEXT NOT NULL,
  cas_hash TEXT NOT NULL,
  PRIMARY KEY (algorithm, oid)
);

CREATE INDEX IF NOT EXISTS git_oid_index_by_cas
  ON git_oid_index (cas_hash);
```

`algorithm` is `sha1` or `sha256`.
`oid` and `cas_hash` are lowercase hex.
`object_type` is `blob`, `tree`, `commit`, or `tag`.

The in-memory index is a `Map` keyed by `${algorithm}:${oid}` with the
same value shape.
Both implement:

```ts
interface OidIndex {
  get(algorithm, oid): Promise<{ type, casHash } | undefined>;
  getMany(algorithm, oids): Promise<(entry | undefined)[]>;
  put(algorithm, oid, type, casHash): Promise<void>;
  has(algorithm, oid): Promise<boolean>;
}
```

`getMany` exists so each bounded `readObjects` batch issues one index
round-trip.

## Pure derived reads (proof surface)

G1 proves the store with pure helpers over the codecs (not yet the
exo-git backend partition from G3):

- **Commit-graph log**: follow `parent` links from a head oid via
  bounded `readObjects` batches.
- **Tree walk**: decode tree entries, recurse, read blobs as needed.
- **Commit-to-commit diff**: walk both trees, emit path-keyed adds /
  deletes / modifications by oid comparison.

Test-time ingest may shell out to native git
(`git cat-file --batch-all-objects --batch` or a bounded
`rev-list` + `cat-file --batch`) to load objects from an existing
checkout.
Only the read path must be pure.

## Composition and ownership

This package is the portable JavaScript layer for logical Git objects and
their ContentStore representation.
PR 987 ([the proposed native Git binding design](https://github.com/endojs/endo-but-for-bots/pull/987)) is expected to supersede the current PR 872 direction if it lands, with a full-power libgit2 adapter for packs, refs, transport, and other native repository behavior.
PR 987 remains open, so this design does not assume that proposal has landed.
The future portable `GitBackend` / `@endo/exo-git` immutable-tree seam is the
intended consumer of this contract as portable coverage grows through concrete
consumers.
The portable layer and native backend direction are complementary layers, not
competing semantic stores.
PR 872 ([the earlier gix-only Phase 1](https://github.com/endojs/endo-but-for-bots/pull/872)) remains the currently committed daemon-private, target-specific implementation and is not copied into this package.

## Out of scope (G1)

- Transport, fetch, push, and CAS ingest wiring (G2).
- Partitioning or modifying the `packages/exo-git` backend contract (G3).
- Native ref stores beyond a minimal head-oid fixture for walk tests.
- Pack retention and compression decisions (G2 measurement).
- Native packfile / delta / wire-protocol code, credentials, worktrees, and
  daemon-private filesystem repository management.

## Dependencies

| Design / package | Relationship |
|---|---|
| Garden `cas-git-package-substrate` | Design of record; G1 delivery item |
| `designs/endo-fs-from-git.md` | Future consumer of object reads via exo-git |
| `designs/daemon-content-store-gc.md` | CAS retention; oid index is not a GC root |
| `@endo/daemon-cas` | Filesystem ContentStore implementation |
| `@endo/platform` `ContentStore` | Injected blob store contract |
| `packages/exo-git` | Eventual G3 consumer of `GitObjectStore` |

## Phased implementation

1. Codecs with known-answer and round-trip tests (oid recomputed from
   reconstructed canonical bytes).
2. Memory oid index + ContentStore-backed `GitObjectStore`, including
   `readObjects`.
3. SQLite oid index adapter matching the schema above.
4. Ingest + pure walk tests against this repository (bounded reachable
   set from `HEAD`), exercising batched reads.

## Prompt

> Implement G1 from the CAS-native git and package substrate design:
> an implementation design under `designs/` plus a new package with
> hand-rolled loose-object codecs and a `GitObjectStore` backed by the
> daemon CAS content store plus an oid index.
> Binding decisions: store content without the framing header; oid
> index as a derived `(algorithm, oid) → (type, cas hash)` cache;
> hash-agnostic codecs; batched `readObjects` as contract; no
> pack/wire/transport code.
> Prove with codec round-trips and a pure walk (log, tree, diff) over
> an ingested real repository.
