//! Embargo coverage (designs/ironhorse-panic.md § Verification, "Embargo
//! coverage assertions"): one case per row of the "Which termination paths
//! the embargo includes" table. Each case drives a crank to its
//! `ExecutionOutcome`, settles the Slot Machine embargo by that outcome's
//! verdict, and asserts that `Quiesced` releases the crank's frames in
//! sequence order after commit while every other row, `MeterAbort`
//! included, leaves zero frames observable outside the vat, before and
//! after a restart.
//!
//! Rows whose halt the engine reaches from guest source run real source
//! through `Machine::evaluate`. `EngineFault`, `Decode`, and `StepLimit`
//! have no guest-source trigger, so those rows classify the halt the
//! engine returns for them.

#![cfg(feature = "ironhorse-engine")]

use std::cell::RefCell;
use std::rc::Rc;

use endo::ironhorse_engine::engine::{
    EvalOutcome, ExecutionOutcome, Machine, MachineError, MeterBounds,
};
use ironhorse_vm::{DecodeError, Halt, PanicKind};
use slot_machine_transcript::{
    ContentAddressedStore, CrankVerdict, Embargo, FrameSink, ReleasableFrame, Settlement,
    SnapshotMeta, Transcript, TranscriptConfig,
};

/// Everything that reached the wire.
#[derive(Default)]
struct Wire(Rc<RefCell<Vec<ReleasableFrame>>>);

impl FrameSink for Wire {
    type Error = std::convert::Infallible;

    fn deliver(&mut self, frame: &ReleasableFrame) -> Result<(), Self::Error> {
        self.0.borrow_mut().push(frame.clone());
        Ok(())
    }
}

/// The supervisor's reading of one evaluation: the halt the run stopped on
/// classifies through the seam's canonical constructor.
fn outcome_of(result: Result<EvalOutcome, MachineError>) -> ExecutionOutcome {
    match result {
        Ok(outcome) => ExecutionOutcome::classify(outcome.halt),
        Err(MachineError::Halt(halt)) => ExecutionOutcome::classify(halt),
        Err(other) => panic!("not a termination path: {other:?}"),
    }
}

fn run(source: &str) -> ExecutionOutcome {
    outcome_of(Machine::with_bounds(MeterBounds::per_crank(200_000)).evaluate(source, false))
}

fn embargo(directory: &std::path::Path) -> (Embargo<Wire>, Rc<RefCell<Vec<ReleasableFrame>>>) {
    let path = slot_machine_transcript::transcript_path(directory, "vat-1");
    let cas = ContentAddressedStore::open(directory.join("snapshots"), "vat-1").unwrap();
    let (mut transcript, _) = Transcript::open(&path, TranscriptConfig::new("vat-1")).unwrap();
    if transcript.latest_snapshot().unwrap().is_none() {
        let meta = SnapshotMeta {
            engine_signature: b"ironhorse-embargo-coverage".to_vec(),
            panic_on_reference_error: false,
        };
        transcript.publish_snapshot(&cas, b"heap", meta).unwrap();
    }
    let wire = Wire::default();
    let seen = wire.0.clone();
    (Embargo::new(transcript, wire).unwrap(), seen)
}

const FRAMES: [&[u8]; 3] = [b"resolve:1", b"send:2", b"drop:3"];

/// Drive one crank: the guest sends `FRAMES` while the engine runs to
/// `outcome`, then the supervisor settles by the outcome's verdict.
/// Returns what reached the wire and what a restart re-releases.
fn crank_to(
    outcome: &ExecutionOutcome,
) -> (
    Vec<ReleasableFrame>,
    usize,
    Settlement<std::convert::Infallible>,
) {
    let directory = tempfile::tempdir().unwrap();
    let (mut embargo, seen) = embargo(directory.path());
    embargo.admit(b"deliver").unwrap();
    for frame in FRAMES {
        embargo.send(frame.to_vec()).unwrap();
        assert!(
            seen.borrow().is_empty(),
            "a staged frame left the vat mid-crank"
        );
    }
    let settlement = embargo.settle(outcome.verdict()).unwrap();
    let released = seen.borrow().clone();
    // Crash before any acknowledgment is durable; a restart re-releases
    // exactly the committed, unacknowledged frames.
    drop(embargo);
    let (restarted, _) = self::embargo(directory.path());
    (released, restarted.queued().len(), settlement)
}

fn assert_released_in_order(outcome: ExecutionOutcome) {
    assert_eq!(outcome, ExecutionOutcome::Quiesced);
    let (released, requeued, settlement) = crank_to(&outcome);
    assert!(matches!(
        settlement,
        Settlement::Committed { blocked: None, .. }
    ));
    let payloads: Vec<&[u8]> = released.iter().map(|f| f.payload.as_slice()).collect();
    assert_eq!(payloads, FRAMES);
    assert!(released.windows(2).all(|w| w[0].sequence < w[1].sequence));
    assert!(released
        .iter()
        .all(|f| f.idempotency_key == format!("vat-1:{}", f.sequence)));
    assert_eq!(
        requeued,
        FRAMES.len(),
        "committed frames must survive to re-release"
    );
}

