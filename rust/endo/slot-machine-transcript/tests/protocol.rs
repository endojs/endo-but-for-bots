//! The transcript's crank protocol, storage-fault disposition, durability
//! bound, and release idempotency (designs/ironhorse-panic.md § Slot Machine
//! per-worker write-ahead transcript, Q6, Q7, § Verification).

mod common;

use common::{meta, oracle, snapshot_bytes, Supervisor, Wire, WorkerFiles};
use slot_machine_transcript::{
    transcript_path, CasStore, FaultMode, FaultPlan, Operation, SnapshotMeta, Transcript,
    TranscriptConfig, TranscriptError, TranscriptLimits,
};

fn fresh(root: &std::path::Path, worker: &str) -> (WorkerFiles, Supervisor, Wire) {
    let files = WorkerFiles::new(root, worker);
    let mut wire = Wire::default();
    let sup = Supervisor::start(&files, None, &mut wire).expect("start");
    (files, sup, wire)
}

#[test]
fn transcript_lives_under_the_worker_directory() {
    let p = transcript_path(std::path::Path::new("/endo"), "w1");
    assert_eq!(
        p,
        std::path::Path::new("/endo/workers/w1/transcript.sqlite")
    );
}

#[test]
fn admission_requires_a_published_snapshot() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("t.sqlite");
    let (mut t, _) = Transcript::open(&path, TranscriptConfig::new("w")).unwrap();
    assert!(matches!(
        t.begin_crank(b"x"),
        Err(TranscriptError::Protocol(_))
    ));
    let cas = CasStore::open(root.path().join("cas")).unwrap();
    t.publish_snapshot(&cas, &snapshot_bytes(0), meta())
        .unwrap();
    t.begin_crank(b"x").unwrap();
}

#[test]
fn aborted_crank_leaves_no_outbound_and_keeps_its_inbound() {
    let root = tempfile::tempdir().unwrap();
    let (_files, mut sup, _wire) = fresh(root.path(), "w");
    let t = &mut sup.transcript;
    let crank = t.begin_crank(b"doomed").unwrap();
    t.stage_outbound(b"leak-1".to_vec()).unwrap();
    t.stage_outbound(b"leak-2".to_vec()).unwrap();
    t.abort_crank().unwrap();
    assert!(t.releasable().unwrap().is_empty());
    assert!(t.outbound_audit().unwrap().is_empty());
    assert_eq!(t.crank_state(crank).unwrap().as_deref(), Some("aborted"));
    let aborted = t.aborted_cranks().unwrap();
    assert_eq!(aborted.len(), 1);
    assert_eq!(aborted[0].inbound, b"doomed");
}

#[test]
fn committed_frames_release_in_sequence_with_stable_keys() {
    let root = tempfile::tempdir().unwrap();
    let (_files, mut sup, _wire) = fresh(root.path(), "w");
    let t = &mut sup.transcript;
    let crank = t.begin_crank(b"in").unwrap();
    for i in 0..3 {
        t.stage_outbound(format!("f{i}").into_bytes()).unwrap();
    }
    let frames = t.commit_crank().unwrap();
    assert_eq!(frames.len(), 3);
    assert!(frames.windows(2).all(|w| w[0].seq < w[1].seq));
    for f in &frames {
        assert_eq!(f.crank, crank);
        assert_eq!(f.idempotency_key, format!("w:{}", f.seq));
    }
    assert_eq!(t.releasable().unwrap(), frames);
    t.mark_released(frames.iter().map(|f| f.seq));
    t.flush_acks().unwrap();
    assert!(t.releasable().unwrap().is_empty());
}

#[test]
fn one_admission_and_one_release_sync_per_crank_regardless_of_frame_count() {
    let root = tempfile::tempdir().unwrap();
    let files = WorkerFiles::new(root.path(), "w");
    let mut wire = Wire::default();
    drop(Supervisor::start(&files, None, &mut wire).unwrap());
    let plan = FaultPlan::counting();
    let config = TranscriptConfig::new("w").with_fault_plan(plan.clone());
    let (mut t, _) = Transcript::open(files.transcript(), config).unwrap();
    let mut syncs_for = |frames: usize| {
        let before = plan.syncs();
        t.begin_crank(b"in").unwrap();
        for i in 0..frames {
            t.stage_outbound(format!("frame-{i}").into_bytes()).unwrap();
        }
        let released = t.commit_crank().unwrap();
        t.mark_released(released.iter().map(|f| f.seq));
        plan.syncs() - before
    };
    // Warm up so the WAL header write is behind us.
    syncs_for(1);
    let one = syncs_for(1);
    let many = syncs_for(64);
    assert_eq!(one, 2, "admission + release commit");
    assert_eq!(many, one, "outbound frames must not add syncs");
    let stats = t.stats();
    assert_eq!(
        (stats.admissions, stats.releases, stats.ack_flushes),
        (3, 3, 0)
    );
}

