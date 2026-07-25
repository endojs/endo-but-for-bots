# Endor In-Process Git Bindings for Content Storage

| | |
|---|---|
| **Created** | 2026-07-15 |
| **Revised** | 2026-07-25 (cross-compilation requirement; pure-Rust backend recommended) |
| **Author** | Kris Kowal (prompted) |
| **Status** | Proposed |

## Motivation

`endor` must be a releasable standalone binary, not a Rust wrapper that requires a separately installed `git` executable for daemon storage.
The Node reference implementation can use native Git subprocesses for its local Git capability, but the Rust daemon needs an in-process object database when it uses Git as a content-addressed store.

`endor` must also **cross-compile** to other platforms and architectures from a small set of build hosts (maintainer requirement, PR review 2026-07-25).
A C library dependency resists this: compiling vendored C source for a foreign target requires a per-target C cross toolchain (and, for some targets, a platform SDK), which multiplies release-engineering cost by the size of the target matrix.
This requirement re-weights the backend choice below toward a pure-Rust Git implementation and demotes the libgit2 bindings to a contingency whose cross-compilation options are spelled out rather than assumed.

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

`GitObjectId` carries its object-format algorithm and fixed-width object-ID bytes (with hexadecimal only as its display form), so a SHA-1 object cannot be confused with a SHA-256 object.
Every input ID must use the repository's configured object format.
`write_object` accepts bytes and an object kind, computes the Git object ID itself, and never trusts a caller-supplied digest.
Before it stores a tree, it parses the tree encoding and rejects malformed entry names, modes, object IDs, and ordering; callers that construct trees use a typed encoder rather than hand-assembling tree bytes.
`read_object` validates the type and object hash before returning data.
`read_tree` returns normalized tree entries with mode, name, kind, and object ID; it rejects malformed names before an adapter turns entries into an Endor tree.

`update_ref_if` is the only mutating ref operation.
It is compare-and-swap: `expected: None` creates an absent ref, an expected ID must match the current direct ref, and a mismatch returns `GitCasError::Conflict` with no update.
The implementation rejects a symbolic ref in the allowed namespace, and verifies that `next` names an existing, hash-valid object before it writes a direct ref, so this boundary cannot publish a dangling or format-mismatched root.
Symbolic refs, caller-selected reflog policy, commit construction, pack import/export, and worktree/index operations are deliberately outside this first boundary.
The caller writes immutable objects first, then advances an allowed ref to make a root reachable.

An adapter outside the trait, `GitTreeToContentStore`, materializes a selected immutable Git tree into the existing `ContentStore` when a daemon subsystem needs Endor's `TreeManifest` vocabulary.
It records source Git object IDs as provenance, not as Endor hash aliases.
The reverse conversion, commit creation, and a pack-transfer API wait for demonstrated consumers.

## Recommended Backend and Evaluation Path

