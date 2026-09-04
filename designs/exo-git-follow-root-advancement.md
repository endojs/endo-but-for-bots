# Follow Root Advancement for exo-git

| | |
|---|---|
| **Created** | 2026-07-29 |
| **Updated** | 2026-08-24 |
| **Author** | Kris Kowal (prompted) |
| **Status** | Proposed |

## What is the Problem Being Solved?

A holder of a `Git` capability cannot currently prepare a working commit as a
capability or follow the sequence of roots published by commits. Consumers
either mutate a live native worktree and poll Git state, or invent their own
ordering, coalescing, staging, and disposal rules.

The portable substrate for this work belongs in `@endo/platform/fs`, not in a
Git-directory watcher. A filesystem root is meaningful for an in-memory,
layered, remote, content-addressed, or native hierarchy. Git then adds one
layer: a **stage** holds tentative commit metadata and a mutable filesystem root,
and `stage.commit()` explicitly publishes that root as a commit.

This design therefore separates two ordered sequences:

1. Filesystem root advancement. Every successful public mutating method call
   is one explicitly delimited filesystem transaction and produces at most one
   new immutable root.
2. Git root advancement. Every successful `stage.commit()` is one explicitly
   delimited version-control transaction and publishes the stage's current root
   and tentative metadata as a commit.

Both layers offer a lossless changes follower and a lossy latest-root follower.
Consumers choose whether every transaction matters or only convergence on the
newest root matters.

Concrete use cases:

1. **React to edits.** An evaluator follows every filesystem transaction on a
   stage and reruns against the exact immutable root each method produced.
2. **Render current state.** A UI follows only the latest root and may skip
   intermediate roots while it is busy.
3. **Observe commits.** A supervisor follows every root published by
   `stage.commit()` and can correlate the tree with commit identity and
   metadata.
4. **Coordinate writers.** Writers sharing one stage observe one serialized
   sequence and use preconditions on high-level patch operations to avoid lost
   updates.
5. **Publish deliberately.** Mutating a stage never pushes. Committing and
   pushing remain distinct capability-bearing operations.

## Scope

This design covers:

- extensions to the existing `@endo/platform/fs` interfaces for immutable
  root snapshots, portable tree identity, transactional mutation, and lossy
  and lossless root followers;
- a `GitStage` capability with tentative commit metadata, a mutable root, and
  an explicit `commit()` delimiter;
- lossy and lossless followers for roots published by Git commits;
- ordering, late subscribers, concurrent writers, duplicate content,
  cancellation, backpressure, failure, restart, and authority; and
- virtual, native, layered, and remote filesystem providers.

Out of scope:

- choosing a branch, remote, or implicit push destination;
- durable replay beyond Git's ordinary commit history;
- a general remotely supplied transaction callback; and
- prescribing one tree-hash algorithm for every backend.

## Terminology

- **Filesystem transaction**: one successful mutating method call. Its effects
  become visible together and it advances the filesystem root at most once.
- **Root snapshot**: an immutable, read-only `Filesystem` plus its portable
  `TreeRef` and incarnation-local revision.
- **Tree reference**: an algorithm-tagged content identity for the complete
  tree. Equal references under the same algorithm identify equal trees.
- **Stage**: a working commit capability containing tentative commit metadata
  and a mutable filesystem root.
- **Commit transaction**: one successful `GitStage.commit()` call. It freezes
  the stage's current root and metadata into a Git commit and advances the
  repository's published root once.
- **Lossless follower**: delivers every transaction after its initial snapshot.
- **Latest follower**: may coalesce transactions and delivers only the newest
  root available when the reader drains.
- **Incarnation revision**: a monotonically increasing `bigint` used only for
  ordering within one live provider incarnation. It is not durable identity.

## Current Shape

`@endo/platform/fs/extended` already supplies the portable capability vocabulary:

- `Filesystem.root()` and `Filesystem.named()` return tree capabilities;
- `Directory` and `File` carry the mutating methods;
- `File.snapshot()` returns a content-addressed `BlobRef`;
- `Node.watch()` and `Directory.watchFrom()` provide node-level observation;
- `Qid` provides backend-specific path/version identity; and
- `FsBackend` lets native, in-memory, layered, and remote adapters share the
  public surface.

