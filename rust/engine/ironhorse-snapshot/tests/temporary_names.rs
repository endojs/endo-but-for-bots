//! The file store and the CAS name their temporary files, and the default
//! commit-token source mints tokens, without the operating system's process
//! id, which WASI does not have: `std::process::id()` panics there.
//!
//! This file stays free of compiler dev-dependencies so
//! `rust/engine/scripts/test-snapshot-wasi.py` can run it on 32-bit WASI.
//! There it finds its scratch directory through `IRONHORSE_TEST_SCRATCH`,
//! a directory the script preopens; natively it uses the system temp dir.
use std::path::{Path, PathBuf};

use ironhorse_snapshot::machine::{
    begin_store_session, checkpoint_to_store, resume_from_cas, resume_from_store, MachineSnapshot,
};
use ironhorse_snapshot::{FileStore, Signature};
use ironhorse_vm::{Interp, Opcode};

fn sig() -> Signature {
    Signature::new("temporary-names")
}

/// A scratch directory removed on drop.
struct Scratch(PathBuf);

impl Scratch {
    fn new(name: &str) -> Scratch {
        let root = match std::env::var_os("IRONHORSE_TEST_SCRATCH") {
            Some(root) => PathBuf::from(root),
            None => std::env::temp_dir(),
        };
        // Distinct per run without a process id: the wall clock and a
        // per-process counter.
        static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let n = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let path = root.join(format!("ironhorse-{name}-{nanos}-{n}"));
        std::fs::create_dir_all(&path).unwrap();
        Scratch(path)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn ran_machine() -> Interp {
    let mut machine = Interp::new();
    assert!(
        machine
            .run(&[
                Opcode::XS_CODE_OBJECT as u8,
                Opcode::XS_CODE_POP as u8,
                Opcode::XS_CODE_RETURN as u8,
            ])
            .completed
    );
    machine
}

fn entries(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

#[test]
fn file_store_commits_reopen_and_leave_no_temporaries() {
    let dir = Scratch::new("file-store-temporaries");
    let path = dir.0.join("heap.ihstore");
    let mut store = FileStore::open(&path).unwrap();
    let mut session = begin_store_session(ran_machine(), &sig(), &mut store)
        .map_err(|(_, e)| e)
        .expect("the first commit mints a token and stages a temp file");
    assert_eq!(
        checkpoint_to_store(&mut session, &sig(), &mut store),
        Ok(2),
        "a second commit stages a second temp file"
    );
    drop(session);
    drop(store);
    let reopened = FileStore::open(&path).unwrap();
    resume_from_store(&reopened, &sig()).expect("the committed file resumes");
    assert_eq!(entries(&dir.0), ["heap.ihstore"]);
}

#[test]
fn cas_suspend_resumes_and_leaves_no_temporaries() {
    let dir = Scratch::new("cas-temporaries");
    let hash = ran_machine()
        .suspend_to_cas(&sig(), &dir.0)
        .expect("the CAS stages a temp file and publishes it");
    // A second writer of the same content stages its own temp file.
    assert_eq!(ran_machine().suspend_to_cas(&sig(), &dir.0).unwrap(), hash);
    resume_from_cas(&dir.0, &hash, &sig()).expect("the published blob resumes");
    assert_eq!(entries(&dir.0), [hash]);
}
