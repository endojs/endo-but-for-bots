//! Gap-revealing probe: the Endor Git object/reference seam on `gix`.
//!
//! This module attempts the `GitObjectDb` contract from
//! `designs/endor-git-bindings.md` against the pure-Rust `gix` stack, so the
//! maintainer can compare it side by side with the sibling libgit2 probe.
//! Where `gix` supplies a stable mechanism (filesystem object read/write, tree
//! decoding, reference compare-and-swap, both SHA-1 and SHA-256 object
//! formats), the seam is implemented for real and covered by tests. Where the
//! design's contract has no stable `gix` equivalent — most importantly the
//! **capability-selected custom object/reference backend** that libgit2 offers
//! through `git_odb_backend`/`git_refdb_backend` — the probe stops at the
//! ambiguity, records the gap in the PR body, and leaves a `// gap:` marker
//! rather than silently substituting a different contract.
//!
//! The Phase 1 blob store in [`crate::git_cas`] stays intact; this module is
//! the Phase-2/3 attempt (custom backend + Endor ref namespace + the
//! sync-to-async bridge) that the probe is asked to press on.
//!
//! Authority boundary: `gix` is depended on with `default-features = false`
//! (only `parallel`, `sha1`, `sha256` in `rust/endo/Cargo.toml`), so no
//! network transport, credential helper, checkout, or index code is linked.
//! Every method here is synchronous and repository-scoped; nothing reaches
//! ambient authority.

use std::fmt;
use std::path::{Path, PathBuf};

use crate::git_cas::{algorithm_from_gix, object_id_from_gix, GitHashAlgorithm, GitObjectId};

/// The Git object kinds the seam can read and write.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GitObjectKind {
    Blob,
    Tree,
    Commit,
    Tag,
}

impl GitObjectKind {
    fn from_gix(kind: gix::objs::Kind) -> Self {
        match kind {
            gix::objs::Kind::Blob => GitObjectKind::Blob,
            gix::objs::Kind::Tree => GitObjectKind::Tree,
            gix::objs::Kind::Commit => GitObjectKind::Commit,
            gix::objs::Kind::Tag => GitObjectKind::Tag,
        }
    }

    fn to_gix(self) -> gix::objs::Kind {
        match self {
            GitObjectKind::Blob => gix::objs::Kind::Blob,
            GitObjectKind::Tree => gix::objs::Kind::Tree,
            GitObjectKind::Commit => gix::objs::Kind::Commit,
            GitObjectKind::Tag => gix::objs::Kind::Tag,
        }
    }
}

/// A fully-read Git object, validated against its identifier at the boundary.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitObject {
    pub id: GitObjectId,
    pub kind: GitObjectKind,
    pub bytes: Vec<u8>,
}

/// The object kind a tree entry points at, derived from its file mode.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GitTreeEntryKind {
    Blob,
    Tree,
    Symlink,
    /// A gitlink: an embedded submodule commit pointer.
    Commit,
}

/// One decoded entry of a Git tree object.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitTreeEntry {
    pub name: Vec<u8>,
    pub mode: u16,
    pub kind: GitTreeEntryKind,
    pub id: GitObjectId,
}

/// A validated reference name.
///
/// Reads accept any `refs/`-rooted name; writes are restricted to the Endor
/// namespace by [`GitObjectDb::update_ref_if`].
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitRefName(String);

/// The Endor-owned writable reference namespace, per the design's
/// "Endor restricts writes to `refs/endor/`".
pub const ENDOR_REF_NAMESPACE: &str = "refs/endor/";

