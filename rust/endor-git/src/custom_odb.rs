//! Panic-confined custom object-database callbacks.
//!
//! This prototype proves the object side of libgit2's custom-storage seam.
//! The matching refdb backend is intentionally not fabricated here: the
//! callback contract requires allocating `git_reference` values, but the
//! reviewed `libgit2-sys` release does not bind libgit2's `git_reference__alloc`
//! sys API. See the probe PR's gap report.

use std::collections::HashMap;
use std::ffi::c_void;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::ptr;
use std::slice;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use libc::{c_int, size_t};
use libgit2_sys as raw;

use crate::{backend_error, GitError, GitHashAlgorithm, GitObjectId, GitObjectKind};

/// Capability supplied storage for a custom libgit2 object database.
pub trait CustomObjectStorage: Send + Sync + 'static {
    /// Looks up an object by identifier.
    fn read(&self, id: &GitObjectId) -> Result<Option<(GitObjectKind, Vec<u8>)>, GitError>;
    /// Stores an object after libgit2 has computed and supplied its identifier.
    fn write(&self, id: GitObjectId, kind: GitObjectKind, bytes: &[u8]) -> Result<(), GitError>;
    /// Enumerates every identifier visible through this capability.
    fn identifiers(&self) -> Result<Vec<GitObjectId>, GitError>;
}

/// An in-memory capability used by the generic conformance tests.
#[derive(Default)]
pub struct InMemoryObjectStorage {
    objects: Mutex<HashMap<GitObjectId, (GitObjectKind, Vec<u8>)>>,
}

impl CustomObjectStorage for InMemoryObjectStorage {
    fn read(&self, id: &GitObjectId) -> Result<Option<(GitObjectKind, Vec<u8>)>, GitError> {
        Ok(self
            .objects
            .lock()
            .map_err(|_| GitError::Backend("custom object storage mutex was poisoned".to_owned()))?
            .get(id)
            .cloned())
    }

    fn write(&self, id: GitObjectId, kind: GitObjectKind, bytes: &[u8]) -> Result<(), GitError> {
        self.objects
            .lock()
            .map_err(|_| GitError::Backend("custom object storage mutex was poisoned".to_owned()))?
            .insert(id, (kind, bytes.to_vec()));
        Ok(())
    }

    fn identifiers(&self) -> Result<Vec<GitObjectId>, GitError> {
        Ok(self
            .objects
            .lock()
            .map_err(|_| GitError::Backend("custom object storage mutex was poisoned".to_owned()))?
            .keys()
            .copied()
            .collect())
    }
}

#[repr(C)]
struct BackendAllocation {
    parent: raw::git_odb_backend,
    algorithm: GitHashAlgorithm,
    storage: Arc<dyn CustomObjectStorage>,
    panic_observed: Arc<AtomicBool>,
}

/// An owned libgit2 ODB whose sole backend is capability-selected Rust storage.
pub struct Libgit2CustomOdb {
    object_database: *mut raw::git_odb,
    algorithm: GitHashAlgorithm,
    panic_observed: Arc<AtomicBool>,
}

// libgit2 serializes backend list mutation, and the Rust capability is Send + Sync.
unsafe impl Send for Libgit2CustomOdb {}
unsafe impl Sync for Libgit2CustomOdb {}

