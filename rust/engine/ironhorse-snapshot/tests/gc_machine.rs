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
    // The dead chain's objects were each referenced from the SAME
    // rewritten global, and dead records keep their edges until their
    // page is rewritten — so the chain's pages stay summary-linked
    // from live pages and the partial collect must be CONSERVATIVE
    // here: freeing nothing is the correct answer. Locked exactly, not
    // just by accounting (which would hold for any `freed`).
    assert_eq!(freed, 0, "summary-chained garbage is conservatively kept");
    assert_eq!(
        session.machine().slots.live_count(),
        live_before - freed,
        "accounting tracks the frees exactly"
    );

    // The machine keeps executing correctly and the next checkpoint
    // round-trips exactly (free-list reclamation travels as free-list
    // state: segment rows plus the manifest's free_len).
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

/// Phase 6 soundness lock (the review's critical finding): an object
/// reachable ONLY through a side table — an Array's element map lives
/// in a Rust `BTreeMap`, not in the arena — has no arena edge, so the
/// stored page-edge summaries cannot see it. `partial_collect` must
/// root side-table-held references directly
/// (`Interp::side_table_ref_slots`), or it frees live element pages
/// and the next crank reads freed slots.
#[test]
fn partial_collect_keeps_side_table_only_referenced_objects() {
    use ironhorse_snapshot::machine::{checkpoint_to_store, partial_collect};

    // 2000 objects held ONLY as array elements: each element's sole
    // reference lives in `arrays[arr].items` (a Rust BTreeMap), so an
    // element page that starts on an object boundary has no inbound
    // arena edge — the summaries alone would call it unreachable.
    // Three slots per element (instance + two properties) make the
    // isolation arithmetic-guaranteed: 256 ≡ 1 (mod 3), so every
    // third page boundary lands exactly on an object start REGARDLESS
    // of where the run begins — no dependence on boot-heap parity.
    // The premise assert below keeps that honest. (Crank 2 redeclares
    // the symbol sequence of crank 1's table — ids are positional.)
    let cranks = [
        "var arr = []; var i = 0; \
         for (i = 0; i < 2000; i = i + 1) { arr[i] = { v: i, w: i }; }; \
         arr[0].v",
        "var i; var v; var w; var length; var arr; \
         arr[0].v + arr[1999].w",
    ];
    let compiled: Vec<(Vec<u8>, Vec<String>)> = cranks.iter().map(|s| compile(s)).collect();

    let mut store = MemoryStore::new();
    let mut m = Interp::new();
    m.link_intrinsics(&compiled[0].1);
    assert!(m.run(&compiled[0].0).completed);
    let mut session = begin_store_session(m, &sig(), &mut store)
        .map_err(|(_, e)| e)
        .expect("begin");

    // Fixture premise: the summaries ALONE (GC roots, no side-table
    // roots) must fail to reach some live pages — otherwise this test
    // could not distinguish the fix from arena-edge luck. If boot-heap
    // layout drift ever re-aligns the fixture, this fails loudly and
    // the pad needs re-tuning, rather than the lock silently weakening.
    {
        use ironhorse_snapshot::store::{reachable_pages, slot_page_count, HeapStore};
        let interp = session.machine();
        let mut gc_root_pages: std::collections::BTreeSet<u32> = std::collections::BTreeSet::new();
        for r in interp.gc_roots() {
            if !r.is_null() {
                gc_root_pages.insert(r.0 / ironhorse_vm::SLOTS_PER_PAGE);
            }
        }
        let reached = reachable_pages(&store, gc_root_pages).expect("reachability");
        let total = slot_page_count(store.manifest().unwrap().slot_count);
        assert!(
            (reached.len() as u32) < total,
            "fixture premise: some live element pages must be invisible to \
             the arena summaries ({} of {total} reached)",
            reached.len()
        );
    }

    let freed = partial_collect(&mut session, &store).expect("partial collect");
    assert_eq!(
        freed, 0,
        "every element object is live through the array's side table"
    );

    // The elements are genuinely intact: read the first and last back.
    let o = session.machine_mut().run(&compiled[1].0);
    assert!(o.completed, "halt: {:?}", o.halt);
    assert_eq!(o.result, "1999", "0 + 1999 read back from live elements");
    checkpoint_to_store(&mut session, &sig(), &mut store).expect("checkpoint");
    let resumed = resume_from_store(&store, &sig()).expect("resume");
    assert_eq!(
        resumed.machine().write_snapshot(&sig()),
        session.machine().write_snapshot(&sig()),
        "store round-trip stays byte-exact"
    );
}

