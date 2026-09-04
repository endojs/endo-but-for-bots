//! Filesystem repository implementation through safe `git2` APIs.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use git2::{
    ErrorCode, ObjectFormat, ObjectType, Oid, ReferenceType, Repository, RepositoryInitOptions,
};

use crate::{
    backend_error, GitError, GitHashAlgorithm, GitObject, GitObjectDb, GitObjectId, GitObjectKind,
    GitRefName, GitTreeEntry, GitVerifyReport, GitVerifyScope,
};

/// A serialized safe wrapper around one bare libgit2 repository.
pub struct Libgit2Repository {
    repository: Mutex<Repository>,
    repository_path: PathBuf,
    algorithm: GitHashAlgorithm,
}

impl Libgit2Repository {
    /// Opens an existing bare repository.
    pub fn open(repository_path: &Path) -> Result<Self, GitError> {
        let repository = Repository::open_bare(repository_path).map_err(backend_error)?;
        Self::from_repository(repository_path, repository)
    }

    /// Initializes a bare repository with the selected object format.
    pub fn initialize_bare(
        repository_path: &Path,
        algorithm: GitHashAlgorithm,
    ) -> Result<Self, GitError> {
        let mut options = RepositoryInitOptions::new();
        options
            .bare(true)
            .mkdir(true)
            .mkpath(true)
            .object_format(match algorithm {
                GitHashAlgorithm::Sha1 => ObjectFormat::Sha1,
                GitHashAlgorithm::Sha256 => ObjectFormat::Sha256,
            });
        let repository = Repository::init_opts(repository_path, &options).map_err(backend_error)?;
        Self::from_repository(repository_path, repository)
    }

    /// Opens or creates Endor's daemon-owned SHA-256 repository.
    pub fn open_or_create_daemon_owned(state_path: &Path) -> Result<Self, GitError> {
        let repository_path = state_path.join("git-cas-libgit2");
        if repository_path.exists() {
            let repository = Self::open(&repository_path)?;
            if repository.algorithm != GitHashAlgorithm::Sha256 {
                return Err(GitError::WrongObjectFormat {
                    expected: GitHashAlgorithm::Sha256,
                    actual: repository.algorithm,
                });
            }
            Ok(repository)
        } else {
            Self::initialize_bare(&repository_path, GitHashAlgorithm::Sha256)
        }
    }

    /// Returns the repository's path.
    pub fn repository_path(&self) -> &Path {
        &self.repository_path
    }

    /// Returns the repository's object format.
    pub fn algorithm(&self) -> GitHashAlgorithm {
        self.algorithm
    }

    fn from_repository(repository_path: &Path, repository: Repository) -> Result<Self, GitError> {
        let algorithm = match repository.object_format() {
            ObjectFormat::Sha1 => GitHashAlgorithm::Sha1,
            ObjectFormat::Sha256 => GitHashAlgorithm::Sha256,
        };
        Ok(Self {
            repository: Mutex::new(repository),
            repository_path: repository_path.to_owned(),
            algorithm,
        })
    }

    fn lock(&self) -> Result<MutexGuard<'_, Repository>, GitError> {
        self.repository
            .lock()
            .map_err(|_| GitError::Backend("repository mutex was poisoned".to_owned()))
    }

    fn checked_oid(&self, id: &GitObjectId) -> Result<Oid, GitError> {
        if id.algorithm() != self.algorithm {
            return Err(GitError::WrongObjectFormat {
                expected: self.algorithm,
                actual: id.algorithm(),
            });
        }
        Oid::from_bytes(id.as_bytes()).map_err(backend_error)
    }
}

impl GitObjectDb for Libgit2Repository {
    fn object_exists(&self, id: &GitObjectId) -> Result<bool, GitError> {
        let oid = self.checked_oid(id)?;
        let repository = self.lock()?;
        let object_database = repository.odb().map_err(backend_error)?;
        Ok(object_database.exists(oid))
    }

    fn read_object(&self, id: &GitObjectId) -> Result<GitObject, GitError> {
        let oid = self.checked_oid(id)?;
        let repository = self.lock()?;
        let object_database = repository.odb().map_err(backend_error)?;
        let object = object_database.read(oid).map_err(|error| {
            if error.code() == ErrorCode::NotFound {
                GitError::ObjectNotFound(*id)
            } else {
                backend_error(error)
            }
        })?;
        Ok(GitObject {
            id: object_id_from_oid(object.id()),
            kind: object_kind_from_git2(object.kind())?,
            bytes: object.data().to_vec(),
        })
    }

    fn write_object(&self, kind: GitObjectKind, bytes: &[u8]) -> Result<GitObjectId, GitError> {
        let repository = self.lock()?;
        let object_database = repository.odb().map_err(backend_error)?;
        object_database
            .write(object_kind_to_git2(kind), bytes)
            .map(object_id_from_oid)
            .map_err(backend_error)
    }

