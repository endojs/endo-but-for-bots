//! Wave-6 contract-violation locks (W6-10, W6-12, W6-13): the persist
//! verbs versus machines that violate their preconditions. This is the
//! test genre the wave-6 analysis found missing everywhere: every gate
//! was tested from the compliant side only.
//!
//! - A HALTED crank returns a non-quiescent machine (pending microtask
//!   queue, populated call stack, set exception, mid-frame value
//!   stack); persisting one serializes the mid-frame stack while
//!   silently dropping the rest — a resumed chimera. Every persist
//!   verb must refuse it (W6-10).
//! - The dynamic-segments refusal must cover the BLOB verbs, not just
//!   the store verbs (W6-12).
//! - A resumed machine must be re-armable WITHOUT destroying its
//!   restored computron count (W6-13): `arm_meter` (a fresh window)
//!   zeroes the index by design; `rearm_meter` preserves it.
//! - Quiescence is a LIFECYCLE property (architecture review F011,
//!   F030/F022): a crank halted at a top-level meter check, the
//!   dispatch ceiling, or a decode fault leaves every table empty and
//!   must still be refused by every verb, while the synthetic
//!   host-boundary throw for an uncoercible completion value must
//!   leave a quiescent machine whose continuous and resumed twins
//!   agree after a boundary collection.

use ironhorse_snapshot::machine::{
    begin_store_session, checkpoint_to_store, from_snapshot_bytes, resume_from_store,
    MachineSnapshot,
};
use ironhorse_snapshot::machine::MachineSnapshotError;
use ironhorse_snapshot::store::{HeapStore, MemoryStore, StoreError};
use ironhorse_snapshot::Signature;
use ironhorse_vm::Interp;

fn sig() -> Signature {
    Signature::new("ironhorse-worker-v1")
}

fn compile(src: &str) -> (Vec<u8>, Vec<String>) {
    let (b, s) = ironhorse_compile::compile_atoms(src).expect("compiles");
    (b, ironhorse_vm::parse_symbols(&s))
}

/// A machine whose last crank halted on an uncaught top-level throw:
/// exception set, host-escaped without unwinding.
fn halted_machine() -> Interp {
    let (b, n) = compile("var x = 0; x = 1; throw 'boom';");
    let mut m = Interp::new();
    m.link_intrinsics(&n);
    let o = m.run(&b);
    assert!(!o.completed, "the fixture crank must halt");
    m
}

#[test]
fn a_halted_machine_refuses_to_begin_a_store_session() {
    let mut store = MemoryStore::new();
    assert!(
        begin_store_session(halted_machine(), &sig(), &mut store).is_err(),
        "a post-throw machine is not quiescent and must not begin a session"
    );
}

#[test]
fn a_halted_crank_refuses_checkpoint_and_writes_nothing() {
    let (b0, n0) = compile("var x = 0; x = 1; x");
    let mut m = Interp::new();
    m.link_intrinsics(&n0);
    let mut store = MemoryStore::new();
    let mut session = begin_store_session(m, &sig(), &mut store)
        .map_err(|(_, e)| e)
        .expect("a clean machine begins");
    assert!(session.machine_mut().run(&b0).completed);
    checkpoint_to_store(&mut session, &sig(), &mut store).expect("clean checkpoint");
    let epoch_before = store.manifest().unwrap().epoch;

    let (b1, n1) = compile("var x; throw 'mid';");
    let b1 = session.machine_mut().relink_crank(&b1, &n1).expect("relink");
    let o = session.machine_mut().run(&b1);
    assert!(!o.completed, "the halting crank must halt");
    assert!(
        checkpoint_to_store(&mut session, &sig(), &mut store).is_err(),
        "a halted crank must not checkpoint (rewind is the caller's move)"
    );
    assert_eq!(
        store.manifest().unwrap().epoch,
        epoch_before,
        "the refusal must land before anything is written"
    );
}

#[test]
fn a_halted_machine_refuses_the_blob_verbs() {
    let m = halted_machine();
    assert!(
        m.write_snapshot(&sig()).is_err(),
        "the in-memory blob verb must refuse a non-quiescent machine"
    );
}

#[test]
fn a_completed_machine_still_passes_the_blob_verbs() {
    let (b, n) = compile("var x = 0; x = 41; x");
    let mut m = Interp::new();
    m.link_intrinsics(&n);
    assert!(m.run(&b).completed);
    m.write_snapshot(&sig())
        .expect("a quiescent completed machine snapshots as before");
}