#[test]
fn staging_past_the_per_crank_bound_is_refused_not_truncated() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("t.sqlite");
    let mut config = TranscriptConfig::new("w");
    config.limits = TranscriptLimits {
        max_outbound_events: 2,
        max_outbound_bytes: 8,
        max_inbound_bytes: 4,
    };
    let (mut t, _) = Transcript::open(&path, config).unwrap();
    let cas = CasStore::open(root.path().join("cas")).unwrap();
    t.publish_snapshot(&cas, &snapshot_bytes(0), meta())
        .unwrap();
    assert!(matches!(
        t.begin_crank(b"too-big"),
        Err(TranscriptError::Backpressure(_))
    ));
    t.begin_crank(b"ok").unwrap();
    t.stage_outbound(b"abc".to_vec()).unwrap();
    assert!(matches!(
        t.stage_outbound(b"123456".to_vec()),
        Err(TranscriptError::Backpressure(_))
    ));
    t.stage_outbound(b"de".to_vec()).unwrap();
    assert!(matches!(
        t.stage_outbound(b"f".to_vec()),
        Err(TranscriptError::Backpressure(_))
    ));
    // The crank is still active; the supervisor chooses to commit or abort.
    assert_eq!(t.commit_crank().unwrap().len(), 2);
}

/// Number the operations of one release commit on a fresh worker, so a test
/// can aim a fault at a specific point in it.
fn commit_ops(root: &std::path::Path) -> (u64, Vec<String>) {
    let files = WorkerFiles::new(root, "probe");
    let mut wire = Wire::default();
    drop(Supervisor::start(&files, None, &mut wire).unwrap());
    let plan = FaultPlan::counting();
    let (mut t, _) = Transcript::open(
        files.transcript(),
        TranscriptConfig::new("probe").with_fault_plan(plan.clone()),
    )
    .unwrap();
    t.begin_crank(b"in").unwrap();
    t.stage_outbound(b"out".to_vec()).unwrap();
    let start = plan.count();
    t.commit_crank().unwrap();
    (start, plan.log()[start as usize..].to_vec())
}

fn worker_with_plan(
    root: &std::path::Path,
    name: &str,
    plan: FaultPlan,
) -> (WorkerFiles, Transcript) {
    let files = WorkerFiles::new(root, name);
    let mut wire = Wire::default();
    drop(Supervisor::start(&files, None, &mut wire).unwrap());
    let (t, _) = Transcript::open(
        files.transcript(),
        TranscriptConfig::new(name).with_fault_plan(plan),
    )
    .unwrap();
    (files, t)
}

#[test]
fn a_write_fault_poisons_the_worker_and_spares_its_sibling() {
    let root = tempfile::tempdir().unwrap();
    let (start, ops) = commit_ops(&root.path().join("probe"));
    let first_write = ops
        .iter()
        .position(|op| op.starts_with("sqlite:write"))
        .unwrap() as u64;
    let plan = FaultPlan::fail_at(start + first_write + 1, FaultMode::FailOnce);
    let (files_a, mut a) = worker_with_plan(root.path(), "a", plan.clone());
    let (_files_b, mut b, mut wire_b) = fresh(root.path(), "b");

    let crank = a.begin_crank(b"in").unwrap();
    a.stage_outbound(b"out".to_vec()).unwrap();
    let Err(TranscriptError::Fault(fault)) = a.commit_crank() else {
        panic!("expected a transcript fault");
    };
    assert!(plan.fired());
    assert_eq!(fault.worker, "a");
    assert_eq!(fault.crank, Some(crank));
    assert_eq!(fault.operation, Operation::Commit);
    assert!(fault.sqlite_primary.is_some() && fault.sqlite_extended.is_some());
    assert!(matches!(
        a.begin_crank(b"next"),
        Err(TranscriptError::Poisoned(_))
    ));
    assert!(matches!(a.flush_acks(), Err(TranscriptError::Poisoned(_))));

    // The sibling keeps serving.
    b.crank(b"one", &mut wire_b).unwrap();
    b.crank(b"two", &mut wire_b).unwrap();
    assert_eq!(wire_b.accepted, oracle(&[b"one", b"two"]).1);

    // Reconcile: reopening finds no proven commit, so nothing is releasable
    // and the crank is recorded aborted with its inbound kept.
    drop(a);
    let (a, recovery) = Transcript::open(files_a.transcript(), TranscriptConfig::new("a")).unwrap();
    assert!(a.releasable().unwrap().is_empty());
    assert_eq!(recovery.in_doubt.len(), 1);
    assert_eq!(recovery.in_doubt[0].crank, crank);
    assert_eq!(a.crank_state(crank).unwrap().as_deref(), Some("aborted"));
}