fn assert_discarded(row: &str, outcome: ExecutionOutcome, verdict: CrankVerdict) {
    assert_eq!(outcome.verdict(), verdict, "{row}: {outcome:?}");
    let (released, requeued, settlement) = crank_to(&outcome);
    assert!(
        released.is_empty(),
        "{row}: {} frame(s) left the vat",
        released.len()
    );
    assert_eq!(
        requeued, 0,
        "{row}: a restart would release an aborted crank's frames"
    );
    assert!(
        matches!(settlement, Settlement::Discarded { frames: 3, verdict: v, .. } if v == verdict),
        "{row}: {settlement:?}"
    );
}

#[test]
fn row_normal_quiescence_commits_then_releases_in_sequence() {
    assert_released_in_order(run(
        "var total = 0; for (var i = 0; i < 10; i++) total += i; total",
    ));
}

#[test]
fn row_normal_quiescence_includes_a_handled_rejection() {
    // § Open Questions, "Should an uncaught `Throw`":
    // an ordinary rejection the delivery handles is a normal result,
    // committed and released, not an uncaught throw.
    assert_released_in_order(run(
        "var r = 'none'; try { throw new Error('rejected'); } catch (e) { r = e.message; } r",
    ));
}

#[test]
fn row_uncaught_throw_is_discarded() {
    let outcome = run("throw new Error('escaped every handler');");
    assert!(
        matches!(outcome, ExecutionOutcome::Uncaught(_)),
        "{outcome:?}"
    );
    assert_discarded("Throw (uncaught)", outcome, CrankVerdict::Uncaught);
}

#[test]
fn row_stack_overflow_is_discarded() {
    let outcome = run("function f(n) { return f(n + 1) + 1; } f(0)");
    let ExecutionOutcome::Panicked(halt) = &outcome else {
        panic!("runaway recursion must panic, got {outcome:?}");
    };
    assert!(
        matches!(halt, Halt::StackOverflow(_) | Halt::ReentryLimit { .. }),
        "{halt:?}"
    );
    assert_discarded("StackOverflow", outcome, CrankVerdict::Panicked);
}

#[test]
fn row_meter_abort_is_discarded() {
    let outcome = run("var i = 0; while (true) { i = i + 1; }");
    assert_eq!(outcome, ExecutionOutcome::Panicked(Halt::MeterAbort));
    assert_discarded("MeterAbort (hard limit)", outcome, CrankVerdict::Panicked);
}

#[test]
fn row_engine_fault_is_discarded() {
    let outcome = ExecutionOutcome::classify(Halt::Panic(PanicKind::EngineFault {
        message: "arena kind check".to_string(),
        location: Some("interp.rs:1:1".to_string()),
    }));
    assert!(matches!(outcome, ExecutionOutcome::Panicked(_)));
    assert_discarded("Rust EngineFault", outcome, CrankVerdict::Panicked);
}

#[test]
fn row_reference_error_is_discarded_with_the_coda_off_or_on() {
    // With panic-on-reference-error off (today's only mode), an unresolved
    // name raises a catchable ReferenceError that escapes as an uncaught
    // throw. With the Coda on it becomes a Panicked outcome; the embargo
    // reads the arm, not the reason, so the verdict discards either way.
    let outcome = run("undeclaredName + 1");
    assert!(
        matches!(outcome, ExecutionOutcome::Uncaught(_)),
        "{outcome:?}"
    );
    assert_discarded("ReferenceError (Coda off)", outcome, CrankVerdict::Uncaught);
    assert_eq!(
        ExecutionOutcome::Panicked(Halt::synthetic_throw("ReferenceError".to_string())).verdict(),
        CrankVerdict::Panicked
    );
}

#[test]
fn row_decode_is_discarded() {
    let outcome =
        ExecutionOutcome::classify(Halt::Decode(DecodeError::ProgramCounterOutOfBounds {
            pc: 9,
            len: 4,
        }));
    assert!(matches!(outcome, ExecutionOutcome::Panicked(_)));
    assert_discarded("Decode", outcome, CrankVerdict::Panicked);
}

#[test]
fn row_step_limit_is_discarded() {
    let outcome = ExecutionOutcome::classify(Halt::StepLimit(1_000_000));
    assert!(matches!(outcome, ExecutionOutcome::Panicked(_)));
    assert_discarded("StepLimit", outcome, CrankVerdict::Panicked);
}

#[test]
fn every_other_non_quiescent_halt_is_discarded_too() {
    // The panic set beyond the table's rows, and the fail-closed
    // `Panicked` superset: none may release.
    for halt in [
        Halt::ReentryLimit { depth: 9, limit: 8 },
        Halt::HeapExhausted,
        Halt::EngineInvariant("bitwise:stack-underflow"),
        Halt::NotImplemented("STAGE8_GAP"),
    ] {
        let row = format!("{halt:?}");
        assert_discarded(
            &row,
            ExecutionOutcome::classify(halt),
            CrankVerdict::Panicked,
        );
    }
}
