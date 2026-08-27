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
        resumed.machine().write_snapshot(&sig()).expect("quiescent machine snapshots"),
        oracle.write_snapshot(&sig()).expect("quiescent machine snapshots"),
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
    // Dead records keep their edges until their page is rewritten, so every
    // page still summary-linked from live pages is retained. Intrinsic boot
    // growth may shift the chain across page boundaries and expose some whole
    // pages with no such link; reclaiming those is safe and intentionally not
    // locked to a boot-allocation-sensitive exact count.
    assert!(freed <= live_before, "partial collection cannot free more than the arena holds");
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
        resumed.machine().write_snapshot(&sig()).expect("quiescent machine snapshots"),
        session.machine().write_snapshot(&sig()).expect("quiescent machine snapshots"),
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
        resumed.machine().write_snapshot(&sig()).expect("quiescent machine snapshots"),
        session.machine().write_snapshot(&sig()).expect("quiescent machine snapshots"),
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
        resumed.machine().write_snapshot(&sig()).expect("quiescent machine snapshots"),
        session.machine().write_snapshot(&sig()).expect("quiescent machine snapshots"),
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





/// Phase 9 proportionality lock (review follow-up): LIFO free-list
/// churn rewrites ONLY the tail segment. Allocation pops from the
/// list's tail, so a crank that reuses a handful of freed slots
/// leaves segment 0's 4096 entries byte-identical — the checkpoint's
/// segment diff must ship exactly one row, observed through
/// `CommitStats::free_segs_written` (the axis the review found
/// asserted in prose and measured by nothing).
#[test]
fn lifo_churn_rewrites_only_the_tail_free_segment() {
    use ironhorse_snapshot::machine::checkpoint_to_store;
    use ironhorse_snapshot::store::{free_seg_count, HeapStore};

    // Crank 2 mirrors crank 1's symbol order (last, v, t, i).
    let cranks = [
        "var last = { v: 0 }; var t = 0; var i = 0; \
         for (i = 0; i < 3000; i = i + 1) { last = { v: i }; } \
         last = 0; t = 7;",
        "var last; var v; var t; var i; last = { v: 1 }; t + 1",
    ];
    let compiled: Vec<(Vec<u8>, Vec<String>)> = cranks.iter().map(|s| compile(s)).collect();

    let mut m = Interp::new();
    m.link_intrinsics(&compiled[0].1);
    assert!(m.run(&compiled[0].0).completed);
    // Sweep the dropped chain onto the free list — thousands of
    // entries, spanning multiple segments.
    m.collect_garbage();

    let mut store = MemoryStore::new();
    let mut session = begin_store_session(m, &sig(), &mut store)
        .map_err(|(_, e)| e)
        .expect("begin");
    let segs_before = free_seg_count(store.manifest().unwrap().free_len);
    assert!(segs_before >= 2, "multi-segment premise, got {segs_before}");

    // A small crank: pops a few entries off the free-list TAIL.
    let o = session.machine_mut().run(&compiled[1].0);
    assert!(o.completed, "halt: {:?}", o.halt);
    checkpoint_to_store(&mut session, &sig(), &mut store).expect("checkpoint");

    let segs_after = free_seg_count(store.manifest().unwrap().free_len);
    assert_eq!(segs_before, segs_after, "fixture premise: no boundary crossing");
    assert_eq!(
        store.last_commit_stats().free_segs_written,
        1,
        "LIFO churn ships exactly the tail segment"
    );
}

#[test]
fn side_table_page_bits_agree_with_slot_enumeration() {
    // The two projections of the single side-table enumeration body
    // must name the same page set — the partial collector roots from
    // the bits, the tests and any future stored summary derive from
    // the slots, and drift between them is the unsoundness class the
    // enumeration refactor exists to prevent. The fixture populates
    // the bulk tables (an array's items, a Map's entries) and the
    // small ones (closures via a captured function, a promise chain
    // would need the event loop — the tables it does hit suffice to
    // catch a projection-level break).
    let build = "var arr = []; var m = new Map(); var f = 0; var i = 0; \
                 for (i = 0; i < 900; i = i + 1) { arr[i] = { v: i }; } \
                 for (i = 0; i < 300; i = i + 1) { m.set({ k: i }, { v: i }); } \
                 f = function (x) { return arr[x]; }; f(1).v";
    let (b, names) = compile(build);
    let mut m = Interp::new();
    m.link_intrinsics(&names);
    let o = m.run(&b);
    assert!(o.completed, "fixture halted: {:?}", o.halt);

    let from_slots: std::collections::BTreeSet<u32> = m
        .side_table_ref_slots()
        .iter()
        .filter(|r| !r.is_null())
        .map(|r| r.0 / ironhorse_vm::SLOTS_PER_PAGE)
        .collect();
    let from_bits: std::collections::BTreeSet<u32> = m
        .side_table_ref_page_bits()
        .into_iter()
        .enumerate()
        .filter_map(|(p, hit)| hit.then_some(p as u32))
        .collect();
    assert!(!from_bits.is_empty(), "fixture produced side-table refs");
    assert_eq!(from_bits, from_slots, "page-bit and slot projections agree");
}

