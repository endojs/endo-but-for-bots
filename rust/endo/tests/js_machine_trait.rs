//! Three machine types answer the same four calls (architecture finding F068).
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
//! be"). That argument was right, and the evidence is
//! [`the_stateless_facade_leaves_jobs_behind_after_a_failed_crank`] below: the
//! first version of this trait gave both IronHorse types the same
//! `drain_jobs() -> Ok(())` under the same comment, and for one of them the
//! postcondition was false.
//!
//! So the two shared bodies take `&mut dyn JsMachine`, and every test reaches
//! the machine through the trait. Not every test covers every engine: where a
//! behaviour differs by engine the test says which one it is about and why,
//! rather than averaging three engines into a claim that holds for none. Some
//! tests also call a concrete method to SET UP (a `PersistentMachine::eval`
//! for its outcome, a concrete `close`); the assertions are through the trait.
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

/// And the drain, made OBSERVABLE — for xsnap. Read what this does and does
/// not prove before adding an engine to it.
///
/// For **xsnap** it is a real assertion: `run_promise_jobs` is what runs the
/// reaction, and deleting that call reddens this.
///
/// For **`PersistentMachine`** it is not. The reaction already ran inside
/// crank 1, so the second read returns `"1"` whether or not `drain_jobs` was
/// called at all — the impl is an empty `Ok(())` and there is nothing here to
/// mutate. It is included because running the same body against it is how the
/// difference between the two IronHorse types was found, not because it gates
/// that impl. What gates that impl is
/// `a_failed_persistent_crank_leaves_no_jobs_behind`.
///
/// The stateless IronHorse facade is excluded outright: each `Machine::eval`
/// is a self-contained crank, so `var seen` set in one and read in the next is
/// a `ReferenceError`.
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
    // The KIND alone is satisfied by any throw, any unlanded surface, any
    // decode error — so it would keep passing if the facade started failing
    // for an unrelated reason, and this test exists to say WHY it fails.
    assert!(
        error.detail().contains("kept"),
        "the error must name the binding that did not survive: {error}"
    );
}

/// The `drain_jobs` postcondition is the queue being EMPTY, and for the
/// stateless facade after a crank that did not complete it is not met — so
/// the trait says so rather than answering `Ok(())`.
///
/// This is the finding the second implementor produced, and it is why the
/// deferral's "the second implementor tells you what the shape should be" was
/// right. The first version of this trait gave both IronHorse types the same
/// unconditional `Ok(())` under a comment asserting the postcondition, and for
/// this one the queue really does survive: `Interp::run` pumps only on
/// `Step::Returned`.
#[test]
fn the_stateless_facade_leaves_jobs_behind_after_a_failed_crank() {
    let mut stateless: Box<dyn JsMachine> = Box::new(Machine::new());
    // A completed crank drains its own queue, so the postcondition holds.
    stateless
        .eval("Promise.resolve(1).then(function () {}); 1")
        .expect("a completed crank");
    stateless
        .drain_jobs()
        .expect("after a completed crank the queue is empty");

    // A crank that halts does not, and the trait must not claim otherwise.
    let mut stateless: Box<dyn JsMachine> = Box::new(Machine::new());
    stateless
        .eval("Promise.resolve(1).then(function () {}); throw new Error('x');")
        .expect_err("the crank halts");
    let error = stateless
        .drain_jobs()
        .expect_err("jobs are queued and this facade cannot pump them");
    assert_eq!(error.kind(), JsMachineErrorKind::Unavailable);
    assert!(
        error.detail().contains("drain_jobs"),
        "the gap must name the verb: {error}"
    );
}