/// The former W6-12 refusal flips once retained function state travels:
/// a blob carries an eval-defined function and its defining segment.
#[test]
fn a_live_eval_function_round_trips_the_blob_verbs() {
    struct TestCompiler;
    impl ironhorse_vm::SourceCompiler for TestCompiler {
        fn compile_source(
            &self,
            source: &str,
            strict: bool,
        ) -> Result<ironhorse_vm::CompiledSource, ironhorse_vm::SourceCompileError> {
            match ironhorse_compile::compile_atoms_with(source, strict) {
                Ok((bytecode, symbols)) => Ok(ironhorse_vm::CompiledSource { bytecode, symbols }),
                Err(_) => Err(ironhorse_vm::SourceCompileError::Syntax(String::new())),
            }
        }
    }
    let (b, n) =
        compile("var f = 0; f = eval('(function (x) { return x + 1; })'); var t = 0; t = f(1); t");
    let mut m = Interp::new();
    m.link_intrinsics(&n);
    m.set_source_compiler(std::rc::Rc::new(TestCompiler));
    let o = m.run(&b);
    assert!(o.completed, "eval crank: {:?}", o.halt);
    assert!(
        m.live_dynamic_segment_function().is_some(),
        "the escaped function is the live segment witness"
    );
    let bytes = m.write_snapshot(&sig()).expect("retained function snapshots");
    let mut restored = from_snapshot_bytes(&bytes, &sig()).expect("restore");
    let (b2, n2) = compile("var f; var t; t = f(41); t");
    let b2 = restored.relink_crank(&b2, &n2).expect("relink");
    let out = restored.run(&b2);
    assert!(out.completed, "resumed eval function: {:?}", out.halt);
    assert_eq!(out.result, "42");
}

/// W6-13: `rearm_meter` preserves the restored computron index, and the
/// re-armed machine actually meter-aborts — the behavioral half the old
/// armed-meter test never ran.
#[test]
fn a_resumed_machine_rearms_without_losing_its_meter() {
    let (b, n) = compile("var i = 0; for (i = 0; i < 200; i++) { i = i; } i");
    let mut m = Interp::new();
    m.link_intrinsics(&n);
    m.arm_meter(1_000_000, Box::new(|_| true));
    assert!(m.run(&b).completed);
    let spent = m.meter_index();
    assert!(spent > 0, "the armed crank metered");

    let mut store = MemoryStore::new();
    let mut session = begin_store_session(m, &sig(), &mut store)
        .map_err(|(_, e)| e)
        .expect("begin");
    checkpoint_to_store(&mut session, &sig(), &mut store).expect("checkpoint");
    drop(session);
    let mut resumed = resume_from_store(&store, &sig()).expect("resume");

    // The fresh-window API zeroes by design; the resume API must not.
    resumed
        .machine_mut()
        .rearm_meter(1_000_000, Box::new(|_| true));
    assert_eq!(
        resumed.machine_mut().meter_index(),
        spent,
        "rearm_meter must preserve the restored computron count"
    );

    // And the re-armed machine really is armed: a hostile host verdict
    // aborts the next crank.
    resumed
        .machine_mut()
        .rearm_meter(1, Box::new(|_| false));
    let (b2, n2) = compile("var j = 0; for (j = 0; j < 100000; j++) { j = j; } j");
    let b2 = resumed.machine_mut().relink_crank(&b2, &n2).expect("relink");
    let o2 = resumed.machine_mut().run(&b2);
    assert!(
        matches!(o2.halt, ironhorse_vm::Halt::MeterAbort),
        "the re-armed meter must fire: {:?}",
        o2.halt
    );
}

/// Review finding 7: a resume that only wants its host callback back
/// must not move the check deadline. `rearm_meter` opens a fresh window
/// from the preserved index (`count = index + interval`) — right for a
/// deliberate interval change, but through it every sub-interval
/// suspend/resume cycle pushes the host deadline forward, so a machine
/// checkpointed often enough would never consult its host.
/// `reattach_meter_host` reinstalls the callback and leaves all three
/// restored counters exactly as the snapshot carried them.
#[test]
fn a_resumed_machine_reattaches_without_moving_the_meter_deadline() {
    use std::cell::Cell;
    use std::rc::Rc;

    // Crank 1 spends most of a window; crank 2 is cheap but crosses
    // what REMAINS of it. Measure both costs on a scratch machine so
    // the armed interval can be pinned strictly between `spent1` and
    // `spent1 + spent2`.
    let crank1_src = "var i = 0; for (i = 0; i < 2000; i++) { i = i; } i";
    let crank2_src = "var j = 0; var i; for (j = 0; j < 50; j++) { j = j; } j";
    let (b1, n1) = compile(crank1_src);
    let mut scratch = Interp::new();
    scratch.link_intrinsics(&n1);
    assert!(scratch.run(&b1).completed);
    let spent1 = scratch.meter_index();
    let (b2s, n2s) = compile(crank2_src);
    let b2s = scratch.relink_crank(&b2s, &n2s).expect("relink");
    assert!(scratch.run(&b2s).completed);
    let spent2 = scratch.meter_index() - spent1;
    // Two computrons past crank 1's spend: inside crank 2's window by a
    // wide margin (a 50-iteration loop meters far beyond 2 computrons).
    let interval = (spent1 >> 16) + 2;
    assert!(spent1 < interval << 16, "interval must clear crank 1");
    assert!(interval << 16 < spent1 + spent2, "and land inside crank 2");

    let mut m = Interp::new();
    m.link_intrinsics(&n1);
    m.arm_meter(interval, Box::new(|_| true));
    assert!(m.run(&b1).completed, "crank 1 stays inside the window");
    let mid_window = m.meter_state();
    assert_eq!(mid_window.index, spent1, "armed crank 1 spent as measured");

    let mut store = MemoryStore::new();
    let mut session = begin_store_session(m, &sig(), &mut store)
        .map_err(|(_, e)| e)
        .expect("begin");
    checkpoint_to_store(&mut session, &sig(), &mut store).expect("checkpoint");
    drop(session);
    let mut resumed = resume_from_store(&store, &sig()).expect("resume");

    // The pure reattach: every restored counter — the `count` deadline
    // included — survives untouched. (`rearm_meter` here would move
    // `count` to `index + interval`, past everything crank 2 spends.)
    let consulted = Rc::new(Cell::new(0u32));
    let seen = consulted.clone();
    resumed.machine_mut().reattach_meter_host(Box::new(move |_| {
        seen.set(seen.get() + 1);
        true
    }));
    assert_eq!(
        resumed.machine_mut().meter_state(),
        mid_window,
        "reattach_meter_host must not touch the restored meter counters"
    );

    let (b2, n2) = compile(crank2_src);
    let b2 = resumed.machine_mut().relink_crank(&b2, &n2).expect("relink");
    assert!(resumed.machine_mut().run(&b2).completed);
    assert!(
        consulted.get() >= 1,
        "crank 2 crossed the ORIGINAL deadline, so the host must be consulted"
    );
}