impl GitRefName {
    /// Validate a reference name for reading. It must be `refs/`-rooted and
    /// free of the path traversal and empty-component shapes Git rejects.
    pub fn new(name: &str) -> Result<Self, GitError> {
        if !name.starts_with("refs/")
            || name.contains("..")
            || name.contains("//")
            || name.ends_with('/')
            || name.contains(' ')
        {
            return Err(GitError::InvalidRefName(name.to_string()));
        }
        Ok(GitRefName(name.to_string()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    fn is_endor_writable(&self) -> bool {
        self.0.starts_with(ENDOR_REF_NAMESPACE)
    }
}

/// The scope of a [`GitObjectDb::verify`] pass.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum GitVerifyScope {
    /// Recompute one object's hash and confirm it matches its identifier.
    Object(GitObjectId),
}

/// The result of a verification pass.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitVerifyReport {
    pub objects_checked: usize,
    pub ok: bool,
}

/// Fail-closed errors from the Git object/reference seam.
#[derive(Debug)]
pub enum GitError {
    Backend(String),
    WrongObjectFormat {
        expected: GitHashAlgorithm,
        actual: GitHashAlgorithm,
    },
    ObjectNotFound(GitObjectId),
    ObjectIntegrityMismatch {
        expected: GitObjectId,
        actual: GitObjectId,
    },
    UnexpectedObjectKind {
        expected: GitObjectKind,
        actual: GitObjectKind,
    },
    InvalidRefName(String),
    /// A write was attempted outside the `refs/endor/` writable namespace.
    RefOutsideWritableNamespace(String),
    /// A write targeted a symbolic reference, which the seam rejects.
    SymbolicRefRejected(String),
    /// The reference's current value did not match the expected value.
    RefCompareAndSwapFailed(String),
    /// The new target object does not exist in the database.
    MissingTargetObject(GitObjectId),
}

impl fmt::Display for GitError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            GitError::Backend(message) => write!(formatter, "Git backend error: {message}"),
            GitError::WrongObjectFormat { expected, actual } => write!(
                formatter,
                "Git object format mismatch: expected {expected:?}, found {actual:?}"
            ),
            GitError::ObjectNotFound(id) => write!(formatter, "Git object not found: {id}"),
            GitError::ObjectIntegrityMismatch { expected, actual } => write!(
                formatter,
                "Git object hash mismatch: expected {expected}, found {actual}"
            ),
            GitError::UnexpectedObjectKind { expected, actual } => write!(
                formatter,
                "Git object kind mismatch: expected {expected:?}, found {actual:?}"
            ),
            GitError::InvalidRefName(name) => write!(formatter, "invalid reference name: {name}"),
            GitError::RefOutsideWritableNamespace(name) => write!(
                formatter,
                "reference {name} is outside the writable {ENDOR_REF_NAMESPACE} namespace"
            ),
            GitError::SymbolicRefRejected(name) => {
                write!(formatter, "refusing to overwrite symbolic reference {name}")
            }
            GitError::RefCompareAndSwapFailed(name) => {
                write!(formatter, "reference {name} changed under compare-and-swap")
            }
            GitError::MissingTargetObject(id) => {
                write!(formatter, "reference target object is absent: {id}")
            }
        }
    }
}

impl std::error::Error for GitError {}

fn backend_error(error: impl fmt::Display) -> GitError {
    GitError::Backend(error.to_string())
}

/// The safe Rust contract both Endor and (in the design) Minion Town use.
///
/// This is the `gix` rendering of the design's `GitObjectDb` trait. It is
/// deliberately synchronous: `gix::Repository` is not `Sync`, so callers run it
/// behind a per-repository handle and bridge to async through
/// [`BoundedBlockingGitPool`].
pub trait GitObjectDb: Send + Sync {
    fn object_exists(&self, id: &GitObjectId) -> Result<bool, GitError>;
    fn read_object(&self, id: &GitObjectId) -> Result<GitObject, GitError>;
    fn write_object(&self, kind: GitObjectKind, bytes: &[u8]) -> Result<GitObjectId, GitError>;
    fn read_tree(&self, id: &GitObjectId) -> Result<Vec<GitTreeEntry>, GitError>;
    fn resolve_ref(&self, name: &GitRefName) -> Result<Option<GitObjectId>, GitError>;
    fn update_ref_if(
        &self,
        name: &GitRefName,
        expected: Option<&GitObjectId>,
        next: &GitObjectId,
        message: &str,
    ) -> Result<(), GitError>;
    fn verify(&self, scope: GitVerifyScope) -> Result<GitVerifyReport, GitError>;
}