/// Phase 6 reclaim lock: page-isolated garbage — whole pages of dead
/// records with no inbound summary edge and no side-table holder — is
/// genuinely freed. This is the case partial collection exists for,
/// and the counterpart to the conservatism locks above (without it,
/// `freed == 0` everywhere would also pass).
#[test]
fn partial_collect_reclaims_page_isolated_garbage() {
    use ironhorse_snapshot::machine::{checkpoint_to_store, partial_collect};

    use ironhorse_vm::{Slot, SLOTS_PER_PAGE};

    let cranks = ["var t = 0; t = 7;", "var t; t + 1"];
    let compiled: Vec<(Vec<u8>, Vec<String>)> = cranks.iter().map(|s| compile(s)).collect();

    let mut store = MemoryStore::new();
    let mut m = Interp::new();
    m.link_intrinsics(&compiled[0].1);
    assert!(m.run(&compiled[0].0).completed);

    // Page-align the arena, then plant four whole pages of pure,
    // reference-free garbage records (integers: no link, no reference
    // — no edges in or out, no side-table holder). Hand-planting pins
    // the layout: JS allocation PARITY decides whether a run of
    // 2-slot objects straddles page boundaries, and a straddling run
    // chains every page (the conservatism case above) — the reclaim
    // lock must not hinge on that parity.
    while m.slots.capacity() % SLOTS_PER_PAGE != 0 {
        m.slots.alloc(Slot::integer(0));
    }
    for _ in 0..(4 * SLOTS_PER_PAGE) {
        m.slots.alloc(Slot::integer(7));
    }

    let mut session = begin_store_session(m, &sig(), &mut store)
        .map_err(|(_, e)| e)
        .expect("begin");

    let live_before = session.machine().slots.live_count();
    let freed = partial_collect(&mut session, &store).expect("partial collect");
    // The four planted pages are exactly page-isolated garbage; the
    // alignment filler shares its page with live records and is
    // conservatively kept.
    assert!(
        freed >= 4 * SLOTS_PER_PAGE,
        "page-isolated garbage reclaimed without content reads, got {freed}"
    );
    assert_eq!(
        session.machine().slots.live_count(),
        live_before - freed,
        "accounting tracks the frees exactly"
    );

    // The machine keeps executing, checkpointing, and resuming exactly
    // — and a later FULL collection over the partially collected heap
    // stays coherent (no stale side-table state survived the frees).
    let o = session.machine_mut().run(&compiled[1].0);
    assert!(o.completed, "halt: {:?}", o.halt);
    assert_eq!(o.result, "8");
    checkpoint_to_store(&mut session, &sig(), &mut store).expect("checkpoint");
    let resumed = resume_from_store(&store, &sig()).expect("resume");
    assert_eq!(
        resumed.machine().write_snapshot(&sig()),
        session.machine().write_snapshot(&sig()),
        "post-reclaim store round-trip is byte-exact"
    );
    session.machine_mut().collect_garbage();
}

/// Phase 9 bar: small state is O(1) in heap size — a machine with a
/// large free list (post-GC) stores a SMALL small-state row, with the
/// list riding in leafed segment rows instead.
#[test]
fn small_state_stays_small_with_a_large_free_list() {
    use ironhorse_snapshot::store::{free_seg_count, HeapStore};

    let cranks = [
        "var last = { v: 0 }; var t = 0; var i = 0; \
         for (i = 0; i < 3000; i = i + 1) { last = { v: i }; } \
         last = 0; t = 7;",
    ];
    let compiled: Vec<(Vec<u8>, Vec<String>)> = cranks.iter().map(|s| compile(s)).collect();
    let mut m = Interp::new();
    m.link_intrinsics(&compiled[0].1);
    assert!(m.run(&compiled[0].0).completed);
    // Full GC sweeps the dropped chain onto the free list.
    let stats = m.collect_garbage();
    assert!(stats.slots_reclaimed > 3000, "chain swept: {stats:?}");

    let mut store = MemoryStore::new();
    let session = begin_store_session(m, &sig(), &mut store)
        .map_err(|(_, e)| e)
        .expect("begin");
    let manifest = store.manifest().unwrap();
    assert!(manifest.free_len > 3000, "free list is genuinely large");
    let small_len = store.read_small_state().unwrap().len();
    assert!(
        small_len < 512,
        "small state is O(1) in heap size, got {small_len} bytes for \
         {} free entries",
        manifest.free_len
    );
    // The list itself rides in segment rows, leafed and verifiable —
    // and it genuinely spans MULTIPLE segments, so the split and the
    // reassembly are exercised, not just the single-segment case.
    let segs = free_seg_count(manifest.free_len);
    assert!(segs >= 2, "multi-segment split exercised, got {segs} segment(s)");
    let total: usize = (0..segs)
        .map(|s| store.read_free_seg(s).unwrap().len())
        .sum();
    assert_eq!(total, manifest.free_len as usize * 4);
    drop(session);

    // And the round-trip carries it exactly.
    let resumed = resume_from_store(&store, &sig()).expect("resume");
    assert_eq!(
        resumed.machine().slots.free_list().len() as u32,
        manifest.free_len
    );
}