// ---------------------------------------------------------------
// The residual persist gate (`stored_unpersistable_row`): the
// refuse-on-hold arms, and until wave 6 the one gate with no test of
// its own -- disabling it entirely left every test binary green.
//
// Its traversal half answers one question: does this machine HOLD a
// reference to a function slot that resume cannot bring back? Since
// the promise-cluster carry (`PRMS`, schema 23) retired the LAST
// guest-storable runtime mint -- the promise resolver, whose
// `FuncInfo` restore now rebuilds -- every reachable machine's doomed
// set is EMPTY and the traversal is a future-proofing net: a NEW
// runtime `alloc_method` mint that escapes to the guest re-arms it,
// and the fixtures below (which mint resolvers into every holder
// shape the traversal walks) become its regression bed.
//
// The refuse-on-hold arms that remain are the ASYNC ones: a promise
// reaction whose kind would resume a still-Pending async frame, and a
// live async generator (a guest-held object whose row `.next()`
// consults in every state). Both refuse by name until their atoms
// land -- the recorded lift.

fn resolver_fixture(tail: &str) -> Interp {
    let src = format!(
        "var g = 0; var p = 0; var o = 0; var s = 0; var b = 0; o = {{}}; \
         p = new Promise(function (res, rej) {{ g = res; }}); {tail} 7"
    );
    let (b, n) = compile(&src);
    let mut m = Interp::new();
    m.link_intrinsics(&n);
    let out = m.run(&b);
    assert!(out.completed, "fixture crank: {:?}", out.halt);
    m
}

fn assert_every_persist_verb_refuses(m: Interp, row: &str) {
    assert_eq!(
        m.stored_unpersistable_row(),
        Some(row),
        "the gate names the holder"
    );
    match m.write_snapshot(&sig()) {
        Err(MachineSnapshotError::PendingStateUnsupported { row: named }) => {
            assert_eq!(named, row, "the blob verb refuses by the same name")
        }
        other => panic!("the blob verb must refuse: {other:?}"),
    }
    let mut store = MemoryStore::new();
    match begin_store_session(m, &sig(), &mut store) {
        Err((_, StoreError::PendingStateUnsupported { row: named })) => {
            assert_eq!(named, row, "the store verb refuses by the same name")
        }
        Err((_, other)) => panic!("the store verb refused by the wrong gate: {other:?}"),
        Ok(_) => panic!("the store verb must refuse"),
    }
    assert!(store.manifest().is_err(), "a refused begin writes nothing");
}

/// The three holder shapes the gate REFUSED before the promise-cluster
/// carry: a resolver as an accessor getter, as a bound target, and as
/// a disposal method. All three persist now — `PRMS` rebuilds the
/// resolver's `FuncInfo`, so each holder resumes callable instead of
/// dead. (The deep behavioral twin for a stored resolver lives in
/// `promise_carry.rs`.)
#[test]
fn a_held_resolver_persists_in_every_former_refusal_holder() {
    for tail in [
        "Object.defineProperty(o, 'x', { get: g });",
        "b = g.bind(null);",
        "s = new DisposableStack(); s.adopt(1, g);",
    ] {
        let m = resolver_fixture(tail);
        assert_eq!(m.stored_unpersistable_row(), None, "now persists: {tail}");
        assert!(m.write_snapshot(&sig()).is_ok(), "blob verb: {tail}");
        let mut store = MemoryStore::new();
        assert!(
            begin_store_session(m, &sig(), &mut store).is_ok(),
            "store verb: {tail}"
        );
    }
}

/// The refuse-on-hold arms that REMAIN: async machinery whose instance
/// rows are still Pending. An `await` suspension is anchored by its
/// reaction on the awaited promise; an async generator is a guest-held
/// object whose row every `.next()` consults. Each refuses by name,
/// on every verb, writing nothing.
#[test]
fn a_pending_await_refuses_every_persist_verb() {
    let (b, n) = compile(
        "var p = 0; var t = 0; \
         p = (async function () { await new Promise(function (rs, rj) {}); })(); t = 7; t",
    );
    let mut m = Interp::new();
    m.link_intrinsics(&n);
    let out = m.run(&b);
    assert!(out.completed, "fixture crank: {:?}", out.halt);
    assert_every_persist_verb_refuses(
        m,
        "a promise reaction that would resume a non-persisted async frame",
    );
}