/// `gix`-backed local Git storage owned by Endor's state directory.
///
/// Uses `gix`'s bundled loose-object, pack, and filesystem-ref backends — the
/// "Endor filesystem adapter" of the design. This is the layer where `gix` and
/// libgit2 are genuinely comparable; the divergence is layer 3 (custom
/// backend), documented in the PR body.
pub struct GixObjectDb {
    repository: gix::ThreadSafeRepository,
    repository_path: PathBuf,
    algorithm: GitHashAlgorithm,
}

impl GixObjectDb {
    /// Open or create a bare repository below `state_path` with the requested
    /// object format. Endor's daemon store is SHA-256; SHA-1 remains openable
    /// for reading authorized legacy repositories.
    pub fn open_or_create(
        state_path: &Path,
        algorithm: GitHashAlgorithm,
    ) -> Result<Self, GitError> {
        let repository_path = state_path.join("git-odb");
        let repository = if repository_path.exists() {
            gix::ThreadSafeRepository::open(&repository_path).map_err(backend_error)?
        } else {
            let object_hash = match algorithm {
                GitHashAlgorithm::Sha1 => gix::hash::Kind::Sha1,
                GitHashAlgorithm::Sha256 => gix::hash::Kind::Sha256,
            };
            let options = gix::create::Options {
                object_hash: Some(object_hash),
                ..Default::default()
            };
            gix::ThreadSafeRepository::init(&repository_path, gix::create::Kind::Bare, options)
                .map_err(backend_error)?
        };
        let found = algorithm_from_gix(repository.to_thread_local().object_hash());
        if found != algorithm {
            return Err(GitError::WrongObjectFormat {
                expected: algorithm,
                actual: found,
            });
        }
        Ok(Self {
            repository,
            repository_path,
            algorithm,
        })
    }

    pub fn repository_path(&self) -> &Path {
        &self.repository_path
    }

    pub fn algorithm(&self) -> GitHashAlgorithm {
        self.algorithm
    }

    fn hash_kind(&self) -> gix::hash::Kind {
        match self.algorithm {
            GitHashAlgorithm::Sha1 => gix::hash::Kind::Sha1,
            GitHashAlgorithm::Sha256 => gix::hash::Kind::Sha256,
        }
    }

    fn checked_id(&self, id: &GitObjectId) -> Result<gix::ObjectId, GitError> {
        if id.algorithm() != self.algorithm {
            return Err(GitError::WrongObjectFormat {
                expected: self.algorithm,
                actual: id.algorithm(),
            });
        }
        gix::ObjectId::from_hex(id.to_hex().as_bytes()).map_err(backend_error)
    }
}

impl GitObjectDb for GixObjectDb {
    fn object_exists(&self, id: &GitObjectId) -> Result<bool, GitError> {
        let object_id = self.checked_id(id)?;
        Ok(self.repository.to_thread_local().has_object(object_id.as_ref()))
    }

    fn read_object(&self, id: &GitObjectId) -> Result<GitObject, GitError> {
        let object_id = self.checked_id(id)?;
        let repository = self.repository.to_thread_local();
        let object = repository
            .try_find_object(object_id)
            .map_err(backend_error)?
            .ok_or_else(|| GitError::ObjectNotFound(id.clone()))?;
        let actual = object_id_from_gix(
            gix::objs::compute_hash(repository.object_hash(), object.kind, &object.data)
                .map_err(backend_error)?,
        );
        if actual != *id {
            return Err(GitError::ObjectIntegrityMismatch {
                expected: id.clone(),
                actual,
            });
        }
        Ok(GitObject {
            id: id.clone(),
            kind: GitObjectKind::from_gix(object.kind),
            bytes: object.data.clone(),
        })
    }

    fn write_object(&self, kind: GitObjectKind, bytes: &[u8]) -> Result<GitObjectId, GitError> {
        use gix::objs::Write as _;
        let repository = self.repository.to_thread_local();
        let id = repository
            .objects
            .write_buf(kind.to_gix(), bytes)
            .map_err(backend_error)?;
        Ok(object_id_from_gix(id))
    }

