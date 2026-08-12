//! Engine-level coverage of the SQLite backend: real JavaScript,
//! compiled by the pure-Rust `ironhorse-compile` pipeline, executed
//! crank by crank on machines that **suspend into and resume from the
//! SQLite store between every crank** (the sleepy-worker shape, with a
//! full last-connection close each time), against an uninterrupted
//! baseline machine.
//!
//! The locks per scenario, all against the baseline:
//! - every crank's completion value matches, crank by crank;
//! - the final computron count matches (the meter continued exactly
//!   through every store round-trip);
//! - after every checkpoint the store equals the live machine
//!   (`store_to_image == snapshot_image`);
//! - the final store's canonical export is **byte-identical** to the
//!   blob the baseline machine writes — total-state equality, not just
//!   observable equality.
//!
//! Fixture discipline: each scenario asserts its baseline completion
//! against a literal expected value first, so a fixture the engine
//! cannot yet run (or a symbol-numbering mismatch between cranks)
//! fails loudly at the baseline, never as a store-attributed
//! divergence. Cross-crank symbol resolution follows the blessed
//! pattern of `ironhorse-snapshot/tests/restore_side_tables.rs`
//! (`link_intrinsics` on the first crank's names; restores re-derive
//! the linkage) with one refinement this suite discovered and locks:
//! program-symbol ids coincide across independently compiled cranks
//! only when every crank uses **exactly the same symbol set**, so each
//! crank anchors otherwise-unused names with no-op mentions (`var n;`
//! re-declarations, which do not clobber, and `o.x;` property reads).
//! A live closure or generator held **across** a suspend is
//! deliberately absent — those side tables are the ledger's enumerated
//! `Pending` remainder, not covered snapshot state (the honest
//! narrower contract).

use ironhorse_snapshot::machine::{
    begin_store_session, checkpoint_to_store, resume_from_store, MachineSnapshot,
};
use ironhorse_snapshot::store::{export_to_container, store_to_image, StoreError};
use ironhorse_snapshot::Signature;
use ironhorse_store_sqlite::SqliteHeapStore;
use ironhorse_vm::{parse_symbols, Interp, CHUNK_EXTENT_BYTES, SLOTS_PER_PAGE};
use std::path::PathBuf;

fn sig() -> Signature {
    Signature::new("ironhorse-worker-v1")
}

fn compile(source: &str) -> (Vec<u8>, Vec<String>) {
    let (bytecode, symbols) = ironhorse_compile::compile_atoms(source).expect("fixture compiles");
    (bytecode, parse_symbols(&symbols))
}

fn tmp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("ironhorse-sqlite-engine-{name}"));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// Run `cranks` uninterrupted on one machine, then again with a full
/// SQLite suspend/close/reopen/resume between every crank, and hold
/// the scenario locks. Returns the baseline's final completion value
/// so callers can assert their literal expectation.
fn run_scenario(name: &str, cranks: &[&str]) -> String {
    let compiled: Vec<(Vec<u8>, Vec<String>)> = cranks.iter().map(|s| compile(s)).collect();

    // Baseline: one machine, never suspended.
    let mut baseline = Interp::new();
    baseline.link_intrinsics(&compiled[0].1);
    let mut baseline_outcomes = Vec::new();
    for (bytecode, _) in &compiled {
        let outcome = baseline.run(bytecode);
        assert!(
            outcome.completed,
            "[{name}] baseline crank completes (halt: {:?})",
            outcome.halt
        );
        baseline_outcomes.push(outcome);
    }

    // Store lifecycle: crank 1 on a fresh machine, then a full
    // suspend/resume cycle (checkpoint, close, reopen, resume) around
    // every subsequent crank.
    let dir = tmp_dir(name);
    let path = dir.join("worker-heap.sqlite");

    let mut store = SqliteHeapStore::open(&path).unwrap();
    let mut m0 = Interp::new();
    m0.link_intrinsics(&compiled[0].1);
    let outcome = m0.run(&compiled[0].0);
    assert_eq!(outcome.result, baseline_outcomes[0].result, "[{name}] crank 1 result");
    let mut session = begin_store_session(m0, &sig(), &mut store)
        .map_err(|(_, e)| e)
        .expect("begin session");
    assert_eq!(
        store_to_image(&store).unwrap(),
        session.machine().snapshot_image(&sig()),
        "[{name}] store equals live machine after the full write"
    );

    for (i, (bytecode, _)) in compiled.iter().enumerate().skip(1) {
        // Sleep: drop the machine, close the database fully.
        drop(session);
        store.close().expect("full close");

        // Wake: reopen, resume, run the next crank.
        store = SqliteHeapStore::open(&path).unwrap();
        session = resume_from_store(&store, &sig()).expect("resumes");
        let outcome = session.machine_mut().run(bytecode);
        assert!(outcome.completed, "[{name}] resumed crank {} completes", i + 1);
        assert_eq!(
            outcome.result,
            baseline_outcomes[i].result,
            "[{name}] crank {} result equals the uninterrupted run",
            i + 1
        );
        assert_eq!(
            outcome.computrons,
            baseline_outcomes[i].computrons,
            "[{name}] crank {} cumulative computrons equal the uninterrupted run",
            i + 1
        );

        let epoch =
            checkpoint_to_store(&mut session, &sig(), &mut store).expect("incremental checkpoint");
        assert_eq!(epoch as usize, i + 1, "[{name}] one epoch per crank");
        assert_eq!(
            store_to_image(&store).unwrap(),
            session.machine().snapshot_image(&sig()),
            "[{name}] store equals live machine after checkpoint {}",
            i + 1
        );
    }

    // Total-state equality: the store's canonical export byte-equals
    // the blob the baseline machine itself writes.
    assert_eq!(
        export_to_container(&store).unwrap(),
        baseline.write_snapshot(&sig()),
        "[{name}] final store export byte-equals the never-suspended machine's blob"
    );

    let _ = std::fs::remove_dir_all(&dir);
    baseline_outcomes.last().unwrap().result.clone()
}