#[test]
fn a_live_async_generator_refuses_every_persist_verb() {
    let (b, n) = compile(
        "var ag = 0; var t = 0; ag = (async function* () { yield 1; })(); t = 7; t",
    );
    let mut m = Interp::new();
    m.link_intrinsics(&n);
    let out = m.run(&b);
    assert!(out.completed, "fixture crank: {:?}", out.halt);
    assert_every_persist_verb_refuses(m, "an async generator whose state does not yet persist");
}

#[test]
fn the_persistable_function_classes_are_not_refused() {
    // The gate must stay narrow: each of these holds a function that
    // resume DOES bring back, in the same three holders. A gate that
    // refused any of them would make ordinary programs unpersistable.
    // Every tail still ends by DROPPING the resolver — before the
    // promise-cluster carry that made these the sharper controls (a
    // non-empty doomed set whose traversal finds nothing stored); the
    // resolver itself persists now, so the drop is inert, but the
    // fixtures keep minting one so a regression that ejects resolvers
    // from `function_persists` re-fails here first.
    for tail in [
        // A guest bytecode function: carried by `FUNC`.
        "Object.defineProperty(o, 'x', { get: function () { return 1; } });",
        "b = (function () { return 1; }).bind(null);",
        "s = new DisposableStack(); s.adopt(1, function () {});",
        // A boot native: below `boot_slot_count`, re-minted by a fresh
        // boot at the same index.
        "Object.defineProperty(o, 'x', { get: Object.keys });",
        "b = Object.keys.bind(null);",
        // A proxy revoker: rebuilt from the carried proxy state.
        "var r = 0; r = Proxy.revocable({}, {}); b = r.revoke.bind(null);",
        // An Intl bound native: carried by `IBFN`, and the case whose
        // RESTORE ordering this round also fixed.
        "var nf = 0; nf = new Intl.NumberFormat('en'); b = nf.format.bind(null);",
        "var c = 0; c = new Intl.Collator('en'); \
         Object.defineProperty(o, 'x', { get: c.compare });",
    ] {
        let m = resolver_fixture(&format!("{tail} g = 0;"));
        assert_eq!(
            m.stored_unpersistable_row(),
            None,
            "must stay persistable: {tail}"
        );
        assert!(m.write_snapshot(&sig()).is_ok(), "blob verb: {tail}");
        let mut store = MemoryStore::new();
        assert!(
            begin_store_session(m, &sig(), &mut store).is_ok(),
            "store verb: {tail}"
        );
    }
}

/// Phase 8's evict/re-fault discipline, the half the leaves fix
/// missed. A lazily resumed session freezes its backing's geometry at
/// attach; its own checkpoints then advance it, because a
/// committed-then-clean row is EVICTABLE and can therefore fault
/// again, and must verify against what that commit wrote rather than
/// the attach-time bytes. The leaves and the record count both
/// advanced there; the chunk-offset bound did not.
///
/// So a crank that allocates a string grows the chunk arena, the
/// checkpoint commits slot rows pointing into the new bytes, and
/// re-faulting one of those rows verified its offset against the
/// attach-time length -- reporting a perfectly healthy store as
/// `corrupt store` (a panic, on the release path too). It needs no
/// hostile input, only an eviction between a growing checkpoint and
/// the next read.
#[test]
fn a_refault_after_a_growing_checkpoint_verifies_against_the_committed_arena() {
    use ironhorse_snapshot::machine::resume_from_store_lazy;
    use std::cell::RefCell;
    use std::rc::Rc;

    let cranks = [
        "var s = 0; var t = 0; s = 'seed';",
        "var s; var t; s = s + '-grown-past-the-attach-time-chunk-arena-length'; s",
        "var s; var t; t = s; t",
    ];
    let compiled: Vec<_> = cranks.iter().map(|c| compile(c)).collect();

    let store = Rc::new(RefCell::new(MemoryStore::new()));
    let mut m = Interp::new();
    m.link_intrinsics(&compiled[0].1);
    assert!(m.run(&compiled[0].0).completed, "crank 1");
    drop(
        begin_store_session(m, &sig(), &mut *store.borrow_mut())
            .map_err(|(_, e)| e)
            .expect("begin"),
    );

    let mut session = resume_from_store_lazy(store.clone(), &sig()).expect("lazy resume");
    let attach_len = store.borrow().manifest().expect("manifest").chunk_len;

    // The growing crank, then the session's own checkpoint.
    assert!(session.machine_mut().run(&compiled[1].0).completed, "crank 2");
    checkpoint_to_store(&mut session, &sig(), &mut *store.borrow_mut()).expect("checkpoint");
    let grown_len = store.borrow().manifest().expect("manifest").chunk_len;
    assert!(
        grown_len > attach_len,
        "the fixture must actually grow the chunk arena ({attach_len} -> {grown_len})"
    );

    // Throw the just-committed, now-clean rows away and read them back.
    // Pre-fix this panicked: `out-of-arena chunk offset ... corrupt store`.
    let pages = session.machine().slots.capacity().div_ceil(256);
    let mut evicted = 0;
    for page in 0..pages {
        evicted += session.machine().slots.evict_page(page) as u32;
    }
    assert!(evicted > 0, "the arm's premise: something was evictable");

    let out = session.machine_mut().run(&compiled[2].0);
    assert!(out.completed, "crank 3 after the evict sweep: {:?}", out.halt);
    assert_eq!(
        out.result, "seed-grown-past-the-attach-time-chunk-arena-length",
        "the re-faulted string is intact"
    );
    checkpoint_to_store(&mut session, &sig(), &mut *store.borrow_mut())
        .expect("checkpoint after the re-faults");
}