#[test]
fn ephemeron_marking_reclaims_dead_keyed_weak_entries() {
    // The ephemeron pass (deferred-work checklist; this flips the old
    // `weak_collection_entries_are_retained_conservatively` pin
    // exactly as that pin promised): a WeakMap holds neither its keys
    // nor — on its own — its values. A value lives exactly while its
    // key does (fixpoint: a value that is itself the KEY of a second
    // entry carries that entry's value too), dead-keyed entries are
    // pruned before the sweep, and a live-keyed entry still answers
    // `get` afterwards.
    //
    // Fixture: one externally-held key (`keep`) whose entry chains to
    // a second entry (value-of-A is key-of-B); 300 map-only pairs
    // (dead by ephemeron semantics, ~1200 slots); 300 plain dropped
    // objects (~900 slots).
    let cranks = [
        "var wm = new WeakMap(); var keep = 0; var g = 0; var i = 0; var t = 0; \
         wm.get; keep.w; \
         keep = { k: 1 }; g = { k: 2 }; wm.set(keep, g); wm.set(g, { v: 3 }); g = 0; \
         for (i = 0; i < 300; i = i + 1) { wm.set({ k: i }, { v: i }); } \
         for (i = 0; i < 300; i = i + 1) { g = { v: i, w: i }; } \
         g = 0; t = 7; t",
        "var wm; var keep; var g; var i; var t; g = WeakMap; g = 0; \
         wm.set; keep.w; \
         g = wm.get(keep); t = g.k; g = wm.get(g); t = t + g.v; \
         i = 0; i < 1; t",
    ];
    let compiled: Vec<(Vec<u8>, Vec<String>)> = cranks.iter().map(|s| compile(s)).collect();
    let mut m = Interp::new();
    m.link_intrinsics(&compiled[0].1);
    let o1 = m.run(&compiled[0].0);
    assert!(o1.completed, "fixture halted: {:?}", o1.halt);
    assert_eq!(o1.result, "7");

    let stats = m.collect_garbage();
    assert!(
        stats.slots_reclaimed >= 2000,
        "dead-keyed weak entries AND the plain garbage reclaim: {stats:?}"
    );

    // The live-keyed chain survives: keep -> {k:2} -> {v:3}.
    let o2 = m.run(&compiled[1].0);
    assert!(o2.completed, "halt: {:?}", o2.halt);
    assert_eq!(o2.result, "5", "get() answers through the ephemeron chain after GC");
}

#[test]
fn weak_set_membership_keeps_nothing_alive() {
    // WeakSet: membership is not an edge — a member lives only
    // through outside references; dead members are pruned and a live
    // member still answers `has` after the collection.
    let cranks = [
        "var ws = new WeakSet(); var keep = 0; var g = 0; var i = 0; var t = 0; \
         ws.has; \
         keep = { k: 1 }; ws.add(keep); \
         for (i = 0; i < 200; i = i + 1) { ws.add({ k: i }); } \
         g = 0; t = 1; t",
        "var ws; var keep; var g; var i; var t; g = WeakSet; g = 0; ws.add; keep.k; \
         t = 0; if (ws.has(keep)) { t = 1; } t",
    ];
    let compiled: Vec<(Vec<u8>, Vec<String>)> = cranks.iter().map(|s| compile(s)).collect();
    let mut m = Interp::new();
    m.link_intrinsics(&compiled[0].1);
    let o1 = m.run(&compiled[0].0);
    assert!(o1.completed, "fixture halted: {:?}", o1.halt);
    let stats = m.collect_garbage();
    assert!(
        stats.slots_reclaimed >= 380,
        "set-only members are dead by ephemeron semantics: {stats:?}"
    );
    let o2 = m.run(&compiled[1].0);
    assert!(o2.completed, "halt: {:?}", o2.halt);
    assert_eq!(o2.result, "1", "the externally-held member is still a member");
}