#[test]
fn an_ambiguous_commit_releases_nothing_until_reconciled() {
    let root = tempfile::tempdir().unwrap();
    let (start, ops) = commit_ops(&root.path().join("probe"));
    let commit_sync = ops.iter().position(|op| op == "sqlite:sync:wal").unwrap() as u64;
    let plan = FaultPlan::fail_at(start + commit_sync + 1, FaultMode::FailAfterEffect);
    let (files, mut t) = worker_with_plan(root.path(), "a", plan.clone());
    let crank = t.begin_crank(b"in").unwrap();
    t.stage_outbound(b"out".to_vec()).unwrap();
    let Err(TranscriptError::Fault(fault)) = t.commit_crank() else {
        panic!("expected a transcript fault");
    };
    assert!(plan.fired());
    assert!(
        !fault.commit_outcome_known,
        "a failed COMMIT sync is an unknown outcome"
    );
    drop(t);

    // Whichever way the reopen resolves it, the transcript is consistent: a
    // committed crank's frames become releasable, an uncommitted one is
    // recorded aborted with nothing to release.
    let (t, recovery) = Transcript::open(files.transcript(), TranscriptConfig::new("a")).unwrap();
    match t.crank_state(crank).unwrap().as_deref() {
        Some("committed") => {
            assert_eq!(t.releasable().unwrap().len(), 1);
            assert!(recovery.in_doubt.is_empty());
        }
        Some("aborted") => {
            assert!(t.releasable().unwrap().is_empty());
            assert_eq!(recovery.in_doubt.len(), 1);
        }
        other => panic!("crank {crank} recovered as {other:?}"),
    }
}

#[test]
fn a_crash_after_release_before_acknowledgement_is_observed_once() {
    let root = tempfile::tempdir().unwrap();
    let files = WorkerFiles::new(root.path(), "w");
    let mut wire = Wire::default();
    let mut sup = Supervisor::start(&files, None, &mut wire).unwrap();
    sup.crank(b"one", &mut wire).unwrap();
    // The acknowledgement for "one" is still in memory: crash now.
    drop(sup);
    let sup = Supervisor::start(&files, None, &mut wire).unwrap();
    assert_eq!(sup.recovery.unreleased, 2);
    assert_eq!(wire.duplicates, 2, "the re-release is dropped by sequence");
    assert_eq!(wire.accepted, oracle(&[b"one"]).1);
    assert_eq!(sup.replayed, 1);
}

#[test]
fn compaction_keeps_aborted_cranks_and_never_reuses_ids() {
    let root = tempfile::tempdir().unwrap();
    let (_files, mut sup, mut wire) = fresh(root.path(), "w");
    sup.crank(b"one", &mut wire).unwrap();
    sup.transcript.flush_acks().unwrap();
    let t = &mut sup.transcript;
    t.begin_crank(b"doomed").unwrap();
    t.abort_crank().unwrap();
    sup.crank(b"two", &mut wire).unwrap();
    let last_seq = wire.accepted_keys.last().unwrap().clone();
    let s = sup.publish().unwrap();
    assert_eq!(s.watermark_crank, 3);
    let t = &mut sup.transcript;
    let superseded = t.compact().unwrap();
    assert_eq!(superseded.len(), 1, "the initial snapshot is superseded");
    assert!(t.releasable().unwrap().is_empty());
    assert!(
        t.outbound_audit().unwrap().is_empty(),
        "acknowledged covered frames are compacted"
    );
    assert_eq!(t.aborted_cranks().unwrap().len(), 1);
    let next = t.begin_crank(b"three").unwrap();
    assert_eq!(next, 4, "crank ids are never reused after compaction");
    t.stage_outbound(b"x".to_vec()).unwrap();
    let frames = t.commit_crank().unwrap();
    let last: u64 = last_seq.rsplit(':').next().unwrap().parse().unwrap();
    assert!(
        frames[0].seq > last,
        "sequences are never reused after compaction"
    );
}

