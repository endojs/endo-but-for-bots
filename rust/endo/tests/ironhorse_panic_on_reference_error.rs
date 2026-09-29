//! The Coda's off-by-default `panic-on-reference-error` construction
//! option (designs/ironhorse-panic.md § Coda, § Verification "Coda").
//!
//! (a) With the option on, the local TDZ read (`GET_LOCAL`), the
//! unresolved-name read (`GET_VARIABLE`) and the closure TDZ read
//! (`GET_CLOSURE`) each surface `Halt::Panic(PanicKind::ReferenceError)`
//! that no enclosing `catch` intercepts; with it off, the same sites raise
//! a catchable `ReferenceError`, and an uncaught one classifies as
//! `Uncaught`, not `Panicked`.
//!
//! (c) A store-backed worker pins the setting with its heap: resuming it
//! under a different setting is refused, and toggling starts a new
//! lineage.

#![cfg(feature = "ironhorse-engine")]

use endo::ironhorse_engine::engine::{
    describe_halt, CadencePolicy, ExecutionOutcome, Halt, HeapStoreOptions, Machine, MachineError,
    MeterBounds, PanicKind, PersistentMachine, RaiseSite, ReplayConfig,
};

const PANIC_ON: ReplayConfig = ReplayConfig {
    panic_on_reference_error: true,
};

/// A local `let` read in its temporal dead zone, inside a `try`.
const LOCAL_TDZ: &str =
    "(function () { try { x; } catch (e) { return 'caught ' + e.name; } let x = 1; })()";
/// A bare name bound nowhere, inside a `try`.
const UNRESOLVED: &str =
    "(function () { try { return notBoundAnywhere; } catch (e) { return 'caught ' + e.name; } })()";
/// A captured `let` read in its temporal dead zone, inside a `try`.
const CLOSURE_TDZ: &str = "(function () { \
     function read() { return x; } \
     try { read(); } catch (e) { return 'caught ' + e.name; } \
     let x = 1; })()";

