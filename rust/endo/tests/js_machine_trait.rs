//! Both engines answer the same three calls (architecture finding F068).
//!
//! F068's claim is that no trait in `rust/endo` abstracts an engine, so the
//! daemon cannot drive an IronHorse machine at all and the retrofit cost grows
//! with every call site written against a concrete type. Its recommended first
//! step is to extract the slice the daemon actually calls and implement it for
//! `xsnap::Machine` first, "which is mechanical and changes no behaviour".
//!
//! The mechanical part is not the interesting part. What makes the extraction
//! real rather than a shape someone imagined is that a SECOND implementor
//! satisfies it — which is precisely the argument W6 decision 2 used to defer
//! it ("the second implementor is the one that tells you what the shape should
//! be"). So every test here drives the trait GENERICALLY, through
//! `&mut dyn JsMachine` or a `<M: JsMachine>` parameter, and runs the same
//! body against all three machine types. A test that named a concrete type
//! would prove the impl compiles, not that the abstraction holds.
//!
//! What is NOT tested here, because it is not done: `Engine::Ironhorse` and
//! spawn-payload selection. See `engine/js_machine.rs` for why.

#![cfg(feature = "ironhorse-engine")]

use endo::engine::{JsMachine, JsMachineErrorKind};
use endo::ironhorse_engine::engine::{
    CadencePolicy, HeapStoreOptions, Machine, MachineError, MeterBounds, PersistentMachine,
};

fn store_options(dir: &std::path::Path) -> HeapStoreOptions {
    HeapStoreOptions {
        path: dir.join("js-machine-trait.sqlite"),
        signature: "endor-js-machine-trait-v1".to_string(),
        cadence: CadencePolicy::default(),
        meter: MeterBounds::per_crank(50_000_000),
        global_names: None,
    }
}

/// The body every engine runs. Takes `&mut dyn JsMachine` so the call sites
/// below cannot accidentally reach a concrete method.
fn evaluates(machine: &mut dyn JsMachine, what: &str) {
    assert_eq!(machine.eval("6 * 7").expect(what), "42", "{what}");
    assert_eq!(machine.eval("'a' + 'b'").expect(what), "ab", "{what}");
    assert_eq!(
        machine
            .eval("[1, 2, 3].map(function (n) { return n * 2; }).join(',')")
            .expect(what),
        "2,4,6",
        "{what}"
    );
    machine.drain_jobs().expect(what);
}

/// And the drain, made OBSERVABLE, for the engines whose globals survive from
/// one evaluation to the next.
///
/// The stateless IronHorse facade is excluded because it does not: each
/// `Machine::eval` is a self-contained crank, so `var seen` set in one and
/// read in the next is a `ReferenceError`. That is a real semantic difference
/// between the two IronHorse types and not something the trait hides — it is
/// why this is a separate helper with a stated exclusion rather than a
/// `drain_jobs()` call whose `Ok` proves nothing.
fn drains_observably(machine: &mut dyn JsMachine, what: &str) {
    assert_eq!(
        machine
            .eval("var seen = 0; Promise.resolve(1).then(function (v) { seen = v; }); seen")
            .expect(what),
        "0",
        "{what}: the reaction must still be pending at the end of the crank"
    );
    machine.drain_jobs().expect(what);
    assert_eq!(
        machine.eval("seen").expect(what),
        "1",
        "{what}: the reaction did not run — `drain_jobs` returned Ok without \
         draining"
    );
}

#[test]
fn every_engine_evaluates_through_the_trait() {
    let mut xs = xsnap::Machine::new(&xsnap::DEFAULT_CREATION, "js-machine-trait")
        .expect("an xsnap machine");
    evaluates(&mut xs, "xsnap");

    let mut stateless = Machine::new();
    evaluates(&mut stateless, "ironhorse (stateless)");

    let dir = tempfile::tempdir().expect("temp dir");
    let mut persistent = PersistentMachine::open(&store_options(dir.path())).expect("open");
    evaluates(&mut persistent, "ironhorse (persistent)");
    persistent.close().expect("close");
}

#[test]
fn a_state_retaining_engine_drains_observably_through_the_trait() {
    let mut xs = xsnap::Machine::new(&xsnap::DEFAULT_CREATION, "js-machine-drain")
        .expect("an xsnap machine");
    drains_observably(&mut xs, "xsnap");

    let dir = tempfile::tempdir().expect("temp dir");
    let mut persistent = PersistentMachine::open(&store_options(dir.path())).expect("open");
    drains_observably(&mut persistent, "ironhorse (persistent)");
    persistent.close().expect("close");
}

/// The exclusion above is a fact about the engine, asserted rather than
/// asserted-about: a stateless crank does not carry `var` bindings forward.
/// If this ever starts passing, `drains_observably` should cover it too.
#[test]
fn the_stateless_facade_does_not_retain_globals_between_evaluations() {
    let mut stateless: Box<dyn JsMachine> = Box::new(Machine::new());
    assert_eq!(
        stateless.eval("var kept = 7; kept").expect("first crank"),
        "7"
    );
    let error = stateless
        .eval("kept")
        .expect_err("a self-contained crank starts from the intrinsics");
    assert_eq!(error.kind(), JsMachineErrorKind::Halt);
}