/// Enumerating HOLDERS cannot be complete: every carried row adds one.
/// The round-2 gate inspected accessors, `bound_functions[..].target`,
/// and disposal methods -- so a non-persisting runtime native reached
/// the store through any other stored reference. The gate traverses
/// the persisted state now instead of enumerating holders, so it is
/// complete by construction rather than by memory.
///
/// Since the promise-cluster carry the resolver these fixtures mint
/// PERSISTS, so every holder shape the traversal walks now ADMITS —
/// and each must resume with the resolver still callable, which is
/// what makes these the traversal's regression bed: a future runtime
/// mint that escapes into any of these holders re-arms the refusal,
/// and a `function_persists` regression fails the admissions below.
#[test]
fn a_resolver_reached_through_any_stored_reference_persists() {
    for (name, tail) in [
        ("a plain global", "g = g;"),
        ("a plain property", "o = {}; o.x = g;"),
        ("a bound argument", "b = (function (x) { return typeof x; }).bind(null, g);"),
        ("a bound this", "b = (function () { return typeof this; }).bind(g);"),
        ("an array element", "o = [g];"),
        ("a Map value", "o = new Map(); o.set('k', g);"),
        ("a Set member", "o = new Set(); o.add(g);"),
        // A Proxy's target and handler are raw slot INDICES in the
        // `proxies` row, not Slots -- the traversal walks them
        // specially, and the restored proxy must find its resolver
        // target callable again.
        ("a proxy target", "o = new Proxy(g, {}); g = 0;"),
        ("a proxy handler", "o = new Proxy({}, g); g = 0;"),
    ] {
        let m = resolver_fixture(tail);
        assert_eq!(
            m.stored_unpersistable_row(),
            None,
            "a resolver held as {name} persists now"
        );
        let bytes = m
            .write_snapshot(&sig())
            .unwrap_or_else(|e| panic!("blob verb must admit {name}: {e:?}"));
        from_snapshot_bytes(&bytes, &sig())
            .unwrap_or_else(|e| panic!("blob resume must accept {name}: {e:?}"));
        let mut store = MemoryStore::new();
        drop(
            begin_store_session(resolver_fixture(tail), &sig(), &mut store)
                .map_err(|(_, e)| e)
                .unwrap_or_else(|e| panic!("store verb must admit {name}: {e:?}")),
        );
        resume_from_store(&store, &sig())
            .unwrap_or_else(|e| panic!("store resume must accept {name}: {e:?}"));
    }
}

/// The traversal must not refuse machines that hold only functions
/// resume DOES bring back -- otherwise it makes ordinary programs
/// unpersistable, which is worse than the hole it closes.
#[test]
fn stored_references_to_persistable_functions_are_not_refused() {
    for (name, src) in [
        ("a guest function in a global", "var f = 0; f = function () { return 1; }; 7"),
        ("a guest function in an array", "var o = 0; o = [function () { return 1; }]; 7"),
        ("a boot native in a property", "var o = 0; o = {}; o.k = Object.keys; 7"),
        ("a boot native in a Map", "var m = 0; m = new Map(); m.set('k', Math.max); 7"),
        (
            "an Intl bound native in a global",
            "var nf = 0; var g = 0; nf = new Intl.NumberFormat('en'); g = nf.format; 7",
        ),
        (
            "a proxy revoker in a global",
            "var r = 0; var g = 0; r = Proxy.revocable({}, {}); g = r.revoke; 7",
        ),
        (
            "a bound guest function with ordinary arguments",
            "var b = 0; b = (function (x) { return x; }).bind(null, 41); 7",
        ),
    ] {
        let (bytes, names) = compile(src);
        let mut m = Interp::new();
        m.link_intrinsics(&names);
        assert!(m.run(&bytes).completed, "fixture: {name}");
        assert_eq!(m.stored_unpersistable_row(), None, "must stay persistable: {name}");
        assert!(m.write_snapshot(&sig()).is_ok(), "blob verb: {name}");
        let mut store = MemoryStore::new();
        assert!(
            begin_store_session(m, &sig(), &mut store).is_ok(),
            "store verb: {name}"
        );
    }
}

