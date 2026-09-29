//! Host functions are messages too: host-call events, logical handles,
//! post-commit effects, and the failure branches of § Verification's
//! host-handle / effect contract (designs/ironhorse-panic.md).

use std::cell::Cell;
use std::path::Path;

use slot_machine_transcript::{
    AdmissionError, AdmittedCallbacks, CallbackRegistry, CasStore, HostCallError, HostClass,
    HostOutcome, HostReply, RecoveryStop, ReplayStop, SnapshotMeta, Transcript, TranscriptConfig,
};

fn meta() -> SnapshotMeta {
    SnapshotMeta {
        engine_signature: b"host-test-v1".to_vec(),
        panic_on_reference_error: false,
    }
}

fn callbacks() -> AdmittedCallbacks {
    CallbackRegistry::new()
        .classify("now", HostClass::Read)
        .classify("open-file", HostClass::Read)
        .classify("read-file", HostClass::Read)
        .classify("close", HostClass::Read)
        .classify("connect", HostClass::Read)
        .classify("send-socket", HostClass::Read)
        .classify("put-row", HostClass::Transactional)
        .classify("post-webhook", HostClass::Outbound { idempotent: true })
        .classify("launch-missile", HostClass::Barrier)
        .admit(true)
        .expect("admissible table")
}

/// Open a transcript with an initial snapshot published.
fn open(root: &Path) -> (Transcript, CasStore) {
    let cas = CasStore::open(root.join("cas")).unwrap();
    let (mut t, _) = Transcript::open(root.join("t.sqlite"), TranscriptConfig::new("w")).unwrap();
    if t.latest_snapshot().unwrap().is_none() {
        t.publish_snapshot(&cas, b"heap-0", meta()).unwrap();
    }
    (t, cas)
}

fn reopen(root: &Path) -> Transcript {
    Transcript::open(root.join("t.sqlite"), TranscriptConfig::new("w"))
        .unwrap()
        .0
}

fn reply(bytes: &[u8]) -> HostOutcome {
    HostOutcome {
        reply: bytes.to_vec(),
        ..HostOutcome::default()
    }
}

fn opens(bytes: &[u8], descriptor: Option<&[u8]>) -> HostOutcome {
    HostOutcome {
        reply: bytes.to_vec(),
        opens: Some(descriptor.map(<[u8]>::to_vec)),
        closes: false,
    }
}

fn opened(r: HostReply) -> u64 {
    match r {
        HostReply::Reply {
            opened: Some(h), ..
        } => h,
        other => panic!("expected an opened handle, got {other:?}"),
    }
}

// (a) A non-idempotent provider without an idempotency protocol.

#[test]
fn retryable_worker_rejects_non_idempotent_outbound_provider_at_startup() {
    let err = CallbackRegistry::new()
        .classify("now", HostClass::Read)
        .classify("send-email", HostClass::Outbound { idempotent: false })
        .admit(true)
        .unwrap_err();
    assert_eq!(
        err,
        AdmissionError::NonIdempotentOutbound(vec!["send-email".into()])
    );
    // Gaining an idempotency protocol, or declaring a barrier, admits it.
    for class in [HostClass::Outbound { idempotent: true }, HostClass::Barrier] {
        CallbackRegistry::new()
            .classify("send-email", class)
            .admit(true)
            .expect("admitted");
    }
    // A worker that is never retried may keep the provider as is.
    CallbackRegistry::new()
        .classify("send-email", HostClass::Outbound { idempotent: false })
        .admit(false)
        .expect("admitted when not retryable");
}

#[test]
fn retryable_worker_rejects_unclassified_callback_at_startup() {
    let err = CallbackRegistry::new()
        .classify("now", HostClass::Read)
        .unclassified("mystery")
        .admit(true)
        .unwrap_err();
    assert_eq!(err, AdmissionError::Unclassified(vec!["mystery".into()]));
    // Not retryable: admitted, and treated as a barrier.
    let admitted = CallbackRegistry::new()
        .unclassified("mystery")
        .admit(false)
        .unwrap();
    assert_eq!(admitted.class("mystery"), Some(HostClass::Barrier));
}

