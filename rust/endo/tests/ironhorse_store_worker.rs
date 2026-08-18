//! The supervisor's store-backed worker-heap option, exercised end to
//! end (designs/ironhorse-snapshot-store-seam.md § supervisor wiring):
//! a `PersistentMachine` opened through `HeapStoreOptions` builds guest
//! state across cranks with a checkpoint per completed crank, rewinds a
//! crashed crank to the last checkpoint, runs a partial collection at a
//! boundary, suspends through the supervisor's store-aware record (no
//! CAS key — the database is the durable state), and resumes from that
//! record with state, epoch chain, and determinism intact.

#![cfg(feature = "ironhorse-engine")]

use endo::ironhorse_engine::engine::{HeapStoreOptions, MachineError, PersistentMachine};
use endo::supervisor::Supervisor;

#[test]
fn store_backed_worker_lifecycle_through_the_supervisor() {
    let dir = tempfile::tempdir().expect("temp dir");
    let options = HeapStoreOptions {
        path: dir.path().join("worker-heap.sqlite"),
        signature: "endor-ironhorse-worker-v1".to_string(),
    };

    // --- Fresh open: epoch 1 is the boot machine. -------------------
    let mut machine = PersistentMachine::open(&options).expect("fresh open");
    assert_eq!(machine.epoch().expect("epoch"), 1, "boot commit");

    // Crank 1 builds guest state; a completed crank checkpoints, so
    // the epoch advances before the outcome is visible.
    let outcome = machine
        .eval(
            "var n = 0; var junk = 0; var i = 0; \
             for (i = 0; i < 100; i = i + 1) { n = n + 1; } \
             for (i = 0; i < 500; i = i + 1) { junk = { v: i, w: i }; } \
             junk = 0; n",
        )
        .expect("crank 1");
    assert_eq!(outcome.result, "100");
    assert!(outcome.computrons > 0, "the meter is real");
    assert_eq!(machine.epoch().expect("epoch"), 2);

    // Crank 2 continues the SAME heap (globals persist; later cranks
    // redeclare positionally per the store suites' convention).
    let outcome = machine
        .eval("var n; var junk; var i; n = n + 1")
        .expect("crank 2");
    assert_eq!(outcome.result, "101");
    assert_eq!(machine.epoch().expect("epoch"), 3);

    // --- Crashed crank: rewind, never persist. ----------------------
    // The throw arrives AFTER a mutation; neither the mutation nor the
    // crank survives — the machine rewinds to epoch 3's state and the
    // epoch does not advance.
    match machine.eval("var n; var junk; var i; n = n + 1000; throw n;") {
        Err(MachineError::Halt(_)) => {}
        other => panic!("expected a halt, got {other:?}"),
    }
    assert_eq!(machine.epoch().expect("epoch"), 3, "no checkpoint for a crashed crank");
    let outcome = machine
        .eval("var n; var junk; var i; n")
        .expect("crank after rewind");
    assert_eq!(outcome.result, "101", "the partial crank's effects are gone");
    assert_eq!(machine.epoch().expect("epoch"), 4);

    // --- Partial collection at the boundary. ------------------------
    // The dropped `junk` chain is page-isolated garbage; the
    // summary-driven collector reclaims some of it without touching
    // row content. Freeing never dirties, so the epoch stands.
    let freed = machine.collect().expect("partial collect");
    assert!(freed > 0, "the dropped chain is reclaimable: {freed}");
    assert_eq!(machine.epoch().expect("epoch"), 4);

    // --- Suspend through the supervisor. ----------------------------
    // The database is the durable state: the suspend record carries
    // the path, no CAS key, and close leaves a self-contained file.
    let (sup, _outbox) = Supervisor::new();
    let handle = sup.alloc_handle();
    sup.mark_suspended_store(handle, machine.heap_store_path().to_path_buf());
    machine.close().expect("close folds the WAL");
    assert!(sup.is_suspended(handle));
    let suspended = sup.take_suspended(handle).expect("suspended record");
    assert!(suspended.sha256.is_empty(), "store-backed workers have no CAS key");
    let heap_store = suspended.heap_store.expect("the record carries the heap path");

    // --- Resume from the suspend record. ----------------------------
    let mut machine = PersistentMachine::open(&HeapStoreOptions {
        path: heap_store,
        signature: options.signature.clone(),
    })
    .expect("resume open");
    assert_eq!(machine.epoch().expect("epoch"), 4, "the epoch chain continues");
    let outcome = machine
        .eval("var n; var junk; var i; n = n + 1")
        .expect("crank after resume");
    assert_eq!(outcome.result, "102", "guest state survived suspend/resume");
    assert_eq!(machine.epoch().expect("epoch"), 5);
    machine.close().expect("close");

    // --- The signature gate refuses a foreign worker. ---------------
    match PersistentMachine::open(&HeapStoreOptions {
        path: dir.path().join("worker-heap.sqlite"),
        signature: "some-other-host-surface".to_string(),
    }) {
        Err(MachineError::Store(e)) => {
            assert!(e.contains("Signature"), "refused by the signature gate: {e}");
        }
        Ok(_) => panic!("a foreign signature must be refused"),
        Err(other) => panic!("expected a store refusal, got {other}"),
    }
}