/// The other half of the gate's contract, and the half that was
/// missing. A fixture the gate ADMITS must not merely snapshot — it
/// must RESUME FAITHFULLY. Asserting `write_snapshot().is_ok()` proves
/// only that we let the machine through, which is exactly how a
/// resolver captured as a bound argument survived review: admitted,
/// snapshotted, restored, and silently non-callable.
///
/// So every admitted fixture here carries a post-resume behavioral
/// oracle: run the observation uninterrupted, run it again across a
/// store round trip, and require the two to agree. A future hole in
/// the gate shows up as a DIVERGENCE rather than as a green
/// admission.
#[test]
fn every_admitted_fixture_resumes_faithfully() {
    // (name, mentions interned by both cranks, setup, observation, expected)
    for (name, mentions, setup, observe, expect) in [
        (
            "a guest function in a global",
            "",
            "f = function (a) { return a + 1; };",
            "t = typeof f + ':' + f(41); t",
            "function:42",
        ),
        (
            "a guest function in an array",
            "",
            "o = [function (a) { return a + 1; }];",
            "t = typeof o[0] + ':' + o[0](41); t",
            "function:42",
        ),
        (
            "a boot native in a property",
            "Object.keys(o);",
            "o = {}; o.k = Object.keys;",
            "t = typeof o.k + ':' + o.k({ a: 1 }).length; t",
            "function:1",
        ),
        (
            "a boot native in a Map",
            "new Map(); m.set('k', Math.max); m.get('k');",
            "m = new Map(); m.set('k', Math.max);",
            "t = typeof m.get('k') + ':' + m.get('k')(1, 5); t",
            "function:5",
        ),
        (
            "a bound guest function with ordinary arguments",
            "",
            "b = (function (x, y) { return x + y; }).bind(null, 41);",
            "t = typeof b + ':' + b(1); t",
            "function:42",
        ),
        (
            "an Intl bound native in a global",
            "new Intl.NumberFormat('en'); nf.format(0);",
            "nf = new Intl.NumberFormat('en'); f = nf.format;",
            "t = typeof f + ':' + f(0.5); t",
            "function:0.5",
        ),
        (
            "a proxy revoker in a global",
            "Proxy.revocable({}, {}); r.revoke();",
            "r = Proxy.revocable({}, {}); f = r.revoke;",
            "t = typeof f; t",
            "function",
        ),
        (
            // The shape that made the controls sharper: a runtime
            // native was MINTED, so the traversal runs in full — it
            // just finds nothing retained, and the machine both
            // persists and resumes correctly.
            "a dropped resolver",
            "new Promise(function (res) { g = res; });",
            "p = new Promise(function (res) { g = res; }); g = 0; p = 0;",
            "t = typeof g; t",
            "number",
        ),
    ] {
        // Both cranks must intern the SAME program symbols, in order —
        // the setup crank's function literals intern their parameter
        // names and `caller`, so the observation crank interns them
        // too, from a dead literal it never runs.
        let decls = "var b; var f; var g; var m; var nf; var o; var p; var r; var t; ";
        let pre = format!(
            "{decls} if (0) {{ (function (a, x, y, res) {{ return a + x + y + res; }}); \
             o.k; o.length; o[0]; m.get('k'); m.set('k', 0); new Map(); \
             Object.keys(o); Math.max(1, 2); f.bind(null); f(0); \
             new Intl.NumberFormat('en'); nf.format(0); \
             Proxy.revocable({{}}, {{}}); r.revoke(); \
             new Promise(function (res) {{ g = res; }}); {mentions} }} "
        );
        let (b1, n1) = compile(&format!("{pre}{setup} 7"));
        let (b2, n2) = compile(&format!("{pre}{observe}"));
        assert_eq!(n1, n2, "{name}: both cranks must intern the same symbols");

        let mut cont = Interp::new();
        cont.link_intrinsics(&n1);
        assert!(cont.run(&b1).completed, "{name}: setup crank");
        let continuous = cont.run(&b2);
        assert!(continuous.completed, "{name}: observation halted: {:?}", continuous.halt);
        assert_eq!(continuous.result, expect, "{name}: the uninterrupted answer");

        let mut m = Interp::new();
        m.link_intrinsics(&n1);
        assert!(m.run(&b1).completed, "{name}: setup crank (store)");
        assert_eq!(
            m.stored_unpersistable_row(),
            None,
            "{name}: the gate admits this machine"
        );
        let mut store = MemoryStore::new();
        drop(
            begin_store_session(m, &sig(), &mut store)
                .map_err(|(_, e)| e)
                .unwrap_or_else(|e| panic!("{name}: begin: {e:?}")),
        );
        let mut session = resume_from_store(&store, &sig())
            .unwrap_or_else(|e| panic!("{name}: resume: {e:?}"));
        let resumed = session.machine_mut().run(&b2);
        assert_eq!(
            (resumed.completed, resumed.result.as_str()),
            (continuous.completed, continuous.result.as_str()),
            "{name}: an ADMITTED machine must resume faithfully (halt {:?})",
            resumed.halt
        );
    }
}

// ---------------------------------------------------------------
// Quiescence is a LIFECYCLE property, not a table-emptiness
// property (architecture review F011, F030/F022). The `throw` fixture
// above halts with a populated catch chain and a set exception, so
// the table-shaped conjuncts of `is_quiescent` catch it. A crank that
// halts at a top-level loop-closing meter check, at the dispatch
// ceiling before any dispatch, or at a decode fault leaves every table
// EMPTY -- and before the `last_crank_completed` conjunct, such a
// machine passed every persist verb while its `result`/`locals`/
// `id_map` registers, live GC roots the restore path never reinstates,
// stayed populated: after one boundary collection the continuous
// machine and its resumed twin held different free lists and different
// canonical bytes while agreeing on every result and computron.
// (Removing the latch conjunct fails the meter-abort and pre-dispatch
// cases below; the mid-loop step-limit case is caught by the value
// stack it leaves mid-expression, and stands as the ceiling's
// every-verb lock rather than a latch lock.)