    fn read_tree(&self, id: &GitObjectId) -> Result<Vec<GitTreeEntry>, GitError> {
        let object = self.read_object(id)?;
        if object.kind != GitObjectKind::Tree {
            return Err(GitError::UnexpectedObjectKind {
                expected: GitObjectKind::Tree,
                actual: object.kind,
            });
        }
        let tree = gix::objs::TreeRef::from_bytes(&object.bytes, self.hash_kind())
            .map_err(backend_error)?;
        let mut entries = Vec::with_capacity(tree.entries.len());
        for entry in tree.entries {
            let mode = entry.mode.value();
            let kind = match mode {
                0o40000 => GitTreeEntryKind::Tree,
                0o120000 => GitTreeEntryKind::Symlink,
                0o160000 => GitTreeEntryKind::Commit,
                _ => GitTreeEntryKind::Blob,
            };
            entries.push(GitTreeEntry {
                name: entry.filename.to_vec(),
                mode,
                kind,
                id: object_id_from_gix(entry.oid.to_owned()),
            });
        }
        Ok(entries)
    }

    fn resolve_ref(&self, name: &GitRefName) -> Result<Option<GitObjectId>, GitError> {
        let repository = self.repository.to_thread_local();
        let reference = match repository
            .try_find_reference(name.as_str())
            .map_err(backend_error)?
        {
            None => return Ok(None),
            Some(reference) => reference,
        };
        if let Some(id) = reference.try_id() {
            return Ok(Some(object_id_from_gix(id.detach())));
        }
        // Symbolic reference: follow it to a concrete object.
        let peeled = reference.into_fully_peeled_id().map_err(backend_error)?;
        Ok(Some(object_id_from_gix(peeled.detach())))
    }

    fn update_ref_if(
        &self,
        name: &GitRefName,
        expected: Option<&GitObjectId>,
        next: &GitObjectId,
        message: &str,
    ) -> Result<(), GitError> {
        use gix::refs::transaction::{Change, LogChange, PreviousValue, RefEdit, RefLog};
        use gix::refs::{FullName, Target};

        if !name.is_endor_writable() {
            return Err(GitError::RefOutsideWritableNamespace(name.as_str().to_string()));
        }
        let next_id = self.checked_id(next)?;
        // Reject a dangling target: the design forbids updating a ref to a
        // missing object.
        if !self.repository.to_thread_local().has_object(next_id.as_ref()) {
            return Err(GitError::MissingTargetObject(next.clone()));
        }

        let repository = self.repository.to_thread_local();

        // Reject overwriting a symbolic reference in the writable namespace.
        if let Some(existing) = repository
            .try_find_reference(name.as_str())
            .map_err(backend_error)?
        {
            if existing.try_id().is_none() {
                return Err(GitError::SymbolicRefRejected(name.as_str().to_string()));
            }
        }

        let previous = match expected {
            Some(expected_id) => {
                PreviousValue::MustExistAndMatch(Target::Object(self.checked_id(expected_id)?))
            }
            None => PreviousValue::MustNotExist,
        };
        let full_name = FullName::try_from(name.as_str()).map_err(backend_error)?;
        let edit = RefEdit {
            change: Change::Update {
                log: LogChange {
                    mode: RefLog::AndReference,
                    force_create_reflog: false,
                    message: message.into(),
                },
                expected: previous,
                new: Target::Object(next_id),
            },
            name: full_name,
            deref: false,
        };
        match repository.edit_reference(edit) {
            Ok(_) => Ok(()),
            Err(error) => {
                // gix reports a lock/precondition failure when the current
                // value disagrees with the expected value.
                Err(GitError::RefCompareAndSwapFailed(format!(
                    "{}: {error}",
                    name.as_str()
                )))
            }
        }
    }

    fn verify(&self, scope: GitVerifyScope) -> Result<GitVerifyReport, GitError> {
        match scope {
            GitVerifyScope::Object(id) => {
                // read_object already recomputes and checks the hash.
                self.read_object(&id)?;
                Ok(GitVerifyReport {
                    objects_checked: 1,
                    ok: true,
                })
            }
        }
    }
}

