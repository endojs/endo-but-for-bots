//! Daemon-private Git object storage.
//!
//! This module deliberately exposes no transport, checkout, index, or guest
//! capability surface.  Its first phase is a validating blob store rooted in
//! the Endo state directory.  `gix` is the only runtime backend.

use std::fmt;
use std::path::{Path, PathBuf};

/// The hash algorithm carried by a Git object identifier.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GitHashAlgorithm {
    Sha1,
    Sha256,
}

/// A Git object identifier together with its hash algorithm.
///
/// The bytes are kept in binary form so callers cannot accidentally compare
/// SHA-1 and SHA-256 hexadecimal strings as equivalent values.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum GitObjectId {
    Sha1([u8; 20]),
    Sha256([u8; 32]),
}

impl GitObjectId {
    /// Returns the object format that produced this identifier.
    pub fn algorithm(&self) -> GitHashAlgorithm {
        match self {
            GitObjectId::Sha1(_) => GitHashAlgorithm::Sha1,
            GitObjectId::Sha256(_) => GitHashAlgorithm::Sha256,
        }
    }

    /// Returns this identifier's hexadecimal display form.
    pub fn to_hex(&self) -> String {
        match self {
            GitObjectId::Sha1(bytes) => hex::encode(bytes),
            GitObjectId::Sha256(bytes) => hex::encode(bytes),
        }
    }
}

impl fmt::Display for GitObjectId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.to_hex().fmt(formatter)
    }
}

/// A validated Git blob returned from the local object database.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitBlob {
    pub id: GitObjectId,
    pub bytes: Vec<u8>,
}

/// Fail-closed errors from the daemon-private Git object database.
#[derive(Debug)]
pub enum GitCasError {
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
    UnexpectedObjectKind,
}

impl fmt::Display for GitCasError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            GitCasError::Backend(message) => {
                write!(formatter, "Git object database error: {message}")
            }
            GitCasError::WrongObjectFormat { expected, actual } => {
                write!(
                    formatter,
                    "Git object format mismatch: expected {expected:?}, found {actual:?}"
                )
            }
            GitCasError::ObjectNotFound(id) => write!(formatter, "Git object not found: {id}"),
            GitCasError::ObjectIntegrityMismatch { expected, actual } => {
                write!(
                    formatter,
                    "Git object hash mismatch: expected {expected}, found {actual}"
                )
            }
            GitCasError::UnexpectedObjectKind => write!(formatter, "Git object is not a blob"),
        }
    }
}

impl std::error::Error for GitCasError {}

/// The Phase 1 Git CAS boundary.
///
/// This validates repository object format and object identity at every
/// boundary.  Refs and tree materialization are deliberately deferred until a
/// durable Endor root consumer exists.
pub trait GitCas: Send + Sync {
    fn object_exists(&self, id: &GitObjectId) -> Result<bool, GitCasError>;
    fn read_blob(&self, id: &GitObjectId) -> Result<GitBlob, GitCasError>;
    fn write_blob(&self, bytes: &[u8]) -> Result<GitObjectId, GitCasError>;
}

/// `gix`-backed local Git storage owned by Endor's state directory.
pub struct GixGitCas {
    repository: gix::ThreadSafeRepository,
    repository_path: PathBuf,
    algorithm: GitHashAlgorithm,
}

impl GixGitCas {
    /// Open or create Endor's SHA-256 bare repository below `state_path`.
    pub fn open_or_create_daemon_owned(state_path: &Path) -> Result<Self, GitCasError> {
        let repository_path = state_path.join("git-cas");
        let repository = if repository_path.exists() {
            gix::ThreadSafeRepository::open(&repository_path).map_err(backend_error)?
        } else {
            let options = gix::create::Options {
                object_hash: Some(gix::hash::Kind::Sha256),
                ..Default::default()
            };
            gix::ThreadSafeRepository::init(&repository_path, gix::create::Kind::Bare, options)
                .map_err(backend_error)?
        };
        let algorithm = algorithm_from_gix(repository.to_thread_local().object_hash());
        if algorithm != GitHashAlgorithm::Sha256 {
            return Err(GitCasError::WrongObjectFormat {
                expected: GitHashAlgorithm::Sha256,
                actual: algorithm,
            });
        }
        Ok(Self {
            repository,
            repository_path,
            algorithm,
        })
    }

    /// Returns the bare repository path inside Endor state storage.
    pub fn repository_path(&self) -> &Path {
        &self.repository_path
    }

