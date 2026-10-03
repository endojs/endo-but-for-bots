//! Host functions are messages too: host-call events, logical handles,
//! post-commit effects, and the failure branches of § Verification's
//! host-handle / effect contract (designs/ironhorse-panic.md).

use std::cell::Cell;
use std::path::Path;
use std::rc::Rc;

use slot_machine_transcript::{
    AdmissionError, AdmittedCallbacks, CallbackRegistry, ContentAddressedStore, HostCallError,
    HostClass, HostOutcome, HostReply, RecoveryStop, ReplayStop, SnapshotMeta, TransactionalWrite,
    Transcript, TranscriptConfig, TranscriptError,
};

fn meta() -> SnapshotMeta {
    SnapshotMeta {
        engine_signature: b"host-test-v1".to_vec(),
        panic_on_reference_error: false,
    }
}

fn callbacks() -> AdmittedCallbacks {
    CallbackRegistry::new()
        .classify("hash", HostClass::Pure)
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
fn open(root: &Path) -> (Transcript, ContentAddressedStore) {
    let blob_store = ContentAddressedStore::open(root.join("blob_store")).unwrap();
    let (mut t, _) = Transcript::open(root.join("t.sqlite"), TranscriptConfig::new("w")).unwrap();
    if t.latest_snapshot().unwrap().is_none() {
        t.publish_snapshot(&blob_store, b"heap-0", meta()).unwrap();
    }
    (t, blob_store)
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

fn closes(bytes: &[u8]) -> HostOutcome {
    HostOutcome {
        reply: bytes.to_vec(),
        opens: None,
        closes: true,
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
    let callbacks = callbacks();
    let invocations = Cell::new(0);
    {
        let (mut t, _) = open(root.path());
        t.begin_crank(b"d1").unwrap();
        t.host_call(&callbacks, "now", None, b"clock", |_| reply(b"t=1"))
            .unwrap();
        t.commit_crank().unwrap();
        t.begin_crank(b"d2").unwrap();
        t.host_call(&callbacks, "launch-missile", None, b"target", |_| {
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
    let callbacks = callbacks();
    {
        let (mut t, _) = open(root.path());
        t.begin_crank(b"d1").unwrap();
        t.host_call(&callbacks, "launch-missile", None, b"target", |_| {
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
fn replay_follows_the_guest_call_order_around_a_barrier() {
    let root = tempfile::tempdir().unwrap();
    let callbacks = callbacks();
    {
        let (mut t, _) = open(root.path());
        t.begin_crank(b"d1").unwrap();
        // The barrier's request is durable before the read's, which is
        // written at commit, yet replay must see the read first.
        t.host_call(&callbacks, "now", None, b"clock", |_| reply(b"t=1"))
            .unwrap();
        t.host_call(&callbacks, "launch-missile", None, b"target", |_| {
            reply(b"launched")
        })
        .unwrap();
        t.host_call(&callbacks, "post-webhook", None, b"hook", |_| {
            panic!("outbound effects are not invoked during the crank")
        })
        .unwrap();
        t.host_call(&callbacks, "now", None, b"clock-2", |_| reply(b"t=2"))
            .unwrap();
        // The active crank's own barrier is not an escaped one.
        assert_eq!(t.recovery_gate().unwrap(), Ok(()));
        t.commit_crank().unwrap();
    }
    let mut t = reopen(root.path());
    let mut replay = t.host_replay().unwrap();
    replay.begin_crank(1);
    assert_eq!(
        replay.call("now", None, b"clock"),
        Ok(HostReply::Reply {
            reply: b"t=1".to_vec(),
            opened: None
        })
    );
    let Err(ReplayStop::Barrier { seq, .. }) = replay.call("launch-missile", None, b"target")
    else {
        panic!("expected the barrier second");
    };
    // Once cleared, replay answers the barrier and the calls after it in
    // the order the guest made them.
    t.clear_barrier(seq).unwrap();
    let mut replay = t.host_replay().unwrap();
    replay.begin_crank(1);
    replay.call("now", None, b"clock").unwrap();
    assert_eq!(
        replay.call("launch-missile", None, b"target"),
        Ok(HostReply::Reply {
            reply: b"launched".to_vec(),
            opened: None
        })
    );
    assert_eq!(
        replay.call("post-webhook", None, b"hook"),
        Ok(HostReply::Deferred)
    );
    assert_eq!(
        replay.call("now", None, b"clock-2"),
        Ok(HostReply::Reply {
            reply: b"t=2".to_vec(),
            opened: None
        })
    );
    replay.end_crank().unwrap();
}

#[test]
fn outbound_effect_runs_only_after_commit_with_a_stable_idempotency_key() {
    let root = tempfile::tempdir().unwrap();
    let callbacks = callbacks();
    let (mut t, _) = open(root.path());
    // Aborted crank: the effect was never invoked and is never releasable.
    t.begin_crank(b"d1").unwrap();
    let r = t
        .host_call(&callbacks, "post-webhook", None, b"hello", |_| {
            panic!("an outbound effect must not run during the crank")
        })
        .unwrap();
    assert_eq!(r, HostReply::Deferred);
    t.abort_crank().unwrap();
    assert!(t.releasable_effects().unwrap().is_empty());
    // Committed crank: releasable after commit, keyed by `<worker>:<seq>`.
    t.begin_crank(b"d2").unwrap();
    t.host_call(
        &callbacks,
        "post-webhook",
        None,
        b"world",
        |_| unreachable!(),
    )
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
    t.flush_acknowledgments().unwrap();
    assert!(t.releasable_effects().unwrap().is_empty());
}

// (b) A handle with no reconstruction descriptor.

#[test]
fn handle_without_descriptor_is_reseated_broken_and_never_silently_succeeds() {
    let root = tempfile::tempdir().unwrap();
    let callbacks = callbacks();
    let socket;
    {
        let (mut t, _) = open(root.path());
        t.begin_crank(b"d1").unwrap();
        socket = opened(
            t.host_call(&callbacks, "connect", None, b"peer:80", |_| {
                opens(b"ok", None)
            })
            .unwrap(),
        );
        t.host_call(&callbacks, "send-socket", Some(socket), b"ping", |_| {
            reply(b"sent")
        })
        .unwrap();
        t.commit_crank().unwrap();
    }
    let mut t = reopen(root.path());
    let report = t
        .reseat_handles(|_| panic!("no descriptor, nothing to rebuild"))
        .unwrap();
    assert!(report.reseated.is_empty());
    assert_eq!(report.broken.len(), 1);
    assert_eq!(report.broken[0].0, socket);
    assert_eq!(
        t.recovery_gate().unwrap(),
        Err(RecoveryStop::BrokenHandles(vec![socket]))
    );
    // Replay of a use of the broken handle stops rather than answering.
    let mut replay = t.host_replay().unwrap();
    replay.begin_crank(1);
    replay.call("connect", None, b"peer:80").unwrap();
    assert_eq!(
        replay.call("send-socket", Some(socket), b"ping"),
        Err(ReplayStop::BrokenHandle(socket))
    );
    // A live use is refused without invoking the adapter.
    t.begin_crank(b"d2").unwrap();
    let err = t
        .host_call(&callbacks, "send-socket", Some(socket), b"ping", |_| {
            panic!("a broken handle must not reach a fabricated resource")
        })
        .unwrap_err();
    assert_eq!(err, HostCallError::BrokenHandle(socket));
    t.abort_crank().unwrap();
    // Still stopped across a restart.
    drop(t);
    let t = reopen(root.path());
    assert!(t.recovery_gate().unwrap().is_err());
}

#[test]
fn broken_handle_resumes_once_the_adapter_supplies_a_replacement_under_the_same_id() {
    let root = tempfile::tempdir().unwrap();
    let callbacks = callbacks();
    let (mut t, _) = open(root.path());
    t.begin_crank(b"d1").unwrap();
    let socket = opened(
        t.host_call(&callbacks, "connect", None, b"peer:80", |_| {
            opens(b"ok", None)
        })
        .unwrap(),
    );
    t.commit_crank().unwrap();
    t.reseat_handles(|_| Ok(())).unwrap();
    assert!(t.recovery_gate().unwrap().is_err());
    // A replacement that fails to rebuild is refused and changes nothing.
    assert!(t
        .supply_replacement(socket, b"peer:80#2".to_vec(), |_| Err("refused".into()))
        .is_err());
    assert!(t.recovery_gate().unwrap().is_err());
    let rebuilt = Cell::new(None);
    t.supply_replacement(socket, b"peer:80#2".to_vec(), |r| {
        rebuilt.set(Some((r.handle, r.descriptor.clone())));
        Ok(())
    })
    .unwrap();
    assert_eq!(rebuilt.take(), Some((socket, Some(b"peer:80#2".to_vec()))));
    assert_eq!(t.recovery_gate().unwrap(), Ok(()));
    t.begin_crank(b"d2").unwrap();
    let r = t
        .host_call(&callbacks, "send-socket", Some(socket), b"ping", |_| {
            reply(b"sent")
        })
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
    assert_eq!(report.reseated, vec![socket]);
}

#[test]
fn broken_handle_resumes_once_the_application_handles_a_delivery_reporting_the_loss() {
    let root = tempfile::tempdir().unwrap();
    let callbacks = callbacks();
    let (mut t, _) = open(root.path());
    t.begin_crank(b"d1").unwrap();
    let socket = opened(
        t.host_call(&callbacks, "connect", None, b"peer:80", |_| {
            opens(b"ok", None)
        })
        .unwrap(),
    );
    t.commit_crank().unwrap();
    t.reseat_handles(|_| Ok(())).unwrap();
    // A loss acknowledged by a crank that then aborts is not recorded.
    t.begin_crank(b"lost:1").unwrap();
    t.acknowledge_loss(socket).unwrap();
    t.abort_crank().unwrap();
    assert!(t.recovery_gate().unwrap().is_err());
    t.begin_crank(b"lost:1").unwrap();
    t.acknowledge_loss(socket).unwrap();
    t.commit_crank().unwrap();
    assert_eq!(t.recovery_gate().unwrap(), Ok(()));
    // The handle is closed: a later use is refused, not fabricated.
    t.begin_crank(b"d3").unwrap();
    assert_eq!(
        t.host_call(
            &callbacks,
            "send-socket",
            Some(socket),
            b"ping",
            |_| unreachable!()
        )
        .unwrap_err(),
        HostCallError::UnknownHandle(socket)
    );
    t.abort_crank().unwrap();
}

// Re-seating with descriptors, and replay == live for the recorded stream.

#[test]
fn handles_with_descriptors_reseat_and_replay_the_recorded_reply_stream() {
    let root = tempfile::tempdir().unwrap();
    let callbacks = callbacks();
    let live;
    let file;
    {
        let (mut t, _) = open(root.path());
        t.begin_crank(b"d1").unwrap();
        file = opened(
            t.host_call(&callbacks, "open-file", None, b"/a.txt", |_| {
                opens(b"fd", Some(b"cap:/a.txt@0"))
            })
            .unwrap(),
        );
        let r1 = t
            .host_call(&callbacks, "read-file", Some(file), b"4", |_| {
                reply(b"abcd")
            })
            .unwrap();
        t.host_call_transactional(&callbacks, "put-row", None, b"k=v", |r| {
            (reply(b"ok"), put_row(r))
        })
        .unwrap();
        t.commit_crank().unwrap();
        t.begin_crank(b"d2").unwrap();
        let r2 = t
            .host_call(&callbacks, "read-file", Some(file), b"4", |_| {
                reply(b"efgh")
            })
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
    let callbacks = callbacks();
    {
        let (mut t, _) = open(root.path());
        t.begin_crank(b"d1").unwrap();
        t.host_call(&callbacks, "now", None, b"clock", |_| reply(b"t=1"))
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
    let callbacks = callbacks();
    let (mut t, _) = open(root.path());
    t.begin_crank(b"d1").unwrap();
    t.host_call(&callbacks, "connect", None, b"peer:80", |_| {
        opens(b"ok", None)
    })
    .unwrap();
    t.abort_crank().unwrap();
    assert!(t.open_handles().unwrap().is_empty());
    assert_eq!(t.recovery_gate().unwrap(), Ok(()));
}

#[test]
fn compaction_keeps_open_handles_and_unreleased_effects() {
    let root = tempfile::tempdir().unwrap();
    let callbacks = callbacks();
    let (mut t, blob_store) = open(root.path());
    t.begin_crank(b"d1").unwrap();
    let file = opened(
        t.host_call(&callbacks, "open-file", None, b"/a.txt", |_| {
            opens(b"fd", Some(b"cap:/a.txt@0"))
        })
        .unwrap(),
    );
    t.host_call(
        &callbacks,
        "post-webhook",
        None,
        b"hello",
        |_| unreachable!(),
    )
    .unwrap();
    t.commit_crank().unwrap();
    t.publish_snapshot(&blob_store, b"heap-1", meta()).unwrap();
    t.compact().unwrap();
    assert_eq!(t.open_handles().unwrap()[0].handle, file);
    assert_eq!(t.releasable_effects().unwrap().len(), 1);
    // The covered crank's calls are not replayed from the new snapshot.
    let mut replay = t.host_replay().unwrap();
    replay.begin_crank(1);
    replay.end_crank().unwrap();
}

#[test]
fn admission_errors_name_the_refused_callbacks() {
    assert_eq!(
        AdmissionError::Unclassified(vec!["a".into(), "b".into()]).to_string(),
        "retryable worker refuses unclassified host callbacks: a, b"
    );
    assert!(
        AdmissionError::NonIdempotentOutbound(vec!["send-email".into()])
            .to_string()
            .ends_with("declare a barrier): send-email")
    );
}

#[test]
fn host_call_refuses_an_unknown_callback_and_a_call_outside_a_crank() {
    let root = tempfile::tempdir().unwrap();
    let callbacks = callbacks();
    let (mut t, _) = open(root.path());
    assert!(matches!(
        t.host_call(&callbacks, "now", None, b"clock", |_| unreachable!()),
        Err(HostCallError::Transcript(_))
    ));
    t.begin_crank(b"d1").unwrap();
    assert_eq!(
        t.host_call(&callbacks, "mystery", None, b"", |_| unreachable!())
            .unwrap_err(),
        HostCallError::UnknownCallback("mystery".into())
    );
    assert_eq!(
        t.host_call(&callbacks, "read-file", Some(99), b"4", |_| unreachable!())
            .unwrap_err(),
        HostCallError::UnknownHandle(99)
    );
    t.abort_crank().unwrap();
}

/// A transactional effect: append the request to a local table.
fn put_row(request: &[u8]) -> TransactionalWrite {
    let request = request.to_vec();
    Box::new(move |transaction| {
        transaction.execute(
            "CREATE TABLE IF NOT EXISTS applied (request BLOB NOT NULL) STRICT",
            [],
        )?;
        transaction.execute("INSERT INTO applied (request) VALUES (?1)", [&request])?;
        Ok(())
    })
}

/// How many times `put_row` has been applied durably.
fn applied(root: &Path) -> i64 {
    let connection = rusqlite::Connection::open(root.join("t.sqlite")).unwrap();
    let exists: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE name = 'applied'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    if exists == 0 {
        return 0;
    }
    connection
        .query_row("SELECT COUNT(*) FROM applied", [], |r| r.get(0))
        .unwrap()
}

#[test]
fn transactional_effects_commit_with_the_crank_and_apply_once_across_a_retry() {
    let root = tempfile::tempdir().unwrap();
    let callbacks = callbacks();
    let (mut t, _) = open(root.path());
    t.begin_crank(b"d1").unwrap();
    let invoked = Cell::new(0);
    t.host_call_transactional(&callbacks, "put-row", None, b"k=v", |r| {
        invoked.set(invoked.get() + 1);
        (reply(b"ok"), put_row(r))
    })
    .unwrap();
    // The crank panics: its staged effect never runs. The transcript holds
    // its database exclusively, so inspect it closed.
    t.abort_crank().unwrap();
    drop(t);
    assert_eq!(applied(root.path()), 0);
    // The supervisor retries the same delivery; the effect applies once.
    let mut t = reopen(root.path());
    t.begin_crank(b"d1").unwrap();
    t.host_call_transactional(&callbacks, "put-row", None, b"k=v", |r| {
        invoked.set(invoked.get() + 1);
        (reply(b"ok"), put_row(r))
    })
    .unwrap();
    t.commit_crank().unwrap();
    drop(t);
    assert_eq!(invoked.get(), 2);
    assert_eq!(applied(root.path()), 1);
}

#[test]
fn transactional_callbacks_have_their_own_entry_point() {
    let root = tempfile::tempdir().unwrap();
    let callbacks = callbacks();
    let (mut t, _) = open(root.path());
    t.begin_crank(b"d1").unwrap();
    assert_eq!(
        t.host_call(&callbacks, "put-row", None, b"k=v", |_| unreachable!())
            .unwrap_err(),
        HostCallError::WrongEntryPoint("put-row".into())
    );
    assert_eq!(
        t.host_call_transactional(&callbacks, "now", None, b"clock", |_| unreachable!())
            .unwrap_err(),
        HostCallError::WrongEntryPoint("now".into())
    );
    t.abort_crank().unwrap();
}

#[test]
fn pure_calls_run_live_and_are_not_recorded() {
    let root = tempfile::tempdir().unwrap();
    let callbacks = callbacks();
    {
        let (mut t, _) = open(root.path());
        t.begin_crank(b"d1").unwrap();
        assert_eq!(
            t.host_call(&callbacks, "hash", None, b"abc", |r| reply(
                &r.len().to_be_bytes()
            ))
            .unwrap(),
            HostReply::Reply {
                reply: 3usize.to_be_bytes().to_vec(),
                opened: None
            }
        );
        t.commit_crank().unwrap();
    }
    // Nothing to replay: the replayed guest re-runs the pure call itself.
    let t = reopen(root.path());
    let mut replay = t.host_replay().unwrap();
    replay.begin_crank(1);
    replay.end_crank().unwrap();
}

#[test]
fn a_committed_outbound_effect_replays_as_deferred_without_the_provider() {
    let root = tempfile::tempdir().unwrap();
    let callbacks = callbacks();
    {
        let (mut t, _) = open(root.path());
        t.begin_crank(b"d1").unwrap();
        t.host_call(
            &callbacks,
            "post-webhook",
            None,
            b"hello",
            |_| unreachable!(),
        )
        .unwrap();
        t.commit_crank().unwrap();
    }
    let t = reopen(root.path());
    let mut replay = t.host_replay().unwrap();
    replay.begin_crank(1);
    assert_eq!(
        replay.call("post-webhook", None, b"hello"),
        Ok(HostReply::Deferred)
    );
    replay.end_crank().unwrap();
}

#[test]
fn a_closed_handle_is_refused_in_its_own_crank_and_after_commit() {
    let root = tempfile::tempdir().unwrap();
    let callbacks = callbacks();
    let file;
    {
        let (mut t, _) = open(root.path());
        t.begin_crank(b"d1").unwrap();
        file = opened(
            t.host_call(&callbacks, "open-file", None, b"/a.txt", |_| {
                opens(b"fd", Some(b"cap:/a.txt@0"))
            })
            .unwrap(),
        );
        t.commit_crank().unwrap();
        t.begin_crank(b"d2").unwrap();
        t.host_call(&callbacks, "close", Some(file), b"", |_| closes(b"closed"))
            .unwrap();
        // The staged close already takes effect within the crank.
        assert_eq!(
            t.host_call(
                &callbacks,
                "read-file",
                Some(file),
                b"4",
                |_| unreachable!()
            )
            .unwrap_err(),
            HostCallError::UnknownHandle(file)
        );
        t.commit_crank().unwrap();
        assert!(t.open_handles().unwrap().is_empty());
    }
    let mut t = reopen(root.path());
    // Nothing is left to re-seat, and a later use is refused.
    let report = t
        .reseat_handles(|_| panic!("a closed handle is not rebuilt"))
        .unwrap();
    assert_eq!(report, Default::default());
    t.begin_crank(b"d3").unwrap();
    assert_eq!(
        t.host_call(
            &callbacks,
            "read-file",
            Some(file),
            b"4",
            |_| unreachable!()
        )
        .unwrap_err(),
        HostCallError::UnknownHandle(file)
    );
    t.abort_crank().unwrap();
    // Replay answers the close from the record.
    let mut replay = t.host_replay().unwrap();
    replay.begin_crank(2);
    assert_eq!(
        replay.call("close", Some(file), b""),
        Ok(HostReply::Reply {
            reply: b"closed".to_vec(),
            opened: None
        })
    );
    replay.end_crank().unwrap();
}

#[test]
fn recovery_operations_refuse_targets_in_the_wrong_state() {
    let root = tempfile::tempdir().unwrap();
    let callbacks = callbacks();
    let (mut t, _) = open(root.path());
    t.begin_crank(b"d1").unwrap();
    let file = opened(
        t.host_call(&callbacks, "open-file", None, b"/a.txt", |_| {
            opens(b"fd", Some(b"cap:/a.txt@0"))
        })
        .unwrap(),
    );
    let socket = opened(
        t.host_call(&callbacks, "connect", None, b"peer:80", |_| {
            opens(b"ok", None)
        })
        .unwrap(),
    );
    assert_ne!(file, socket);
    t.commit_crank().unwrap();
    t.reseat_handles(|_| Ok(())).unwrap();
    // A healthy handle has no loss to report and needs no replacement.
    t.begin_crank(b"lost:file").unwrap();
    assert!(matches!(
        t.acknowledge_loss(file),
        Err(TranscriptError::Protocol(_))
    ));
    // A loss already acknowledged in this crank is not acknowledged twice.
    t.acknowledge_loss(socket).unwrap();
    assert!(t.acknowledge_loss(socket).is_err());
    t.abort_crank().unwrap();
    assert!(t
        .supply_replacement(file, b"cap:/a.txt@0".to_vec(), |_| unreachable!())
        .is_err());
    // A loss is acknowledged only by the crank that delivers it.
    assert!(t.acknowledge_loss(socket).is_err());
    // Clearing a barrier that was never recorded is refused.
    assert!(t.clear_barrier(12345).is_err());
    // A replayed call before any crank begins is a mismatch.
    let mut replay = t.host_replay().unwrap();
    assert!(matches!(
        replay.call("now", None, b"clock"),
        Err(ReplayStop::Mismatch { crank: 0, .. })
    ));
}

#[test]
fn pure_callback_reporting_a_handle_effect_is_refused() {
    let root = tempfile::tempdir().unwrap();
    let callbacks = callbacks();
    let (mut t, _) = open(root.path());
    t.begin_crank(b"d1").unwrap();
    assert_eq!(
        t.host_call(&callbacks, "hash", None, b"x", |_| opens(b"h", None)),
        Err(HostCallError::Misclassified("hash".into()))
    );
    assert_eq!(
        t.host_call(&callbacks, "hash", None, b"x", |_| closes(b"h")),
        Err(HostCallError::Misclassified("hash".into()))
    );
    assert_eq!(
        t.host_call(&callbacks, "hash", None, b"x", |_| reply(b"h")),
        Ok(HostReply::Reply {
            reply: b"h".to_vec(),
            opened: None
        })
    );
    // The escaped resource is in the handle log as broken, so recovery
    // stops on it even though the crank never commits.
    t.abort_crank().unwrap();
    let handles = t.open_handles().unwrap();
    assert_eq!(handles.len(), 1);
    assert!(handles[0].broken);
    assert_eq!(
        t.recovery_gate().unwrap(),
        Err(RecoveryStop::BrokenHandles(vec![handles[0].handle]))
    );
}

#[test]
fn a_reply_past_the_byte_bound_is_refused_and_its_handle_recorded_broken() {
    let root = tempfile::tempdir().unwrap();
    let callbacks = callbacks();
    let mut config = TranscriptConfig::new("w");
    config.limits.max_host_bytes = 8;
    let blob_store = ContentAddressedStore::open(root.path().join("blob_store")).unwrap();
    let (mut t, _) = Transcript::open(root.path().join("t.sqlite"), config).unwrap();
    t.publish_snapshot(&blob_store, b"heap-0", meta()).unwrap();
    t.begin_crank(b"d1").unwrap();
    // The only call in the crank: its request fits, its reply does not.
    assert!(matches!(
        t.host_call(&callbacks, "now", None, b"a", |_| reply(&[0; 8])),
        Err(HostCallError::Transcript(TranscriptError::Backpressure(_)))
    ));
    assert!(matches!(
        t.host_call(&callbacks, "open-file", None, b"b", |_| {
            opens(&[0; 8], Some(b"cap:/a.txt@0"))
        }),
        Err(HostCallError::Transcript(TranscriptError::Backpressure(_)))
    ));
    // A reply that fits is still staged.
    t.host_call(&callbacks, "now", None, b"c", |_| reply(b"1234567"))
        .unwrap();
    t.commit_crank().unwrap();
    let handles = t.open_handles().unwrap();
    assert_eq!(handles.len(), 1);
    assert!(handles[0].broken);
}

/// Run `statement` as a transactional write and report whether the
/// authorizer denied it. The write swallows the error so the crank's own
/// commit bookkeeping cannot stand in for the authorizer.
fn authorizer_denies(statement: &'static str) -> bool {
    let root = tempfile::tempdir().unwrap();
    let callbacks = callbacks();
    let (mut t, _) = open(root.path());
    let denied = Rc::new(Cell::new(None));
    t.begin_crank(b"d1").unwrap();
    let observed = denied.clone();
    t.host_call_transactional(&callbacks, "put-row", None, b"k=v", move |_| {
        let observed = observed.clone();
        let write: TransactionalWrite = Box::new(move |transaction| {
            let outcome = transaction.execute_batch(statement);
            observed.set(Some(matches!(
                outcome,
                Err(rusqlite::Error::SqliteFailure(e, _))
                    if e.code == rusqlite::ErrorCode::AuthorizationForStatementDenied
            )));
            Ok(())
        });
        (reply(b"ok"), write)
    })
    .unwrap();
    t.commit_crank().unwrap();
    denied.get().expect("the write ran")
}

#[test]
fn a_transactional_write_cannot_touch_the_transcript_tables() {
    for statement in [
        "SELECT count(*) FROM event",
        "UPDATE crank SET state = 'aborted' WHERE crank_id = 0",
        "INSERT INTO meta (key, value) VALUES ('k', 'v')",
        "DELETE FROM host_handle",
        "CREATE INDEX evil ON event (payload)",
        "DROP TABLE snapshot",
        "PRAGMA user_version = 7",
        "SAVEPOINT s",
        "ATTACH DATABASE ':memory:' AS other",
        "REINDEX",
        // SQLite folds identifier case.
        "SELECT count(*) FROM EVENT",
        "UPDATE Crank SET state = 'aborted' WHERE crank_id = 0",
        // A temp object would shadow the transcript's unqualified names.
        "CREATE TEMP TABLE EVENT (seq INTEGER PRIMARY KEY)",
        "CREATE TEMP TABLE own_scratch (v INTEGER)",
        "CREATE TEMP VIEW event AS SELECT 1",
        "CREATE TEMP VIEW Crank AS SELECT 1 AS crank_id, 'committed' AS state",
        "CREATE TABLE own (v INTEGER); CREATE TEMP TRIGGER t AFTER INSERT ON own BEGIN SELECT 1; END",
        "CREATE VIEW host_handle_v AS SELECT 1; DROP VIEW host_handle_v; CREATE VIEW Host_Handle AS SELECT 1",
        // The transcript's AUTOINCREMENT counters.
        "UPDATE sqlite_sequence SET seq = 9223372036854775807 WHERE name = 'event'",
    ] {
        assert!(authorizer_denies(statement), "{statement} was allowed");
    }
    // The adapter's own tables stay writable.
    for statement in [
        "CREATE TABLE own (v INTEGER)",
        "CREATE TABLE own (v INTEGER PRIMARY KEY AUTOINCREMENT); INSERT INTO own DEFAULT VALUES",
        "CREATE TABLE own (v INTEGER); CREATE VIEW own_view AS SELECT v FROM own; DROP VIEW own_view; DROP TABLE own",
        "CREATE TABLE own (v INTEGER); INSERT INTO own VALUES (abs(-1)); SELECT count(*) FROM own",
    ] {
        assert!(!authorizer_denies(statement), "{statement} was denied");
    }
}

#[test]
fn a_shadowing_temp_table_cannot_capture_the_transcript_writes() {
    let root = tempfile::tempdir().unwrap();
    let callbacks = callbacks();
    let (mut t, _) = open(root.path());
    t.begin_crank(b"d1").unwrap();
    t.host_call_transactional(&callbacks, "put-row", None, b"k=v", |_| {
        let write: TransactionalWrite = Box::new(|transaction| {
            transaction.execute_batch(
                "CREATE TEMP TABLE EVENT (seq INTEGER PRIMARY KEY, crank_id, kind, payload)",
            )
        });
        (reply(b"ok"), write)
    })
    .unwrap();
    assert!(t.commit_crank().is_err());
    drop(t);
    // The refused write left nothing behind: a fresh delivery's inbound
    // event is durable in the main schema.
    let mut t = reopen(root.path());
    t.begin_crank(b"d2").unwrap();
    t.commit_crank().unwrap();
    drop(t);
    let connection = rusqlite::Connection::open(root.path().join("t.sqlite")).unwrap();
    let durable: i64 = connection
        .query_row(
            "SELECT count(*) FROM main.event WHERE payload = ?1",
            [b"d2".as_slice()],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(durable, 1);
}

#[test]
fn an_escaped_close_of_a_handle_opened_in_the_same_crank_breaks_it() {
    let root = tempfile::tempdir().unwrap();
    let callbacks = callbacks();
    let (mut t, _) = open(root.path());
    t.begin_crank(b"d1").unwrap();
    let file = opened(
        t.host_call(&callbacks, "open-file", None, b"/a.txt", |_| {
            opens(b"fd", Some(b"cap:/a.txt@0"))
        })
        .unwrap(),
    );
    // A misclassified pure call closes the handle the crank just opened.
    assert_eq!(
        t.host_call(&callbacks, "hash", Some(file), b"x", |_| closes(b"h")),
        Err(HostCallError::Misclassified("hash".into()))
    );
    assert_eq!(
        t.host_call(&callbacks, "read-file", Some(file), b"n", |_| reply(b"")),
        Err(HostCallError::BrokenHandle(file))
    );
    t.commit_crank().unwrap();
    let handles = t.open_handles().unwrap();
    assert_eq!(handles.len(), 1);
    assert_eq!(handles[0].handle, file);
    assert!(handles[0].broken);
    assert_eq!(
        t.recovery_gate().unwrap(),
        Err(RecoveryStop::BrokenHandles(vec![file]))
    );
}

#[test]
fn a_denied_transactional_write_fails_the_commit() {
    let root = tempfile::tempdir().unwrap();
    let callbacks = callbacks();
    let (mut t, _) = open(root.path());
    t.begin_crank(b"d1").unwrap();
    t.host_call_transactional(&callbacks, "put-row", None, b"k=v", |_| {
        let write: TransactionalWrite =
            Box::new(|transaction| transaction.execute_batch("SELECT count(*) FROM event"));
        (reply(b"ok"), write)
    })
    .unwrap();
    assert!(t.commit_crank().is_err());
}

#[test]
fn a_transactional_reply_past_the_byte_bound_records_no_escape() {
    let root = tempfile::tempdir().unwrap();
    let callbacks = callbacks();
    let mut config = TranscriptConfig::new("w");
    config.limits.max_host_bytes = 8;
    let blob_store = ContentAddressedStore::open(root.path().join("cas")).unwrap();
    let (mut t, _) = Transcript::open(root.path().join("t.sqlite"), config).unwrap();
    t.publish_snapshot(&blob_store, b"heap-0", meta()).unwrap();
    t.begin_crank(b"d1").unwrap();
    // The write never runs, so the handle it would open never exists.
    assert!(matches!(
        t.host_call_transactional(&callbacks, "put-row", None, b"k=v", |r| {
            (opens(&[0; 8], Some(b"cap:/row")), put_row(r))
        }),
        Err(HostCallError::Transcript(TranscriptError::Backpressure(_)))
    ));
    t.commit_crank().unwrap();
    assert!(t.open_handles().unwrap().is_empty());
    assert_eq!(t.recovery_gate().unwrap(), Ok(()));
    drop(t);
    assert_eq!(applied(root.path()), 0);
}

#[test]
fn a_barrier_reply_past_the_byte_bound_forces_abort_and_stops_recovery() {
    let root = tempfile::tempdir().unwrap();
    let callbacks = callbacks();
    let mut config = TranscriptConfig::new("w");
    config.limits.max_host_bytes = 8;
    let blob_store = ContentAddressedStore::open(root.path().join("cas")).unwrap();
    let (mut t, _) = Transcript::open(root.path().join("t.sqlite"), config).unwrap();
    t.publish_snapshot(&blob_store, b"heap-0", meta()).unwrap();
    t.begin_crank(b"d1").unwrap();
    // The barrier's effect has run, but its reply does not fit.
    assert!(matches!(
        t.host_call(&callbacks, "launch-missile", None, b"a", |_| reply(&[0; 8])),
        Err(HostCallError::Transcript(TranscriptError::Backpressure(_)))
    ));
    // The crank can only abort, so no further effect may run in it.
    assert_eq!(
        t.host_call(&callbacks, "launch-missile", None, b"b", |_| unreachable!()),
        Err(HostCallError::MustAbort(1))
    );
    assert_eq!(
        t.host_call(&callbacks, "now", None, b"c", |_| unreachable!()),
        Err(HostCallError::MustAbort(1))
    );
    // A pure call has no effect to escape.
    t.host_call(&callbacks, "hash", None, b"d", |_| reply(b"1"))
        .unwrap();
    // The crank may not commit past the refused barrier.
    assert!(matches!(
        t.commit_crank(),
        Err(TranscriptError::Protocol(_))
    ));
    t.abort_crank().unwrap();
    let stop = t.recovery_gate().unwrap().unwrap_err();
    assert!(
        matches!(&stop, RecoveryStop::EscapedBarrier { crank: 1, callback, .. } if callback == "launch-missile"),
        "expected an escaped barrier, got {stop:?}"
    );
    // Only the one barrier ran, so clearing it clears the gate.
    let RecoveryStop::EscapedBarrier { seq, .. } = stop else {
        unreachable!()
    };
    t.clear_barrier(seq).unwrap();
    assert_eq!(t.recovery_gate().unwrap(), Ok(()));
}

#[test]
fn misclassified_escapes_per_crank_are_bounded() {
    let root = tempfile::tempdir().unwrap();
    let callbacks = callbacks();
    let mut config = TranscriptConfig::new("w");
    config.limits.max_host_calls = 2;
    let blob_store = ContentAddressedStore::open(root.path().join("cas")).unwrap();
    let (mut t, _) = Transcript::open(root.path().join("t.sqlite"), config).unwrap();
    t.publish_snapshot(&blob_store, b"heap-0", meta()).unwrap();
    t.begin_crank(b"d1").unwrap();
    for _ in 0..2 {
        assert_eq!(
            t.host_call(&callbacks, "hash", None, b"a", |_| opens(
                b"",
                Some(b"cap:x")
            )),
            Err(HostCallError::Misclassified("hash".into()))
        );
    }
    // Each escape was a durable record, so the crank's bound now refuses
    // further calls, pure ones included, before the adapter runs.
    assert!(matches!(
        t.host_call(&callbacks, "hash", None, b"a", |_| unreachable!()),
        Err(HostCallError::Transcript(TranscriptError::Backpressure(_)))
    ));
    assert!(matches!(
        t.host_call(&callbacks, "now", None, b"b", |_| unreachable!()),
        Err(HostCallError::Transcript(TranscriptError::Backpressure(_)))
    ));
    assert_eq!(t.open_handles().unwrap().len(), 2);
}

#[test]
fn registering_a_callback_again_replaces_its_classification() {
    let callbacks = CallbackRegistry::new()
        .classify("now", HostClass::Pure)
        .classify("now", HostClass::Read)
        .admit(true)
        .unwrap();
    assert_eq!(callbacks.class("now"), Some(HostClass::Read));
}

#[test]
fn recorded_host_calls_per_crank_are_bounded() {
    let root = tempfile::tempdir().unwrap();
    let callbacks = callbacks();
    let mut config = TranscriptConfig::new("w");
    config.limits.max_host_calls = 2;
    config.limits.max_host_bytes = 16;
    let blob_store = ContentAddressedStore::open(root.path().join("blob_store")).unwrap();
    let (mut t, _) = Transcript::open(root.path().join("t.sqlite"), config).unwrap();
    t.publish_snapshot(&blob_store, b"heap-0", meta()).unwrap();
    t.begin_crank(b"d1").unwrap();
    t.host_call(&callbacks, "now", None, b"a", |_| reply(b"1"))
        .unwrap();
    t.host_call(&callbacks, "post-webhook", None, b"b", |_| unreachable!())
        .unwrap();
    assert!(matches!(
        t.host_call(&callbacks, "now", None, b"c", |_| unreachable!()),
        Err(HostCallError::Transcript(TranscriptError::Backpressure(_)))
    ));
    // Pure calls stage nothing, so the bound does not refuse them.
    t.host_call(&callbacks, "hash", None, b"d", |_| reply(b"2"))
        .unwrap();
    t.commit_crank().unwrap();
    t.begin_crank(b"d2").unwrap();
    assert!(matches!(
        t.host_call(&callbacks, "now", None, &[0; 17], |_| unreachable!()),
        Err(HostCallError::Transcript(TranscriptError::Backpressure(_)))
    ));
    t.host_call(&callbacks, "now", None, &[0; 16], |_| reply(b""))
        .unwrap();
}
