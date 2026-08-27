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
    begin_store_session, checkpoint_to_store, resume_from_store, MachineSnapshot,
};
use ironhorse_snapshot::store::{HeapStore, MemoryStore};
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

/// W6-12: the blob verbs get the dynamic-segments gate the store verbs
/// already have.
#[test]
fn a_live_eval_function_refuses_the_blob_verbs() {
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
    assert!(
        m.write_snapshot(&sig()).is_err(),
        "the blob verb must refuse what the store verbs refuse"
    );
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