impl Libgit2CustomOdb {
    /// Installs a panic-confined Rust backend into a new libgit2 ODB.
    pub fn new(
        algorithm: GitHashAlgorithm,
        storage: Arc<dyn CustomObjectStorage>,
    ) -> Result<Self, GitError> {
        unsafe {
            raw::git_libgit2_init();
            let mut object_database = ptr::null_mut();
            let mut options: raw::git_odb_options = std::mem::zeroed();
            options.version = raw::GIT_ODB_OPTIONS_VERSION;
            options.oid_type = algorithm_to_raw(algorithm);
            check(raw::git_odb_new(&mut object_database, &options))?;

            let panic_observed = Arc::new(AtomicBool::new(false));
            let mut allocation = Box::new(BackendAllocation {
                parent: std::mem::zeroed(),
                algorithm,
                storage,
                panic_observed: Arc::clone(&panic_observed),
            });
            check(raw::git_odb_init_backend(
                &mut allocation.parent,
                raw::GIT_ODB_BACKEND_VERSION,
            ))?;
            allocation.parent.read = Some(read_callback);
            allocation.parent.read_header = Some(read_header_callback);
            allocation.parent.write = Some(write_callback);
            allocation.parent.exists = Some(exists_callback);
            allocation.parent.foreach = Some(foreach_callback);
            allocation.parent.free = Some(free_callback);
            let backend = Box::into_raw(allocation);
            if let Err(error) = check(raw::git_odb_add_backend(
                object_database,
                &mut (*backend).parent,
                100,
            )) {
                drop(Box::from_raw(backend));
                raw::git_odb_free(object_database);
                raw::git_libgit2_shutdown();
                return Err(error);
            }
            Ok(Self {
                object_database,
                algorithm,
                panic_observed,
            })
        }
    }

    /// Writes an object through libgit2 and the custom callback.
    pub fn write_object(&self, kind: GitObjectKind, bytes: &[u8]) -> Result<GitObjectId, GitError> {
        self.panic_observed.store(false, Ordering::SeqCst);
        unsafe {
            let mut identifier: raw::git_oid = std::mem::zeroed();
            let result = raw::git_odb_write(
                &mut identifier,
                self.object_database,
                bytes.as_ptr().cast(),
                bytes.len(),
                kind_to_raw(kind),
            );
            self.check_callback_result(result)?;
            Ok(id_from_raw(&identifier, self.algorithm))
        }
    }

    /// Reads an object through libgit2 and the custom callback.
    pub fn read_object(&self, id: &GitObjectId) -> Result<(GitObjectKind, Vec<u8>), GitError> {
        let identifier = self.checked_raw_id(id)?;
        self.panic_observed.store(false, Ordering::SeqCst);
        unsafe {
            let mut object = ptr::null_mut();
            let result = raw::git_odb_read(&mut object, self.object_database, &identifier);
            if result == raw::GIT_ENOTFOUND {
                return Err(GitError::ObjectNotFound(*id));
            }
            self.check_callback_result(result)?;
            let kind = kind_from_raw(raw::git_odb_object_type(object))?;
            let bytes = slice::from_raw_parts(
                raw::git_odb_object_data(object).cast::<u8>(),
                raw::git_odb_object_size(object),
            )
            .to_vec();
            raw::git_odb_object_free(object);
            Ok((kind, bytes))
        }
    }

    /// Reports whether the custom backend contains an object.
    pub fn object_exists(&self, id: &GitObjectId) -> Result<bool, GitError> {
        let identifier = self.checked_raw_id(id)?;
        self.panic_observed.store(false, Ordering::SeqCst);
        let result = unsafe { raw::git_odb_exists(self.object_database, &identifier) };
        self.check_callback_result(result)?;
        Ok(result != 0)
    }

    fn checked_raw_id(&self, id: &GitObjectId) -> Result<raw::git_oid, GitError> {
        if id.algorithm() != self.algorithm {
            return Err(GitError::WrongObjectFormat {
                expected: self.algorithm,
                actual: id.algorithm(),
            });
        }
        Ok(raw_id_from_id(id))
    }

    fn check_callback_result(&self, result: c_int) -> Result<(), GitError> {
        if self.panic_observed.load(Ordering::SeqCst) {
            return Err(GitError::Backend(
                "custom object callback panicked".to_owned(),
            ));
        }
        check(result)
    }
}

impl Drop for Libgit2CustomOdb {
    fn drop(&mut self) {
        unsafe {
            raw::git_odb_free(self.object_database);
            raw::git_libgit2_shutdown();
        }
    }
}