#[test]
fn symbol_key_descriptor_survives_collection() {
    // The PR review's symbol-key finding: a symbol used only as a
    // property key is held BY ID in the property record — no arena
    // reference reaches its descriptor slot, and `symbol_key_ids` is
    // the only descriptor→id link. Before the fix, collection swept
    // the descriptor and dropped the mapping, after which the
    // string-key enumerations misclassified the still-live symbol
    // property. Retention is PRECISE now (the deferred pass): the
    // ephemeron pass keeps a descriptor exactly while its interned id
    // sits on a marked property record — here `o` is live, so the
    // descriptor and the partition survive a full collect; the twin
    // test below proves the dead-keyed case reclaims. Crank 2 must
    // compile to crank 1's exact symbol table (same names, same
    // first-appearance order where names hash-collide — wave 3
    // falsified the looser "same set suffices" claim), so it
    // references exactly crank 1's names — the vars, the property
    // names (`a` via a read, `v`/`w` via reads), and the intrinsics
    // (`Symbol` via a reference).
    let cranks = [
        "var o = 0; var g = 0; var i = 0; var sym = 0; \
         o = { a: 1 }; sym = Symbol('key'); o[sym] = 42; sym = 0; \
         for (i = 0; i < 200; i = i + 1) { g = { v: i, w: i }; } g = 0; \
         Object.keys(o).length",
        "var o; var g; var i; var sym; \
         g = o.a; g = o.v; g = o.w; sym = Symbol; sym = 0; g = 0; \
         Object.keys(o).length",
    ];
    let compiled: Vec<(Vec<u8>, Vec<String>)> = cranks.iter().map(|s| compile(s)).collect();
    let mut m = Interp::new();
    m.link_intrinsics(&compiled[0].1);
    let o1 = m.run(&compiled[0].0);
    assert!(o1.completed, "crank 1 halted: {:?}", o1.halt);
    assert_eq!(o1.result, "1", "the symbol key is partitioned out before GC");
    let stats = m.collect_garbage();
    assert!(stats.slots_reclaimed > 0, "the plain garbage was real: {stats:?}");
    let o2 = m.run(&compiled[1].0);
    assert!(o2.completed, "crank 2 halted: {:?}", o2.halt);
    assert_eq!(
        o2.result, "1",
        "the symbol-key descriptor survived collection, so enumeration still partitions it"
    );
}