Use [`gix`](https://crates.io/crates/gix), the pure-Rust Git implementation from the gitoxide project, for the near-term `GixGitCas` implementation.
It covers local object-database access (loose and packed), tree traversal, object writes, and ref transactions with an expected-previous-value check (the compare-and-swap `update_ref_if` needs), without executing `git` and without any C dependency in the profile below.
Cross-compiling a pure-Rust dependency graph needs only `rustup target add <triple>` and a linker for the target — no per-target C cross toolchain, no platform C library builds — which is what the cross-compilation requirement demands.
The first Cargo profile is intentionally local-only and pure-Rust:

```toml
gix = { version = "<pinned via Cargo.lock at implementation time>", default-features = false, features = ["max-pure"] }
```

`max-pure` is gitoxide's no-C-dependency profile (pure-Rust DEFLATE and hashing, no zlib-ng, no OpenSSL); the implementation trims it further to the local object, ref, and validation feature set — the local-only artifact enables no transport feature at all.
Pin the resolved `gix` crate graph through `Cargo.lock`, record its version in `endor --version --verbose`, and update it through the normal security-review process.
The release profile initially supports SHA-1 repositories only; SHA-256-repository support is immature in every candidate backend (gitoxide's is in progress; libgit2's is `unstable-sha256`), so a SHA-256-repository experiment stays opt-in and cannot graduate until its dedicated interoperability and recovery cases pass on every release target.
`gix` must prove the exact local object, ref transaction, packed-object, and corruption-recovery behavior that `GitCas` needs by passing the full validation matrix before Phase 2 builds on it; the matrix is the gate, not the crate's reputation.

### Contingency: libgit2 bindings and their cross-compilation options

If `gix` fails a required validation case, fall back to [`git2`](https://crates.io/crates/git2) (the libgit2 bindings) behind the same `GitCas` trait, and pay one of the following cross-compilation costs — documented here so the fallback is a measured decision, not a scramble:

1. **Vendored source, per-target C cross toolchain.** `git2` with `default-features = false, features = ["vendored-libgit2"]` compiles the libgit2 C source pinned inside the `libgit2-sys` crate at build time. Cross builds then need a C toolchain per target: `cross` (containerized prebaked toolchains), `cargo-zigbuild` (Zig as a portable C cross-compiler and linker), or native CI runners per OS. Deterministic (the C source is pinned by the crate and `Cargo.lock`), but every new target adds toolchain and SDK maintenance — the cost the primary recommendation avoids.
2. **Prebuilt static libgit2 artifacts, pinned by version and hash.** Build a static libgit2 per target once, publish the artifacts, and have the build script download each by pinned version and verify its SHA-256 before linking. This moves the C-toolchain cost out of the per-build loop but makes Endo the custodian of per-target binary artifacts: we must cross-build them ourselves anyway (relocating, not removing, the toolchain problem), attest their provenance and reproducibility, carry their license notices, and keep an offline/vendored fallback so release builds do not depend on a live download.
3. **System or dynamic libgit2 per target** — rejected outright: runtime library discovery and version skew violate the standalone-binary requirement.

Do not ship two production backends or add an abstraction larger than `GitCas` to hedge between them; the contingency activates only on a demonstrated `gix` failure recorded against the validation matrix.

The rejected baseline remains subprocess Git: it preserves exact Git behavior but fails the standalone-binary requirement, makes runtime behavior depend on host PATH and Git version, and repeats the Node reference implementation's process boundary.
Direct libgit2 FFI adds no value over `git2`, and a new in-house Git implementation is not justified while `gix` is viable.

## Features, Transports, and Distribution

The baseline artifact supports local loose and packed SHA-1 objects, refs, and reflogs accepted by the pinned `gix` build.
It enables no `gix` transport, HTTP, or credential feature.
That keeps network and credential code out of the daemon-content-storage binary profile and preserves the [daemon-git-remotes](daemon-git-remotes.md) authority split.

If a later authorized remote design needs HTTPS, it must use a separately named Cargo feature that enables the corresponding `gix` transport features over a pure-Rust TLS stack (rustls), preserving the no-C-toolchain cross-compilation property, and has release tests for certificate validation, proxy policy, and disabled interactive credentials.
SSH is a separate decision because host-key verification, agent forwarding, and key custody need an explicit capability design; it is not enabled as a side effect of HTTPS.
Neither feature may fall back to a system `git`, a system Git library, or an interactive credential helper.

"Standalone" means the release artifact contains the required Git implementation and has no runtime dependency on `git` or a dynamically discovered Git library.
It does not promise one fully static executable on every target: platform C runtimes and operating-system frameworks remain platform concerns.
Release jobs must publish the target triple, linked-library inventory, enabled Git features, the pinned `gix` (or contingency libgit2) revision, and license notices, and reject an unexpected libgit2, zlib, OpenSSL, libcurl, or libssh2 dynamic dependency in the local-only artifact.
Release jobs must also demonstrate the cross-compilation property: every release target builds from the canonical build hosts with `cargo build --target <triple>` and the target linker alone — no target-specific C cross toolchain in the pure-Rust profile.

## Storage, Refs, Concurrency, and Corruption

Objects are immutable and deduplicate naturally by Git object ID.
`write_object` is idempotent and can safely race with another writer that stores identical bytes.
`gix` speaks Git's on-disk object and ref lockfile protocol, which provides interoperability with normal Git readers and writers; Endor additionally serializes `update_ref_if` per repository in-process so one daemon can return a deterministic conflict rather than relying on timing.
An external writer can still race Endor, so ref-update failure is a normal conflict that callers may re-read and retry deliberately.

Every durable Endor Git root is an allowed direct ref under `refs/endor/`.
Unreachable Git objects are not retained by Endor's `.meta` ref counts and are collected only by a Git-aware maintenance operation after verification; `ContentStore.gc()` never scans or deletes Git objects.
Conversely, a Git-backed materialization that produces an Endor `TreeManifest` retains that Endor root through the existing formula or retain/release path.
This separates Git reachability from Endor CAS liveness and prevents either collector from corrupting the other store.

At open, Endor checks repository discovery, object format, directory ownership and permissions, and the allowed ref namespace.
Each object read verifies identity and kind before use.
Failure to parse a tree, a missing promised object, a hash mismatch, or an invalid ref is fail-closed: the operation returns a structured corruption error, quarantines the affected repository for writes, and records the object or ref name without logging content bytes or credentials.
`endor git-cas verify --full` enumerates every object available through the object database, reads and re-hashes it, parses every tree, and validates every ref in the allowed namespace; it is the only operation that can clear the quarantine after it succeeds.
This is a `GitCas` contract, not a promise of any backend's `fsck` wrapper: `GixGitCas` implements it using the object-database enumeration and the same validating read path, and a contingency `Libgit2GitCas` must do the equivalent work.
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

1. Add `GitObjectId`, validated ref names, `GitCas`, and `GixGitCas` with the local-only pure-Rust profile, gated by the validation matrix.
2. Add the tree-to-`ContentStore` adapter and provenance record, without changing public daemon verbs.
3. Add quarantine, verification command, cross-process conflict coverage, release linkage checks, and the cross-compilation release check (every release target from the canonical build hosts).
4. Contingency only: if a required matrix case fails in `gix`, implement `Libgit2GitCas` behind the same trait using one of the documented cross-compilation options, record the failing case and the measured toolchain cost, and re-run the full matrix.
5. Design a separate HTTPS and then SSH transport feature only when [daemon-git-remotes](daemon-git-remotes.md) authorizes the corresponding credential and policy surface.

## Executable Validation Matrix

| Scenario | Fixture and command | Required observation |
|---|---|---|
| Standalone local artifact | `cargo build --release -p endo`; platform linkage inspection (`ldd`, `otool -L`, or `dumpbin /dependents`) | No runtime `git` or Git-library dependency; local-only profile has no unexpected zlib, TLS, curl, or SSH dependency. |
| Cross-compiled artifacts | `cargo build --release --target <triple>` for every release target from the canonical build hosts, then the same linkage inspection per artifact | Every target builds with `rustup target add` plus the target linker only — no per-target C cross toolchain in the pure-Rust profile; each artifact passes the standalone inspection. |
| Object identity | `cargo test -p endo git_cas::object_round_trip`; repeat under the experimental SHA-256 feature | Blob and tree IDs match Git's object framing; duplicate writes return one ID; SHA-1 and SHA-256 IDs cannot compare equal. |
| Packed repository interoperability | `cargo test -p endo git_cas::packed_objects` after `git gc` creates fixture packs | Objects and trees written by regular Git remain readable in-process without invoking Git at runtime. |
| Ref compare-and-swap | `cargo test -p endo git_cas::ref_compare_and_swap` | Exactly one concurrent expected-old update succeeds; the other reports `Conflict`; no ref is torn. Dangling targets, wrong-format IDs, and symbolic refs under `refs/endor/` are rejected. |
| External writer race | integration fixture runs Endor and Git tooling against one repo | Endor reports a conflict and leaves an externally updated ref intact. |
| Content-store bridge | `cargo test -p endo git_cas::materialize_tree` | Materialized Endor tree has the expected bytes and Git provenance, while its SHA-256 root differs from the Git tree ID. |
| Corruption handling | mutate loose and packed-object fixtures, a ref, and a tree entry in isolated fixtures; run `endor git-cas verify --full` | Read and full verification fail closed, writes quarantine, and only a verified restored repository clears quarantine. |
| Unsupported transport | build and run the local-only artifact against an HTTPS URL | It returns a structured unsupported-transport error without spawning `git`, prompting, or contacting a credential helper. |
| Contingency parity | only on a demonstrated `gix` failure: run the preceding corpus with the contingency `Libgit2GitCas` | The contingency is eligible only with identical required outcomes and a documented binary-size, build-time, cross-toolchain, and maintenance comparison against the failing `gix` result. |

## Open Questions

1. Should daemon-owned repositories use SHA-1 for maximum interoperability, SHA-256 for new repositories, or select the format per repository at creation time?
2. Which Endor subsystem first needs a durable `refs/endor/` root: archive imports, formula snapshots, or Git-tree materialization?
3. Does the pinned `gix` version provide sufficient object-database enumeration and validating reads for `endor git-cas verify --full` on every release target, or should the verifier initially bundle its own read-only pass?
4. Which release-target set is canonical for the cross-compilation check (Linux glibc/musl on x86-64 and aarch64, macOS on aarch64, Windows), and which build hosts produce it?
5. If the `gix` contingency triggers, which libgit2 cross-compilation option (per-target toolchain vs pinned prebuilt artifacts) does the release pipeline adopt, and who custodies the artifacts?
6. What backup, ownership, and repository-location policy is appropriate for a daemon-owned Git object database on shared-user machines?

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
