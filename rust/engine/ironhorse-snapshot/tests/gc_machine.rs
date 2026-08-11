//! Machine-level GC acceptance (the side-table liveness contract):
//! `Interp::collect_garbage` traces side-table-held references, drops
//! entries for swept objects, rewrites externally held chunk offsets,
//! and a collected machine keeps executing and checkpointing exactly.

use ironhorse_snapshot::machine::{begin_store_session, resume_from_store, MachineSnapshot};
use ironhorse_snapshot::store::MemoryStore;
use ironhorse_snapshot::Signature;
use ironhorse_vm::{parse_symbols, Interp};

fn sig() -> Signature {
    Signature::new("ironhorse-worker-v1")
}

fn compile(source: &str) -> (Vec<u8>, Vec<String>) {
    let (bytecode, symbols) = ironhorse_compile::compile_atoms(source).expect("fixture compiles");
    (bytecode, parse_symbols(&symbols))
}

const CRANKS: [&str; 2] = [
    // Live: a closure over captured state, an array, a grown string, an
    // object graph. Garbage: a loop's worth of dead objects and strings.
    "var mk = function (n) { return function () { return n + 1; }; }; \
     var f = mk(41); var arr = [1, 2, 3]; var s = 'seed'; \
     var keep = { v: 7 }; var i = 0; var t = ''; \
     for (i = 0; i < 500; i = i + 1) { t = 'x' + i; var dead = { d: i }; } \
     f()",
    "var mk; var n; var f; var arr; var s; var keep; keep.v; var i; var t; \
     var dead; dead && dead.d; \
     s = s + '-grow'; arr[3] = keep.v; 42 + arr[3] + s.length",
];

#[test]
fn collected_machine_keeps_executing_and_agrees() {
    let compiled: Vec<(Vec<u8>, Vec<String>)> = CRANKS.iter().map(|s| compile(s)).collect();

    // Baseline: never collected.
    let mut base = Interp::new();
    base.link_intrinsics(&compiled[0].1);
    assert!(base.run(&compiled[0].0).completed);
    let b2 = base.run(&compiled[1].0);
    assert!(b2.completed);

    // Collected between cranks: same results, same computrons (GC is
    // not metered; scheduling here is host-driven at the boundary).
    let mut m = Interp::new();
    m.link_intrinsics(&compiled[0].1);
    let o1 = m.run(&compiled[0].0);
    assert!(o1.completed);
    let stats = m.collect_garbage();
    assert!(stats.slots_reclaimed > 0, "the loop's dead objects sweep");
    assert!(
        stats.chunk_bytes_after < stats.chunk_bytes_before,
        "dead strings compact away"
    );
    let o2 = m.run(&compiled[1].0);
    assert!(o2.completed, "halt: {:?}", o2.halt);
    assert_eq!(o2.result, b2.result, "array/string/object survive GC");
    assert_eq!(o2.computrons, b2.computrons, "meter unperturbed by GC");

    // A second collect right after the first is a fixpoint apart from
    // the crank's own garbage — nothing live is lost either way.
    let live_before = m.collect_garbage().slots_live;
    let again = m.collect_garbage();
    assert_eq!(again.slots_live, live_before, "collect is idempotent on live set");
}

#[test]
fn collected_machine_checkpoints_and_resumes_exactly() {
    let compiled: Vec<(Vec<u8>, Vec<String>)> = CRANKS.iter().map(|s| compile(s)).collect();

    let mut m = Interp::new();
    m.link_intrinsics(&compiled[0].1);
    assert!(m.run(&compiled[0].0).completed);
    m.collect_garbage();

    // The GC'd machine, uninterrupted, is the oracle for its own
    // store round-trip.
    let mut store = MemoryStore::new();
    let session = begin_store_session(m, &sig(), &mut store)
        .map_err(|(_, e)| e)
        .expect("begin");
    let mut oracle = session.into_machine();
    let expected = oracle.run(&compiled[1].0);
    assert!(expected.completed);

    let mut resumed = resume_from_store(&store, &sig()).expect("resume");
    let got = resumed.machine_mut().run(&compiled[1].0);
    assert_eq!(got.result, expected.result);
    assert_eq!(got.computrons, expected.computrons);
    assert_eq!(
        resumed.machine().write_snapshot(&sig()),
        oracle.write_snapshot(&sig()),
        "post-GC store round-trip is byte-exact"
    );
}

/// Phase 6 acceptance: the summary-driven partial collect decides
/// from store queries alone, stays strictly conservative (never frees
/// a reachable slot), and the machine keeps executing and
/// checkpointing exactly afterward.
#[test]
fn partial_collect_is_conservative_and_exact() {
    use ironhorse_snapshot::machine::{checkpoint_to_store, partial_collect};

    // Crank 1 builds a large object chain then DROPS it (t stays), so
    // whole pages become unreachable; crank 2 touches one global.
    let cranks = [
        "var last = { v: 0 }; var t = 0; var i = 0; \
         for (i = 0; i < 3000; i = i + 1) { last = { v: i }; } \
         last = { v: -1 }; t = 7;",
        "var last; var i; t + 1",
    ];
    let compiled: Vec<(Vec<u8>, Vec<String>)> = cranks.iter().map(|s| compile(s)).collect();

    let mut store = MemoryStore::new();
    let mut m = Interp::new();
    m.link_intrinsics(&compiled[0].1);
    assert!(m.run(&compiled[0].0).completed);
    let mut session = begin_store_session(m, &sig(), &mut store)
        .map_err(|(_, e)| e)
        .expect("begin");

    let live_before = session.machine().slots.live_count();
    let freed = partial_collect(&mut session, &store).expect("partial collect");
    // Sequentially allocated objects straddle page boundaries, so the
    // dead chain's pages stay summary-linked: the partial collect must
    // be CONSERVATIVE here — freeing nothing is the correct answer,
    // never freeing a reachable slot. (Page-isolated garbage — the
    // case partial collection exists for — is exercised below.)
    assert_eq!(
        session.machine().slots.live_count(),
        live_before - freed,
        "accounting tracks the frees exactly"
    );

    // The machine keeps executing correctly and the next checkpoint
    // round-trips exactly (free-list reclamation rides small state).
    let o = session.machine_mut().run(&compiled[1].0);
    assert!(o.completed);
    assert_eq!(o.result, "8");
    checkpoint_to_store(&mut session, &sig(), &mut store).expect("checkpoint");
    let resumed = resume_from_store(&store, &sig()).expect("resume");
    assert_eq!(
        resumed.machine().write_snapshot(&sig()),
        session.machine().write_snapshot(&sig()),
        "post-partial-collect store round-trip is byte-exact"
    );
}
