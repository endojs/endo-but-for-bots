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
// The residual persist gate (`stored_unpersistable_row`): the last
// refuse-on-hold arm, and until now the one gate with no test of its
// own -- disabling it entirely left every test binary green.
//
// It answers one question: does this machine HOLD a reference to a
// function slot that resume cannot bring back? A native minted at
// runtime (a promise resolver, say) sits above `boot_slot_count` and
// travels in no table, so restore reinstates the reference without
// its `FuncInfo`. Three structural holders can carry one, and each
// fails differently:
//
//   - an ACCESSOR getter/setter: the property survives as an accessor
//     whose getter is dead;
//   - a BOUND function's target: restore refuses the whole machine
//     (`malformed retained function state`) -- an honest machine that
//     commits and can then never be resumed, which is data loss;
//   - a DISPOSAL method on a disposable stack: `dispose()` dies on a
//     non-callable record.
//
// Refusing to PERSIST is strictly better than all three: the machine
// keeps running and the caller learns immediately. The carry (the
// promise cluster, still Pending) is the recorded lift.

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

#[test]
fn a_held_unpersistable_native_refuses_every_persist_verb() {
    assert_every_persist_verb_refuses(
        resolver_fixture("Object.defineProperty(o, 'x', { get: g });"),
        "accessors with non-persisted native functions",
    );
    assert_every_persist_verb_refuses(
        resolver_fixture("b = g.bind(null);"),
        "bound functions with non-persisted targets",
    );
    assert_every_persist_verb_refuses(
        resolver_fixture("s = new DisposableStack(); s.adopt(1, g);"),
        "disposable stacks with non-persisted disposal methods",
    );
}

#[test]
fn the_persistable_function_classes_are_not_refused() {
    // The gate must stay narrow: each of these holds a function that
    // resume DOES bring back, in the same three holders. A gate that
    // refused any of them would make ordinary programs unpersistable.
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
        let m = resolver_fixture(tail);
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