    fn checked_id(&self, id: &GitObjectId) -> Result<gix::ObjectId, GitCasError> {
        if id.algorithm() != self.algorithm {
            return Err(GitCasError::WrongObjectFormat {
                expected: self.algorithm,
                actual: id.algorithm(),
            });
        }
        gix::ObjectId::from_hex(id.to_hex().as_bytes()).map_err(backend_error)
    }
}

impl GitCas for GixGitCas {
    fn object_exists(&self, id: &GitObjectId) -> Result<bool, GitCasError> {
        let id = self.checked_id(id)?;
        let repository = self.repository.to_thread_local();
        Ok(repository.has_object(id.as_ref()))
    }

    fn read_blob(&self, id: &GitObjectId) -> Result<GitBlob, GitCasError> {
        let object_id = self.checked_id(id)?;
        let repository = self.repository.to_thread_local();
        let object = repository
            .try_find_object(object_id)
            .map_err(backend_error)?
            .ok_or_else(|| GitCasError::ObjectNotFound(id.clone()))?;
        let actual_id = object_id_from_gix(
            gix::objs::compute_hash(repository.object_hash(), object.kind, &object.data)
                .map_err(backend_error)?,
        );
        if actual_id != *id {
            return Err(GitCasError::ObjectIntegrityMismatch {
                expected: id.clone(),
                actual: actual_id,
            });
        }
        if object.kind != gix::objs::Kind::Blob {
            return Err(GitCasError::UnexpectedObjectKind);
        }
        Ok(GitBlob {
            id: id.clone(),
            bytes: object.data.clone(),
        })
    }

    fn write_blob(&self, bytes: &[u8]) -> Result<GitObjectId, GitCasError> {
        let repository = self.repository.to_thread_local();
        let id = repository.write_blob(bytes).map_err(backend_error)?;
        Ok(object_id_from_gix(id.detach()))
    }
}

fn backend_error(error: impl std::error::Error) -> GitCasError {
    GitCasError::Backend(error.to_string())
}

pub(crate) fn algorithm_from_gix(kind: gix::hash::Kind) -> GitHashAlgorithm {
    match kind {
        gix::hash::Kind::Sha1 => GitHashAlgorithm::Sha1,
        gix::hash::Kind::Sha256 => GitHashAlgorithm::Sha256,
        _ => unreachable!("gix returned an unsupported object format"),
    }
}

pub(crate) fn object_id_from_gix(id: gix::ObjectId) -> GitObjectId {
    match id.kind() {
        gix::hash::Kind::Sha1 => {
            GitObjectId::Sha1(id.as_bytes().try_into().expect("SHA-1 object ID length"))
        }
        gix::hash::Kind::Sha256 => {
            GitObjectId::Sha256(id.as_bytes().try_into().expect("SHA-256 object ID length"))
        }
        _ => unreachable!("gix returned an unsupported object format"),
    }
}

#[cfg(test)]
mod tests {
    use std::io::Write;
    use std::process::{Command, Stdio};

    use tempfile::TempDir;

    use super::{GitCas, GitHashAlgorithm, GitObjectId, GixGitCas};

    #[test]
    fn object_round_trip_uses_sha256_daemon_storage() {
        let state_directory = TempDir::new().unwrap();
        let cas = GixGitCas::open_or_create_daemon_owned(state_directory.path()).unwrap();
        let id = cas.write_blob(b"Endor Git CAS").unwrap();

        assert_eq!(id.algorithm(), GitHashAlgorithm::Sha256);
        assert_eq!(
            cas.repository_path(),
            state_directory.path().join("git-cas")
        );
        assert!(cas.object_exists(&id).unwrap());
        assert_eq!(cas.read_blob(&id).unwrap().bytes, b"Endor Git CAS");
        assert_eq!(cas.write_blob(b"Endor Git CAS").unwrap(), id);
    }

    #[test]
    fn git_cross_validation_matches_sha256_object_identity() {
        let state_directory = TempDir::new().unwrap();
        let cas = GixGitCas::open_or_create_daemon_owned(state_directory.path()).unwrap();
        let bytes = b"Git is a test-only interoperability oracle.";

        let mut git = Command::new("git")
            .args([
                "-C",
                cas.repository_path().to_str().unwrap(),
                "hash-object",
                "-w",
                "--stdin",
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .expect("ordinary Git is required only by this cross-validation test");
        git.stdin.take().unwrap().write_all(bytes).unwrap();
        let output = git.wait_with_output().unwrap();
        assert!(output.status.success());
        let id_hex = String::from_utf8(output.stdout).unwrap();
        let id = GitObjectId::Sha256(
            hex::decode(id_hex.trim())
                .unwrap()
                .try_into()
                .expect("SHA-256 object ID length"),
        );
        assert_eq!(cas.read_blob(&id).unwrap().bytes, bytes);
    }
}