/// Runtime global + arithmetic across a suspend (the ledger's
/// GlobalProps/SymbolTables shape, through SQLite).
#[test]
fn globals_survive_sqlite_sleep_cycles() {
    let last = run_scenario("globals", &["var x = 5;", "x = x + 1;", "x + 10"]);
    assert_eq!(last, "16");
}

/// String state: chunk-arena content (UTF-16 payloads) round-trips,
/// growing across cranks; the final read composes pre- and
/// post-suspend string data.
#[test]
fn strings_survive_sqlite_sleep_cycles() {
    let last = run_scenario(
        "strings",
        &[
            "var s = 'seed';",
            "s = s + '-grow';",
            "s = s + s;",
            "s",
        ],
    );
    assert_eq!(last, "seed-growseed-grow");
}

/// Object graphs: instance + property slots round-trip; properties
/// written before a suspend are read and mutated after it.
#[test]
fn object_properties_survive_sqlite_sleep_cycles() {
    let last = run_scenario(
        "objects",
        &[
            "var o = { a: 1, b: 2 };",
            "o.a = o.a + o.b;",
            "o.b = o.a * 10;",
            "o.a + o.b",
        ],
    );
    assert_eq!(last, "33");
}

/// Property deletion frees a slot: the free list crosses the store
/// (order preserved) and a post-resume allocation reuses the freed
/// record exactly as the uninterrupted machine's does — locked by the
/// computron and export equalities in the scenario runner. The
/// standalone tail proves the fixture really populates the free list.
#[test]
fn free_list_reuse_survives_sqlite_sleep_cycles() {
    let last = run_scenario(
        "free-list",
        &[
            "var o = { a: 1, b: 2, c: 3, d: 0 };",
            "o.a; o.c; o.d; delete o.b;",
            "o.a; o.b; o.c; o.d = 4;",
            "o.b; o.a + o.c + o.d",
        ],
    );
    assert_eq!(last, "8");

    // The fixture genuinely frees a slot (delete detaches the property
    // record to the free list), so the scenario's export equality
    // really covers free-list round-trip and reuse.
    let (b1, names) = compile("var o = { a: 1, b: 2, c: 3, d: 0 };");
    let (b2, _) = compile("o.a; o.c; o.d; delete o.b;");
    let mut m = Interp::new();
    m.link_intrinsics(&names);
    assert!(m.run(&b1).completed);
    assert!(m.run(&b2).completed);
    assert!(
        !m.slots.free_list().is_empty(),
        "delete must push the property record onto the free list"
    );
}