fn assert_every_persist_verb_refuses_non_quiescent(m: Interp, shape: &str) {
    assert!(!m.is_quiescent(), "{shape}: a halted crank is not a quiescent boundary");
    match m.write_snapshot(&sig()) {
        Err(MachineSnapshotError::NotQuiescent) => {}
        other => panic!("{shape}: the blob verb must refuse as NotQuiescent: {other:?}"),
    }
    let mut store = MemoryStore::new();
    match begin_store_session(m, &sig(), &mut store) {
        Err((_, StoreError::MachineNotQuiescent)) => {}
        Err((_, other)) => panic!("{shape}: the store verb refused by the wrong gate: {other:?}"),
        Ok(_) => panic!("{shape}: the store verb must refuse"),
    }
    assert!(store.manifest().is_err(), "{shape}: a refused begin writes nothing");
}

/// A metered crank the host refuses at a TOP-LEVEL loop-closing check:
/// the call stack, catch chain, and value stack are all empty at that
/// check, so only the lifecycle conjunct can see the halt.
#[test]
fn a_meter_aborted_crank_refuses_every_persist_verb() {
    let (b, n) = compile("var i = 0; for (i = 0; i < 100000; i++) { i = i; } i");
    let mut m = Interp::new();
    m.link_intrinsics(&n);
    m.arm_meter(1, Box::new(|_| false));
    let o = m.run(&b);
    assert!(matches!(o.halt, ironhorse_vm::Halt::MeterAbort), "fixture: {:?}", o.halt);
    assert!(!o.completed);
    assert_every_persist_verb_refuses_non_quiescent(m, "meter abort");
}

/// The dispatch-ceiling halt mid-loop in a top-level frame. The value
/// stack is mid-expression at that loop top, so the table conjuncts
/// already refuse this shape; the latch-only ceiling shape is the
/// pre-dispatch one in the next test.
#[test]
fn a_step_limited_crank_refuses_every_persist_verb() {
    let (b, n) = compile("var i = 0; for (i = 0; i < 100000; i++) { i = i; } i");
    let mut m = Interp::new();
    m.link_intrinsics(&n);
    let o = m.run_bounded(&b, 50);
    assert!(matches!(o.halt, ironhorse_vm::Halt::StepLimit(_)), "fixture: {:?}", o.halt);
    assert!(!o.completed);
    assert_every_persist_verb_refuses_non_quiescent(m, "step limit");
}

/// The ceiling reached BEFORE any dispatch, and a decode fault on an
/// empty buffer: nothing ran, every table is empty, and the crank still
/// did not complete. The lifecycle gate refuses these too -- the managed
/// lifecycle rewinds a halted crank whole, whatever its shape.
#[test]
fn a_crank_that_halted_before_dispatching_refuses_every_persist_verb() {
    let (b, n) = compile("var i = 0; i");
    let mut m = Interp::new();
    m.link_intrinsics(&n);
    let o = m.run_bounded(&b, 0);
    assert!(matches!(o.halt, ironhorse_vm::Halt::StepLimit(_)), "fixture: {:?}", o.halt);
    assert_every_persist_verb_refuses_non_quiescent(m, "step limit before dispatch");

    let mut m = Interp::new();
    m.link_intrinsics(&n);
    let o = m.run(&[]);
    assert!(matches!(o.halt, ironhorse_vm::Halt::Decode(_)), "fixture: {:?}", o.halt);
    assert_every_persist_verb_refuses_non_quiescent(m, "decode fault");
}

/// Checkpointing a bound session after a table-empty halt refuses and
/// writes nothing, exactly as the `throw` shape does.
#[test]
fn a_meter_aborted_crank_refuses_checkpoint_and_writes_nothing() {
    let (b0, n0) = compile("var x = 0; var i = 0; x = 1; x");
    let mut m = Interp::new();
    m.link_intrinsics(&n0);
    let mut store = MemoryStore::new();
    let mut session = begin_store_session(m, &sig(), &mut store)
        .map_err(|(_, e)| e)
        .expect("a clean machine begins");
    assert!(session.machine_mut().run(&b0).completed);
    checkpoint_to_store(&mut session, &sig(), &mut store).expect("clean checkpoint");
    let epoch_before = store.manifest().unwrap().epoch;

    let (b1, n1) = compile("var x; var i; for (i = 0; i < 100000; i++) { x = x + 1; } x");
    let b1 = session.machine_mut().relink_crank(&b1, &n1).expect("relink");
    session.machine_mut().arm_meter(1, Box::new(|_| false));
    let o = session.machine_mut().run(&b1);
    assert!(matches!(o.halt, ironhorse_vm::Halt::MeterAbort), "fixture: {:?}", o.halt);
    match checkpoint_to_store(&mut session, &sig(), &mut store) {
        Err(StoreError::MachineNotQuiescent) => {}
        other => panic!("a meter-aborted crank must not checkpoint: {other:?}"),
    }
    assert_eq!(
        store.manifest().unwrap().epoch,
        epoch_before,
        "the refusal must land before anything is written"
    );
}