#[test]
fn partial_collect_under_bulk_table_churn_stays_parity_clean() {
    use ironhorse_snapshot::machine::{checkpoint_to_store, partial_collect};
    // The counted-accessor churn arm (design § Plan: counted
    // side-table ref-page accessors): drive the bulk tables through
    // their full mutation surface — dynamic element writes, a
    // length-truncation drop, shift/unshift whole-map rebuilds, Map
    // set/overwrite/delete/clear — with a partial collection at every
    // clean boundary. In debug builds EVERY projection call
    // cross-checks the standing per-page counts against a fresh
    // enumeration (the parity net in `side_table_ref_page_bits`), so
    // this test is the churn oracle; the pinned results prove the
    // machine still computes.
    // One crank text discipline: every crank references the SAME name
    // set (program-symbol ids are table positions; the file's other
    // fixtures anchor unused names the same way).
    let cranks = [
        // Build: 400 array-held objects (dynamic index), a Map of 60
        // object->object pairs, a dropped 300-object chain, then
        // truncate the array to 200 (the remove_item drop loop).
        "var arr = []; var m = new Map(); var g = 0; var i = 0; var k = 0; var t = 0; \
         arr.unshift; arr.shift; m.clear; \
         for (i = 0; i < 400; i = i + 1) { arr[i] = { v: i, w: i }; } \
         for (i = 0; i < 60; i = i + 1) { k = { v: i, w: 0 }; m.set(k, { v: 0, w: i }); } \
         for (i = 0; i < 300; i = i + 1) { g = { v: i, w: i }; } \
         g = 0; arr.length = 200; t = 7; t",
        // Churn: unshift/shift (replace_items paths), overwrite the
        // low elements, clear the Map and repopulate small, then read
        // through a DYNAMIC index (the items-map path).
        "var arr; var m; var g; var i; var k; var t; g = Map; g = 0; \
         arr.unshift({ v: 9, w: 9 }); arr.shift(); \
         for (i = 0; i < 50; i = i + 1) { arr[i] = { v: i + 1000, w: i }; } \
         m.clear(); \
         for (i = 0; i < 10; i = i + 1) { k = { v: i, w: 1 }; m.set(k, k); } \
         i = 10; t = arr[i].v; t; arr.length; t",
        // Post-collect integrity read, same name set.
        "var arr; var m; var g; var i; var k; var t; g = Map; g = 0; \
         arr.unshift; arr.shift; m.clear; m.set; k = { v: 0, w: 0 }; \
         i = 5; t = arr[i].v + 1; arr.length; t",
    ];
    let compiled: Vec<(Vec<u8>, Vec<String>)> = cranks.iter().map(|s| compile(s)).collect();

    let mut m = Interp::new();
    m.link_intrinsics(&compiled[0].1);
    let o1 = m.run(&compiled[0].0);
    assert!(o1.completed, "halt: {:?}", o1.halt);
    assert_eq!(o1.result, "7");

    let mut store = MemoryStore::new();
    let mut session = begin_store_session(m, &sig(), &mut store)
        .map_err(|(_, e)| e)
        .expect("begin");
    let freed_1 = partial_collect(&mut session, &store).expect("collect after build");
    assert!(freed_1 > 0, "the dropped chain reclaims: {freed_1}");
    checkpoint_to_store(&mut session, &sig(), &mut store).expect("checkpoint");

    let o2 = session.machine_mut().run(&compiled[1].0);
    assert!(o2.completed, "halt: {:?}", o2.halt);
    assert_eq!(o2.result, "1010", "post-churn dynamic read");
    checkpoint_to_store(&mut session, &sig(), &mut store).expect("checkpoint");
    let _freed_2 = partial_collect(&mut session, &store).expect("collect after churn");

    let o3 = session.machine_mut().run(&compiled[2].0);
    assert!(o3.completed, "halt: {:?}", o3.halt);
    assert_eq!(o3.result, "1006", "the churned state survives the collections");
}

#[test]
fn dead_keyed_symbol_interns_are_reclaimed_precisely() {
    // The twin of `symbol_key_descriptor_survives_collection`: when
    // the last object carrying a symbol-keyed property DIES, the
    // descriptor, its intern, and its description chunk go with it —
    // the old behavior rooted every intern forever (retention-only,
    // but a leak per dead symbol key). A live plain-keyed object
    // rides through untouched, and symbols keep working afterwards.
    let cranks = [
        "var o = 0; var g = 0; var i = 0; var sym = 0; \
         for (i = 0; i < 50; i = i + 1) { sym = Symbol('key'); o = { a: 1 }; o[sym] = 42; } \
         o = 0; sym = 0; g = { a: 7 }; g.a",
        "var o; var g; var i; var sym; \
         o = { a: 2 }; sym = Symbol('key'); o[sym] = 9; i = o[sym]; g.a + i",
    ];
    let compiled: Vec<(Vec<u8>, Vec<String>)> = cranks.iter().map(|s| compile(s)).collect();
    let mut m = Interp::new();
    m.link_intrinsics(&compiled[0].1);
    let o1 = m.run(&compiled[0].0);
    assert!(o1.completed, "fixture halted: {:?}", o1.halt);
    assert_eq!(o1.result, "7");

    let stats = m.collect_garbage();
    // 50 dead owners (2-slot objects + their symbol property slots)
    // and 50 dead descriptors; the exact figure rides slot layout, so
    // bound it from below well past what plain-object garbage alone
    // would explain, and require the description chunks to compact.
    assert!(
        stats.slots_reclaimed >= 200,
        "dead symbol-keyed owners AND their descriptors reclaim: {stats:?}"
    );
    assert!(
        stats.chunk_bytes_after < stats.chunk_bytes_before,
        "the dead descriptions' chunks compact away: {stats:?}"
    );

    // Symbols still intern and read back after the precise sweep.
    let o2 = m.run(&compiled[1].0);
    assert!(o2.completed, "halt: {:?}", o2.halt);
    assert_eq!(o2.result, "16", "a fresh symbol key works after the reclamation");
}