fn sites() -> [(&'static str, &'static str, RaiseSite, &'static str); 3] {
    [
        ("GET_LOCAL", LOCAL_TDZ, RaiseSite::LocalTdz, "x"),
        (
            "GET_VARIABLE",
            UNRESOLVED,
            RaiseSite::VariableLookup,
            "notBoundAnywhere",
        ),
        ("GET_CLOSURE", CLOSURE_TDZ, RaiseSite::ClosureTdz, "x"),
    ]
}

#[test]
fn option_on_panics_at_each_site_past_the_enclosing_catch() {
    let machine = Machine::with_config(MeterBounds::default(), PANIC_ON);
    for (label, source, site, name) in sites() {
        let outcome = machine.evaluate(source, false).expect(label);
        assert!(!outcome.completed, "{label}: the catch must not run");
        match &outcome.halt {
            Halt::Panic(PanicKind::ReferenceError {
                name: got_name,
                site: got_site,
            }) => {
                assert_eq!(*got_site, site, "{label}: raise site");
                assert_eq!(got_name.as_deref(), Some(name), "{label}: binding name");
            }
            other => panic!("{label}: expected a reference-error panic, got {other:?}"),
        }
        assert!(outcome.halt.is_panic(), "{label}: is_panic");
        assert!(
            matches!(
                ExecutionOutcome::classify(outcome.halt.clone()),
                ExecutionOutcome::Panicked(_)
            ),
            "{label}: the supervisor seam sees Panicked, not Uncaught"
        );
        assert!(
            describe_halt(&outcome.halt).starts_with("reference-error panic"),
            "{label}: {}",
            describe_halt(&outcome.halt)
        );
        if let Halt::Panic(kind) = &outcome.halt {
            assert_eq!(kind.wire_kind(), "reference-error");
        }
    }
}

#[test]
fn option_off_keeps_each_site_a_catchable_reference_error() {
    let machine = Machine::new();
    for (label, source, _, _) in sites() {
        assert_eq!(
            machine.eval(source).expect(label),
            "caught ReferenceError",
            "{label}"
        );
    }
}

#[test]
fn option_off_uncaught_reference_error_is_uncaught_not_a_panic() {
    let machine = Machine::new();
    for source in ["notBoundAnywhere", "(function () { x; let x = 1; })()"] {
        let outcome = machine.evaluate(source, false).expect(source);
        assert!(!outcome.halt.is_panic(), "{source}: {:?}", outcome.halt);
        match ExecutionOutcome::classify(outcome.halt) {
            ExecutionOutcome::Uncaught(rendered) => {
                assert!(rendered.contains("ReferenceError"), "{source}: {rendered}")
            }
            other => panic!("{source}: expected Uncaught, got {other:?}"),
        }
    }
}

/// #1016's Open Question 5: an async body converts a thrown reference error
/// into a rejection. With the option on the site panics instead, so no
/// reference-error-sourced rejection exists for a rejection tracker to
/// report twice; with it off the rejection is the ordinary one.
#[test]
fn option_on_async_body_reference_error_panics_instead_of_rejecting() {
    let source = "var seen = 'none'; \
         (async function () { notBoundAnywhere; })().catch(e => { seen = e.name; }); \
         'returned'";
    let machine = Machine::with_config(MeterBounds::default(), PANIC_ON);
    let outcome = machine.evaluate(source, false).expect("evaluate");
    assert!(
        matches!(
            outcome.halt,
            Halt::Panic(PanicKind::ReferenceError {
                site: RaiseSite::VariableLookup,
                ..
            })
        ),
        "{:?}",
        outcome.halt
    );
    // Off: the same body rejects its promise and the script completes.
    let outcome = Machine::new().evaluate(source, false).expect("evaluate");
    assert!(outcome.completed, "{:?}", outcome.halt);
    assert_eq!(outcome.result, "returned");
}

#[test]
fn option_on_leaves_non_error_paths_alone() {
    let machine = Machine::with_config(MeterBounds::default(), PANIC_ON);
    // `typeof` of an unbound name is not a reference error.
    assert_eq!(
        machine.eval("typeof notBoundAnywhere").unwrap(),
        "undefined"
    );
    // A guest-thrown ReferenceError is a throw, not an engine raise site.
    assert_eq!(
        machine
            .eval("try { throw new ReferenceError('guest'); } catch (e) { e.message }")
            .unwrap(),
        "guest"
    );
    // Initialized bindings read normally.
    assert_eq!(
        machine
            .eval("(function () { let x = 2; function r() { return x; } return x + r(); })()")
            .unwrap(),
        "4"
    );
}

#[test]
fn replay_config_mismatch_is_a_deterministic_fault() {
    let pinned = PANIC_ON;
    assert_eq!(pinned.check_replay(&pinned), Ok(()));
    let err = ReplayConfig::default()
        .check_replay(&pinned)
        .expect_err("a different setting must be refused");
    assert_eq!(err.pinned, pinned);
    assert_eq!(err.requested, ReplayConfig::default());
    assert!(err.to_string().contains("panic-on-reference-error=1"));
    // The default fingerprint is empty, so lineages recorded before the
    // fingerprint existed keep their identity.
    assert_eq!(ReplayConfig::default().fingerprint(), "");
}

fn store_options(dir: &std::path::Path, replay: ReplayConfig) -> HeapStoreOptions {
    HeapStoreOptions {
        path: dir.join("worker-heap.sqlite"),
        signature: "coda-replay-pin-v1".to_string(),
        cadence: CadencePolicy::default(),
        meter: MeterBounds::default(),
        global_names: None,
        replay,
    }
}

fn assert_refused(result: Result<PersistentMachine, MachineError>, what: &str) {
    match result {
        Err(MachineError::Halt(_)) | Ok(_) => panic!("{what}: expected a store refusal"),
        Err(error) => {
            let text = error.to_string();
            assert!(text.contains("signature"), "{what}: {text}");
        }
    }
}

#[test]
fn store_pins_the_setting_and_refuses_a_divergent_resume() {
    let dir = tempfile::tempdir().expect("temp dir");
    let on = store_options(dir.path(), PANIC_ON);
    let off = store_options(dir.path(), ReplayConfig::default());

    let mut machine = PersistentMachine::open(&on).expect("fresh open with the option on");
    assert_eq!(machine.eval("var n = 41; n + 1").unwrap().result, "42");
    // The option is in force on the booted heap.
    match machine.eval("(function () { try { y; } catch (e) { return 1; } let y; })()") {
        Err(MachineError::Halt(Halt::Panic(PanicKind::ReferenceError { site, .. }))) => {
            assert_eq!(site, RaiseSite::LocalTdz)
        }
        other => panic!("expected a reference-error panic, got {other:?}"),
    }
    machine.close().expect("close");

    // Replaying this lineage with the option off is refused, and the
    // refusal leaves the heap resumable under the pinned setting.
    assert_refused(PersistentMachine::open(&off), "resume with the option off");
    let mut machine = PersistentMachine::open(&on).expect("resume under the pinned setting");
    assert_eq!(machine.eval("var n; n").unwrap().result, "41");
    // The resumed machine re-applied the option (it is not heap state).
    match machine.eval("(function () { try { y; } catch (e) { return 1; } let y; })()") {
        Err(MachineError::Halt(Halt::Panic(PanicKind::ReferenceError { .. }))) => {}
        other => panic!("resumed machine lost the option: {other:?}"),
    }
    machine.close().expect("close");

    // And the converse: a default lineage refuses a resume with it on.
    let dir = tempfile::tempdir().expect("temp dir");
    let off = store_options(dir.path(), ReplayConfig::default());
    let on = store_options(dir.path(), PANIC_ON);
    PersistentMachine::open(&off)
        .expect("fresh default open")
        .close()
        .expect("close");
    assert_refused(PersistentMachine::open(&on), "resume with the option on");
}