/// Closures resolved within their crank (the covered contract): a
/// closure-produced value crosses the suspend; no live closure does.
/// The follow-up crank anchors the function's internal names so its
/// symbol set matches crank 1's.
#[test]
fn closure_results_survive_sqlite_sleep_cycles() {
    let last = run_scenario(
        "closure-results",
        &[
            "var y = (function (n) { var k = 2; return n * k; })(21);",
            "var n; var k; y + 1",
        ],
    );
    assert_eq!(last, "43");
}

/// A heap wide enough to span many slot pages: thousands of
/// instance/property slots from an object-churn loop, verified after
/// a sleep cycle. Asserts the store really carries multiple pages so
/// the scenario cannot silently shrink below its purpose.
#[test]
fn multi_page_heap_survives_sqlite_sleep_cycles() {
    let last = run_scenario(
        "multi-page",
        &[
            "var last = { v: 0 }; var i = 0; for (i = 0; i < 2000; i = i + 1) { last = { v: i }; }",
            "var i; last.v + 1",
        ],
    );
    assert_eq!(last, "2000");

    // Independently confirm the fixture's heap really is multi-page.
    let (bytecode, names) = compile(
        "var last = { v: 0 }; var i = 0; for (i = 0; i < 2000; i = i + 1) { last = { v: i }; }",
    );
    let mut m = Interp::new();
    m.link_intrinsics(&names);
    assert!(m.run(&bytecode).completed);
    assert!(
        m.slots.capacity() > 4 * SLOTS_PER_PAGE,
        "fixture must span several slot pages, has {} records",
        m.slots.capacity()
    );
}

/// A chunk arena wide enough to span multiple extents: doubling string
/// concatenation. Verified after sleep cycles, with the extent span
/// independently confirmed.
#[test]
fn multi_extent_chunks_survive_sqlite_sleep_cycles() {
    let doubler =
        "var s = '0123456789abcdef'; var i = 0; for (i = 0; i < 12; i = i + 1) { s = s + s; }";
    let last = run_scenario("multi-extent", &[doubler, "s = s + 'END';", "'ok'"]);
    assert_eq!(last, "ok");

    let (bytecode, names) = compile(doubler);
    let mut m = Interp::new();
    m.link_intrinsics(&names);
    assert!(m.run(&bytecode).completed);
    assert!(
        m.chunks.byte_size() > 2 * CHUNK_EXTENT_BYTES as usize,
        "fixture must span several chunk extents, has {} bytes",
        m.chunks.byte_size()
    );
}

/// A long lifecycle: many cranks, one epoch per crank, every wake from
/// a fully closed database. The per-crank symbol numbering is
/// identical by construction (every crank is the same source).
#[test]
fn many_epoch_lifecycle_tracks_uninterrupted() {
    let mut cranks: Vec<&str> = vec!["var x = 1;"];
    for _ in 0..8 {
        cranks.push("x = x + x;");
    }
    cranks.push("x");
    let last = run_scenario("many-epochs", &cranks);
    assert_eq!(last, "256");
}

/// An interrupted lifecycle can be told apart from a corrupted one: a
/// scenario against a store whose file was truncated mid-life fails
/// closed at open/validate, never resumes wrong.
#[test]
fn truncated_database_fails_closed_not_wrong() {
    let dir = tmp_dir("truncate");
    let path = dir.join("worker-heap.sqlite");
    let (bytecode, names) = compile("var x = 5;");

    let mut store = SqliteHeapStore::open(&path).unwrap();
    let mut m = Interp::new();
    m.link_intrinsics(&names);
    assert!(m.run(&bytecode).completed);
    drop(
        begin_store_session(m, &sig(), &mut store)
            .map_err(|(_, e)| e)
            .unwrap(),
    );
    store.close().unwrap();

    // Truncate the closed, self-contained database file.
    let bytes = std::fs::read(&path).unwrap();
    std::fs::write(&path, &bytes[..bytes.len() / 3]).unwrap();

    match SqliteHeapStore::open(&path).and_then(|s| resume_from_store(&s, &sig()).map(|_| ())) {
        Err(StoreError::Io(_)) | Err(StoreError::Snapshot(_)) | Err(StoreError::Empty) => {}
        Err(other) => panic!("unexpected error shape: {other:?}"),
        Ok(()) => panic!("a truncated database must not resume"),
    }
    let _ = std::fs::remove_dir_all(&dir);
}