/// A guest throw is an `Err`, not a value. Asserted for IronHorse only, and
/// the exclusion is the finding below rather than a gap in the trait.
#[test]
fn a_guest_throw_is_an_error() {
    let mut machine: Box<dyn JsMachine> = Box::new(Machine::new());
    let error = machine
        .eval("throw new Error('boom')")
        .expect_err("a throw is not a completion");
    assert_eq!(error.kind(), JsMachineErrorKind::Halt);
    assert!(
        !error.detail().is_empty(),
        "an error with no detail is not reportable"
    );
}

/// `xsnap::Machine::eval` documents "Returns `None` if the evaluation throws".
/// It does not. It installs no outermost `txJump`, so an XS throw longjmps
/// past a frame Rust no longer owns and the process takes **SIGSEGV**.
///
/// `#[ignore]` because running it kills the test binary, taking every other
/// test in this file with it — so this is a pinned, runnable reproduction
/// (`cargo test -p endo --test js_machine_trait -- --ignored`) rather than a
/// gate.
///
/// **Not caused by the `JsMachine` extraction, and not fixed by it.** The
/// defect predates this file; `xsnap::Machine::eval` had no caller outside
/// `#[cfg(test)]`, which is why nothing had met it. The fix is a `c_setjmp`
/// guard of the shape `fxRunPromiseJobsMetered` already uses in
/// `xsnap/xsnap-platform.c`, which is a change to the XS glue and belongs in
/// its own review rather than inside an architecture-review finding about an
/// abstraction.
#[test]
#[ignore = "SIGSEGVs the test binary: xsnap::Machine::eval has no jump guard"]
fn a_guest_throw_through_xsnap_segfaults() {
    let mut xs = xsnap::Machine::new(&xsnap::DEFAULT_CREATION, "js-machine-throw")
        .expect("an xsnap machine");
    let outcome = (&mut xs as &mut dyn JsMachine).eval("throw new Error('boom')");
    assert!(
        outcome.is_err(),
        "if this line is REACHED, the jump guard landed and this test should \
         become an ordinary one beside `a_guest_throw_is_an_error`"
    );
}

/// IronHorse's error taxonomy survives the trait (F157, which this extraction
/// could easily have re-committed). The coarse kind is what a caller branches
/// on; the engine's own `MachineError` is still underneath, reachable by
/// downcast, so nothing is discarded.
#[test]
fn the_engine_taxonomy_survives_the_trait() {
    let mut machine: Box<dyn JsMachine> = Box::new(Machine::new());
    let error = machine.eval("var = ;").expect_err("a syntax error");
    assert_eq!(
        error.kind(),
        JsMachineErrorKind::Compile,
        "a source that does not compile must not read as a halt"
    );
    let source = std::error::Error::source(&error).expect("the engine's own error is carried");
    let machine_error = source
        .downcast_ref::<MachineError>()
        .expect("and it is still a MachineError, not a rendering of one");
    assert!(
        matches!(machine_error, MachineError::Compile { .. }),
        "the taxonomy was flattened: {machine_error}"
    );
}

/// A verb an engine does not serve is a TYPED, NAMED gap rather than an absent
/// method or a silent success. F068 asked for exactly this: "leaving the verbs
/// it cannot yet serve as explicit `Err(Unavailable)` so the gap stays named
/// and typed rather than absent".
#[test]
fn an_unserved_verb_is_a_named_gap() {
    let mut stateless: Box<dyn JsMachine> = Box::new(Machine::new());
    let error = stateless
        .collect_garbage()
        .expect_err("the stateless facade has no reachable collector");
    assert_eq!(error.kind(), JsMachineErrorKind::Unavailable);
    assert!(
        error.detail().contains("collect_garbage"),
        "the gap must name the verb: {error}"
    );

    // And the engines that DO serve it, serve it.
    let mut xs = xsnap::Machine::new(&xsnap::DEFAULT_CREATION, "js-machine-collect")
        .expect("an xsnap machine");
    (&mut xs as &mut dyn JsMachine)
        .collect_garbage()
        .expect("xsnap collects");
    let dir = tempfile::tempdir().expect("temp dir");
    let mut persistent = PersistentMachine::open(&store_options(dir.path())).expect("open");
    persistent
        .eval("var held = [1, 2, 3]; held.length")
        .expect("a crank");
    (&mut persistent as &mut dyn JsMachine)
        .collect_garbage()
        .expect("the persistent machine collects");
    persistent.close().expect("close");
}

/// The trait is object-safe and the daemon can hold a heterogeneous set.
/// Without this the extraction buys nothing a generic function did not
/// already: runtime selection between engines is the first named trigger in
/// W6 decision 2, and it needs `dyn`.
#[test]
fn the_trait_is_object_safe_across_engines() {
    let dir = tempfile::tempdir().expect("temp dir");
    let mut machines: Vec<Box<dyn JsMachine>> = vec![
        Box::new(
            xsnap::Machine::new(&xsnap::DEFAULT_CREATION, "js-machine-dyn")
                .expect("an xsnap machine"),
        ),
        Box::new(Machine::new()),
        Box::new(PersistentMachine::open(&store_options(dir.path())).expect("open")),
    ];
    for machine in &mut machines {
        assert_eq!(machine.eval("1 + 1").expect("arithmetic"), "2");
    }
}