#[test]
fn declared_barrier_halts_replay_instead_of_reinvoking_the_effect() {
    let root = tempfile::tempdir().unwrap();
    let cb = callbacks();
    let invocations = Cell::new(0);
    {
        let (mut t, _) = open(root.path());
        t.begin_crank(b"d1").unwrap();
        t.host_call(&cb, "now", None, b"clock", |_| reply(b"t=1"))
            .unwrap();
        t.commit_crank().unwrap();
        t.begin_crank(b"d2").unwrap();
        t.host_call(&cb, "launch-missile", None, b"target", |_| {
            invocations.set(invocations.get() + 1);
            reply(b"launched")
        })
        .unwrap();
        t.commit_crank().unwrap();
    }
    assert_eq!(invocations.get(), 1);
    let t = reopen(root.path());
    assert_eq!(t.recovery_gate().unwrap(), Ok(()));
    let mut replay = t.host_replay().unwrap();
    replay.begin_crank(1);
    assert_eq!(
        replay.call("now", None, b"clock"),
        Ok(HostReply::Reply {
            reply: b"t=1".to_vec(),
            opened: None
        })
    );
    replay.end_crank().unwrap();
    replay.begin_crank(2);
    assert!(matches!(
        replay.call("launch-missile", None, b"target"),
        Err(ReplayStop::Barrier { crank: 2, ref callback, .. }) if callback == "launch-missile"
    ));
    // Replay answers from the record; the barrier's effect never re-ran.
    assert_eq!(invocations.get(), 1);
}

#[test]
fn barrier_in_a_crank_that_never_committed_stops_retry_until_cleared() {
    let root = tempfile::tempdir().unwrap();
    let cb = callbacks();
    {
        let (mut t, _) = open(root.path());
        t.begin_crank(b"d1").unwrap();
        t.host_call(&cb, "launch-missile", None, b"target", |_| {
            reply(b"launched")
        })
        .unwrap();
        // Crash before commit: the transcript is dropped mid-crank.
    }
    let mut t = reopen(root.path());
    let stop = t.recovery_gate().unwrap().unwrap_err();
    let RecoveryStop::EscapedBarrier {
        crank,
        seq,
        callback,
    } = stop
    else {
        panic!("expected an escaped barrier, got {stop:?}");
    };
    assert_eq!((crank, callback.as_str()), (1, "launch-missile"));
    // No recorded reply for the aborted crank reaches replay.
    let mut replay = t.host_replay().unwrap();
    replay.begin_crank(1);
    assert!(matches!(
        replay.call("launch-missile", None, b"target"),
        Err(ReplayStop::Mismatch { .. })
    ));
    t.clear_barrier(seq).unwrap();
    assert_eq!(t.recovery_gate().unwrap(), Ok(()));
}

#[test]
fn outbound_effect_runs_only_after_commit_with_a_stable_idempotency_key() {
    let root = tempfile::tempdir().unwrap();
    let cb = callbacks();
    let (mut t, _) = open(root.path());
    // Aborted crank: the effect was never invoked and is never releasable.
    t.begin_crank(b"d1").unwrap();
    let r = t
        .host_call(&cb, "post-webhook", None, b"hello", |_| {
            panic!("an outbound effect must not run during the crank")
        })
        .unwrap();
    assert_eq!(r, HostReply::Deferred);
    t.abort_crank().unwrap();
    assert!(t.releasable_effects().unwrap().is_empty());
    // Committed crank: releasable after commit, keyed by `<worker>:<seq>`.
    t.begin_crank(b"d2").unwrap();
    t.host_call(&cb, "post-webhook", None, b"world", |_| unreachable!())
        .unwrap();
    assert!(t.releasable_effects().unwrap().is_empty());
    t.commit_crank().unwrap();
    let effects = t.releasable_effects().unwrap();
    assert_eq!(effects.len(), 1);
    assert_eq!(effects[0].request, b"world");
    assert_eq!(effects[0].idempotency_key, format!("w:{}", effects[0].seq));
    // Crash after invoking the provider, before the ack is durable: the
    // effect is offered again under the same key, which the provider's
    // idempotency protocol collapses.
    t.mark_released([effects[0].seq]);
    drop(t);
    let mut t = reopen(root.path());
    let again = t.releasable_effects().unwrap();
    assert_eq!(again, effects);
    t.mark_released([again[0].seq]);
    t.flush_acks().unwrap();
    assert!(t.releasable_effects().unwrap().is_empty());
}

// (b) A handle with no reconstruction descriptor.

