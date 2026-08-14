# Endor In-Process Git Bindings

| | |
|---|---|
| **Created** | 2026-07-15 |
| **Updated** | 2026-08-14 |
| **Author** | Kris Kowal (prompted) |
| **Status** | Proposed |

## Revision context

The original version selected pure-Rust `gix` and rejected libgit2 after the
2026-07-26 review of
[PR 740](https://github.com/endojs/endo-but-for-bots/pull/740).
The newer
[Minion Town review](https://github.com/kriscendobot/minion.town/pull/41#discussion_r3785717342)
reopens that decision and asks Endor to lead with Rust bindings to libgit2,
provided that Zig can make the C dependency cross-compilable for Windows,
macOS, and Linux.
This revision supersedes the earlier `gix`-only decision and makes the
cross-build matrix an executable gate rather than an assumption.

The companion
[Minion Town Git remote design](https://github.com/kriscendobot/minion.town/blob/609fdd5251a0297ce15355acc8d902f973c99a18/designs/git-remote-capability.md#5--research--how-much-of-gits-wire-protocol-and-the-prior-art)
section 5 is the server-half and pluggable-object-database prior art for this
design.
Its review comment is also the source of the requirement that the two projects
share an implementation seam and build experience.

## Goals and scope

Endor needs in-process Git object and reference operations without executing a
host `git` program.
The binding must:

- expose a narrow, synchronous Rust interface over libgit2;
- support both Endor's daemon-owned repository and Minion Town's CAS and SQLite
  adapters;
- build one statically linked libgit2 copy from pinned source as part of Cargo;
- cross-compile release artifacts for supported Windows, macOS, and Linux
  targets with Zig as the C compiler and linker; and
- provide shared fixtures and conformance tests so a fix learned in either
  project applies to both.

The baseline is local Git storage.
It does not grant network, shell, checkout, index, hook, credential-helper, or
interactive authentication authority.
HTTPS and SSH client transports remain owned by
[daemon-git-remotes](daemon-git-remotes.md).
Serving Git smart HTTP is required by Minion Town, but is a separate layer over
the same storage boundary because libgit2 does not provide a ready-made
`upload-pack` or `receive-pack` HTTP server.

## Architecture

The reusable code lives in a new Rust crate, `rust/endor-git`, in this
repository.
Endor depends on it by workspace path.
Minion Town initially pins this repository and commit as a Cargo Git dependency;
it may switch to a published crate after the interface stabilizes.
The crate has no dependency on either daemon's database schema.

```mermaid
flowchart LR
    E["Endor daemon"] --> EC["Endor filesystem adapter"]
    M["Minion Town smart-HTTP service"] --> MC["Minion CAS + SQLite adapter"]
    EC --> C["endor-git safe Rust contract"]
    MC --> C
    C --> F["small audited FFI module"]
    F --> L["pinned static libgit2"]
    T["shared fixtures + conformance suite"] --> EC
    T --> MC
```

`endor-git` has three layers:

1. `GitStore` is the safe Rust contract used by both applications.
2. `Libgit2Repository` implements ordinary on-disk repositories through the
   safe [`git2`](https://docs.rs/git2) crate.
3. `Libgit2Backend` installs custom object and reference databases through
   [`libgit2-sys`](https://docs.rs/libgit2-sys) for Minion Town and any later
   Endor database-backed store.

Only layer 3 contains `unsafe` code.
No raw libgit2 pointer crosses its module boundary.

## Safe Rust contract

```rust
pub trait GitStore: Send + Sync {
    fn object_exists(&self, oid: &GitObjectId) -> Result<bool, GitError>;
    fn read_object(&self, oid: &GitObjectId) -> Result<GitObject, GitError>;
    fn write_object(
        &self,
        kind: GitObjectKind,
        bytes: &[u8],
    ) -> Result<GitObjectId, GitError>;
    fn read_tree(&self, oid: &GitObjectId) -> Result<Vec<GitTreeEntry>, GitError>;
    fn resolve_ref(&self, name: &GitRefName)
        -> Result<Option<GitObjectId>, GitError>;
    fn update_ref_if(
        &self,
        name: &GitRefName,
        expected: Option<&GitObjectId>,
        next: &GitObjectId,
        message: &str,
    ) -> Result<(), GitError>;
    fn verify(&self, scope: GitVerifyScope)
        -> Result<GitVerifyReport, GitError>;
}
```

`GitObjectId` carries the repository object format and fixed-width bytes.
The daemon never treats a Git object ID as an Endor `ContentStore` identifier.
Daemon-owned repositories continue to use Git's SHA-256 object format, while
authorized SHA-1 repositories remain readable.
Because libgit2 and `git2` still label SHA-256 support experimental, the Cargo
feature `unstable-sha256` and its ABI are pinned together and the SHA-256 tests
are release gates.

`update_ref_if` is the only mutating ref operation.
It rejects symbolic refs in the writable namespace, a missing target object,
an object-format mismatch, and an unexpected current value.
Endor restricts writes to `refs/endor/`.
Minion Town scopes the same operation by partition before it reaches the
backend.

The C callbacks are synchronous, so adapter methods are synchronous too.
`git2::Repository` is not `Sync`, so `Libgit2Repository` serializes access to
each repository behind a mutex while allowing separate repositories to proceed
in parallel.
An async web server calls them from a bounded blocking pool.
No Rust panic may unwind through C: every callback catches panics, stores a
sanitized Rust error in request-local state, and returns a libgit2 error code.
The FFI module owns callback allocation, pointer lifetime, shutdown ordering,
and conversion of libgit2 errors to `GitError`.

## Storage adapters

### Endor filesystem adapter

Endor opens a bare repository below the Endo state directory and uses
libgit2's bundled loose-object, pack, and filesystem-ref backends.
The repository inherits the state directory's permissions, backup policy, and
single-daemon ownership.
The existing `ContentStore` remains separate.
A `GitTreeToContentStore` adapter may materialize an immutable Git tree when a
formula consumer needs Endor's `TreeManifest` vocabulary, recording the Git ID
as provenance rather than as an alias.

### Minion Town CAS and SQLite adapter

Minion Town supplies custom `git_odb_backend` and `git_refdb_backend`
implementations, following its design's pluggable-ODB strategy.
Git object bytes go to its CAS; SQLite maps
`(partition, object-format, git-oid)` to the CAS blob and stores partitioned
refs.
Ref compare-and-swap is one SQLite transaction.
The adapter validates the partition capability before opening a repository, so
libgit2 never receives ambient access to another partition.

The custom ODB implements the whole subset exercised by the shared suite:
object reads, headers, existence and prefix checks, enumeration, streaming
writes, and pack ingestion.
Unsupported callbacks return a named error rather than silently falling back to
the filesystem.
Received packs are bounded, checksummed, indexed, and committed to the CAS
before any ref transaction can publish them.

## Smart HTTP and the shared seam

libgit2 supplies object traversal, pack construction and ingestion, ODB and
refdb extension points, and client transports.
Its transport extension points describe how libgit2 acts as a client; they are
not an HTTP server implementation.
The Minion Town service therefore owns Git protocol v2 request parsing,
capability advertisement, fetch negotiation, and receive-pack status framing.
It delegates object walks, pack production and ingestion, and atomic ref
updates to `endor-git`.

The shared boundary is deliberately below HTTP:

- Endor owns `GitStore`, the libgit2 wrapper, backend callback safety, object
  validation, and the golden fixture corpus.
- Minion Town owns capability-URL authentication, HTTP routing, request limits,
  partition selection, and projection of a pushed tip into a weblet manifest.
- Protocol transcripts and packs from Minion Town become fixtures in
  `rust/endor-git/tests/fixtures/`.
- Every `endor-git` change runs both the filesystem backend suite and a generic
  in-memory backend suite. Minion Town runs the same suite against its CAS and
  SQLite adapter at its pinned Endo commit.

This arrangement transfers lessons in both directions without coupling Endor
to Minion Town's web framework or database schema.
A bug fixed in pack validation, ref transactions, object-format handling, or
FFI ownership lands in `endor-git`; Minion Town advances its pinned commit and
reruns the shared transcripts.
A Minion-only authentication or HTTP framing bug stays in Minion Town.

## Vendoring and Zig cross-compilation

Cargo pins `git2`, `libgit2-sys`, and their checksums in `Cargo.lock`.
The `vendored-libgit2` feature makes `libgit2-sys` compile the libgit2 source
included in its crate package and statically link it into `endor`.
The local-storage profile disables `https` and `ssh`, uses the bundled parser
and hashing code selected by `libgit2-sys`, and must not discover a system
libgit2 through `pkg-config`.

```toml
git2 = {
  version = "=<reviewed release>",
  default-features = false,
  features = ["vendored-libgit2", "unstable-sha256"],
}
```

`libgit2-sys` builds the vendored C sources with Rust's `cc` crate rather than
invoking libgit2's CMake project.
The release wrapper uses `cargo zigbuild` for targets it supports.
For other targets it provides checked-in target-specific compiler, archiver,
and linker wrappers over `zig cc` and `zig ar`; the Windows lane starts with
this explicit wrapper because `cargo-zigbuild` does not currently claim Windows
target support.
The builder records the exact Rust toolchain, Zig version, Cargo package
checksums, target triple, target CPU baseline, and macOS SDK identity.

| Release family | Initial target | Build lane | Native gate |
|---|---|---|---|
| Linux glibc | `x86_64-unknown-linux-gnu` and `aarch64-unknown-linux-gnu` | `cargo zigbuild`; explicit oldest supported glibc version | Run tests in containers at that glibc floor and on both architectures |
| Linux static | `x86_64-unknown-linux-musl` and `aarch64-unknown-linux-musl` | `cargo zigbuild`; no assumption that static glibc works | Run the artifact in empty musl containers |
| Windows | `x86_64-pc-windows-gnu` initially | Cargo target config plus checked-in `zig cc`/`zig ar` wrappers for Zig's MinGW-compatible target | Run tests on Windows; add MSVC artifacts only from a native MSVC lane |
| macOS | `x86_64-apple-darwin` and `aarch64-apple-darwin` | Zig with an explicitly provisioned, pinned macOS SDK; combine only after both slices pass | Run on Intel and Apple Silicon, then sign and notarize on macOS |

Zig does not remove every platform dependency.
Darwin linking still needs a legally provisioned SDK and final Apple signing.
Windows MSVC artifacts still need the MSVC toolchain if the project elects to
ship them.
Every cross-built artifact therefore runs on its native operating system before
release.

## Verification gates

| Gate | Required observation |
|---|---|
| Binding safety | Miri or sanitizer-backed callback tests cover ownership, callback panic conversion, concurrent access, and shutdown; no sanitizer finding is accepted. |
| Object formats | SHA-1 fixtures are readable; daemon-created SHA-256 objects and refs round-trip and match ordinary Git's object IDs. |
| ODB parity | Loose and packed objects, prefix lookups, streaming writes, and corrupted objects have identical results across filesystem and test backends. |
| Ref atomicity | Exactly one of two updates with the same expected old ID succeeds; external-writer races preserve the winning ref. |
| Smart HTTP corpus | Stock Git can clone, fetch, and push through Minion Town's service; captured protocol-v2 transcripts replay against the shared store contract. |
| Cross-build | Every matrix target builds from the canonical build host with the pinned Zig toolchain and no target C compiler installed. |
| Native execution | Each artifact runs the same object, pack, ref, corruption, and protocol corpus on its target operating system and architecture. |
| Link audit | `ldd`, `otool -L`, or `dumpbin /dependents` shows no dynamic libgit2, OpenSSL, libssh2, or unexpected zlib dependency. |
| Reproducibility | Two clean builds with the same pinned inputs produce matching normalized artifacts; any signing envelope is compared separately. |

Ordinary Git remains a test oracle only.
The released Endor and Minion Town artifacts neither spawn `git` nor discover a
system Git library at runtime.

## Phased delivery

1. Add `endor-git` with the safe contract, pinned `git2`/`libgit2-sys`, the
   filesystem backend, SHA-1 and SHA-256 object tests, and linkage audit.
2. Add the custom-backend FFI module and a generic in-memory conformance backend.
   Exercise every required ODB/refdb callback and fault path.
3. Add Endor's state-directory repository and tree-to-`ContentStore` adapter.
   Formula snapshots remain the first durable `refs/endor/` consumer, followed
   by archive imports and Git-tree materialization.
4. Add the Zig release wrapper and run the cross-build plus native-execution
   matrix before declaring any target supported.
5. In Minion Town, depend on the reviewed Endo commit, implement the CAS/SQLite
   adapter and smart-HTTP server, and contribute its protocol corpus back to
   `endor-git`.

## Alternatives considered

- **Pure-Rust `gix`.** This avoids the C toolchain, but no longer follows the
  2026-08-14 direction to align Endor and Minion Town around libgit2's ODB/refdb
  seams. Keep it as a benchmark and emergency redesign option, not a second
  production backend.
- **System libgit2.** Rejected because it makes behavior and ABI depend on the
  host and defeats the standalone artifact.
- **Prebuilt libgit2 archives.** Rejected for the first implementation because
  source builds give Cargo one auditable dependency graph. Reconsider only if a
  target cannot build reliably with Zig.
- **Subprocess Git.** Retained only as a test oracle. Runtime use violates the
  standalone and least-authority requirements.
- **A shared HTTP service binary.** Rejected because it would force Endor to
  carry Minion Town's authentication and deployment concerns. Share the storage
  crate and transcripts instead.

## Dependencies

| Design | Relationship |
|---|---|
| [daemon-endor-architecture](daemon-endor-architecture.md) | Places the in-process binding in the Rust supervisor. |
| [daemon-cas-management](daemon-cas-management.md) | Keeps Endor `ContentStore` identity and lifetime separate from Git object identity. |
| [daemon-git-capability](daemon-git-capability.md) | Public Git authority may consume this backend without exposing it directly. |
| [daemon-git-remotes](daemon-git-remotes.md) | Owns outbound transport and credential authority. |
| [Minion Town Git remote, section 5](https://github.com/kriscendobot/minion.town/blob/609fdd5251a0297ce15355acc8d902f973c99a18/designs/git-remote-capability.md#5--research--how-much-of-gits-wire-protocol-and-the-prior-art) | Supplies pluggable-ODB and server-half prior art; consumes the shared Rust crate and fixtures. |
| [Review comment that requested this revision](https://github.com/kriscendobot/minion.town/pull/41#discussion_r3785717342) | Requires libgit2, Zig cross-compilation, and shared experience between the two projects. |

## Open questions

- **Windows ABI target after the first release?** Is the GNU ABI sufficient for
  the standalone binary, or must release engineering add native MSVC artifacts?
- **Supported glibc floor?** The release owner must choose and test an explicit
  minimum before the GNU/Linux artifacts are public.
- **Shared crate publication?** Should Minion Town keep a commit-pinned Cargo Git
  dependency, or should `endor-git` be published after its API stabilizes?

## Prompt

> Elaborate the Endor Git bindings design: binding libgit2 from Rust; the
> cross-compilation story (Zig cc to build/cross-link libgit2's C dependency
> across Windows/macOS/Linux); and how it stays in sync with the Minion Town
> git-client-to-daemon web server so experience transfers both ways. Back
> reference Minion Town's `designs/git-remote-capability.md` section 5 and the
> originating review comment.
