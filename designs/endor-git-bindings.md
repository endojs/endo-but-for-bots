# Endor In-Process Git Bindings for Content Storage

| | |
|---|---|
| **Created** | 2026-07-15 |
| **Author** | Kris Kowal (prompted) |
| **Status** | Proposed |

## Motivation

`endor` must be a releasable standalone binary, not a Rust wrapper that requires a separately installed `git` executable for daemon storage.
The Node reference implementation can use native Git subprocesses for its local Git capability, but the Rust daemon needs an in-process object database when it uses Git as a content-addressed store.

The existing `ContentStore` in `rust/endo/src/cas.rs` remains the daemon's SHA-256 blob and tree store.
Git is an additional object database with Git object identity, ref reachability, and interoperable on-disk layout.
The two identifiers are never interchangeable: Git hashes a framed object and may use SHA-1 or SHA-256, while Endor hashes its stored bytes with SHA-256.

This design derives from [Git on Endor Rust](https://github.com/kriskowal/garden/issues/46) and its [dispatch request](https://github.com/kriskowal/garden/issues/46#issuecomment-4981804044).

## Scope

This design adds a daemon-private `GitCas` boundary for local Git object and ref operations.
It does not replace the public `Git` capability, grant shell or network authority, implement checkout or index mutation, or turn an Endor CAS tree into a Git worktree.
Those concerns remain respectively in [daemon-git-capability](daemon-git-capability.md), [daemon-git-remotes](daemon-git-remotes.md), and the mount designs.

The first target is a local repository owned by the Endor state directory or an already-authorized repository opened by trusted daemon code.
The baseline build neither fetches nor pushes.

## `GitCas` Boundary

`GitCas` is a Rust-internal trait in `rust/endo/src/git_cas.rs`, behind a repository policy established when the daemon opens it.
It is not an envelope verb and is never handed to a guest.
The policy fixes the repository location and allowed write-ref namespace, initially `refs/endor/`; it prevents this storage layer from silently updating `refs/heads/`, tags, remotes, hooks, or configuration.

```rust
pub trait GitCas: Send + Sync {
    fn object_exists(&self, oid: GitObjectId) -> Result<bool, GitCasError>;
    fn read_object(&self, oid: GitObjectId) -> Result<GitObject, GitCasError>;
    fn write_object(
        &self,
        kind: GitObjectKind,
        bytes: &[u8],
    ) -> Result<GitObjectId, GitCasError>;
    fn read_tree(&self, oid: GitObjectId) -> Result<Vec<GitTreeEntry>, GitCasError>;
    fn resolve_ref(&self, name: GitRefName) -> Result<Option<GitObjectId>, GitCasError>;
    fn update_ref_if(
        &self,
        name: GitRefName,
        expected: Option<GitObjectId>,
        next: GitObjectId,
        message: &str,
    ) -> Result<(), GitCasError>;
    fn verify(&self, scope: GitVerifyScope) -> Result<GitVerifyReport, GitCasError>;
}
```

`GitObjectId` carries its object-format algorithm and hex bytes, so a SHA-1 object cannot be confused with a SHA-256 object.
`write_object` accepts bytes and an object kind, computes the Git object ID itself, and never trusts a caller-supplied digest.
`read_object` validates the type and object hash before returning data.
`read_tree` returns normalized tree entries with mode, name, kind, and object ID; it rejects malformed names before an adapter turns entries into an Endor tree.

`update_ref_if` is the only mutating ref operation.
It is compare-and-swap: `expected: None` creates an absent ref, an expected ID must match the current direct ref, and a mismatch returns `GitCasError::Conflict` with no update.
Symbolic refs, reflog policy, commit construction, pack import/export, and worktree/index operations are deliberately outside this first boundary.
The caller writes immutable objects first, then advances an allowed ref to make a root reachable.

An adapter outside the trait, `GitTreeToContentStore`, materializes a selected immutable Git tree into the existing `ContentStore` when a daemon subsystem needs Endor's `TreeManifest` vocabulary.
It records source Git object IDs as provenance, not as Endor hash aliases.
The reverse conversion, commit creation, and a pack-transfer API wait for demonstrated consumers.

## Recommended Backend and Evaluation Path

Use [`git2`](https://crates.io/crates/git2), the Rust bindings for libgit2, for the near-term `Libgit2GitCas` implementation.
It covers local object-database access, tree traversal, object writes, ref compare-and-swap, locking, and integrity checking through one mature Git implementation, without executing `git`.
The first Cargo profile is intentionally local-only:

```toml
git2 = { version = "0.21", default-features = false, features = ["vendored-libgit2"] }
```

The `vendored-libgit2` feature makes the Git implementation part of the release build rather than a runtime dependency on a host libgit2 installation.
Pin the resolved libgit2 source through `Cargo.lock`, record its version in `endor --version --verbose`, and update it through the normal security-review process.
The release profile initially supports SHA-1 repositories only; a SHA-256-repository experiment must opt in to `git2/unstable-sha256` and cannot graduate until its dedicated interoperability and recovery cases pass on every release target.

Evaluate [`gix`](https://crates.io/crates/gix) as the strategic alternative after the first implementation passes the validation matrix.
`gix` offers a Rust-native implementation and granular feature selection, which may reduce the native-library and cross-compile burden, but it must first prove the exact local object, ref transaction, packed-object, SHA-256-repository, and corruption-recovery behavior that `GitCas` needs.
Do not ship two production backends or add an abstraction larger than `GitCas` merely to run that evaluation.

The rejected baseline is subprocess Git: it preserves exact Git behavior but fails the standalone-binary requirement, makes runtime behavior depend on host PATH and Git version, and repeats the Node reference implementation's process boundary.
Direct libgit2 FFI adds no value over `git2`, and a new Git implementation is not justified while `gix` is the viable strategic experiment.

## Features, Transports, and Distribution

The baseline artifact supports local loose and packed SHA-1 objects, refs, and reflogs accepted by the pinned libgit2 build.
It does not enable `git2`'s `https`, `ssh`, or `vendored-openssl` features.
That keeps network and credential code out of the daemon-content-storage binary profile and preserves the [daemon-git-remotes](daemon-git-remotes.md) authority split.

If a later authorized remote design needs HTTPS, it must use a separately named Cargo feature that enables `git2/https` and `git2/vendored-openssl` and has release tests for certificate validation, proxy policy, and disabled interactive credentials.
SSH is a separate decision because host-key verification, agent forwarding, and key custody need an explicit capability design; it is not enabled as a side effect of HTTPS.
Neither feature may fall back to a system `git`, system libgit2, or an interactive credential helper.

"Standalone" means the release artifact contains the required Git implementation and has no runtime dependency on `git` or a dynamically discovered libgit2.
It does not promise one fully static executable on every target: platform C runtimes and operating-system frameworks remain platform concerns.
Release jobs must publish the target triple, linked-library inventory, enabled Git features, libgit2 revision, and license notices, and reject an unexpected libgit2, OpenSSL, libcurl, or libssh2 dynamic dependency in the local-only artifact.

## Storage, Refs, Concurrency, and Corruption

Objects are immutable and deduplicate naturally by Git object ID.
`write_object` is idempotent and can safely race with another writer that stores identical bytes.
Libgit2's object and ref lockfile protocol provides interoperability with normal Git readers and writers; Endor additionally serializes `update_ref_if` per repository in-process so one daemon can return a deterministic conflict rather than relying on timing.
An external writer can still race Endor, so ref-update failure is a normal conflict that callers may re-read and retry deliberately.

Every durable Endor Git root is an allowed direct ref under `refs/endor/`.
Unreachable Git objects are not retained by Endor's `.meta` ref counts and are collected only by a Git-aware maintenance operation after verification; `ContentStore.gc()` never scans or deletes Git objects.
Conversely, a Git-backed materialization that produces an Endor `TreeManifest` retains that Endor root through the existing formula or retain/release path.
This separates Git reachability from Endor CAS liveness and prevents either collector from corrupting the other store.

At open, Endor checks repository discovery, object format, directory ownership and permissions, and the allowed ref namespace.
Each object read verifies identity and kind before use.
Failure to parse a tree, a missing promised object, a hash mismatch, or an invalid ref is fail-closed: the operation returns a structured corruption error, quarantines the affected repository for writes, and records the object or ref name without logging content bytes or credentials.
`endor git-cas verify --full` runs the backend's full object/ref verification and is the only operation that can clear the quarantine after it succeeds.
Recovery is restore from a known-good clone or backup, followed by a new verification pass; automatic object repair and destructive pruning are out of scope.

## Migration and Interoperability

The initial implementation adds `GitCas` beside `ContentStore`; it does not rewrite `store-sha256/`, existing formulas, or the Node daemon's Git repositories.
Existing Node `NativeGitBackend` subprocess behavior continues unchanged.
The Rust daemon opens ordinary Git repositories, so repositories created by Endor remain readable by Git tooling and vice versa, subject to concurrent ref conflicts.

Migration is lazy and per root:

1. Open or create the daemon-owned Git repository and verify it.
2. On a Git-tree consumer, read the selected Git root and materialize it into the existing Endor content store only when that consumer requires an Endor tree.
3. Persist the Git object ID as provenance with the Endor root, then retain the Endor root through the current lifetime mechanism.
4. Keep old SHA-256 roots readable until existing retention and GC release them naturally.

No background whole-store import occurs, and no conversion claims byte-for-byte identifier equality across the two stores.
The later public `Git` capability may choose `GitCas` for its in-process immutable-tree backend only after it demonstrates the same observable tree behavior as the current native implementation.

## Phased Delivery

1. Add `GitObjectId`, validated ref names, `GitCas`, and `Libgit2GitCas` with the local-only vendored profile.
2. Add the tree-to-`ContentStore` adapter and provenance record, without changing public daemon verbs.
3. Add quarantine, verification command, cross-process conflict coverage, and release linkage checks.
4. Run the `gix` spike against the same test corpus. Adopt it only if it meets every required case and reduces a measured distribution or maintenance cost.
5. Design a separate HTTPS and then SSH transport feature only when [daemon-git-remotes](daemon-git-remotes.md) authorizes the corresponding credential and policy surface.

## Executable Validation Matrix

| Scenario | Fixture and command | Required observation |
|---|---|---|
| Standalone local artifact | `cargo build --release -p endo`; platform linkage inspection (`ldd`, `otool -L`, or `dumpbin /dependents`) | No runtime `git` or libgit2 dependency; local-only profile has no unexpected TLS, curl, or SSH dependency. |
| Object identity | `cargo test -p endo git_cas::object_round_trip`; repeat under the experimental SHA-256 feature | Blob and tree IDs match Git's object framing; duplicate writes return one ID; SHA-1 and SHA-256 IDs cannot compare equal. |
| Packed repository interoperability | `cargo test -p endo git_cas::packed_objects` after `git gc` creates fixture packs | Objects and trees written by regular Git remain readable in-process without invoking Git at runtime. |
| Ref compare-and-swap | `cargo test -p endo git_cas::ref_compare_and_swap` | Exactly one concurrent expected-old update succeeds; the other reports `Conflict`; no ref is torn. |
| External writer race | integration fixture runs Endor and Git tooling against one repo | Endor reports a conflict and leaves an externally updated ref intact. |
| Content-store bridge | `cargo test -p endo git_cas::materialize_tree` | Materialized Endor tree has the expected bytes and Git provenance, while its SHA-256 root differs from the Git tree ID. |
| Corruption handling | mutate a loose object, ref, and tree entry in isolated fixtures; run `endor git-cas verify --full` | Read and verify fail closed, writes quarantine, and a verified restored repository clears quarantine. |
| Unsupported transport | build and run the local-only artifact against an HTTPS URL | It returns a structured unsupported-transport error without spawning `git`, prompting, or contacting a credential helper. |
| Strategic parity | run the preceding corpus once with `Libgit2GitCas` and once with the `gix` spike | A candidate is eligible only with identical required outcomes and a documented binary-size, build-time, and maintenance comparison. |

## Open Questions

1. Should daemon-owned repositories use SHA-1 for maximum interoperability, SHA-256 for new repositories, or select the format per repository at creation time?
2. Which Endor subsystem first needs a durable `refs/endor/` root: archive imports, formula snapshots, or Git-tree materialization?
3. Does the pinned libgit2 version provide a sufficient full verification API on every release target, or should `endor git-cas verify --full` initially include a read-only bundled verifier?
4. What artifact-size and cross-compilation improvement would justify replacing the mature libgit2 backend with `gix` after parity is proven?
5. What backup, ownership, and repository-location policy is appropriate for a daemon-owned Git object database on shared-user machines?

## Dependencies

| Design | Relationship |
|---|---|
| [daemon-endor-architecture](daemon-endor-architecture.md) | Places the in-process storage boundary in the Rust supervisor. |
| [daemon-cas-management](daemon-cas-management.md) | Existing SHA-256 `ContentStore` remains the daemon content API and lifetime owner. |
| [daemon-git-capability](daemon-git-capability.md) | Future consumer of the in-process immutable-tree backend; public Git authority stays separate. |
| [daemon-git-remotes](daemon-git-remotes.md) | Owns future network, credential, and transport authority. |
| [daemon-make-archive](daemon-make-archive.md) | A potential Git-tree materialization consumer, not a new archive wire format. |

## Prompt

> I would like Endor to be a stand-alone binary. Where it is sufficient for the reference implementation in Node.js to shell out to git for daemon content-address-storage, Endor should have Git bindings that run in the same process. What are our options for binding Git to Rust?