/// A resumed machine, and a machine that has never run, both stand at a
/// clean boundary: the lifecycle conjunct starts true and a restore
/// lands on a fresh machine.
#[test]
fn a_fresh_and_a_resumed_machine_are_quiescent() {
    let (b, n) = compile("var x = 0; x = 41; x");
    let mut m = Interp::new();
    m.link_intrinsics(&n);
    assert!(m.is_quiescent(), "a linked machine that never ran is at a boundary");
    assert!(m.run(&b).completed);
    let bytes = m.write_snapshot(&sig()).expect("snapshots");
    let resumed = from_snapshot_bytes(&bytes, &sig()).expect("resumes");
    assert!(resumed.is_quiescent(), "a resumed machine is at a boundary");
    resumed.write_snapshot(&sig()).expect("and snapshots again");
}

/// After a halted crank, the NEXT completed crank restores quiescence:
/// the latch is per-crank, not a lifetime poison. The halt here is the
/// pre-dispatch ceiling, the one shape that leaves NO mid-frame debris,
/// so the latch is the only conjunct refusing (a halt mid-frame leaves
/// stack debris a later run does not sweep — the managed lifecycle
/// rewinds such a machine rather than running over it).
#[test]
fn a_completed_crank_after_a_halt_restores_quiescence() {
    let (b_halt, n) = compile("var i = 0; i");
    let mut m = Interp::new();
    m.link_intrinsics(&n);
    let o = m.run_bounded(&b_halt, 0);
    assert!(matches!(o.halt, ironhorse_vm::Halt::StepLimit(_)), "fixture: {:?}", o.halt);
    assert!(!m.is_quiescent(), "the latch alone refuses");
    let (b_ok, n_ok) = compile("var i; i = 7; i");
    let b_ok = m.relink_crank(&b_ok, &n_ok).expect("relink");
    let o = m.run(&b_ok);
    assert!(o.completed, "{:?}", o.halt);
    assert!(m.is_quiescent(), "a completed crank is a boundary again");
    m.write_snapshot(&sig()).expect("and the blob verb admits it");
}

/// The two synthetic HOST-BOUNDARY throws -- a completion value the
/// oracle harness's `String(result)` cannot coerce (a Symbol, a
/// null-prototype object) -- are minted AFTER the engine's own crank
/// completed and its job queue drained. The machine IS at a clean
/// boundary, so the boundary registers must clear exactly as for a
/// rendered completion; before this fix the rewrite happened first and
/// the clear was skipped, so `result`/`locals`/`id_map` stayed rooted
/// and the continuous and resumed twins forked at the next collection
/// while agreeing on every result and computron (F030/F022, reproduced
/// end to end in the review).
#[test]
fn a_synthetic_host_throw_leaves_a_quiescent_machine_whose_twins_agree() {
    for (name, completion) in [
        ("a Symbol completion", "let s = Symbol('k'); s"),
        ("a null-prototype completion", "let s = Object.create(null); s"),
    ] {
        // Both cranks intern the same program symbols, in order (the
        // dead mention block), so the twins run identical bytecode.
        // Crank 1's bindings are LEXICAL: `let` lives in the frame's
        // `locals` register, not on the global object, so `a` and the
        // completion value are rooted by nothing but the boundary
        // registers — exactly the roots the restore path never
        // reinstates. (`g` is the one global the observation reads.)
        let pre = "var g; var t; \
                   if (0) { let a = 0; let b = 0; let s = 0; a.p; b.q; g.q; \
                            Symbol('k'); Object.create(null); } ";
        let (b1, n1) = compile(&format!(
            "{pre} let a = {{ p: 1 }}; let b = {{ q: 2 }}; g = b; {completion}"
        ));
        let (b2, n2) = compile(&format!("{pre} t = g.q * 21; t"));
        assert_eq!(n1, n2, "{name}: both cranks intern the same symbols");

        let mut cont = Interp::new();
        cont.link_intrinsics(&n1);
        let o = cont.run(&b1);
        assert!(!o.completed, "{name}: the host-boundary coercion is reported as a throw");
        assert!(matches!(o.halt, ironhorse_vm::Halt::Throw { .. }), "{name}: {:?}", o.halt);
        assert!(
            cont.is_quiescent(),
            "{name}: the engine's crank completed, so the machine is at a boundary"
        );
        // Persist right at that boundary: the resumed twin.
        let bytes = cont.write_snapshot(&sig()).expect("the boundary snapshots");
        let mut twin = from_snapshot_bytes(&bytes, &sig()).expect("resumes");

        // Both twins collect at the boundary and run the same next crank.
        let cont_gc = cont.collect_garbage();
        let twin_gc = twin.collect_garbage();
        assert_eq!(
            cont_gc.slots_live, twin_gc.slots_live,
            "{name}: the boundary registers must not root anything the twin cannot see"
        );
        let co = cont.run(&b2);
        let to = twin.run(&b2);
        assert_eq!((co.completed, co.result.as_str()), (true, "42"), "{name}: {:?}", co.halt);
        assert_eq!((to.completed, to.result.as_str()), (true, "42"), "{name}: {:?}", to.halt);
        assert_eq!(co.computrons, to.computrons, "{name}: computrons agree");
        assert_eq!(
            cont.write_snapshot(&sig()).expect("continuous snapshots"),
            twin.write_snapshot(&sig()).expect("resumed snapshots"),
            "{name}: the continuous and resumed images must agree byte-for-byte"
        );
    }
}