#[test]
fn generational_collect_frees_new_garbage_and_never_more_than_partial() {
    use ironhorse_snapshot::machine::{
        checkpoint_to_store, generational_collect, partial_collect,
    };
    // Phase 11's semantic lock, run as TWINS from identical state:
    // the generational pass (candidates = pages dirtied since the
    // last collect) frees new page-isolated garbage, never frees a
    // page the full partial pass would keep (retention-only
    // divergence), and the machine computes identically afterwards.
    let cranks = [
        // Old generation: live structure plus a dropped chain, then a
        // collect to draw the generation boundary.
        "var keep = 0; var g = 0; var i = 0; var t = 0; \
         keep = { v: 0, w: 0 }; \
         for (i = 0; i < 800; i = i + 1) { keep = { v: i, w: i }; } \
         t = 1; t",
        // New generation: fresh garbage (page-isolated chain) plus a
        // little live growth.
        "var keep; var g; var i; var t; \
         for (i = 0; i < 900; i = i + 1) { g = { v: i, w: i }; } \
         g = 0; keep = { v: -1, w: -1 }; t = 2; t",
        // The read that proves state survived either collector (the
        // `keep.w` read anchors `w` so the crank's symbol table
        // matches the earlier cranks').
        "var keep; var g; var i; var t; keep.w; t = keep.v; t",
    ];
    let compiled: Vec<(Vec<u8>, Vec<String>)> = cranks.iter().map(|s| compile(s)).collect();

    let run_twin = |generational: bool| -> (u32, String, u64) {
        let mut store = MemoryStore::new();
        let mut m = Interp::new();
        m.link_intrinsics(&compiled[0].1);
        assert!(m.run(&compiled[0].0).completed);
        let mut session = begin_store_session(m, &sig(), &mut store)
            .map_err(|(_, e)| e)
            .expect("begin");
        // Draw the generation boundary: everything to here is OLD.
        let _ = partial_collect(&mut session, &store).expect("boundary collect");
        checkpoint_to_store(&mut session, &sig(), &mut store).expect("checkpoint");

        let o = session.machine_mut().run(&compiled[1].0);
        assert!(o.completed, "halt: {:?}", o.halt);
        checkpoint_to_store(&mut session, &sig(), &mut store).expect("checkpoint");

        let freed = if generational {
            generational_collect(&mut session, &store).expect("generational")
        } else {
            partial_collect(&mut session, &store).expect("partial")
        };
        let o = session.machine_mut().run(&compiled[2].0);
        assert!(o.completed, "halt: {:?}", o.halt);
        (freed, o.result, o.computrons)
    };

    let (freed_gen, r_gen, c_gen) = run_twin(true);
    let (freed_part, r_part, c_part) = run_twin(false);
    assert!(freed_gen > 0, "the new dropped chain reclaims: {freed_gen}");
    assert!(
        freed_gen <= freed_part,
        "retention-only divergence: gen {freed_gen} <= partial {freed_part}"
    );
    assert_eq!(r_gen, r_part, "the surviving state agrees");
    assert_eq!(r_gen, "-1");
    assert_eq!(c_gen, c_part, "the meter agrees across collector choices");
}

#[test]
fn generational_collect_is_a_noop_with_no_new_dirt() {
    use ironhorse_snapshot::machine::{generational_collect, partial_collect};
    // Right after a full partial collect the candidate set is empty:
    // the generational pass frees nothing and touches nothing.
    let (b, names) = compile(
        "var g = 0; var i = 0; \
         for (i = 0; i < 400; i = i + 1) { g = { v: i, w: i }; } g = 0;",
    );
    let mut m = Interp::new();
    m.link_intrinsics(&names);
    assert!(m.run(&b).completed);
    let mut store = MemoryStore::new();
    let mut session = begin_store_session(m, &sig(), &mut store)
        .map_err(|(_, e)| e)
        .expect("begin");
    let freed = partial_collect(&mut session, &store).expect("partial");
    assert!(freed > 0);
    let again = generational_collect(&mut session, &store).expect("generational");
    assert_eq!(again, 0, "no dirt since the last collect, nothing to examine");
}