It does not yet provide content identity for a whole tree, a root-level
snapshot/follower, or an atomicity contract across composite mutations.
`Qid` is insufficient as portable content identity because its default
`pathId` is path-derived and its `version` is provider-local.

`makeGit({ mount, backend, lineageOf }, options)` currently combines a live
workspace authority with a native Git backend. That shape has no capability
representing a tentative commit. The new `GitStage` moves the working commit
one layer above the filesystem and keeps `.git`, `HEAD`, the index, and host
paths out of the portable filesystem contract.

## Precedent

The follower split follows the two topic semantics already established in
Endo:

- [`@endo/pubsub` design PR #507](https://github.com/endojs/endo-but-for-bots/pull/507)
  distinguishes lossy latest updates from lossless changes.
- [`@endo/pubsub` implementation PR #513](https://github.com/endojs/endo-but-for-bots/pull/513)
  lands `makeLatestTopic` and `makeChangeTopic` over the local
  Sink/Spring promise-list convention.
- [`@endo/exo-pubsub` bridge PR #553](https://github.com/endojs/endo-but-for-bots/pull/553)
  carries both topic shapes over CapTP while keeping subscriptions
  wire-compatible with `PassableReader`.

The high-level mutation direction follows the hashline work:

- [`endo edit` hashline design PR #162](https://github.com/endojs/endo-but-for-bots/pull/162)
  defines a content-preconditioned, atomic batch patch.
- [hashline implementation probe PR #204](https://github.com/endojs/endo-but-for-bots/pull/204)
  demonstrates read-validate-patch-write as one method call and surfaces the
  locking and cross-backing questions a filesystem-level transaction must
  answer.

These are precedents, not dependencies on daemon-specific APIs. The platform
filesystem owns the portable contracts; pubsub and exo-pubsub provide their
local and passable transport implementations.

## Design

### Extend `@endo/platform/fs`

The existing authored `types.ts`, runtime `type-guards.js`, read-only wrapper,
backend wrapper, generated code-mode declarations, and conformance tests grow
together.

```ts
export type TreeRef = {
  algorithm: string;
  hash: string;
};

export type RootSnapshot = {
  type: 'snapshot';
  revision: bigint;
  tree: TreeRef;
  /** Immutable and read-only. */
  root: Filesystem;
};

export type RootTransition = {
  type: 'transition';
  fromRevision: bigint;
  toRevision: bigint;
  tree: TreeRef;
  /** Immutable and read-only. */
  root: Filesystem;
};

export type RootChange = RootSnapshot | RootTransition;

export type FollowRootOptions = {
  cancelled?: Promise<never>;
};

export type Filesystem = {
  // Existing methods omitted.
  snapshotRoot: () => Promise<RootSnapshot>;
  followRootChanges: (
    options?: FollowRootOptions,
  ) => ERef<PassableReader<RootChange, undefined>>;
  followLatestRoot: (
    options?: FollowRootOptions,
  ) => ERef<PassableReader<RootSnapshot, undefined>>;
};
```

`snapshotRoot()` is the tree analogue of `File.snapshot()`. It atomically
captures the current root, computes or obtains its `TreeRef`, and returns a
read-only filesystem capability whose future reads cannot observe later
mutation.

`TreeRef.algorithm` identifies both the digest and tree-encoding convention.
Examples include `git-sha1-tree`, `git-sha256-tree`, and a future canonical
`endo-tree-sha256`. A backend may use a native tree identity when it satisfies
the equality rule. A wrapper that combines backends computes a reference over
its visible composed tree. Tree identity is therefore standardized at the
interface without pretending that every backend uses Git object IDs.

The runtime shapes are strict records. `root` must satisfy the read-only
`FilesystemInterface`, and wrappers validate fulfilled eventual references.
The existing declaration-drift gates keep the authored TypeScript, guards, and
generated code-mode surface aligned.

### Lossless root changes

`followRootChanges()` atomically returns the current snapshot and a cursor for
every later filesystem transaction. The first value is a `RootSnapshot`.
Every subsequent value is a `RootTransition`, and each `fromRevision` equals
the previously delivered revision.

The implementation uses the lossless `makeChangeTopic` topology locally and
the `@endo/exo-pubsub` subscription bridge over CapTP. A slow reader does not
block a writer. It retains its undrained change chain. A provider may impose a
documented bound and terminate that reader with an overflow error, but it must
not silently skip a transaction on this surface.

Equal content does not suppress a successfully committed transaction. An edit
followed by its reversal therefore produces two transitions even if the second
tree reference equals an older one. A method that determines before commit
that it made no change returns normally without advancing the revision.

### Lossy latest root

`followLatestRoot()` uses the lossy `makeLatestTopic` topology. Its first value
is the current `RootSnapshot`. If roots B, C, and D are published while the
consumer is busy with A, its next read may yield D without yielding B or C.
The revision jump makes coalescing visible.

This follower is appropriate for rendering, indexing that restarts from a
complete snapshot, and other convergence-only consumers. It retains one latest
snapshot per topic rather than an undrained chain per subscriber. It never
returns a transition whose `fromRevision` would imply delivery of roots the
consumer did not see.

The two methods are separate capability methods rather than an option flag.
Their names make loss behavior visible at review and call sites, and they map
directly to the established topic factories.

### Filesystem transaction boundary

Every public mutating method call is one transaction. A successful call either
publishes exactly one new root or publishes none because the visible content
did not change. A rejected call publishes nothing. Consumers never observe a
partially applied result through `snapshotRoot()` or either follower.

This rule covers the existing surface:

- `Directory.write`, `makeDirectory`, `mkdir`, `remove`, `unlink`, `move`,
  `copy`, `rename`, `setStat`, and `setAttrs`;
- `File.write`, `setStat`, and `setAttrs`;
- `OpenFile.truncate`; and
- `Xattrs.set` and `Xattrs.remove` where attributes participate in the visible
  tree identity.

A mutating method that returns a writer commits when the writer closes with
`return()`. Its chunks are private tentative state before close. `throw()`, a
failed close, or cancellation aborts without publishing a root. `OpenFile`
groups each direct mutating call separately; merely opening or closing a handle
is not a transaction.

Composite methods are atomic at their public boundary. Recursive `copy` or
`move` may perform many backend writes, but followers see one new root after
all succeed. Backends must use a native transaction, copy-on-write root, or
journal-and-rollback strategy to satisfy this contract. A backing that cannot
provide the guarantee does not advertise the transactional mutable interface.

Foreign writes that bypass the capability cannot recover method boundaries.
A native adapter may reconcile them as explicitly tagged `external`
transactions and document coalescing, but capability-mediated mutations never
weaken to watcher-burst semantics.

### High-level operations

The filesystem should provide high-level operations that express a user's
intent in one transaction rather than forcing a sequence of primitive calls.
The first additions are patch-shaped:

```ts
export type RootPrecondition = { tree: TreeRef };

export type TreePatch = {
  operations: readonly TreePatchOperation[];
};

export type Filesystem = {
  // Existing and follower methods omitted.
  applyPatch: (
    patch: TreePatch,
    precondition?: RootPrecondition,
  ) => Promise<RootSnapshot>;
};
```

`TreePatchOperation` is a tagged union for path-local create, replace, remove,
move, copy, and metadata edits. A text replacement operation may carry the
hashline line anchors and expected blob identity established by PR #162.
All preconditions validate before any mutation. The whole patch either commits
as one new root or rejects without changing the stage.

Later operations can add tree `diff`, patch composition, inversion, and
operational-transform-style rebasing. These are preferable to a generic
`beginTransaction()` capability: they are passable, auditable, validate all
authority and preconditions at one boundary, and let a backend optimize the
whole operation.

A persistent tree backend may construct only the final root for a high-level
patch. This avoids intermediate objects but does not change semantics. The
transaction is still explicitly delimited by the single `applyPatch()` call.

### Model a working commit as `GitStage`

`Git` creates a stage instead of exposing a mutable repository root directly:

```ts
export type GitCommitMetadata = {
  message?: string;
  authorName?: string;
  authorEmail?: string;
  authorTimestamp?: bigint;
};

export type GitCommitPosition = {
  commitOid: string;
  tree: TreeRef;
  root: Filesystem;
};

export type GitStage = {
  /** Mutable filesystem rooted at the tentative commit tree. */
  root: () => ERef<Filesystem>;
  getMetadata: () => Promise<GitCommitMetadata>;
  setMetadata: (patch: GitCommitMetadata) => Promise<void>;
  commit: () => Promise<GitCommitPosition>;
  abort: () => Promise<void>;
};

export type Git = {
  // Existing methods omitted.
  stage: (metadata?: GitCommitMetadata) => ERef<GitStage>;
};
```

`Git.stage()` snapshots the repository's current published root into a mutable
filesystem stage. Mutating the stage advances that filesystem's root according
to the method-call transaction rule. `setMetadata()` changes only tentative
commit metadata and does not advance the filesystem root.

`stage.commit()` is the explicit version-control transaction delimiter. It
atomically freezes the stage's current root and metadata, creates a commit, and
advances the repository's published root. If the repository has advanced since
the stage was created, commit rejects with a stale-base error unless a separate
high-level rebase or patch operation has reconciled the stage. It never silently
overwrites another writer's commit.

After commit or abort, the stage is sealed. A caller that wants another commit
creates a new stage from the newly published root. This makes commit boundaries
and tentative metadata capability-visible without exposing Git's index as a
second public filesystem root.

The native adapter may use an index internally to materialize a stage. An
in-process Git backend may write tree objects directly. Both implement the same
stage contract.

### Follow roots published by Git commits

Git offers the same explicit follower split, but its transaction is
`stage.commit()` rather than a filesystem mutator:

```ts
export type GitRootSnapshot = {
  type: 'snapshot';
  revision: bigint;
  position: GitCommitPosition | null;
};

export type GitRootTransition = {
  type: 'transition';
  fromRevision: bigint;
  toRevision: bigint;
  position: GitCommitPosition;
};

export type Git = {
  // Existing methods omitted.
  followRootChanges: (
    options?: FollowRootOptions,
  ) => ERef<PassableReader<GitRootSnapshot | GitRootTransition, undefined>>;
  followLatestRoot: (
    options?: FollowRootOptions,
  ) => ERef<PassableReader<GitRootSnapshot, undefined>>;
};
```

An unborn repository's snapshot has `position: null`; its first commit produces
a transition with a non-null position. Later commits always produce a
transition, including metadata-only commits whose `tree` equals the prior tree.
The commit OID identifies the version-control event; `TreeRef` identifies the
content. Branch name, ref name, host path, index state, and push destination are
absent.

The lossless method delivers every successful stage commit. The latest method
may coalesce commits and yields only the newest complete position. Durable
historical replay remains a Git history query, not a promise made by the live
topic.

### Ordering and concurrent writers

One filesystem stage serializes its mutating method calls and assigns revisions
in commit order. Two calls begun concurrently may complete in either order, but
their effects and publications have one total order. Each method's
preconditions evaluate at its serialization point.

One `Git` repository serializes `stage.commit()` calls. A stage remembers its
base commit. The first compatible commit advances the repository; a competing
stage based on the old commit fails stale-base validation. Callers can compute a
tree patch, apply or transform it against a fresh stage, and retry explicitly.

Distinct stages have distinct filesystem-follower sequences. The Git follower
is the shared sequence of successfully published commits.

### Cancellation, failure, and restart

A rejected `cancelled` promise and consumer `return()` both release only that
subscription. The underlying provider watcher or topic is released after its
last subscriber leaves. Cancellation does not abort a stage or revoke already
delivered immutable roots.

A failure to snapshot or read the next root terminates the affected reader with
a sticky error. Recovery uses a new follower call, whose first value is the
current snapshot. Lossless overflow is also terminal and explicit. The lossy
follower does not overflow because replacement of an undrained latest value is
its declared behavior.

Revisions and subscriptions are incarnation-local. After restart, a follower
begins with a new snapshot and consumers must not compare its revision with a
prior incarnation. `TreeRef` and Git commit OIDs remain durable according to
their algorithms and storage providers.

### Authority and attenuation

- A writable filesystem holder can mutate and follow it. Its read-only
  attenuation retains `snapshotRoot()` and both follower methods but omits or
  rejects every mutator, `applyPatch()`, and stage-construction authority.
- A `Git` holder may create a stage and follow committed roots. `Git.readOnly()`
  retains both Git followers and history queries but cannot create a mutable
  stage, commit, switch, or push.
- A `GitStage` holder has authority over only its tentative root and metadata.
  It does not gain a branch, remote, push, or ambient filesystem capability.
- A follower-only holder receives continuing read authority to future immutable
  roots. It cannot reach the mutable stage or any commit method through an
  event.
- `TreeRef`, commit OID, and tentative metadata are data, not authority.
- Cancelling a follower revokes future observation. Already delivered roots
  remain usable according to their own capability lifetime.
- Repository names, paths, metadata, and file contents remain untrusted data
  and are never interpreted outside the capability that vends them.

### Representative example

```js
import { makeCancelKit } from '@endo/cancel';
import { iterateSubscription } from '@endo/exo-pubsub';

const stage = await E(git).stage({ message: 'Update evaluator inputs' });
const filesystem = await E(stage).root();
const { cancelled, cancel } = makeCancelKit();

const roots = E(filesystem).followLatestRoot({ cancelled });
const rendering = (async () => {
  for await (const snapshot of iterateSubscription(roots)) {
    const directory = await E(snapshot.root).root();
    await renderDirectory(directory);
  }
})();

await E(filesystem).applyPatch(patch, { tree: expectedTree });
const position = await E(stage).commit();
console.log(position.commitOid);

cancel(Error('done'));
await rendering;
```

The patch is one filesystem transaction. The commit is a separate, explicit
Git transaction. Neither operation implies a push.

## Invariants

1. **Atomic method calls.** Every successful public mutator advances the stage
   root at most once; rejection exposes no partial root.
2. **Explicit commit delimiter.** Only successful `stage.commit()` advances the
   Git root follower.
3. **Immutable delivery.** Every delivered root remains unchanged after later
   mutations or commits.
4. **Portable tree identity.** Equal `TreeRef` values under one algorithm mean
   equal complete tree content.
5. **Snapshot first.** Every follower begins with a current snapshot obtained
   atomically with subscription.
6. **Lossless chain.** `followRootChanges()` delivers every later transaction
   in a chained revision order or terminates explicitly.
7. **Lossy convergence.** `followLatestRoot()` may skip intermediate revisions
   but eventually yields the newest root after publication stops.
8. **Stale-stage safety.** A stage cannot silently replace a commit published
   after its base.
9. **Backend neutrality.** Platform filesystem types mention no Git ref,
   worktree, index, host path, or polling mechanism.
10. **Authority separation.** A root event provides read authority only; a
    stage provides neither push nor ambient repository authority.

## Alternatives Considered

**Keep root following only on `Git`.** Rejected. Root identity, transactional
filesystem mutation, and latest/change topic semantics apply equally to
virtual and native filesystems. Duplicating them in exo-git would leave the
platform interface incomplete.

**Expose the Git index as the stage.** Rejected. A virtual filesystem should
not emulate a native Git administrative artifact. `GitStage` is the portable
working-commit capability; an index is one backend implementation.

**Publish after every low-level backend write.** Rejected. It exposes partial
recursive copy, patch, and stream-write states. The public method call is the
transaction boundary, regardless of backend implementation steps.

**A generic `beginTransaction()` / `commit()` on every directory.** Rejected as
the primary composition mechanism. A long-lived transaction capability is hard
to attenuate, abandon, nest, and carry over CapTP. High-level patch, diff, and
transform methods express intent and delimit one auditable call. The separate
`GitStage.commit()` exists because tentative commit metadata and repository
publication are genuinely one layer above filesystem mutation.

**Offer only the lossless follower.** Rejected. UI and indexing consumers need
bounded latest-state retention and should not fake lossiness by draining and
discarding an ever-growing lossless chain.

**Offer only the lossy follower.** Rejected. Evaluators, audit consumers, and
replication cannot silently miss transactions.

**Client-side polling or `.git` watching.** Rejected. Both lose provider
transaction boundaries and couple virtual consumers to native artifacts.

**Use only `Qid` as tree identity.** Rejected. The existing `Qid` identifies one
path with provider-specific version semantics. It does not identify the content
of a complete tree across providers.

## Acceptance Criteria

1. `@endo/platform/fs` exposes `TreeRef`, `snapshotRoot()`,
   `followRootChanges()`, and `followLatestRoot()` through authored types,
   runtime guards, read-only wrappers, and generated declarations.
2. A new empty in-memory filesystem yields an immutable empty-root snapshot
   with a stable tree reference.
3. Three mutating method calls yield three lossless chained transitions; a
   slow latest follower may yield only the third and exposes the revision jump.
4. A multi-entry `applyPatch()` yields one transition. A failed precondition or
   invalid operation yields none and changes no entry.
5. A stream-shaped file or attribute write publishes only when its writer
   closes successfully.
6. Recursive move and copy never expose an intermediate root.
7. The same conformance suite passes for in-memory and native-directory
   providers. An adapter unable to implement atomic mutation fails closed by
   withholding the transactional mutable interface.
8. A stage exposes tentative metadata and a mutable root. Root mutations do
   not advance Git's follower before `stage.commit()`.
9. One successful `stage.commit()` produces one Git root transition with both
   commit OID and tree reference. A stale competing stage rejects without
   replacing it.
10. Both Git followers preserve their declared lossless or latest semantics,
    including late subscription and metadata-only commits.
11. Read-only filesystem and Git attenuations can follow roots but cannot
    mutate, stage, commit, or push. Follower-only holders cannot recover those
    powers from events.
12. Cancellation, consumer return, overflow, source failure, and restart obey
    the terminal and fresh-snapshot rules.

## Test Plan

Shared `@endo/platform/fs` conformance tests cover:

1. empty-tree identity and immutable snapshots;
2. snapshot-before-subscribe atomicity;
3. lossless ordered writes and chain property;
4. lossy coalescing and convergence;
5. no-op calls and edit reversal;
6. stream-write close, abort, and failure;
7. atomic recursive move/copy;
8. atomic hashline-style and multi-path patches;
9. concurrent calls and precondition evaluation;
10. cancellation, return, overflow, sticky failure, and restart; and
11. read-only and follower-only attenuation.

Run the suite against in-memory, native-directory, and composed-layer fixtures.
Native tests may separately document reconciliation of foreign writes, but that
test does not substitute for capability-mediated transaction atomicity.

`@endo/exo-git` tests cover:

1. stage creation from the current commit or unborn empty root;
2. tentative metadata and mutable-root isolation;
3. multiple filesystem transactions followed by one explicit commit;
4. lossless and latest Git followers;
5. metadata-only commits with an unchanged tree reference;
6. stale competing stages and explicit patch/rebase retry;
7. commit failure and stage sealing; and
8. read-only Git and stage authority boundaries.

Contract-drift tests keep platform and exo-git authored types, runtime guards,
read-only wrappers, backend adapters, and generated code-mode declarations in
sync.

## Design Decisions

1. **Root following is a platform filesystem concern first.** exo-git reuses
   and extends the existing `@endo/platform/fs` interfaces.
2. **Tree identity is standardized.** `TreeRef` is algorithm-tagged and applies
   to a complete immutable root.
3. **Both follower semantics are required.** Changes are lossless; latest is
   intentionally lossy. Their names follow `@endo/pubsub` and
   `@endo/exo-pubsub` precedent.
4. **Every mutating method call is a transaction.** Composite and streamed
   operations publish only at the public call's successful delimiter.
5. **High-level patch methods are preferred.** Hashline-style preconditions,
   tree diff/patch, and future operational transforms do more useful work in a
   single transaction.
6. **A working commit is a stage one layer above the filesystem.** It carries
   tentative metadata and a mutable root; `stage.commit()` explicitly delimits
   repository publication.
7. **Optimization does not alter boundaries.** Avoiding intermediate persistent
   tree objects is an implementation optimization, not observable transaction
   coalescing.
8. **Git presentation and push policy stay separate.** Branches, refs, index
   layout, host paths, and remotes are absent from platform root events.

## Open Questions

None. The prior questions about tree identity, follower loss policy, mutation
boundaries, and the working-commit layer are resolved by the decisions above.

## Dependencies

| Design or PR | Relationship |
|--------|--------------|
| [platform-fs](platform-fs.md) | Existing portable filesystem vocabulary extended by this design. |
| [fs-interface-consolidation](fs-interface-consolidation.md) | Keeps authored types, runtime guards, wrappers, and generated declarations aligned. |
| [daemon-git-capability](daemon-git-capability.md) | Defines `Git`, `readOnly()`, and the backend that gains `GitStage`. |
| [daemon-git-remotes](daemon-git-remotes.md) | Owns remote and implicit-upstream policy, separate from root identity. |
| [endo-fs-from-git](endo-fs-from-git.md) | Supplies immutable filesystem views over Git trees. |
| [filesystem-watchers](filesystem-watchers.md) | Supplies node-watch and snapshot-before-stream precedent. |
| [PR #507](https://github.com/endojs/endo-but-for-bots/pull/507) | Designs lossy/latest and lossless/change topic semantics. |
| [PR #513](https://github.com/endojs/endo-but-for-bots/pull/513) | Implements both local `@endo/pubsub` topics. |
| [PR #553](https://github.com/endojs/endo-but-for-bots/pull/553) | Bridges both topic shapes over CapTP with `@endo/exo-pubsub`. |
| [PR #162](https://github.com/endojs/endo-but-for-bots/pull/162) | Provides hashline patch and optimistic-precondition precedent. |

## Phased Implementation

1. **Platform root identity and snapshots.** Add `TreeRef`,
   `snapshotRoot()`, immutable empty roots, backend hooks, wrappers, guards,
   declarations, and conformance tests.
2. **Platform transaction contract and followers.** Make public mutators atomic,
   add change/latest topics through `@endo/pubsub` and `@endo/exo-pubsub`, and
   run the suite against in-memory and native adapters.
3. **High-level patch.** Add content-preconditioned tree patches, including a
   hashline text operation, with all-or-none multi-path tests.
4. **Git stage.** Add tentative metadata, mutable stage roots, explicit commit
   and abort, stale-base validation, and native-index projection behind the
   adapter boundary.
5. **Git followers.** Publish successful stage commits through lossless and
   latest followers, synchronize exo-git declarations, and test authority,
   restart, and failure recovery.
6. **Further high-level transforms.** Add diff, patch composition, inversion,
   and operational-transform-style rebasing when concrete multi-writer
   consumers require them.

## Prompt

> Propose and land a design document that enhances exo-git so an appropriately
> authorized holder can follow the stream of tree-ref updates, specifically
> the advancing sequence of commits that replace the repository root
> commit-ref.
>
> Begin by reading the current exo-git implementation, interfaces, tests,
> existing designs, and authority model. Treat repository content as
> untrusted data. Define the use cases and precise semantics for observing
> root advancement: initial state or snapshot, ordered updates, commit/tree
> reference identity, replay or cursor behavior, late subscribers, concurrent
> writers, duplicate/coalesced updates, reorg or non-fast-forward replacement,
> cancellation, backpressure, failure and restart behavior, and whether
> observation is push-, pull-, iterator-, subscription-, or follower-shaped.
> Explain how the proposal relates to existing Endo follower/iteration
> patterns where applicable.
>
> Keep capability discipline explicit. Identify exactly which holder receives
> observation authority, prevent the observation facet from gaining mutation
> or ambient repository authority, specify what information updates disclose,
> and describe revocation or lifetime behavior. Address durable state and
> upgrade compatibility if the exo persists repository state. Give a concrete
> API sketch with passable guards/types, state transitions, invariants, and
> representative examples. Compare viable alternatives and record why the
> recommended shape best composes with exo-git.
>
> Define acceptance criteria and a testing strategy covering ordered
> multi-commit advancement, subscriber timing, concurrent/root replacement
> cases, cancellation, restart, authority attenuation, and failure recovery.
> This is a design-only job: do not implement package code.