/// The design's reusable sync-to-async seam: run a synchronous
/// [`GitObjectDb`] call on a bounded blocking pool and return a future.
///
/// `gix::ThreadSafeRepository` is `Send + Sync`, so a `GixObjectDb` can be
/// shared across the pool. Boundedness is enforced by a semaphore; the design
/// requires "separate repositories run through a bounded blocking pool".
pub struct BoundedBlockingGitPool {
    permits: std::sync::Arc<tokio::sync::Semaphore>,
    max_concurrency: usize,
}

impl BoundedBlockingGitPool {
    pub fn new(max_concurrency: usize) -> Self {
        let max_concurrency = max_concurrency.max(1);
        Self {
            permits: std::sync::Arc::new(tokio::sync::Semaphore::new(max_concurrency)),
            max_concurrency,
        }
    }

    pub fn max_concurrency(&self) -> usize {
        self.max_concurrency
    }

    /// Run `operation` on a blocking thread, bounded by the pool's permits.
    pub async fn run<F, T>(&self, operation: F) -> Result<T, GitError>
    where
        F: FnOnce() -> Result<T, GitError> + Send + 'static,
        T: Send + 'static,
    {
        let permit = self
            .permits
            .clone()
            .acquire_owned()
            .await
            .map_err(|error| GitError::Backend(error.to_string()))?;
        let result = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            operation()
        })
        .await
        .map_err(|error| GitError::Backend(error.to_string()))?;
        result
    }
}

// gap: see PR body § "Gaps surfaced" — the capability-selected custom
// object/reference backend (design Architecture layer 3, `Libgit2Backend`)
// has no stable `gix` equivalent that plugs into `gix::Repository`. `gix`
// hardwires `Repository.objects` to the concrete `gix_odb::Store` and
// `Repository.refs` to the concrete `gix_ref::file::Store`; neither is a
// trait object. `gix` *does* expose object-level traits
// (`gix_object::{Find, Exists, Write}`) a custom store can implement, but
// they compose only with the low-level `gix-odb`/`gix-pack` algorithms, not
// with the high-level porcelain used above. The trait below demonstrates the
// low-level seam that *is* available, as evidence for the gap report; it is
// not wired into `GixObjectDb`.

/// The low-level object-source seam `gix` actually exposes.
///
/// A Minion-Town-style CAS/SQLite store could implement this and drive
/// `gix-odb`/`gix-pack` algorithms directly — but it cannot be installed into
/// a `gix::Repository`, so the porcelain (`GixObjectDb`) above cannot consume
/// it. See the gap report for why this blocks the shared-seam contract.
pub trait CustomGitObjectSource:
    gix::objs::Find + gix::objs::Exists + gix::objs::Write + Send + Sync
{
}

#[cfg(test)]
mod tests {
    use tempfile::TempDir;

    use super::*;

    fn commit_bytes(tree_hex: &str) -> Vec<u8> {
        // A minimal, well-formed commit object referencing a tree by hex id.
        format!(
            "tree {tree_hex}\nauthor A <a@example.com> 0 +0000\ncommitter A <a@example.com> 0 +0000\n\nprobe\n"
        )
        .into_bytes()
    }

    #[test]
    fn blob_round_trip_and_verify_sha256() {
        let state = TempDir::new().unwrap();
        let db = GixObjectDb::open_or_create(state.path(), GitHashAlgorithm::Sha256).unwrap();
        let id = db.write_object(GitObjectKind::Blob, b"probe blob").unwrap();
        assert_eq!(id.algorithm(), GitHashAlgorithm::Sha256);
        assert!(db.object_exists(&id).unwrap());
        let object = db.read_object(&id).unwrap();
        assert_eq!(object.kind, GitObjectKind::Blob);
        assert_eq!(object.bytes, b"probe blob");
        let report = db.verify(GitVerifyScope::Object(id)).unwrap();
        assert!(report.ok);
    }

