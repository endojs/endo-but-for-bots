//! A restored machine charges exactly what the machine it came from charges.
//!
//! Array items, index properties, Map/Set entries and `Intl.Segmenter`
//! results are charged against the chunk ceiling (`ironhorse-vm`'s
//! `side_storage.rs`). The ledger is never persisted: a restore derives it
//! from the rebuilt tables. The charge depends on what the heap holds, not on
//! how it was built — tombstones a Map's deletes left behind live and the
//! snapshot compacts away are not charged — so a machine resumed from a
//! whole-heap snapshot or from a store, eagerly or lazily, halts at the
//! ceiling at the same computron as the machine that never stopped.

// Only the crank helpers are used here; the twin driver sets no ceilings.
#[allow(dead_code)]
#[path = "common/twin.rs"]
mod carry;
use carry::{compile, crank, sig, Observation};

use std::cell::RefCell;
use std::rc::Rc;

use ironhorse_snapshot::machine::{
    begin_store_session, from_snapshot_bytes, resume_from_store, resume_from_store_lazy,
    MachineSnapshot,
};
use ironhorse_snapshot::store::MemoryStore;
use ironhorse_vm::Interp;

/// Builds every charged table near a small ceiling, with Map and Set
/// deletes (live tombstones), an open Map cursor and a retained `%Segments%`.
const BUILD: &str = "var m = new Map(); var s = new Set(); var a = []; var o = {}; \
    for (var i = 0; i < 3000; i++) { m.set('k' + i, i); s.add(i); a.push(i); o[i] = i; } \
    for (var i = 0; i < 1100; i++) { m.delete('k' + (2 * i)); s.delete(3 * i); } \
    var it = m.keys(); it.next(); it.next(); \
    var seg = new Intl.Segmenter('en', { granularity: 'grapheme' }).segment('abc'.repeat(700)); \
    a.length + m.size + s.size";

/// Grows every table until the ceiling halts it, after checking that the
/// open cursor resumes where it stood.
const GROW: &str = "var m; var s; var a; var o; var it; \
    var first = it.next().value; var i = 0; \
    for (;;) { m.set('n' + i, i); s.add('s' + i); a.push(i); o[3000 + i] = i; i++; }";

/// The heap's ceiling: what the build leaves in chunks and side storage, plus
/// room for a few thousand more entries in each table.
const HEADROOM: usize = 384 * 1024;

fn built() -> (Interp, usize) {
    let (bytecode, names) = compile(BUILD);
    let mut machine = Interp::new();
    machine.link_intrinsics(&names);
    let outcome = machine.run(&bytecode);
    assert!(outcome.completed, "build: {:?}", outcome.halt);
    assert_eq!(outcome.result, "6900");
    let (charged, derived) = machine.side_storage_parity();
    assert_eq!(charged, derived);
    let ceiling = machine.chunks().byte_size() + charged as usize + HEADROOM;
    (machine, ceiling)
}

fn grow(machine: &mut Interp, ceiling: usize) -> (u64, Observation) {
    // Ceilings are host policy, reapplied after every restore.
    machine.set_chunk_ceiling(ceiling).unwrap();
    machine.set_slot_ceiling(50_000).unwrap();
    let charged = machine.side_storage_bytes();
    let observation = crank(machine, GROW);
    (charged, observation)
}

#[test]
fn resumed_machines_halt_where_the_continuous_one_does() {
    let (mut continuous, ceiling) = built();
    let expected = grow(&mut continuous, ceiling);
    assert!(!expected.1 .0);
    assert_eq!(expected.1 .1, "HeapExhausted");
    assert!(expected.0 > 0);

    // Whole-heap snapshot.
    let (machine, _) = built();
    let bytes = machine.write_snapshot(&sig()).expect("snapshot");
    let mut blob = from_snapshot_bytes(&bytes, &sig()).expect("blob restore");
    assert_eq!(grow(&mut blob, ceiling), expected, "whole-heap snapshot");

    // Store session, eager and lazy.
    let store = Rc::new(RefCell::new(MemoryStore::new()));
    let (machine, _) = built();
    drop(
        begin_store_session(machine, &sig(), &mut *store.borrow_mut())
            .map_err(|(_, error)| error)
            .expect("begin"),
    );
    let mut eager = resume_from_store(&mut *store.borrow_mut(), &sig()).expect("eager resume");
    assert_eq!(grow(eager.machine_mut(), ceiling), expected, "eager store");
    let mut lazy = resume_from_store_lazy(store, &sig()).expect("lazy resume");
    assert_eq!(grow(lazy.machine_mut(), ceiling), expected, "lazy store");
}

#[test]
fn resumed_cursors_continue_after_deletes_and_compaction() {
    let observe = "var m; var it; var t = []; var r; \
        for (var i = 0; i < 1500; i++) m.delete('k' + (2 * i + 1)); \
        m.set('tail', 1); while (!(r = it.next()).done) t.push(r.value); \
        t.length + ':' + t[0] + ':' + t[t.length - 1]";
    let (mut continuous, _) = built();
    let expected = crank(&mut continuous, observe);
    assert!(expected.0, "{expected:?}");
    let (machine, _) = built();
    let bytes = machine.write_snapshot(&sig()).expect("snapshot");
    let mut blob = from_snapshot_bytes(&bytes, &sig()).expect("blob restore");
    assert_eq!(crank(&mut blob, observe), expected);
    assert_eq!(
        blob.side_storage_parity(),
        continuous.side_storage_parity(),
        "the restored ledger equals the continuous one"
    );
}