#[test]
fn handle_without_descriptor_is_reseated_broken_and_never_silently_succeeds() {
    let root = tempfile::tempdir().unwrap();
    let cb = callbacks();
    let sock;
    {
        let (mut t, _) = open(root.path());
        t.begin_crank(b"d1").unwrap();
        sock = opened(
            t.host_call(&cb, "connect", None, b"peer:80", |_| opens(b"ok", None))
                .unwrap(),
        );
        t.host_call(&cb, "send-socket", Some(sock), b"ping", |_| reply(b"sent"))
            .unwrap();
        t.commit_crank().unwrap();
    }
    let mut t = reopen(root.path());
    let report = t
        .reseat_handles(|_| panic!("no descriptor, nothing to rebuild"))
        .unwrap();
    assert!(report.reseated.is_empty());
    assert_eq!(report.broken.len(), 1);
    assert_eq!(report.broken[0].0, sock);
    assert_eq!(
        t.recovery_gate().unwrap(),
        Err(RecoveryStop::BrokenHandles(vec![sock]))
    );
    // Replay of a use of the broken handle stops rather than answering.
    let mut replay = t.host_replay().unwrap();
    replay.begin_crank(1);
    replay.call("connect", None, b"peer:80").unwrap();
    assert_eq!(
        replay.call("send-socket", Some(sock), b"ping"),
        Err(ReplayStop::BrokenHandle(sock))
    );
    // A live use is refused without invoking the adapter.
    t.begin_crank(b"d2").unwrap();
    let err = t
        .host_call(&cb, "send-socket", Some(sock), b"ping", |_| {
            panic!("a broken handle must not reach a fabricated resource")
        })
        .unwrap_err();
    assert_eq!(err, HostCallError::BrokenHandle(sock));
    t.abort_crank().unwrap();
    // Still stopped across a restart.
    drop(t);
    let t = reopen(root.path());
    assert!(t.recovery_gate().unwrap().is_err());
}

#[test]
fn broken_handle_resumes_once_the_adapter_supplies_a_replacement_under_the_same_id() {
    let root = tempfile::tempdir().unwrap();
    let cb = callbacks();
    let (mut t, _) = open(root.path());
    t.begin_crank(b"d1").unwrap();
    let sock = opened(
        t.host_call(&cb, "connect", None, b"peer:80", |_| opens(b"ok", None))
            .unwrap(),
    );
    t.commit_crank().unwrap();
    t.reseat_handles(|_| Ok(())).unwrap();
    assert!(t.recovery_gate().unwrap().is_err());
    // A replacement that fails to rebuild is refused and changes nothing.
    assert!(t
        .supply_replacement(sock, b"peer:80#2".to_vec(), |_| Err("refused".into()))
        .is_err());
    assert!(t.recovery_gate().unwrap().is_err());
    let rebuilt = Cell::new(None);
    t.supply_replacement(sock, b"peer:80#2".to_vec(), |r| {
        rebuilt.set(Some((r.handle, r.descriptor.clone())));
        Ok(())
    })
    .unwrap();
    assert_eq!(rebuilt.take(), Some((sock, Some(b"peer:80#2".to_vec()))));
    assert_eq!(t.recovery_gate().unwrap(), Ok(()));
    t.begin_crank(b"d2").unwrap();
    let r = t
        .host_call(&cb, "send-socket", Some(sock), b"ping", |_| reply(b"sent"))
        .unwrap();
    assert_eq!(
        r,
        HostReply::Reply {
            reply: b"sent".to_vec(),
            opened: None
        }
    );
    t.commit_crank().unwrap();
    // The replacement's descriptor is durable: the next restart rebuilds it.
    drop(t);
    let mut t = reopen(root.path());
    let report = t.reseat_handles(|_| Ok(())).unwrap();
    assert_eq!(report.reseated, vec![sock]);
}

#[test]
fn broken_handle_resumes_once_the_application_handles_a_delivery_reporting_the_loss() {
    let root = tempfile::tempdir().unwrap();
    let cb = callbacks();
    let (mut t, _) = open(root.path());
    t.begin_crank(b"d1").unwrap();
    let sock = opened(
        t.host_call(&cb, "connect", None, b"peer:80", |_| opens(b"ok", None))
            .unwrap(),
    );
    t.commit_crank().unwrap();
    t.reseat_handles(|_| Ok(())).unwrap();
    // A loss acknowledged by a crank that then aborts is not recorded.
    t.begin_crank(b"lost:1").unwrap();
    t.acknowledge_loss(sock).unwrap();
    t.abort_crank().unwrap();
    assert!(t.recovery_gate().unwrap().is_err());
    t.begin_crank(b"lost:1").unwrap();
    t.acknowledge_loss(sock).unwrap();
    t.commit_crank().unwrap();
    assert_eq!(t.recovery_gate().unwrap(), Ok(()));
    // The handle is closed: a later use is refused, not fabricated.
    t.begin_crank(b"d3").unwrap();
    assert_eq!(
        t.host_call(&cb, "send-socket", Some(sock), b"ping", |_| unreachable!())
            .unwrap_err(),
        HostCallError::UnknownHandle(sock)
    );
    t.abort_crank().unwrap();
}