    #[test]
    fn read_tree_decodes_entries() {
        let state = TempDir::new().unwrap();
        let db = GixObjectDb::open_or_create(state.path(), GitHashAlgorithm::Sha256).unwrap();
        let blob = db.write_object(GitObjectKind::Blob, b"file body").unwrap();
        // Build a tree with one blob entry named "file" via gix's tree writer.
        let mut tree = gix::objs::Tree::empty();
        tree.entries.push(gix::objs::tree::Entry {
            mode: gix::objs::tree::EntryKind::Blob.into(),
            filename: "file".into(),
            oid: gix::ObjectId::from_hex(blob.to_hex().as_bytes()).unwrap(),
        });
        let mut encoded = Vec::new();
        gix::objs::WriteTo::write_to(&tree, &mut encoded).unwrap();
        let tree_id = db.write_object(GitObjectKind::Tree, &encoded).unwrap();

        let entries = db.read_tree(&tree_id).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, b"file");
        assert_eq!(entries[0].kind, GitTreeEntryKind::Blob);
        assert_eq!(entries[0].id, blob);
    }

    #[test]
    fn ref_compare_and_swap_enforces_expected_value() {
        let state = TempDir::new().unwrap();
        let db = GixObjectDb::open_or_create(state.path(), GitHashAlgorithm::Sha256).unwrap();
        let first = db.write_object(GitObjectKind::Blob, b"first").unwrap();
        let second = db.write_object(GitObjectKind::Blob, b"second").unwrap();
        let name = GitRefName::new("refs/endor/formula/root").unwrap();

        // Create-only (expected None) succeeds once.
        db.update_ref_if(&name, None, &first, "create").unwrap();
        assert_eq!(db.resolve_ref(&name).unwrap(), Some(first.clone()));

        // A second create-only fails: the ref now exists.
        assert!(db.update_ref_if(&name, None, &second, "recreate").is_err());

        // CAS with the wrong expected value loses.
        assert!(db
            .update_ref_if(&name, Some(&second), &second, "bad-cas")
            .is_err());

        // CAS with the right expected value wins.
        db.update_ref_if(&name, Some(&first), &second, "advance")
            .unwrap();
        assert_eq!(db.resolve_ref(&name).unwrap(), Some(second));
    }

    #[test]
    fn writes_outside_endor_namespace_are_rejected() {
        let state = TempDir::new().unwrap();
        let db = GixObjectDb::open_or_create(state.path(), GitHashAlgorithm::Sha256).unwrap();
        let id = db.write_object(GitObjectKind::Blob, b"x").unwrap();
        let name = GitRefName::new("refs/heads/main").unwrap();
        assert!(matches!(
            db.update_ref_if(&name, None, &id, "nope"),
            Err(GitError::RefOutsideWritableNamespace(_))
        ));
    }

    #[test]
    fn update_to_missing_object_is_rejected() {
        let state = TempDir::new().unwrap();
        let db = GixObjectDb::open_or_create(state.path(), GitHashAlgorithm::Sha256).unwrap();
        // A syntactically valid SHA-256 id that was never written.
        let absent = GitObjectId::Sha256([0x11; 32]);
        let name = GitRefName::new("refs/endor/formula/root").unwrap();
        assert!(matches!(
            db.update_ref_if(&name, None, &absent, "dangling"),
            Err(GitError::MissingTargetObject(_))
        ));
    }

    #[test]
    fn sha1_repository_reads_legacy_objects() {
        let state = TempDir::new().unwrap();
        let db = GixObjectDb::open_or_create(state.path(), GitHashAlgorithm::Sha1).unwrap();
        let id = db.write_object(GitObjectKind::Blob, b"legacy").unwrap();
        assert_eq!(id.algorithm(), GitHashAlgorithm::Sha1);
        assert_eq!(db.read_object(&id).unwrap().bytes, b"legacy");
        let _ = commit_bytes(&id.to_hex()); // keep helper exercised
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn bounded_pool_runs_git_calls() {
        let state = TempDir::new().unwrap();
        let db = std::sync::Arc::new(
            GixObjectDb::open_or_create(state.path(), GitHashAlgorithm::Sha256).unwrap(),
        );
        let pool = BoundedBlockingGitPool::new(4);
        assert_eq!(pool.max_concurrency(), 4);
        let db_for_task = db.clone();
        let id = pool
            .run(move || db_for_task.write_object(GitObjectKind::Blob, b"async"))
            .await
            .unwrap();
        let db_for_read = db.clone();
        let object = pool
            .run(move || db_for_read.read_object(&id))
            .await
            .unwrap();
        assert_eq!(object.bytes, b"async");
    }
}
