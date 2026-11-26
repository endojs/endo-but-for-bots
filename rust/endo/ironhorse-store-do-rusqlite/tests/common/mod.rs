//! Shared test support: a scratch-dir guard that pre-cleans any prior run's
//! leftover, creates the directory and removes it on drop (success or panic),
//! as the SQLite backend's tests have it; and the helpers both test files use.

#![allow(dead_code)]

use ironhorse_snapshot::Signature;
use ironhorse_store_do::DoStore;
use ironhorse_store_do_rusqlite::RusqliteExecutor;
use ironhorse_vm::{parse_symbols, Interp, SymbolName};

pub struct TempDir(std::path::PathBuf);

impl TempDir {
    pub fn new(name: &str) -> TempDir {
        // Per-process and per-call unique, so two concurrent runs of this
        // crate's tests never share (and delete) each other's directory.
        static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let unique = format!(
            "{name}-{}-{}",
            std::process::id(),
            SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        );
        let path = std::env::temp_dir().join(unique);
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).unwrap();
        TempDir(path)
    }
}

impl std::ops::Deref for TempDir {
    type Target = std::path::Path;
    fn deref(&self) -> &std::path::Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

pub type Store = DoStore<RusqliteExecutor>;

/// The suite's signature, so a store these tests write is one the suite's
/// helpers accept.
pub fn sig() -> Signature {
    Signature::new("ironhorse-worker-v1")
}

pub fn compile(source: &str) -> (Vec<u8>, Vec<SymbolName>) {
    let (bytecode, symbols) = ironhorse_compile::compile_atoms(source).expect("fixture compiles");
    (bytecode, parse_symbols(&symbols))
}

/// A fresh machine that has run `source` to completion.
pub fn machine(source: &str) -> Interp {
    let (code, names) = compile(source);
    let mut machine = Interp::new();
    machine.link_intrinsics(&names);
    let outcome = machine.run(&code);
    assert!(outcome.completed, "{:?}", outcome.halt);
    machine
}

/// Fresh stores 1, 2, 3, … over one database, as one Durable Object holds
/// several.
pub fn fresh_stores(executor: RusqliteExecutor) -> impl FnMut() -> Store {
    let mut next = 0u32;
    move || {
        next += 1;
        DoStore::open(executor.clone(), next).expect("a fresh store opens")
    }
}

/// Rewrite section `id` of store `store` at rest through `conn`, in the
/// store's layout for chunks of `chunk_bytes` (full chunks, then one shorter
/// final chunk), with the payload's digest on chunk 0.
pub fn rewrite_section(
    conn: &rusqlite::Connection,
    store: u32,
    id: u32,
    payload: &[u8],
    chunk_bytes: usize,
) {
    use ironhorse_snapshot::store_sections::{section_hash, SmallSection};
    use rusqlite::params;
    conn.execute(
        "DELETE FROM ih_sections WHERE store = ?1 AND id = ?2",
        params![store, id],
    )
    .unwrap();
    let hash = section_hash(SmallSection::ALL[id as usize], payload);
    for n in 0..=payload.len() / chunk_bytes {
        let chunk = &payload[n * chunk_bytes..payload.len().min((n + 1) * chunk_bytes)];
        let digest: &[u8] = if n == 0 { &hash } else { &[] };
        conn.execute(
            "INSERT INTO ih_sections (store, id, chunk, bytes, hash) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![store, id, n as u32, chunk, digest],
        )
        .unwrap();
    }
}
