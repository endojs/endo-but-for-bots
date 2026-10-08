//! Content-addressed snapshot blobs with power-loss-durable publication.
//!
//! The XS/CAS backend (designs/ironhorse-panic.md § Open Questions, "Which
//! worker backend") keeps each worker heap snapshot as an immutable,
//! SHA-256-named blob. Writing one durably takes four ordered steps, each a
//! counted [`crate::FaultPlan`] operation:
//!
//! 1. write the bytes to a unique temporary file,
//! 2. sync the temporary file,
//! 3. rename it to its hash,
//! 4. sync the containing directory, so the rename survives power loss.
//!
//! `xsnap`'s `suspend_to_cas` performed the first three; step 4 is the one the
//! design calls out as missing before power-loss durability can be claimed.
//! A blob is not *published* until the transcript records its hash and
//! watermark ([`crate::Transcript::publish_snapshot`]), so a crash anywhere in
//! these four steps leaves at worst an orphan temporary or an unpublished
//! blob, which is safe to reclaim.

use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use sha2::{Digest, Sha256};

use crate::fault::FaultPlan;

/// A directory of content-addressed snapshot blobs.
#[derive(Clone, Debug)]
pub struct ContentAddressedStore {
    directory: PathBuf,
    fault: Option<FaultPlan>,
}

/// A CAS read failure. Any of these is a storage fault: recovery must stop,
/// not fall back to an older or arbitrary snapshot.
#[derive(Debug)]
pub enum ContentAddressedStoreError {
    /// The blob could not be read.
    Io(io::Error),
    /// The blob's bytes do not hash to its name.
    Corrupt { expected: String, actual: String },
    /// The name is not a SHA-256 digest, so it names no blob in the store.
    InvalidName(String),
}

impl std::fmt::Display for ContentAddressedStoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ContentAddressedStoreError::Io(e) => write!(f, "snapshot blob unreadable: {e}"),
            ContentAddressedStoreError::Corrupt { expected, actual } => {
                write!(
                    f,
                    "snapshot blob {expected} is corrupt (hashes to {actual})"
                )
            }
            ContentAddressedStoreError::InvalidName(name) => {
                write!(f, "snapshot blob name {name:?} is not a SHA-256 digest")
            }
        }
    }
}

impl std::error::Error for ContentAddressedStoreError {}

/// Numbers this process's temporaries. `xsnap::Machine::suspend_to_cas`
/// keeps its own counter under a `.snapshot.` prefix, so the transcript's
/// temporaries take a distinct `.transcript-blob.` prefix: two writers
/// sharing one directory never open the same temporary.
static TEMPORARY_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// The SHA-256 of `bytes`, lower-case hex: a blob's CAS name.
pub fn blob_hash(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

impl ContentAddressedStore {
    /// A content-addressed store rooted at `directory`, created if absent.
    pub fn open(directory: impl Into<PathBuf>) -> io::Result<ContentAddressedStore> {
        let directory = directory.into();
        fs::create_dir_all(&directory)?;
        Ok(ContentAddressedStore {
            directory,
            fault: None,
        })
    }

    /// The same store with its durability operations routed through `plan`.
    pub fn with_fault_plan(mut self, plan: FaultPlan) -> ContentAddressedStore {
        self.fault = Some(plan);
        self
    }

    /// The store's directory.
    pub fn directory(&self) -> &Path {
        &self.directory
    }

    fn op(
        &self,
        label: &str,
        is_sync: bool,
        full: impl FnOnce() -> io::Result<()>,
        half: Option<&mut dyn FnMut() -> io::Result<()>>,
    ) -> io::Result<()> {
        match &self.fault {
            Some(plan) => plan.op(label, is_sync, full, half),
            None => full(),
        }
    }

    /// Durably write `bytes` as a blob and return its hash. Idempotent: an
    /// existing blob of the same hash is rewritten to the same content.
    pub fn write_blob(&self, bytes: &[u8]) -> io::Result<String> {
        let hash = blob_hash(bytes);
        let sequence = TEMPORARY_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let temporary = self.directory.join(format!(
            ".transcript-blob.{}.{sequence}.tmp",
            std::process::id()
        ));
        let result = self.write_blob_steps(bytes, &temporary, &hash);
        if result.is_err() && !self.fault.as_ref().is_some_and(FaultPlan::dead) {
            // A surviving process cleans up after itself; a dead one leaves
            // the orphan temporary for later reclamation.
            let _ = fs::remove_file(&temporary);
        }
        result.map(|()| hash)
    }

    fn write_blob_steps(&self, bytes: &[u8], temporary: &Path, hash: &str) -> io::Result<()> {
        let mut half = || -> io::Result<()> {
            let mut f = File::create(temporary)?;
            f.write_all(&bytes[..bytes.len() / 2])
        };
        self.op(
            "blob-store:write-blob",
            false,
            || {
                let mut f = File::create(temporary)?;
                f.write_all(bytes)
            },
            Some(&mut half),
        )?;
        self.op(
            "blob-store:sync-blob",
            true,
            || File::open(temporary)?.sync_all(),
            None,
        )?;
        let dest = self.directory.join(hash);
        self.op(
            "blob-store:rename-blob",
            false,
            || fs::rename(temporary, &dest),
            None,
        )?;
        self.op(
            "blob-store:sync-directory",
            true,
            || sync_directory(&self.directory),
            None,
        )
    }

    /// Read and verify the blob named `hash`.
    /// The name must be 64 lowercase hexadecimal digits: it comes from the
    /// durable transcript, and anything else could leave the directory.
    pub fn read_blob(&self, hash: &str) -> Result<Vec<u8>, ContentAddressedStoreError> {
        if !is_blob_name(hash) {
            return Err(ContentAddressedStoreError::InvalidName(hash.to_string()));
        }
        let bytes = fs::read(self.directory.join(hash)).map_err(ContentAddressedStoreError::Io)?;
        let actual = blob_hash(&bytes);
        if actual != hash {
            return Err(ContentAddressedStoreError::Corrupt {
                expected: hash.to_string(),
                actual,
            });
        }
        Ok(bytes)
    }

    /// Remove every blob and orphan temporary not named in `keep`. Blobs the
    /// transcript never published (a crash between rename and publication)
    /// and blobs superseded by a newer published snapshot are both garbage.
    pub fn reclaim(&self, keep: &[String]) -> io::Result<usize> {
        let mut removed = 0;
        for entry in fs::read_dir(&self.directory)? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if keep.contains(&name) {
                continue;
            }
            fs::remove_file(entry.path())?;
            removed += 1;
        }
        Ok(removed)
    }
}

/// Whether `name` has the shape of a [`blob_hash`]: 64 lowercase
/// hexadecimal digits.
fn is_blob_name(name: &str) -> bool {
    name.len() == 64 && name.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// Sync a directory so a rename or create inside it survives power loss.
pub fn sync_directory(directory: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        File::open(directory)?.sync_all()
    }
    #[cfg(not(unix))]
    {
        // Only unix targets are supported. Windows has no directory handle
        // to sync, and no durability guarantee is claimed there.
        let _ = directory;
        Ok(())
    }
}
