//! Structurally valid SQLite databases with damaged store rows. Whole-file
//! truncation only proves SQLite's envelope; these cases keep that envelope
//! readable and damage one row class at a time.
//!
//! Under the store-seam design's trust model nothing checks a row against a
//! stored digest. Structural damage is refused where the row is decoded: at
//! open for the rows open reads (the manifest, the small state, the free
//! list), at the fault for a heap row, and by both validator levels. Damage
//! to derived state (a section digest, a page summary, the edge index) is
//! the full validator's to find.

mod common;

use std::cell::RefCell;
use std::rc::Rc;

use ironhorse_snapshot::machine::{
    begin_store_session, catch_store_fault, checkpoint_to_store, resume_from_store,
    resume_from_store_lazy,
};
use ironhorse_snapshot::store::{
    chunk_extent_count, slot_page_count, validate_store, validate_store_content, HeapStore,
    StoreError,
};
use ironhorse_snapshot::{Signature, SnapshotError};
use ironhorse_store_sqlite::SqliteHeapStore;
use ironhorse_vm::{parse_symbols, Interp};
use rusqlite::Connection;

fn sig() -> Signature {
    Signature::new("ironhorse-worker-v1")
}

fn compile(source: &str) -> (Vec<u8>, Vec<ironhorse_vm::SymbolName>) {
    let (bytecode, symbols) = ironhorse_compile::compile_atoms(source).expect("fixture compiles");
    (bytecode, parse_symbols(&symbols))
}

fn make_store(path: &std::path::Path) {
    let (bytecode, names) = compile(
        "var sentinel = { deep: 'value' }; var arr = []; var map = new Map(); \
         var coll = new Intl.Collator('en'); var rebound = coll.compare.bind(null); \
         var doomed = { a: 1, b: 2 }; delete doomed.a; \
         var i = 0; for (i = 0; i < 700; i = i + 1) { \
           arr[i] = 'chunk-payload-' + i; map.set(i, arr[i]); \
         } 7",
    );
    let mut machine = Interp::new();
    machine.link_intrinsics(&names);
    assert!(machine.run(&bytecode).completed);
    let mut store = SqliteHeapStore::open(path).unwrap();
    drop(
        begin_store_session(machine, &sig(), &mut store)
            .map_err(|(_, e)| e)
            .expect("fixture persists"),
    );
    store.close().unwrap();
}

/// A fixture store at `path` with one SQL mutation applied through a
/// second connection while the store is closed.
fn damaged_store(path: &std::path::Path, case: &str, sql: &str) {
    make_store(path);
    let conn = Connection::open(path).unwrap();
    let changed = conn.execute(sql, []).unwrap();
    assert!(changed > 0, "{case} mutation changed a real fixture row");
    conn.close().unwrap();
}

#[derive(Clone, Copy)]
enum Probe {
    Validate,
    ValidateContent,
    EagerResume,
    LazyResumeAndTouch,
}

impl Probe {
    fn name(self) -> &'static str {
        match self {
            Probe::Validate => "validate",
            Probe::ValidateContent => "validate-content",
            Probe::EagerResume => "eager",
            Probe::LazyResumeAndTouch => "lazy",
        }
    }
}

fn refuses(path: &std::path::Path, probe: Probe) -> bool {
    let store = match SqliteHeapStore::open(path) {
        Ok(store) => store,
        Err(_) => return true,
    };
    match probe {
        Probe::Validate => validate_store(&store, &sig()).is_err(),
        Probe::ValidateContent => validate_store_content(&store, &sig()).is_err(),
        Probe::EagerResume => resume_from_store(&store, &sig()).is_err(),
        // Force every page and extent resident, so a refusal at the fault
        // does not depend on which rows the restore happened to touch. A
        // refusal is the store's error or a named fault, never an
        // anonymous panic.
        Probe::LazyResumeAndTouch => {
            let store = Rc::new(RefCell::new(store));
            let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let session = resume_from_store_lazy(store.clone(), &sig())?;
                let manifest = store.borrow().manifest()?;
                catch_store_fault(|| {
                    for page in 0..slot_page_count(manifest.slot_count) {
                        session.machine().slots().touch_page(page);
                    }
                    for ext in 0..chunk_extent_count(manifest.chunk_len) {
                        session.machine().chunks().touch_extent(ext);
                    }
                    Ok(())
                })
            }));
            match outcome {
                Ok(result) => result.is_err(),
                Err(payload) => {
                    let message = payload
                        .downcast_ref::<String>()
                        .map(String::as_str)
                        .or_else(|| payload.downcast_ref::<&str>().copied())
                        .unwrap_or_default();
                    assert!(
                        message.contains("lazy heap fault") || message.contains("corrupt"),
                        "a fault refuses by name: {message:?}"
                    );
                    true
                }
            }
        }
    }
}

