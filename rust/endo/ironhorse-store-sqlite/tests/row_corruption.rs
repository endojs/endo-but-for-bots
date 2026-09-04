//! Structurally valid SQLite databases with corrupted store rows. Whole-file
//! truncation only proves SQLite's envelope; these cases keep that envelope
//! readable and damage each sealed row class independently.

mod common;

use std::cell::RefCell;
use std::rc::Rc;

use ironhorse_snapshot::machine::{begin_store_session, resume_from_store, resume_from_store_lazy};
use ironhorse_snapshot::store::validate_store;
use ironhorse_snapshot::Signature;
use ironhorse_store_sqlite::SqliteHeapStore;
use ironhorse_vm::{parse_symbols, Interp};
use rusqlite::Connection;

fn sig() -> Signature {
    Signature::new("ironhorse-worker-v1")
}

fn compile(source: &str) -> (Vec<u8>, Vec<String>) {
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

#[derive(Clone, Copy)]
enum Probe {
    Validate,
    EagerResume,
    LazyResumeAndRead,
}

impl Probe {
    fn name(self) -> &'static str {
        match self {
            Probe::Validate => "validate",
            Probe::EagerResume => "eager",
            Probe::LazyResumeAndRead => "lazy",
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
        Probe::EagerResume => resume_from_store(&store, &sig()).is_err(),
        Probe::LazyResumeAndRead => {
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let store = Rc::new(RefCell::new(store));
                match resume_from_store_lazy(store, &sig()) {
                    Err(_) => true,
                    Ok(mut session) => {
                        let (bytecode, names) = compile("var sentinel; sentinel.deep");
                        let bytecode = session
                            .machine_mut()
                            .relink_crank(&bytecode, &names)
                            .expect("oracle relinks");
                        !session.machine_mut().run(&bytecode).completed
                    }
                }
            }))
            .unwrap_or(true)
        }
    }
}

#[test]
fn valid_database_row_corruption_fails_closed_on_every_adoption_path() {
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
            "small-state-bytes",
            "UPDATE small_state SET bytes = zeroblob(length(bytes))",
        ),
        ("free-segment-row", "DELETE FROM free_segs WHERE seg = 0"),
        (
            "corresponding-leaf-row",
            "DELETE FROM leaf_hashes WHERE kind = 0 AND idx = 0",
        ),
        (
            "encoded-manifest",
            "UPDATE meta SET value = zeroblob(length(value)) WHERE key = 'manifest'",
        ),
    ];

    for (case, sql) in mutations {
        for probe in [
            Probe::Validate,
            Probe::EagerResume,
            Probe::LazyResumeAndRead,
        ] {
            let dir = common::TempDir::new(&format!("ih-row-corrupt-{case}-{}", probe.name()));
            let path = dir.join("heap.sqlite");
            make_store(&path);
            let conn = Connection::open(&path).unwrap();
            let changed = conn.execute(sql, []).unwrap();
            assert!(changed > 0, "{case} mutation changed a real fixture row");
            conn.close().unwrap();
            assert!(
                refuses(&path, probe),
                "{case} must fail closed through the {} path",
                probe.name()
            );
        }
    }
}

#[test]
fn length_preserving_row_edits_are_caught_on_eager_and_lazy_reads() {
    for (case, sql) in [
        (
            "slot-page-content",
            "UPDATE slot_pages SET bytes = zeroblob(length(bytes))",
        ),
        (
            "chunk-extent-content",
            "UPDATE chunk_exts SET bytes = zeroblob(length(bytes))",
        ),
    ] {
        // Open-time validation deliberately reads row metadata and sealed
        // leaves, not O(heap) row content. Pin that boundary explicitly;
        // the content hash is checked when eager reification or a lazy
        // fault actually reads the row.
        let dir = common::TempDir::new(&format!("ih-row-flip-{case}-validate"));
        let path = dir.join("heap.sqlite");
        make_store(&path);
        let conn = Connection::open(&path).unwrap();
        assert!(conn.execute(sql, []).unwrap() > 0);
        conn.close().unwrap();
        let store = SqliteHeapStore::open(&path).unwrap();
        validate_store(&store, &sig()).expect("metadata-scale validation remains valid");

        for probe in [Probe::EagerResume, Probe::LazyResumeAndRead] {
            let dir = common::TempDir::new(&format!("ih-row-flip-{case}-{}", probe.name()));
            let path = dir.join("heap.sqlite");
            make_store(&path);
            let conn = Connection::open(&path).unwrap();
            assert!(conn.execute(sql, []).unwrap() > 0);
            conn.close().unwrap();
            assert!(
                refuses(&path, probe),
                "{case} must fail closed when the {} path reads it",
                probe.name()
            );
        }
    }
}