    fn read_tree(&self, id: &GitObjectId) -> Result<Vec<GitTreeEntry>, GitError> {
        let oid = self.checked_oid(id)?;
        let repository = self.lock()?;
        let tree = repository.find_tree(oid).map_err(backend_error)?;
        Ok(tree
            .iter()
            .map(|entry| GitTreeEntry {
                name: entry.name_bytes().to_vec(),
                file_mode: entry.filemode(),
                id: object_id_from_oid(entry.id()),
            })
            .collect())
    }

    fn resolve_ref(&self, name: &GitRefName) -> Result<Option<GitObjectId>, GitError> {
        let repository = self.lock()?;
        let result = match repository.find_reference(name.as_str()) {
            Ok(reference) if reference.kind() == Some(ReferenceType::Symbolic) => Err(
                GitError::SymbolicReferenceRejected(name.as_str().to_owned()),
            ),
            Ok(reference) => Ok(reference.target().map(object_id_from_oid)),
            Err(error) if error.code() == ErrorCode::NotFound => Ok(None),
            Err(error) => Err(backend_error(error)),
        };
        result
    }

    fn update_ref_if(
        &self,
        name: &GitRefName,
        expected: Option<&GitObjectId>,
        next: &GitObjectId,
        message: &str,
    ) -> Result<(), GitError> {
        let next_oid = self.checked_oid(next)?;
        let expected_oid = expected.map(|id| self.checked_oid(id)).transpose()?;
        let repository = self.lock()?;
        if !repository.odb().map_err(backend_error)?.exists(next_oid) {
            return Err(GitError::ObjectNotFound(*next));
        }

        let mut transaction = repository.transaction().map_err(backend_error)?;
        let mut attempts = 0;
        loop {
            match transaction.lock_ref(name.as_str()) {
                Ok(()) => break,
                Err(error) if error.code() == ErrorCode::Locked && attempts < 1000 => {
                    attempts += 1;
                    std::thread::sleep(Duration::from_millis(1));
                }
                Err(error) => return Err(backend_error(error)),
            }
        }
        let actual = match repository.find_reference(name.as_str()) {
            Ok(reference) if reference.kind() == Some(ReferenceType::Symbolic) => {
                return Err(GitError::SymbolicReferenceRejected(
                    name.as_str().to_owned(),
                ));
            }
            Ok(reference) => reference.target(),
            Err(error) if error.code() == ErrorCode::NotFound => None,
            Err(error) => return Err(backend_error(error)),
        };
        if actual != expected_oid {
            return Err(GitError::ReferenceCompareMismatch {
                expected: expected.copied(),
                actual: actual.map(object_id_from_oid),
            });
        }
        transaction
            .set_target(name.as_str(), next_oid, None, message)
            .map_err(backend_error)?;
        transaction.commit().map_err(backend_error)
    }

    fn verify(&self, _scope: GitVerifyScope) -> Result<GitVerifyReport, GitError> {
        let repository = self.lock()?;
        let object_database = repository.odb().map_err(backend_error)?;
        let mut identifiers = Vec::new();
        object_database
            .foreach(|identifier| {
                identifiers.push(*identifier);
                true
            })
            .map_err(backend_error)?;
        for identifier in &identifiers {
            object_database.read(*identifier).map_err(backend_error)?;
        }
        Ok(GitVerifyReport {
            objects_checked: identifiers.len(),
        })
    }
}

fn object_kind_to_git2(kind: GitObjectKind) -> ObjectType {
    match kind {
        GitObjectKind::Blob => ObjectType::Blob,
        GitObjectKind::Tree => ObjectType::Tree,
        GitObjectKind::Commit => ObjectType::Commit,
        GitObjectKind::Tag => ObjectType::Tag,
    }
}

fn object_kind_from_git2(kind: ObjectType) -> Result<GitObjectKind, GitError> {
    match kind {
        ObjectType::Blob => Ok(GitObjectKind::Blob),
        ObjectType::Tree => Ok(GitObjectKind::Tree),
        ObjectType::Commit => Ok(GitObjectKind::Commit),
        ObjectType::Tag => Ok(GitObjectKind::Tag),
        _ => Err(GitError::Backend("unsupported Git object type".to_owned())),
    }
}

fn object_id_from_oid(id: Oid) -> GitObjectId {
    match id.object_format() {
        ObjectFormat::Sha1 => GitObjectId::Sha1(id.as_bytes().try_into().expect("SHA-1 length")),
        ObjectFormat::Sha256 => {
            GitObjectId::Sha256(id.as_bytes().try_into().expect("SHA-256 length"))
        }
    }
}

#[cfg(test)]
mod tests {
    use std::io::Write;
    use std::process::{Command, Stdio};
    use std::sync::{Arc, Barrier};

