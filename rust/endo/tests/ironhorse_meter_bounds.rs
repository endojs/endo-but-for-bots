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
/// About 2^20 backtracking paths: tens of millions of steps unmetered,
/// which a regressed seam would run to completion in seconds and then
/// fail the assertion below, rather than hang the suite.
const CATASTROPHIC_REGEXP: &str = "var re = /(a+)+b/; var s = 'aaaaaaaaaaaaaaaaaaaa'; re.test(s)";

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
            // The whole search is tens of millions of computrons; the
            // abort landed inside the match, within a stride or two of
            // the limit.
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

/// Adversarial review: whether a crank is refused must be a function of
/// its own cost and the policy alone. The check window used to keep
/// whatever phase history left it, so a crank spending inside
/// `(limit, limit + interval]` was refused on a natively armed machine
/// and admitted on one migrated from an un-armed store (or the reverse).
/// Now the window is re-based at every crank start, so the host is
/// consulted at the same computron offsets into every crank, and three
/// machines with three histories — fresh, migrated from an un-armed
/// store, and rewound after a refusal — agree on every side of the
/// limit: admitted above the cost, admitted inside the slop zone (the
/// crank ends before the next consultation), refused once a
/// consultation falls past the limit, and, decisively, refused at the
/// one limit the old phase-carrying window admitted on a fresh machine.
#[test]
fn a_refusal_depends_on_the_crank_and_the_policy_not_on_history() {
    // The prelude is deliberately costly (about 5,000 computrons): it is
    // what puts a phase-carrying window off the crank boundary. Under
    // the old code a fresh machine's window ran from boot, so the
    // probe's consultations fell at `k * INTERVAL - prelude` into it;
    // re-based, they fall at `k * INTERVAL`. The discriminating limit
    // below sits between the two.
    const PRELUDE: &str = "var n = 0; var i = 0; for (i = 0; i < 280; i++) { i = i; } n = 1; n";
    // Costs about 21,000 computrons: the host is consulted at roughly
    // 10,000 and 20,000 computrons into the crank and the crank ends
    // a comfortable margin past the second.
    const PROBE: &str = "var n; var i; for (i = 0; i < 1200; i++) { i = i; } n";
    const INTERVAL: u64 = 10_000;

    // Calibrate both cranks on an un-bounded persistent machine (the
    // meter counts identically armed or not), so the test pins no
    // cost-table constant. The prelude is the first crank, as in every
    // history below, so its reading is exactly the index a fresh
    // machine's probe starts from.
    let calib = tempfile::tempdir().expect("temp dir");
    let mut m =
        PersistentMachine::open(&options(calib.path(), MeterBounds::Unbounded)).expect("open");
    let prelude = m.eval(PRELUDE).expect("prelude").computrons;
    let after = m.eval(PROBE).expect("probe").computrons;
    m.close().expect("close");
    let cost = after - prelude;
    // The second consultation lands within one loop iteration (well
    // under 500 computrons) past 20,000; the crank must end after it
    // and before the third, for the slop-zone case below to be exact.
    assert!(
        cost > 2 * INTERVAL + 500 && cost < 3 * INTERVAL,
        "probe cost {cost}"
    );
    // For the discriminating case: the old fresh window's consultations
    // at `10,000 - prelude` and `20,000 - prelude` must both clear the
    // limit below, and its third at `30,000 - prelude` must fall past
    // the crank's end.
    assert!(
        prelude > 3_000 && prelude < 3 * INTERVAL - cost,
        "prelude cost {prelude} against probe cost {cost}"
    );
    let discriminating = 2 * INTERVAL - prelude / 2;

    // A history is a closure that hands back a bounded machine ready to
    // run the probe, with the prelude's state in place.
    let run_probe = |limit: u64, history: &str| -> Result<String, MachineError> {
        let dir = tempfile::tempdir().expect("temp dir");
        let bounded = MeterBounds::PerCrank {
            check_interval: INTERVAL,
            crank_limit: limit,
        };
        let mut machine = match history {
            "fresh" => {
                let mut mm = PersistentMachine::open(&options(dir.path(), bounded)).expect("open");
                mm.eval(PRELUDE).expect("prelude");
                mm
            }
            "migrated" => {
                let mut un = PersistentMachine::open(&options(dir.path(), MeterBounds::Unbounded))
                    .expect("open");
                un.eval(PRELUDE).expect("prelude");
                un.close().expect("close");
                PersistentMachine::open(&options(dir.path(), bounded)).expect("reopen")
            }
            "rewound" => {
                let mut mm = PersistentMachine::open(&options(dir.path(), bounded)).expect("open");
                mm.eval(PRELUDE).expect("prelude");
                assert!(matches!(
                    mm.eval(SPIN),
                    Err(MachineError::MeterAbort { .. })
                ));
                mm
            }
            other => unreachable!("{other}"),
        };
        let out = machine.eval(PROBE).map(|o| o.result);
        machine.close().expect("close");
        out
    };

    for history in ["fresh", "migrated", "rewound"] {
        // Just over the cost: admitted everywhere.
        assert_eq!(
            run_probe(cost + 50, history).unwrap_or_else(|e| panic!("{history}: {e}")),
            "1",
            "{history}: admitted just over the cost"
        );
        // Just under the cost, inside the slop zone: the consultation
        // at ~20,000 sees the meter under the limit and the crank ends
        // before the next one, so it is admitted — on every history.
        assert_eq!(
            run_probe(cost - 50, history).unwrap_or_else(|e| panic!("{history}: {e}")),
            "1",
            "{history}: admitted inside the slop zone"
        );
        // The discriminating limit: re-based, the consultation at
        // ~20,000 finds the meter past it, so refused everywhere. Under
        // the old phase-carrying window a FRESH machine consulted at
        // `20,000 - prelude`, under the limit, and its next
        // consultation lay past the crank's end, so it admitted the
        // crank while a migrated machine (re-armed at resume, hence on
        // the crank boundary) refused it: the replica fork this locks
        // out.
        match run_probe(discriminating, history) {
            Err(MachineError::MeterAbort { computrons, limit }) => {
                assert_eq!(limit, discriminating, "{history}");
                assert!(computrons > limit, "{history}: {computrons}");
            }
            other => panic!(
                "{history}: expected a refusal at the discriminating limit \
                 {discriminating} (a phase-carrying window admits it), got {other:?}"
            ),
        }
        // One interval under the cost: the consultation at ~20,000
        // finds the meter past the limit, so refused everywhere.
        match run_probe(cost - INTERVAL, history) {
            Err(MachineError::MeterAbort { computrons, limit }) => {
                assert_eq!(limit, cost - INTERVAL, "{history}");
                assert!(computrons > limit, "{history}: {computrons}");
            }
            other => {
                panic!("{history}: expected a refusal an interval under the cost, got {other:?}")
            }
        }
    }
}

/// Adversarial review: a check interval at or above `2^48` computrons
/// saturates in the meter and would never consult the host, so an
/// "armed" policy with a finite limit enforced nothing. The cadence is
/// clamped to the limit, so every `PerCrank` policy is enforceable.
#[test]
fn an_oversized_check_interval_still_enforces_the_limit() {
    let src = "var i = 0; for (i = 0; i < 50000; i++) { i = i; } i";
    for check_interval in [u64::MAX, 1 << 48, 1 << 40] {
        let m = Machine::with_bounds(MeterBounds::PerCrank {
            check_interval,
            crank_limit: 1_000,
        });
        assert!(
            matches!(
                m.eval(src),
                Err(MachineError::MeterAbort { limit: 1_000, .. })
            ),
            "check_interval {check_interval} must still enforce the limit"
        );
    }
}