#[test]
fn structural_row_damage_fails_closed_where_it_is_decoded() {
    let mutations = [
        (
            "slot-page-bytes",
            "UPDATE slot_pages SET bytes = substr(bytes, 1, length(bytes) - 1)",
        ),
        (
            "chunk-extent-bytes",
            "UPDATE chunk_exts SET bytes = substr(bytes, 1, length(bytes) - 1)",
        ),
        (
            "missing-small-section",
            "DELETE FROM small_sections WHERE id = 6",
        ),
        (
            "small-state-bytes",
            "UPDATE small_sections SET bytes = zeroblob(length(bytes))",
        ),
        ("free-segment-row", "DELETE FROM free_segs WHERE seg = 0"),
        (
            "encoded-manifest",
            "UPDATE meta SET value = zeroblob(length(value)) WHERE key = 'manifest'",
        ),
    ];

    for (case, sql) in mutations {
        for probe in [
            Probe::Validate,
            Probe::ValidateContent,
            Probe::EagerResume,
            Probe::LazyResumeAndTouch,
        ] {
            let dir = common::TempDir::new(&format!("ih-row-corrupt-{case}-{}", probe.name()));
            let path = dir.join("heap.sqlite");
            damaged_store(&path, case, sql);
            assert!(
                refuses(&path, probe),
                "{case} must fail closed through the {} path",
                probe.name()
            );
        }
    }
}

/// Open and the fault read no leaf hash, so damage to the leaf rows is
/// found by both validator levels and by the first checkpoint after a
/// resume, which rebuilds its root ledger from them.
#[test]
fn leaf_row_damage_is_refused_by_the_validators_and_the_next_checkpoint() {
    for (case, sql, refusal) in [
        (
            "leaf-gap",
            "DELETE FROM leaf_hashes WHERE kind = 0 AND idx = 0",
            StoreError::MissingRow("slot page leaf", 0),
        ),
        (
            "leaf-count",
            "DELETE FROM leaf_hashes WHERE kind = 0 \
             AND idx = (SELECT MAX(idx) FROM leaf_hashes WHERE kind = 0)",
            StoreError::Snapshot(SnapshotError::Corrupt(
                "store leaf-hash inventory disagrees with geometry",
            )),
        ),
    ] {
        let dir = common::TempDir::new(&format!("ih-row-leaf-{case}"));
        let path = dir.join("heap.sqlite");
        damaged_store(&path, case, sql);
        // One handle at a time: the store takes an exclusive lock.
        drop(
            resume_from_store_lazy(
                Rc::new(RefCell::new(SqliteHeapStore::open(&path).unwrap())),
                &sig(),
            )
            .expect("lazy resume reads no leaf"),
        );
        let mut store = SqliteHeapStore::open(&path).unwrap();
        assert_eq!(
            validate_store(&store, &sig()).err(),
            Some(refusal),
            "{case}"
        );
        assert!(validate_store_content(&store, &sig()).is_err(), "{case}");
        let mut session = resume_from_store(&store, &sig()).expect("eager resume reads no leaf");
        let checkpoint = checkpoint_to_store(&mut session, &sig(), &mut store).err();
        match case {
            "leaf-gap" => assert_eq!(
                checkpoint,
                Some(StoreError::MissingRow("slot page leaf", 0))
            ),
            _ => assert_eq!(
                checkpoint,
                Some(StoreError::Snapshot(SnapshotError::Corrupt(
                    "prior leaf tables disagree with the prior manifest geometry"
                ))),
            ),
        }
        assert_eq!(
            store.manifest().unwrap().epoch,
            1,
            "{case}: nothing committed"
        );
    }
}

/// Derived state is what open trusts without re-deriving it: the
/// metadata-scale validator does not read it either, and the full
/// validator re-derives each piece from its source.
#[test]
fn derived_state_damage_is_refused_by_the_full_validator() {
    for (case, sql, refusal) in [
        (
            "small-section-digests",
            "UPDATE small_sections SET hash = zeroblob(32)",
            StoreError::Snapshot(SnapshotError::Corrupt(
                "small-state section digest disagrees with its payload",
            )),
        ),
        (
            "edge-index",
            "DELETE FROM edge_pairs",
            StoreError::Snapshot(SnapshotError::Corrupt(
                "sqlite: edge_pairs disagrees with page_edges",
            )),
        ),
        (
            "edge-index-surplus",
            "INSERT INTO edge_pairs (target, page) VALUES (-1, 0)",
            StoreError::Snapshot(SnapshotError::Corrupt(
                "sqlite: edge_pairs disagrees with page_edges",
            )),
        ),
        (
            "edge-index-text",
            "INSERT INTO edge_pairs (target, page) VALUES ('x', 0)",
            StoreError::Snapshot(SnapshotError::Corrupt(
                "sqlite: edge_pairs disagrees with page_edges",
            )),
        ),
    ] {
        let dir = common::TempDir::new(&format!("ih-row-derived-{case}"));
        let path = dir.join("heap.sqlite");
        damaged_store(&path, case, sql);
        let store = SqliteHeapStore::open(&path).unwrap();
        validate_store(&store, &sig()).expect("the metadata-scale level reads no derived state");
        assert_eq!(validate_store_content(&store, &sig()).err(), Some(refusal));
    }

    // A page summary edited offline no longer matches its page's records.
    let dir = common::TempDir::new("ih-row-derived-summaries");
    let path = dir.join("heap.sqlite");
    damaged_store(
        &path,
        "page-summaries",
        "UPDATE page_edges SET targets = x'' WHERE length(targets) > 0",
    );
    let store = SqliteHeapStore::open(&path).unwrap();
    validate_store(&store, &sig()).expect("the metadata-scale level counts summaries only");
    match validate_store_content(&store, &sig()) {
        Err(StoreError::SummaryMismatch { .. }) => {}
        other => panic!("expected a summary mismatch, got {other:?}"),
    }
}