#[test]
fn compaction_retains_unreleased_frames() {
    let root = tempfile::tempdir().unwrap();
    let (_files, mut sup, _wire) = fresh(root.path(), "w");
    let t = &mut sup.transcript;
    t.begin_crank(b"in").unwrap();
    t.stage_outbound(b"held".to_vec()).unwrap();
    t.commit_crank().unwrap();
    // Never handed to the transport, so never acknowledged.
    let cas = sup.cas.clone();
    sup.transcript
        .publish_snapshot(&cas, &snapshot_bytes(7), meta())
        .unwrap();
    sup.transcript.compact().unwrap();
    let held = sup.transcript.releasable().unwrap();
    assert_eq!(held.len(), 1);
    assert_eq!(held[0].payload, b"held");
    assert!(sup.transcript.replay_plan(&cas).unwrap().cranks.is_empty());
}

#[test]
fn a_corrupt_or_missing_published_snapshot_is_a_fault_not_a_fallback() {
    let root = tempfile::tempdir().unwrap();
    let (files, mut sup, mut wire) = fresh(root.path(), "w");
    sup.crank(b"one", &mut wire).unwrap();
    let s = sup.publish().unwrap();
    drop(sup);
    let blob = files.cas_dir().join(&s.hash);
    std::fs::write(&blob, b"vat-state:999").unwrap();
    let err = Supervisor::start(&files, None, &mut wire)
        .err()
        .expect("corrupt blob must stop recovery");
    assert!(
        matches!(&err, TranscriptError::Fault(f) if f.detail.contains("corrupt")),
        "{err}"
    );
    std::fs::remove_file(&blob).unwrap();
    assert!(matches!(
        Supervisor::start(&files, None, &mut wire),
        Err(TranscriptError::Fault(_))
    ));
}

#[test]
fn resume_under_a_different_pinned_configuration_is_rejected() {
    let root = tempfile::tempdir().unwrap();
    let (_files, sup, _wire) = fresh(root.path(), "w");
    sup.transcript.check_resume(&meta()).unwrap();
    let flipped = SnapshotMeta {
        panic_on_reference_error: true,
        ..meta()
    };
    assert!(matches!(
        sup.transcript.check_resume(&flipped),
        Err(TranscriptError::Protocol(_))
    ));
    let other_engine = SnapshotMeta {
        engine_signature: b"other".to_vec(),
        ..meta()
    };
    assert!(matches!(
        sup.transcript.check_resume(&other_engine),
        Err(TranscriptError::Protocol(_))
    ));
}

#[test]
fn a_transcript_belongs_to_one_worker() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("t.sqlite");
    drop(Transcript::open(&path, TranscriptConfig::new("a")).unwrap());
    assert!(matches!(
        Transcript::open(&path, TranscriptConfig::new("b")),
        Err(TranscriptError::Protocol(_))
    ));
}

#[test]
fn a_blob_write_fault_poisons_before_anything_is_published() {
    let root = tempfile::tempdir().unwrap();
    let files = WorkerFiles::new(root.path(), "w");
    let mut wire = Wire::default();
    drop(Supervisor::start(&files, None, &mut wire).unwrap());
    let plan = FaultPlan::counting();
    let (mut t, _) = Transcript::open(files.transcript(), TranscriptConfig::new("w")).unwrap();
    let cas = CasStore::open(files.cas_dir())
        .unwrap()
        .with_fault_plan(plan.clone());
    let before = t.latest_snapshot().unwrap();
    // Aim at the directory sync, the step xsnap's suspend_to_cas omitted.
    let plan2 = FaultPlan::fail_at(4, FaultMode::FailOnce);
    let cas2 = CasStore::open(files.cas_dir())
        .unwrap()
        .with_fault_plan(plan2.clone());
    let Err(TranscriptError::Fault(fault)) = t.publish_snapshot(&cas2, &snapshot_bytes(1), meta())
    else {
        panic!("expected a fault");
    };
    assert_eq!(plan2.log()[3], "cas:sync-dir");
    assert_eq!(fault.operation, Operation::WriteSnapshotBlob);
    assert_eq!(
        t.latest_snapshot().unwrap(),
        before,
        "nothing was published"
    );
    assert!(matches!(
        t.publish_snapshot(&cas, &snapshot_bytes(1), meta()),
        Err(TranscriptError::Poisoned(_))
    ));
}