extern "C" fn read_callback(
    data_out: *mut *mut c_void,
    length_out: *mut size_t,
    kind_out: *mut raw::git_object_t,
    backend: *mut raw::git_odb_backend,
    identifier: *const raw::git_oid,
) -> c_int {
    callback_result(backend, || unsafe {
        let allocation = allocation(backend);
        let id = id_from_raw(&*identifier, allocation.algorithm);
        let Some((kind, bytes)) = allocation.storage.read(&id)? else {
            return Ok(raw::GIT_ENOTFOUND);
        };
        let data = raw::git_odb_backend_data_alloc(backend, bytes.len());
        if data.is_null() && !bytes.is_empty() {
            return Ok(raw::GIT_ERROR);
        }
        ptr::copy_nonoverlapping(bytes.as_ptr(), data.cast::<u8>(), bytes.len());
        *data_out = data;
        *length_out = bytes.len();
        *kind_out = kind_to_raw(kind);
        Ok(raw::GIT_OK)
    })
}

extern "C" fn read_header_callback(
    length_out: *mut size_t,
    kind_out: *mut raw::git_object_t,
    backend: *mut raw::git_odb_backend,
    identifier: *const raw::git_oid,
) -> c_int {
    callback_result(backend, || unsafe {
        let allocation = allocation(backend);
        let id = id_from_raw(&*identifier, allocation.algorithm);
        let Some((kind, bytes)) = allocation.storage.read(&id)? else {
            return Ok(raw::GIT_ENOTFOUND);
        };
        *length_out = bytes.len();
        *kind_out = kind_to_raw(kind);
        Ok(raw::GIT_OK)
    })
}

extern "C" fn write_callback(
    backend: *mut raw::git_odb_backend,
    identifier: *const raw::git_oid,
    data: *const c_void,
    length: size_t,
    kind: raw::git_object_t,
) -> c_int {
    callback_result(backend, || unsafe {
        let allocation = allocation(backend);
        let id = id_from_raw(&*identifier, allocation.algorithm);
        let bytes = slice::from_raw_parts(data.cast::<u8>(), length);
        allocation.storage.write(id, kind_from_raw(kind)?, bytes)?;
        Ok(raw::GIT_OK)
    })
}

extern "C" fn exists_callback(
    backend: *mut raw::git_odb_backend,
    identifier: *const raw::git_oid,
) -> c_int {
    callback_result(backend, || unsafe {
        let allocation = allocation(backend);
        let id = id_from_raw(&*identifier, allocation.algorithm);
        Ok(i32::from(allocation.storage.read(&id)?.is_some()))
    })
}

extern "C" fn foreach_callback(
    backend: *mut raw::git_odb_backend,
    callback: raw::git_odb_foreach_cb,
    payload: *mut c_void,
) -> c_int {
    callback_result(backend, || unsafe {
        let allocation = allocation(backend);
        let Some(callback) = callback else {
            return Ok(raw::GIT_EINVALIDSPEC);
        };
        for id in allocation.storage.identifiers()? {
            let identifier = raw_id_from_id(&id);
            let result = callback(&identifier, payload);
            if result != 0 {
                return Ok(result);
            }
        }
        Ok(raw::GIT_OK)
    })
}

extern "C" fn free_callback(backend: *mut raw::git_odb_backend) {
    if !backend.is_null() {
        unsafe {
            drop(Box::from_raw(backend.cast::<BackendAllocation>()));
        }
    }
}

fn callback_result(
    backend: *mut raw::git_odb_backend,
    operation: impl FnOnce() -> Result<c_int, GitError>,
) -> c_int {
    match catch_unwind(AssertUnwindSafe(operation)) {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => raw::GIT_ERROR,
        Err(_) => {
            if !backend.is_null() {
                unsafe {
                    allocation(backend)
                        .panic_observed
                        .store(true, Ordering::SeqCst);
                }
            }
            raw::GIT_ERROR
        }
    }
}

unsafe fn allocation<'a>(backend: *mut raw::git_odb_backend) -> &'a BackendAllocation {
    &*backend.cast::<BackendAllocation>()
}

fn check(result: c_int) -> Result<(), GitError> {
    if result < 0 {
        Err(backend_error(format!("libgit2 error code {result}")))
    } else {
        Ok(())
    }
}