/// And the persistent machine's unconditional `Ok(())` is sound in the same
/// shape, because a halted crank REWINDS rather than returning with a
/// half-drained queue. Two impls that look identical are not, and this is the
/// half that holds.
#[test]
fn a_failed_persistent_crank_leaves_no_jobs_behind() {
    let dir = tempfile::tempdir().expect("temp dir");
    let mut persistent = PersistentMachine::open(&store_options(dir.path())).expect("open");
    persistent.eval("var ran = 0; ran").expect("a first crank");
    {
        let machine: &mut dyn JsMachine = &mut persistent;
        machine
            .eval("Promise.resolve(1).then(function () { ran = 1; }); throw new Error('x');")
            .expect_err("the crank halts");
        machine
            .drain_jobs()
            .expect("the rewind leaves nothing queued");
        assert_eq!(
            machine.eval("ran").expect("after the rewind"),
            "0",
            "the halted crank's effects must have been rewound"
        );
    }
    persistent.close().expect("close");
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

/// `collect_garbage` COLLECTS, on both engines that serve it.
///
/// Without this, deleting the body of either impl and returning a bare
/// `Ok(())` left the whole suite green: a `collect_garbage` that collects
/// nothing passed a test that called it and asserted the `Ok`.
///
/// The observable is engine-specific because the engines do not share one.
/// xsnap has `WeakRef`, so a guest can watch an unreachable referent go; the
/// IronHorse realm does not expose `WeakRef`, so the counter `collect` returns
/// is the witness there. Reaching for an engine-specific observable is the
/// right trade: a shared one that only worked for one engine would be back to
/// asserting `Ok`.
#[test]
fn collect_garbage_actually_collects() {
    // xsnap: the referent is unreachable the moment the IIFE returns, so only
    // a collection can clear the `WeakRef`.
    let mut xs = xsnap::Machine::new(&xsnap::DEFAULT_CREATION, "js-machine-collect-effect")
        .expect("an xsnap machine");
    {
        let machine: &mut dyn JsMachine = &mut xs;
        assert_eq!(
            machine
                .eval("var wr; (function () { wr = new WeakRef({}); })(); typeof wr.deref()")
                .expect("xsnap"),
            "object",
            "the referent must still be live before collecting"
        );
        machine.collect_garbage().expect("xsnap collects");
        assert_eq!(
            machine.eval("typeof wr.deref()").expect("xsnap"),
            "undefined",
            "xsnap: `collect_garbage` returned Ok without collecting"
        );
    }

    // IronHorse: a collection CHECKPOINTS, and the store epoch "advances by
    // one per checkpoint", so the epoch either side of the trait call is the
    // witness. (`collect`'s own return value is slots reclaimed, which is 0
    // when there is nothing to free and so cannot tell a collection that ran
    // from one that did not.) Nothing else runs between the two readings, so
    // only the collection can move it.
    let dir = tempfile::tempdir().expect("temp dir");
    let mut persistent = PersistentMachine::open(&store_options(dir.path())).expect("open");
    persistent
        .eval("var held = [1, 2, 3]; held.length")
        .expect("a crank to collect over");
    let before = persistent.epoch().expect("an epoch");
    (&mut persistent as &mut dyn JsMachine)
        .collect_garbage()
        .expect("the persistent machine collects");
    let after = persistent.epoch().expect("an epoch");
    assert!(
        after > before,
        "the trait's `collect_garbage` did not run a collection: the store \
         epoch stayed at {before} across it"
    );
    persistent.close().expect("close");
}

/// The one reachable `Err` from xsnap's `eval`, and its kind.
///
/// A source carrying an interior NUL fails in `CString::new` before any JS
/// runs, so it is the only failure that comes back rather than crashing (see
/// the impl's documentation). It is `Compile` — a fact about the source — and
/// not `Halt`, which the first version answered and which would have said the
/// program ran.
#[test]
fn an_unpassable_source_is_a_compile_error_on_xsnap() {
    let mut xs =
        xsnap::Machine::new(&xsnap::DEFAULT_CREATION, "js-machine-nul").expect("an xsnap machine");
    let error = (&mut xs as &mut dyn JsMachine)
        .eval("var x = 1;\0 x")
        .expect_err("a source with an interior NUL cannot be passed to XS");
    assert_eq!(error.kind(), JsMachineErrorKind::Compile);
    assert!(
        error.detail().contains("NUL"),
        "the error must say what is wrong with the source: {error}"
    );
}

/// A `PersistentMachine` can be RELEASED through the trait.
///
/// `PersistentMachine::close` consumes by value, so before `close` was on the
/// trait a `Box<dyn JsMachine>` holding one could only be dropped — losing the
/// final flush and the `StoreLeakedAtClose` detection that only `close`
/// performs. The `dyn` path is the whole point of the extraction (runtime
/// engine selection is W6 decision 2's first trigger), so a `dyn` path that
/// cannot release a machine correctly is not a working abstraction.
#[test]
fn every_engine_can_be_released_through_the_trait() {
    let dir = tempfile::tempdir().expect("temp dir");
    // A cadence WIDER than one crank, so the crank below is completed but not
    // yet flushed when the machine is released. Under the default
    // `checkpoint_every: 1` every crank is already durable and dropping the
    // machine would lose nothing — the test would pass against a `close` that
    // did nothing, which is the mutation it exists to catch.
    let mut options = store_options(dir.path());
    options.cadence.checkpoint_every = 8;
    {
        let mut machines: Vec<Box<dyn JsMachine>> = vec![
            Box::new(
                xsnap::Machine::new(&xsnap::DEFAULT_CREATION, "js-machine-close")
                    .expect("an xsnap machine"),
            ),
            Box::new(Machine::new()),
            Box::new(PersistentMachine::open(&options).expect("open")),
        ];
        for machine in &mut machines {
            assert_eq!(
                machine
                    .eval("var durable = 41; durable + 1")
                    .expect("a crank"),
                "42"
            );
        }
        for machine in machines {
            machine.close().expect("release");
        }
    }
    // The store is reopenable and carries the crank, which is what a closed
    // machine owes and a dropped one does not guarantee.
    let mut reopened = PersistentMachine::open(&options).expect("reopen");
    assert_eq!(
        reopened
            .eval("durable")
            .expect("the closed machine's crank survived")
            .result,
        "41"
    );
    reopened.close().expect("close");
}

/// A metered refusal is a RESOURCE STOP, which the trait's `Halt` kind is
/// documented to cover — not the `Engine` catch-all.
///
/// It reached `Engine` in the first version, in the same bucket as a relink
/// failure, and worse: the SAME refusal took two different kinds depending on
/// whether a limit was attached to it (`MachineError::MeterAbort {..}` against
/// `MachineError::Halt(Halt::MeterAbort)`). `MachineError`'s own comment calls
/// `MeterAbort` "distinct from every other halt because it is the one a
/// supervisor budgets for", so collapsing it is the F157 mistake in miniature.
#[test]
fn a_metered_refusal_is_a_resource_stop() {
    let mut machine: Box<dyn JsMachine> =
        Box::new(Machine::with_bounds(MeterBounds::per_crank(200_000)));
    let error = machine
        .eval("var i = 0; while (true) { i = i + 1; }")
        .expect_err("the meter refuses a spinning crank");
    assert_eq!(
        error.kind(),
        JsMachineErrorKind::Halt,
        "a metered refusal is a resource stop, not an engine-internal failure"
    );
    let source = std::error::Error::source(&error).expect("the engine's own error");
    let machine_error = source
        .downcast_ref::<MachineError>()
        .expect("still a MachineError");
    assert!(
        matches!(machine_error, MachineError::MeterAbort { .. }),
        "the refusal must keep its own identity underneath: {machine_error}"
    );
}

/// An engine GAP and a profile REFUSAL are `Unavailable`, not `Halt`.
///
/// IronHorse says "not built yet" through two channels — `MachineError::
/// Unavailable` for a surface the embedder seam has not landed, and
/// `Halt::NotImplemented` for one the VM has not — and it says "this profile
/// declines that" through `Halt::Refused`. The first version routed the two
/// halts to `Halt`, which reads as "your program did something", splitting one
/// statement across two kinds for no reason a caller could use.
#[test]
fn an_engine_gap_and_a_profile_refusal_are_both_unavailable() {
    for (source, what) in [
        // A named, unlanded VM surface.
        (
            "new Intl.NumberFormat('fr', { notation: 'compact' }).format(1000)",
            "Halt::NotImplemented",
        ),
        // A surface the execution profile declines rather than lacks.
        (
            "Atomics.wait(new Int32Array(new SharedArrayBuffer(8)), 0, 0, 0)",
            "Halt::Refused",
        ),
    ] {
        let mut machine: Box<dyn JsMachine> = Box::new(Machine::new());
        let error = machine.eval(source).expect_err(what);
        assert_eq!(
            error.kind(),
            JsMachineErrorKind::Unavailable,
            "{what} must read as 'this engine cannot do that', not as a halt \
             the program caused: {error}"
        );
    }
}