    use tempfile::TempDir;

    use super::Libgit2Repository;
    use crate::{
        GitError, GitHashAlgorithm, GitObjectDb, GitObjectKind, GitRefName, GitVerifyScope,
    };

    fn exercise_object_format(algorithm: GitHashAlgorithm) {
        let temporary_directory = TempDir::new().unwrap();
        let repository =
            Libgit2Repository::initialize_bare(temporary_directory.path(), algorithm).unwrap();
        let id = repository
            .write_object(GitObjectKind::Blob, b"libgit2 Endor probe")
            .unwrap();
        assert_eq!(id.algorithm(), algorithm);
        assert!(repository.object_exists(&id).unwrap());
        assert_eq!(
            repository.read_object(&id).unwrap().bytes,
            b"libgit2 Endor probe"
        );
        assert_eq!(
            repository
                .verify(GitVerifyScope::AllObjects)
                .unwrap()
                .objects_checked,
            1
        );
    }

    #[test]
    fn sha1_round_trip() {
        exercise_object_format(GitHashAlgorithm::Sha1);
    }

    #[test]
    fn sha256_round_trip() {
        exercise_object_format(GitHashAlgorithm::Sha256);
    }

    #[test]
    fn git_oracle_matches_both_object_formats() {
        for algorithm in [GitHashAlgorithm::Sha1, GitHashAlgorithm::Sha256] {
            let temporary_directory = TempDir::new().unwrap();
            let repository =
                Libgit2Repository::initialize_bare(temporary_directory.path(), algorithm).unwrap();
            let bytes = b"ordinary Git is only a test oracle";
            let id = repository.write_object(GitObjectKind::Blob, bytes).unwrap();
            let mut git = Command::new("git")
                .args([
                    "-C",
                    temporary_directory.path().to_str().unwrap(),
                    "hash-object",
                    "--stdin",
                ])
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .spawn()
                .unwrap();
            git.stdin.take().unwrap().write_all(bytes).unwrap();
            let output = git.wait_with_output().unwrap();
            assert!(output.status.success());
            assert_eq!(
                id.to_string(),
                String::from_utf8(output.stdout).unwrap().trim()
            );
        }
    }

    #[test]
    fn parses_tree_entries() {
        let temporary_directory = TempDir::new().unwrap();
        let repository = Libgit2Repository::initialize_bare(
            temporary_directory.path(),
            GitHashAlgorithm::Sha256,
        )
        .unwrap();
        let blob = repository
            .write_object(GitObjectKind::Blob, b"tree member")
            .unwrap();
        let mut tree_bytes = b"100644 member.txt\0".to_vec();
        tree_bytes.extend_from_slice(blob.as_bytes());
        let tree = repository
            .write_object(GitObjectKind::Tree, &tree_bytes)
            .unwrap();
        let entries = repository.read_tree(&tree).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, b"member.txt");
        assert_eq!(entries[0].id, blob);
    }

    #[test]
    fn rejects_cross_format_identifier() {
        let temporary_directory = TempDir::new().unwrap();
        let repository = Libgit2Repository::initialize_bare(
            temporary_directory.path(),
            GitHashAlgorithm::Sha256,
        )
        .unwrap();
        let error = repository
            .object_exists(&crate::GitObjectId::Sha1([0; 20]))
            .unwrap_err();
        assert!(matches!(error, GitError::WrongObjectFormat { .. }));
    }

    #[test]
    fn reference_compare_and_swap_has_one_winner() {
        let temporary_directory = TempDir::new().unwrap();
        let first_repository = Arc::new(
            Libgit2Repository::initialize_bare(
                temporary_directory.path(),
                GitHashAlgorithm::Sha256,
            )
            .unwrap(),
        );
        let second_repository =
            Arc::new(Libgit2Repository::open(temporary_directory.path()).unwrap());
        let first = first_repository
            .write_object(GitObjectKind::Blob, b"first")
            .unwrap();
        let second = first_repository
            .write_object(GitObjectKind::Blob, b"second")
            .unwrap();
        let name = GitRefName::new("refs/endor/root").unwrap();
        let barrier = Arc::new(Barrier::new(3));
        let mut threads = Vec::new();
        for (repository, next) in [(first_repository, first), (second_repository, second)] {
            let name = name.clone();
            let barrier = Arc::clone(&barrier);
            threads.push(std::thread::spawn(move || {
                barrier.wait();
                repository.update_ref_if(&name, None, &next, "race")
            }));
        }
        barrier.wait();
        let results: Vec<_> = threads
            .into_iter()
            .map(|thread| thread.join().unwrap())
            .collect();
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(
            results
                .iter()
                .filter(|result| matches!(result, Err(GitError::ReferenceCompareMismatch { .. })))
                .count(),
            1
        );
    }
}
