//! The crash-injection matrix over every ordering point of a committing
//! crank (designs/ironhorse-panic.md § Verification), for the XS/CAS
//! watermark-ordering discipline.
//!
//! A clean setup phase leaves a worker with a published snapshot, one
//! compacted crank behind it, and a committed replay suffix. The measured
//! phase then restarts that worker under a [`FaultPlan`] and does one full
//! committing crank's lifecycle: admission, staging, the release commit,
//! release and acknowledgment, snapshot publication (blob write, blob sync,
//! rename, directory sync, snapshot record), and compaction. A counting dry
//! run numbers every mutating durability operation in that phase; the matrix
//! then replays the phase once per (operation, fault mode), restarts the
//! worker cleanly, and asserts:
//!
//! - replay reaches exactly the pre-crank or the post-crank state, never a
//!   third (torn) one, and re-derives every recorded frame;
//! - every outbound row on record belongs to a committed crank, and the
//!   receiver saw exactly the frames of the committed cranks, in order, once
//!   each (so no aborted crank's frame leaked, and no committed one was lost);
//! - the published snapshot never covers a crank beyond the last committed
//!   one, and its blob verifies;
//! - a surfaced fault poisoned the transcript, and a poisoned transcript
//!   refuses admission;
//! - the recovered worker converges: an explicit retry of a crank recovered
//!   as not committed, then a further crank, lands on the oracle state.

mod common;

use common::{oracle, Supervisor, Wire, WorkerFiles};
use slot_machine_transcript::{FaultMode, FaultPlan, TranscriptError};

const SETUP: [&[u8]; 3] = [b"alpha", b"beta", b"gamma"];
const TARGET: &[u8] = b"delta";
const AFTER: &[u8] = b"epsilon";

fn setup(files: &WorkerFiles, wire: &mut Wire) {
    let mut supervisor = Supervisor::start(files, None, wire).expect("fresh start");
    supervisor.crank(SETUP[0], wire).expect("alpha");
    supervisor.crank(SETUP[1], wire).expect("beta");
    supervisor.publish().expect("publish after beta");
    supervisor.compact().expect("compact after beta");
    // gamma is committed and released, but its acknowledgment is still
    // pending when the worker stops: the restart must re-release it.
    supervisor.crank(SETUP[2], wire).expect("gamma");
}

/// The measured phase. Stops at the first error, as a supervisor whose
/// transcript faulted stops serving the worker.
fn measured(supervisor: &mut Supervisor, wire: &mut Wire) -> Result<(), TranscriptError> {
    supervisor.crank(TARGET, wire)?;
    supervisor.publish()?;
    supervisor.compact()
}

struct Outcome {
    committed: bool,
    surfaced: Option<TranscriptError>,
}