// Re-seating with descriptors, and replay == live for the recorded stream.

#[test]
fn handles_with_descriptors_reseat_and_replay_the_recorded_reply_stream() {
    let root = tempfile::tempdir().unwrap();
    let cb = callbacks();
    let live;
    let file;
    {
        let (mut t, _) = open(root.path());
        t.begin_crank(b"d1").unwrap();
        file = opened(
            t.host_call(&cb, "open-file", None, b"/a.txt", |_| {
                opens(b"fd", Some(b"cap:/a.txt@0"))
            })
            .unwrap(),
        );
        let r1 = t
            .host_call(&cb, "read-file", Some(file), b"4", |_| reply(b"abcd"))
            .unwrap();
        t.host_call(&cb, "put-row", None, b"k=v", |_| reply(b"ok"))
            .unwrap();
        t.commit_crank().unwrap();
        t.begin_crank(b"d2").unwrap();
        let r2 = t
            .host_call(&cb, "read-file", Some(file), b"4", |_| reply(b"efgh"))
            .unwrap();
        live = vec![r1, r2];
        t.commit_crank().unwrap();
    }
    let mut t = reopen(root.path());
    let open = t.open_handles().unwrap();
    assert_eq!(open.len(), 1);
    assert_eq!(open[0].descriptor.as_deref(), Some(&b"cap:/a.txt@0"[..]));
    let report = t
        .reseat_handles(|r| {
            assert_eq!(r.handle, file);
            Ok(())
        })
        .unwrap();
    assert_eq!(report.reseated, vec![file]);
    assert_eq!(t.recovery_gate().unwrap(), Ok(()));
    let mut replay = t.host_replay().unwrap();
    replay.begin_crank(1);
    assert_eq!(
        opened(replay.call("open-file", None, b"/a.txt").unwrap()),
        file
    );
    let r1 = replay.call("read-file", Some(file), b"4").unwrap();
    replay.call("put-row", None, b"k=v").unwrap();
    replay.end_crank().unwrap();
    replay.begin_crank(2);
    let r2 = replay.call("read-file", Some(file), b"4").unwrap();
    replay.end_crank().unwrap();
    assert_eq!(vec![r1, r2], live);
}

#[test]
fn replay_divergence_is_a_deterministic_fault() {
    let root = tempfile::tempdir().unwrap();
    let cb = callbacks();
    {
        let (mut t, _) = open(root.path());
        t.begin_crank(b"d1").unwrap();
        t.host_call(&cb, "now", None, b"clock", |_| reply(b"t=1"))
            .unwrap();
        t.commit_crank().unwrap();
    }
    let t = reopen(root.path());
    let mut replay = t.host_replay().unwrap();
    replay.begin_crank(1);
    assert!(matches!(
        replay.call("now", None, b"other"),
        Err(ReplayStop::Mismatch { crank: 1, .. })
    ));
    let mut replay = t.host_replay().unwrap();
    replay.begin_crank(1);
    assert!(matches!(
        replay.end_crank(),
        Err(ReplayStop::Mismatch { crank: 1, .. })
    ));
}

#[test]
fn aborted_crank_records_no_host_events_or_handles() {
    let root = tempfile::tempdir().unwrap();
    let cb = callbacks();
    let (mut t, _) = open(root.path());
    t.begin_crank(b"d1").unwrap();
    t.host_call(&cb, "connect", None, b"peer:80", |_| opens(b"ok", None))
        .unwrap();
    t.abort_crank().unwrap();
    assert!(t.open_handles().unwrap().is_empty());
    assert_eq!(t.recovery_gate().unwrap(), Ok(()));
}

#[test]
fn compaction_keeps_open_handles_and_unreleased_effects() {
    let root = tempfile::tempdir().unwrap();
    let cb = callbacks();
    let (mut t, cas) = open(root.path());
    t.begin_crank(b"d1").unwrap();
    let file = opened(
        t.host_call(&cb, "open-file", None, b"/a.txt", |_| {
            opens(b"fd", Some(b"cap:/a.txt@0"))
        })
        .unwrap(),
    );
    t.host_call(&cb, "post-webhook", None, b"hello", |_| unreachable!())
        .unwrap();
    t.commit_crank().unwrap();
    t.publish_snapshot(&cas, b"heap-1", meta()).unwrap();
    t.compact().unwrap();
    assert_eq!(t.open_handles().unwrap()[0].handle, file);
    assert_eq!(t.releasable_effects().unwrap().len(), 1);
    // The covered crank's calls are not replayed from the new snapshot.
    let mut replay = t.host_replay().unwrap();
    replay.begin_crank(1);
    replay.end_crank().unwrap();
}
