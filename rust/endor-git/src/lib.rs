//! A narrow, local-only Git storage seam for Endor.
//!
//! The crate deliberately exposes no transport, checkout, index, hook, shell,
//! credential-helper, or interactive-authentication authority. The filesystem
//! implementation uses the safe `git2` API. [`custom_odb`] is the only module
//! that crosses the libgit2 FFI boundary.

use std::fmt;

pub mod blocking;
pub mod custom_odb;
pub mod filesystem;

pub use blocking::BoundedGitExecutor;
pub use custom_odb::{CustomObjectStorage, InMemoryObjectStorage, Libgit2CustomOdb};
pub use filesystem::Libgit2Repository;

/// The object format of a Git repository.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GitHashAlgorithm {
    /// The 160-bit object format used by conventional Git repositories.
    Sha1,
    /// The experimental 256-bit Git object format.
    Sha256,
}

/// An algorithm-tagged, fixed-width Git object identifier.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum GitObjectId {
    /// A SHA-1 object identifier.
    Sha1([u8; 20]),
    /// A SHA-256 object identifier.
    Sha256([u8; 32]),
}

impl GitObjectId {
    /// Returns the identifier's object format.
    pub fn algorithm(&self) -> GitHashAlgorithm {
        match self {
            Self::Sha1(_) => GitHashAlgorithm::Sha1,
            Self::Sha256(_) => GitHashAlgorithm::Sha256,
        }
    }

    /// Returns the identifier bytes.
    pub fn as_bytes(&self) -> &[u8] {
        match self {
            Self::Sha1(bytes) => bytes,
            Self::Sha256(bytes) => bytes,
        }
    }
}

impl fmt::Display for GitObjectId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        for byte in self.as_bytes() {
            write!(formatter, "{byte:02x}")?;
        }
        Ok(())
    }
}

/// A Git object type supported by the common storage seam.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GitObjectKind {
    /// Blob contents.
    Blob,
    /// Tree contents.
    Tree,
    /// Commit contents.
    Commit,
    /// Annotated-tag contents.
    Tag,
}

/// A validated Git object.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitObject {
    /// The object's identifier.
    pub id: GitObjectId,
    /// The object's Git type.
    pub kind: GitObjectKind,
    /// The canonical, uncompressed object bytes.
    pub bytes: Vec<u8>,
}

/// One entry in a parsed Git tree.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitTreeEntry {
    /// The raw file-name bytes recorded in the tree.
    pub name: Vec<u8>,
    /// The entry's Git file mode.
    pub file_mode: i32,
    /// The object named by the entry.
    pub id: GitObjectId,
}

/// A validated writable reference name.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitRefName(String);

impl GitRefName {
    /// Validates an Endor-owned reference name.
    pub fn new(name: impl Into<String>) -> Result<Self, GitError> {
        let name = name.into();
        if !name.starts_with("refs/endor/") || !git2::Reference::is_valid_name(&name) {
            return Err(GitError::InvalidReferenceName(name));
        }
        Ok(Self(name))
    }

    /// Returns the validated reference name.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// The requested verification depth.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GitVerifyScope {
    /// Verify every object visible to the object database.
    AllObjects,
}

/// Results from a repository verification pass.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct GitVerifyReport {
    /// Number of objects successfully read through libgit2.
    pub objects_checked: usize,
}

/// Fail-closed errors from the local Git storage boundary.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum GitError {
    /// libgit2 or its safe Rust wrapper rejected an operation.
    Backend(String),
    /// An object identifier does not match the repository format.
    WrongObjectFormat {
        /// Format required by the repository.
        expected: GitHashAlgorithm,
        /// Format carried by the object identifier.
        actual: GitHashAlgorithm,
    },
    /// The requested object does not exist.
    ObjectNotFound(GitObjectId),
    /// A reference did not contain the expected value.
    ReferenceCompareMismatch {
        /// Value required by the caller.
        expected: Option<GitObjectId>,
        /// Value observed while the reference was locked.
        actual: Option<GitObjectId>,
    },
    /// The writable namespace contains a symbolic reference.
    SymbolicReferenceRejected(String),
    /// A reference name is invalid or outside `refs/endor/`.
    InvalidReferenceName(String),
    /// The bounded blocking task could not be completed.
    BlockingTask(String),
}

impl fmt::Display for GitError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Backend(message) => write!(formatter, "Git backend error: {message}"),
            Self::WrongObjectFormat { expected, actual } => write!(
                formatter,
                "Git object format mismatch: expected {expected:?}, found {actual:?}"
            ),
            Self::ObjectNotFound(id) => write!(formatter, "Git object not found: {id}"),
            Self::ReferenceCompareMismatch { expected, actual } => write!(
                formatter,
                "Git reference compare-and-swap mismatch: expected {expected:?}, found {actual:?}"
            ),
            Self::SymbolicReferenceRejected(name) => {
                write!(formatter, "symbolic reference rejected: {name}")
            }
            Self::InvalidReferenceName(name) => write!(formatter, "invalid Endor ref name: {name}"),
            Self::BlockingTask(message) => write!(formatter, "blocking Git task failed: {message}"),
        }
    }
}

impl std::error::Error for GitError {}

/// The safe synchronous contract shared by filesystem and custom storage.
pub trait GitObjectDb: Send + Sync {
    /// Reports whether an object is present.
    fn object_exists(&self, id: &GitObjectId) -> Result<bool, GitError>;
    /// Reads and validates an object.
    fn read_object(&self, id: &GitObjectId) -> Result<GitObject, GitError>;
    /// Writes an object and returns its Git identifier.
    fn write_object(&self, kind: GitObjectKind, bytes: &[u8]) -> Result<GitObjectId, GitError>;
    /// Parses a tree object.
    fn read_tree(&self, id: &GitObjectId) -> Result<Vec<GitTreeEntry>, GitError>;
    /// Resolves a direct reference.
    fn resolve_ref(&self, name: &GitRefName) -> Result<Option<GitObjectId>, GitError>;
    /// Atomically updates a direct reference when its current value matches.
    fn update_ref_if(
        &self,
        name: &GitRefName,
        expected: Option<&GitObjectId>,
        next: &GitObjectId,
        message: &str,
    ) -> Result<(), GitError>;
    /// Verifies all objects in the requested scope.
    fn verify(&self, scope: GitVerifyScope) -> Result<GitVerifyReport, GitError>;
}

pub(crate) fn backend_error(error: impl fmt::Display) -> GitError {
    GitError::Backend(error.to_string())
}