fn run_case(n: Option<(u64, FaultMode)>) -> (Outcome, FaultPlan) {
    let root = tempfile::tempdir().expect("tempdir");
    let files = WorkerFiles::new(root.path(), "worker-a");
    let mut wire = Wire::default();
    setup(&files, &mut wire);
    let (pre_state, pre_frames) = oracle(&SETUP);
    let with_target: Vec<&[u8]> = SETUP.iter().copied().chain([TARGET]).collect();
    let (post_state, post_frames) = oracle(&with_target);

    let plan = match n {
        Some((n, mode)) => FaultPlan::fail_at(n, mode),
        None => FaultPlan::counting(),
    };
    let label = n.map_or("dry run".to_string(), |(n, mode)| {
        format!("{mode:?} at op {n}")
    });

    let mut surfaced = None;
    match Supervisor::start(&files, Some(plan.clone()), &mut wire) {
        Ok(mut supervisor) => {
            if let Err(e) = measured(&mut supervisor, &mut wire) {
                if let TranscriptError::Fault(_) = &e {
                    assert!(
                        supervisor.transcript.poisoned().is_some(),
                        "{label}: a fault must poison the transcript"
                    );
                    assert!(
                        matches!(
                            supervisor.transcript.begin_crank(AFTER),
                            Err(TranscriptError::Poisoned(_))
                        ),
                        "{label}: a poisoned transcript must refuse admission"
                    );
                }
                surfaced = Some(e);
            }
        }
        Err(e) => surfaced = Some(e),
    }
    if let Some(e) = &surfaced {
        assert!(n.is_some(), "dry run failed: {e}");
        assert!(
            plan.fired(),
            "{label}: error without an injected fault: {e}"
        );
    }

    // Restart cleanly: the supervisor after a process kill, or after a
    // reconcile-before-retry.
    let mut supervisor = Supervisor::start(&files, None, &mut wire)
        .unwrap_or_else(|e| panic!("{label}: restart failed: {e}"));
    let committed = if supervisor.state == post_state {
        true
    } else {
        assert_eq!(
            supervisor.state, pre_state,
            "{label}: replay reached a torn state"
        );
        false
    };
    let expected_frames = if committed { &post_frames } else { &pre_frames };
    assert_eq!(
        &wire.accepted, expected_frames,
        "{label}: receiver saw the wrong frames"
    );

    for (seq, crank, state) in supervisor.transcript.outbound_audit().expect("audit") {
        assert_eq!(
            state, "committed",
            "{label}: outbound seq {seq} of crank {crank} is on record uncommitted"
        );
    }
    for aborted in supervisor.transcript.aborted_cranks().expect("aborted") {
        assert!(
            !committed,
            "{label}: the target committed yet crank {} is aborted",
            aborted.crank
        );
        assert_eq!(
            aborted.inbound, TARGET,
            "{label}: only the target crank may be in doubt"
        );
    }
    let snapshot = supervisor
        .transcript
        .latest_snapshot()
        .expect("snapshot")
        .expect("a published snapshot");
    let committed_cranks = if committed { 4 } else { 3 };
    assert!(
        snapshot.watermark_crank <= committed_cranks,
        "{label}: snapshot covers crank {} but only {committed_cranks} committed",
        snapshot.watermark_crank
    );

    // Converge: retry the target if it did not commit, then one more crank.
    if !committed {
        supervisor
            .crank(TARGET, &mut wire)
            .unwrap_or_else(|e| panic!("{label}: retry failed: {e}"));
    }
    supervisor
        .crank(AFTER, &mut wire)
        .unwrap_or_else(|e| panic!("{label}: follow-on failed: {e}"));
    supervisor.publish().expect("publish");
    supervisor.compact().expect("compact");
    drop(supervisor);
    let final_sup = Supervisor::start(&files, None, &mut wire).expect("final restart");
    let all: Vec<&[u8]> = SETUP.iter().copied().chain([TARGET, AFTER]).collect();
    let (final_state, final_frames) = oracle(&all);
    assert_eq!(final_sup.state, final_state, "{label}: did not converge");
    assert_eq!(
        wire.accepted, final_frames,
        "{label}: converged frames differ"
    );

    (
        Outcome {
            committed,
            surfaced,
        },
        plan,
    )
}

#[test]
fn crash_matrix_xs_cas_watermark_ordering() {
    let (dry, counting) = run_case(None);
    assert!(dry.committed && dry.surfaced.is_none());
    let ops = counting.log();
    let total = ops.len() as u64;
    assert!(total > 0);
    // The ordering points the design names must all be in the numbered
    // sequence, or the matrix is not covering them.
    for needle in [
        "sqlite:sync:wal",
        "blob-store:write-blob",
        "blob-store:sync-blob",
        "blob-store:rename-blob",
        "blob-store:sync-directory",
    ] {
        assert!(
            ops.iter().any(|op| op.starts_with(needle)),
            "no {needle} operation in {ops:#?}"
        );
    }
    eprintln!("measured phase: {total} durability operations");
    for (i, op) in ops.iter().enumerate() {
        eprintln!("  {:>3} {op}", i + 1);
    }

    let mut committed = 0;
    let mut rolled_back = 0;
    let mut surfaced = 0;
    for mode in FaultMode::ALL {
        for n in 1..=total {
            let (outcome, plan) = run_case(Some((n, mode)));
            assert!(plan.fired(), "{mode:?} at op {n}: fault never fired");
            if outcome.committed {
                committed += 1;
            } else {
                rolled_back += 1;
            }
            if outcome.surfaced.is_some() {
                surfaced += 1;
            }
        }
    }
    eprintln!(
        "matrix: {} cases, {committed} reached post-crank, {rolled_back} reached pre-crank, {surfaced} surfaced a fault",
        4 * total
    );
    // Not vacuous: faults early in the crank must roll it back, and faults
    // after its release commit must keep it.
    assert!(committed > 0 && rolled_back > 0);
}
