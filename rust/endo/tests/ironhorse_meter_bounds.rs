//! Architecture review finding 2, the embedder half ("the meter bounds
//! nothing in the shipped configuration", F014/F020): every path
//! through the `rust/endo` seam now runs a crank under `MeterBounds`,
//! armed by default. A guest `while (true) {}` delivered through
//! `Machine::eval` or `PersistentMachine::eval` terminates with a named
//! refusal; on the persistent path the machine is rewound and keeps
//! serving; the bound survives a suspend/resume and a rewind; and a
//! store written un-metered is bounded from its next crank on.

#![cfg(feature = "ironhorse-engine")]

use endo::ironhorse_engine::engine::{
    CadencePolicy, HeapStoreOptions, Machine, MachineError, MeterBounds, PersistentMachine,
};

const SPIN: &str = "var i = 0; while (true) { i = i + 1; }";
const CATASTROPHIC_REGEXP: &str =
    "var re = /(a+)+b/; var s = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; re.test(s)";

fn options(dir: &std::path::Path, meter: MeterBounds) -> HeapStoreOptions {
    HeapStoreOptions {
        path: dir.join("worker-heap.sqlite"),
        signature: "endor-ironhorse-worker-v1".to_string(),
        cadence: CadencePolicy::default(),
        meter,
    }
}

#[test]
fn the_default_machine_is_bounded() {
    assert_eq!(Machine::new().bounds(), &MeterBounds::default());
    assert!(
        matches!(MeterBounds::default(), MeterBounds::PerCrank { crank_limit, .. } if crank_limit > 0),
        "un-metered must be an opt-in, never the default"
    );
}

#[test]
fn a_spinning_crank_is_refused_through_the_stateless_machine() {
    let m = Machine::with_bounds(MeterBounds::per_crank(200_000));
    match m.eval(SPIN) {
        Err(MachineError::MeterAbort { computrons, limit }) => {
            assert_eq!(limit, 200_000);
            assert!(
                computrons > limit,
                "refused once past the limit: {computrons}"
            );
        }
        other => panic!("expected a meter refusal, got {other:?}"),
    }
    // And the same through `evaluate`'s raw outcome.
    let outcome = m.evaluate(SPIN, false).expect("compiles");
    assert!(!outcome.completed);
    assert!(matches!(
        outcome.halt,
        endo::ironhorse_engine::engine::Halt::MeterAbort
    ));
    // Ordinary programs are untouched.
    assert_eq!(m.eval("1 + 2").expect("completes"), "3");
}

#[test]
fn a_catastrophic_regexp_is_refused_mid_match() {
    let m = Machine::with_bounds(MeterBounds::per_crank(100_000));
    match m.eval(CATASTROPHIC_REGEXP) {
        Err(MachineError::MeterAbort { computrons, .. }) => {
            // 2^32-ish steps would be billions; the abort landed inside
            // the match, within a stride or two of the limit.
            assert!(
                computrons < 200_000,
                "aborted mid-match, not after: {computrons}"
            );
        }
        other => panic!("expected a meter refusal, got {other:?}"),
    }
}

#[test]
fn the_unbounded_opt_in_runs_unmetered() {
    let m = Machine::with_bounds(MeterBounds::Unbounded);
    // Cheap enough to finish, expensive enough that the default bound
    // with a tiny limit would refuse it.
    let src = "var i = 0; for (i = 0; i < 50000; i++) { i = i; } i";
    assert_eq!(m.eval(src).expect("unbounded completes"), "50000");
    assert!(matches!(
        Machine::with_bounds(MeterBounds::per_crank(1_000)).eval(src),
        Err(MachineError::MeterAbort { .. })
    ));
}

#[test]
fn a_persistent_machine_refuses_a_spinning_crank_and_keeps_serving() {
    let dir = tempfile::tempdir().expect("temp dir");
    let options = options(dir.path(), MeterBounds::per_crank(200_000));
    let mut machine = PersistentMachine::open(&options).expect("fresh open");
    machine.eval("var n = 0; n = 1; n").expect("crank 1");
    let epoch = machine.epoch().expect("epoch");

    // The runaway crank mutates, then spins: refused and rewound.
    match machine.eval("var n; n = 1000; var i = 0; while (true) { i = i + 1; }") {
        Err(MachineError::MeterAbort { computrons, limit }) => {
            assert_eq!(limit, 200_000);
            assert!(computrons > limit && computrons < 2 * limit, "{computrons}");
        }
        other => panic!("expected a meter refusal, got {other:?}"),
    }
    assert_eq!(
        machine.epoch().expect("epoch"),
        epoch,
        "a refused crank never persists"
    );

    // The next crank sees the rewound state and its own full budget:
    // the ceiling is re-pointed per crank, so the refused crank's spend
    // is not charged against this one.
    let outcome = machine
        .eval("var n; var i; n")
        .expect("crank after refusal");
    assert_eq!(outcome.result, "1");
    let big = machine
        .eval("var n; var i; for (i = 0; i < 3000; i++) { i = i; } n")
        .expect("a legitimately costly crank still fits its own budget");
    assert_eq!(big.result, "1");
    machine.close().expect("close");
}

#[test]
fn the_bound_survives_suspend_and_resume() {
    let dir = tempfile::tempdir().expect("temp dir");
    let options = options(dir.path(), MeterBounds::per_crank(200_000));
    let mut machine = PersistentMachine::open(&options).expect("fresh open");
    machine.eval("var n = 0; n = 7; n").expect("crank 1");
    machine.close().expect("suspend");

    // Resume: the host callback is reattached, so the armed meter the
    // store carries neither runs unbounded nor fails closed.
    let mut machine = PersistentMachine::open(&options).expect("resume");
    assert_eq!(machine.eval("var n; n").expect("cheap crank").result, "7");
    assert!(matches!(
        machine.eval(SPIN),
        Err(MachineError::MeterAbort { .. })
    ));
    // And after the rewind that refusal caused, the same again.
    assert_eq!(
        machine
            .eval("var n; var i; n")
            .expect("after rewind")
            .result,
        "7"
    );
    assert!(matches!(
        machine.eval(SPIN),
        Err(MachineError::MeterAbort { .. })
    ));
    machine.close().expect("close");
}

#[test]
fn a_store_written_unbounded_is_bounded_from_its_next_crank() {
    let dir = tempfile::tempdir().expect("temp dir");
    let mut open_unbounded =
        PersistentMachine::open(&options(dir.path(), MeterBounds::Unbounded)).expect("open");
    let src = "var i = 0; for (i = 0; i < 50000; i++) { i = i; } i";
    assert_eq!(open_unbounded.eval(src).expect("unbounded").result, "50000");
    open_unbounded.close().expect("close");

    let mut bounded = PersistentMachine::open(&options(dir.path(), MeterBounds::per_crank(1_000)))
        .expect("reopen");
    assert!(
        matches!(bounded.eval(src), Err(MachineError::MeterAbort { .. })),
        "the un-armed store is re-armed on resume"
    );
    assert_eq!(bounded.eval("var i; i").expect("cheap").result, "50000");
    bounded.close().expect("close");

    // The other direction: an armed store opened un-bounded refuses
    // nothing (the opt-out attaches a permissive host rather than
    // leaving the armed meter to fail closed).
    let mut reopened =
        PersistentMachine::open(&options(dir.path(), MeterBounds::Unbounded)).expect("reopen");
    assert_eq!(reopened.eval(src).expect("unbounded again").result, "50000");
    reopened.close().expect("close");
}