fn algorithm_to_raw(algorithm: GitHashAlgorithm) -> raw::git_oid_t {
    match algorithm {
        GitHashAlgorithm::Sha1 => raw::GIT_OID_SHA1,
        GitHashAlgorithm::Sha256 => raw::GIT_OID_SHA256,
    }
}

fn raw_id_from_id(id: &GitObjectId) -> raw::git_oid {
    let mut identifier: raw::git_oid = unsafe { std::mem::zeroed() };
    identifier.kind = algorithm_to_raw(id.algorithm()) as u8;
    identifier.id[..id.as_bytes().len()].copy_from_slice(id.as_bytes());
    identifier
}

fn id_from_raw(identifier: &raw::git_oid, algorithm: GitHashAlgorithm) -> GitObjectId {
    match algorithm {
        GitHashAlgorithm::Sha1 => {
            GitObjectId::Sha1(identifier.id[..20].try_into().expect("SHA-1 length"))
        }
        GitHashAlgorithm::Sha256 => {
            GitObjectId::Sha256(identifier.id[..32].try_into().expect("SHA-256 length"))
        }
    }
}

fn kind_to_raw(kind: GitObjectKind) -> raw::git_object_t {
    match kind {
        GitObjectKind::Blob => raw::GIT_OBJECT_BLOB,
        GitObjectKind::Tree => raw::GIT_OBJECT_TREE,
        GitObjectKind::Commit => raw::GIT_OBJECT_COMMIT,
        GitObjectKind::Tag => raw::GIT_OBJECT_TAG,
    }
}

fn kind_from_raw(kind: raw::git_object_t) -> Result<GitObjectKind, GitError> {
    match kind {
        raw::GIT_OBJECT_BLOB => Ok(GitObjectKind::Blob),
        raw::GIT_OBJECT_TREE => Ok(GitObjectKind::Tree),
        raw::GIT_OBJECT_COMMIT => Ok(GitObjectKind::Commit),
        raw::GIT_OBJECT_TAG => Ok(GitObjectKind::Tag),
        _ => Err(GitError::Backend("unsupported Git object type".to_owned())),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::{CustomObjectStorage, InMemoryObjectStorage, Libgit2CustomOdb};
    use crate::{GitError, GitHashAlgorithm, GitObjectId, GitObjectKind};

    struct PanickingStorage;

    impl CustomObjectStorage for PanickingStorage {
        fn read(&self, _id: &GitObjectId) -> Result<Option<(GitObjectKind, Vec<u8>)>, GitError> {
            panic!("panic payload must not unwind through C")
        }

        fn write(
            &self,
            _id: GitObjectId,
            _kind: GitObjectKind,
            _bytes: &[u8],
        ) -> Result<(), GitError> {
            panic!("panic payload must not unwind through C")
        }

        fn identifiers(&self) -> Result<Vec<GitObjectId>, GitError> {
            panic!("panic payload must not unwind through C")
        }
    }

    fn exercise_custom_backend(algorithm: GitHashAlgorithm) {
        let storage = Arc::new(InMemoryObjectStorage::default());
        let object_database = Libgit2CustomOdb::new(algorithm, storage).unwrap();
        let id = object_database
            .write_object(GitObjectKind::Blob, b"capability-selected storage")
            .unwrap();
        assert_eq!(id.algorithm(), algorithm);
        assert!(object_database.object_exists(&id).unwrap());
        assert_eq!(
            object_database.read_object(&id).unwrap(),
            (GitObjectKind::Blob, b"capability-selected storage".to_vec())
        );
    }

    #[test]
    fn sha1_custom_backend_round_trip() {
        exercise_custom_backend(GitHashAlgorithm::Sha1);
    }

    #[test]
    fn sha256_custom_backend_round_trip() {
        exercise_custom_backend(GitHashAlgorithm::Sha256);
    }

    #[test]
    fn callback_panic_becomes_libgit2_error() {
        let object_database =
            Libgit2CustomOdb::new(GitHashAlgorithm::Sha1, Arc::new(PanickingStorage)).unwrap();
        let error = object_database
            .object_exists(&GitObjectId::Sha1([7; 20]))
            .unwrap_err();
        assert!(matches!(error, GitError::Backend(_)));
    }
}
