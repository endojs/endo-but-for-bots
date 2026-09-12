//! F160: the production daemon seam installs the runtime source compiler.
//!
//! Before this wiring, `rust/endo` linked `ironhorse-compile` and compiled the
//! top-level program with it but never called `Interp::set_source_compiler`,
//! so a guest `eval("…")` or `new Function(…)` aborted the whole crank with
//! `Halt::NotImplemented("eval:no-compiler")`. The compiler is host
//! configuration that does not ride a snapshot, so the ephemeral `Machine`, a
//! fresh boot, and every resume/rewind all install it.

#![cfg(feature = "ironhorse-engine")]

use endo::ironhorse_engine::engine::{
    CadencePolicy, HeapStoreOptions, Machine, MeterBounds, PersistentMachine,
};

#[test]
fn ephemeral_machine_evaluates_dynamic_source() {
    let mut machine = Machine::new();
    assert_eq!(machine.eval("eval('1+1')").unwrap(), "2");
    assert_eq!(
        machine
            .eval("new Function('a','b','return a+b')(2,3)")
            .unwrap(),
        "5"
    );
    // Indirect eval goes through the same bridge.
    assert_eq!(machine.eval("(0, eval)('40+2')").unwrap(), "42");
}

#[test]
fn persistent_machine_evaluates_dynamic_source_across_resume() {
    let dir = tempfile::tempdir().expect("temp dir");
    let options = HeapStoreOptions {
        path: dir.path().join("worker-heap.sqlite"),
        signature: "endor-ironhorse-worker-v1".to_string(),
        cadence: CadencePolicy::default(),
        meter: MeterBounds::per_crank(1_000_000),
        intrinsic_permit: None,
    };

    let mut machine = PersistentMachine::open(&options).unwrap();
    assert_eq!(machine.eval("eval('1+1')").unwrap().result, "2");
    machine.close().unwrap();

    // A resumed heap carries no compiler in its snapshot; `open` re-installs
    // it, or this second crank would regress to the named gap.
    let mut machine = PersistentMachine::open(&options).unwrap();
    assert_eq!(machine.eval("eval('2+2')").unwrap().result, "4");
    machine.close().unwrap();
}

#[test]
fn rewind_reinstalls_the_source_bridge() {
    let dir = tempfile::tempdir().expect("temp dir");
    let options = HeapStoreOptions {
        path: dir.path().join("worker-heap.sqlite"),
        signature: "endor-ironhorse-worker-v1".to_string(),
        cadence: CadencePolicy::default(),
        meter: MeterBounds::per_crank(1_000_000),
        intrinsic_permit: None,
    };

    let mut machine = PersistentMachine::open(&options).unwrap();
    assert_eq!(machine.eval("var n = 1; n").unwrap().result, "1");
    // A compile failure is a crank-preparation failure: the machine rewinds to
    // its last checkpoint, which is a fresh `Interp` with no compiler. The
    // rewind arm must re-install it or the next eval regresses.
    assert!(machine.eval("var = ;").is_err());
    assert_eq!(machine.eval("eval('3+4')").unwrap().result, "7");
    machine.close().unwrap();
}
