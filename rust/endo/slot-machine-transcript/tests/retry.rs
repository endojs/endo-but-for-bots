//! Terminate, restore, replay, and retry (designs/ironhorse-panic.md
//! § Slot Machine Termination and Retry, § Verification: replay == live).
//!
//! A toy worker whose heap is a byte log drives the supervisor. Its host
//! calls reach a native reader table owned by the factory, so re-seating
//! and the committed-position invariant are observable: a replayed read
//! never moves a native reader.

use std::cell::RefCell;
use std::collections::HashMap;
use std::convert::Infallible;
use std::path::Path;
use std::rc::Rc;

use slot_machine_transcript::{
    CallbackRegistry, CasStore, CrankIo, CrankVerdict, Delivered, DuplicateSuppressor, Embargo,
    FrameSink, HandleRecord, HostClass, HostOutcome, HostReply, IoRefusal, PanicSource, Received,
    RecoveryStop, ReleasableFrame, ReplayStop, RetryFix, SnapshotMeta, Supervisor, SupervisorError,
    Transcript, TranscriptConfig, Worker, WorkerFactory,
};

/// Host state shared by the factory and every incarnation: the native
/// readers behind logical handles, and the knobs a fix changes.
#[derive(Default)]
struct Env {
    readers: HashMap<u64, (Vec<u8>, usize)>,
    meter_limit: usize,
    depth_answer: u32,
    native_reads: usize,
    fail_reseat: bool,
    frame_prefix: &'static str,
}

type Shared = Rc<RefCell<Env>>;

struct Toy {
    heap: Vec<u8>,
    env: Shared,
}

const FILE: &[u8] = b"abcdefghijklmnop";

impl Toy {
    fn version(&self) -> u8 {
        self.heap[0]
    }

    fn call(
        &mut self,
        io: &mut dyn CrankIo,
        callback: &str,
        handle: Option<u64>,
        request: &[u8],
    ) -> Result<HostReply, IoRefusal> {
        let env = self.env.clone();
        io.host_call(callback, handle, request, &mut |request| {
            let mut env = env.borrow_mut();
            match callback {
                "open" => HostOutcome {
                    opens: Some(Some(b"0".to_vec())),
                    ..HostOutcome::default()
                },
                "read" => {
                    env.native_reads += 1;
                    let h = handle.unwrap();
                    let n = usize::from(request[0]);
                    let (data, pos) = env.readers.get_mut(&h).expect("reader re-seated");
                    let end = (*pos + n).min(data.len());
                    let chunk = data[*pos..end].to_vec();
                    *pos = end;
                    HostOutcome {
                        reply: chunk,
                        redescribes: Some(Some(end.to_string().into_bytes())),
                        ..HostOutcome::default()
                    }
                }
                "depth" => HostOutcome {
                    reply: env.depth_answer.to_string().into_bytes(),
                    ..HostOutcome::default()
                },
                _ => HostOutcome::default(),
            }
        })
    }
}

impl Worker for Toy {
    fn deliver(&mut self, inbound: &[u8], io: &mut dyn CrankIo) -> CrankVerdict {
        let text = String::from_utf8(inbound.to_vec()).unwrap();
        let (verb, arg) = text.split_once(':').unwrap_or((&text, ""));
        let prefix = self.env.borrow().frame_prefix;
        let out = |io: &mut dyn CrankIo, heap: &mut Vec<u8>, body: &[u8]| {
            heap.extend_from_slice(body);
            let mut frame = prefix.as_bytes().to_vec();
            frame.extend_from_slice(body);
            io.send(frame).is_ok()
        };
        let ok = match verb {
            "note" => out(io, &mut self.heap, arg.as_bytes()),
            "open" => match self.call(io, "open", None, b"") {
                Ok(HostReply::Reply {
                    opened: Some(h), ..
                }) => {
                    let env = self.env.clone();
                    env.borrow_mut()
                        .readers
                        .entry(h)
                        .or_insert((FILE.to_vec(), 0));
                    out(io, &mut self.heap, format!("h{h}").as_bytes())
                }
                _ => false,
            },
            "read" => {
                let (h, n) = arg.split_once(',').unwrap();
                let request = [n.parse::<u8>().unwrap()];
                match self.call(io, "read", Some(h.parse().unwrap()), &request) {
                    Ok(HostReply::Reply { reply, .. }) => out(io, &mut self.heap, &reply),
                    _ => false,
                }
            }
            "write" => self.call(io, "write", None, arg.as_bytes()).is_ok(),
            "wspin" => {
                let _ = self.call(io, "write", None, arg.as_bytes());
                return CrankVerdict::Panicked;
            }
            "spin" => {
                if arg.parse::<usize>().unwrap() > self.env.borrow().meter_limit {
                    return CrankVerdict::Panicked;
                }
                out(io, &mut self.heap, b"spun")
            }
            "bug" => {
                if self.version() < 2 {
                    return CrankVerdict::Panicked;
                }
                out(io, &mut self.heap, b"fixed")
            }
            "deep" => match self.call(io, "depth", None, b"") {
                Ok(HostReply::Reply { reply, .. }) => {
                    let depth: u32 = String::from_utf8(reply).unwrap().parse().unwrap();
                    if depth > 100 {
                        return CrankVerdict::Panicked;
                    }
                    out(io, &mut self.heap, format!("depth{depth}").as_bytes())
                }
                _ => false,
            },
            "throw" => {
                out(io, &mut self.heap, b"before-throw");
                return CrankVerdict::Uncaught;
            }
            _ => false,
        };
        if ok {
            CrankVerdict::Quiesced
        } else {
            CrankVerdict::Uncaught
        }
    }

    fn snapshot(&mut self) -> Result<Vec<u8>, String> {
        Ok(self.heap.clone())
    }
}

struct Factory(Shared);

impl WorkerFactory for Factory {
    type Worker = Toy;

    fn restore(&mut self, heap: &[u8]) -> Result<Toy, String> {
        Ok(Toy {
            heap: heap.to_vec(),
            env: self.0.clone(),
        })
    }

    fn reseat(&mut self, record: &HandleRecord) -> Result<(), String> {
        let mut env = self.0.borrow_mut();
        if env.fail_reseat {
            return Err("resource gone".into());
        }
        let pos = String::from_utf8(record.descriptor.clone().unwrap())
            .unwrap()
            .parse()
            .unwrap();
        env.readers.insert(record.handle, (FILE.to_vec(), pos));
        Ok(())
    }
}

#[derive(Default)]
struct Wire(Vec<ReleasableFrame>);

impl FrameSink for Wire {
    type Error = Infallible;
    fn deliver(&mut self, frame: &ReleasableFrame) -> Result<(), Infallible> {
        self.0.push(frame.clone());
        Ok(())
    }
}

fn meta(version: u8) -> SnapshotMeta {
    SnapshotMeta {
        engine_signature: vec![b't', version],
        panic_on_reference_error: false,
    }
}

const HEAP_V1: &[u8] = &[1];

fn open(dir: &Path, env: &Shared, meta: SnapshotMeta) -> Supervisor<Factory, Wire> {
    let (transcript, _) =
        Transcript::open(dir.join("t.sqlite"), TranscriptConfig::new("vat")).unwrap();
    let callbacks = CallbackRegistry::new()
        .classify("open", HostClass::Read)
        .classify("read", HostClass::Read)
        .classify("depth", HostClass::Read)
        .classify("write", HostClass::Barrier)
        .admit(true)
        .unwrap();
    Supervisor::new(
        Embargo::new(transcript, Wire::default()).unwrap(),
        CasStore::open(dir.join("cas")).unwrap(),
        Factory(env.clone()),
        callbacks,
        meta,
    )
}

fn fresh_env() -> Shared {
    Rc::new(RefCell::new(Env {
        meter_limit: 10,
        depth_answer: 5,
        ..Env::default()
    }))
}

fn payloads(frames: &[ReleasableFrame]) -> Vec<Vec<u8>> {
    frames.iter().map(|f| f.payload.clone()).collect()
}

fn committed(d: Delivered) -> Vec<u64> {
    match d {
        Delivered::Committed { released, .. } => released,
        other => panic!("expected a commit, got {other:?}"),
    }
}

/// Crash the process: drop the supervisor and every native resource, and
/// reopen from disk.
fn crash(
    dir: &Path,
    supervisor: Supervisor<Factory, Wire>,
    env: &Shared,
) -> Supervisor<Factory, Wire> {
    drop(supervisor);
    env.borrow_mut().readers.clear();
    open(dir, env, meta(1))
}

#[test]
fn replay_equals_live_in_heap_bytes_frames_and_handle_positions() {
    let dir = tempfile::tempdir().unwrap();
    let env = fresh_env();
    let mut live = open(dir.path(), &env, meta(1));
    live.start(HEAP_V1).unwrap();
    committed(live.deliver(b"note:a").unwrap());
    committed(live.deliver(b"open").unwrap());
    committed(live.deliver(b"read:1,3").unwrap());
    live.checkpoint().unwrap();
    let before_suffix = live.sink().0.len();
    for inbound in [
        &b"read:1,2"[..],
        b"note:b",
        b"open",
        b"read:2,4",
        b"read:1,1",
    ] {
        committed(live.deliver(inbound).unwrap());
    }
    let live_heap = live.worker_mut().unwrap().snapshot().unwrap();
    let live_frames = payloads(&live.sink().0);
    let suffix: Vec<u64> = live.sink().0[before_suffix..]
        .iter()
        .map(|f| f.seq)
        .collect();
    let reads_live = env.borrow().native_reads;
    let last_live = live.sink().0.last().unwrap().seq;

    let mut restored = crash(dir.path(), live, &env);
    let recovered = restored.recover().unwrap();
    assert_eq!(recovered.replayed, 5);
    assert_eq!(recovered.pending, None);
    assert_eq!(recovered.reseat.reseated, vec![1, 2]);
    // Byte-identical heap, and the replayed frames are exactly the live
    // suffix, suppressed rather than sent again.
    assert_eq!(
        restored.worker_mut().unwrap().snapshot().unwrap(),
        live_heap
    );
    assert_eq!(recovered.suppressed, suffix);
    assert!(restored.sink().0.is_empty());
    assert_eq!(
        env.borrow().native_reads,
        reads_live,
        "replay reached a native reader"
    );

    // Re-seated readers continue from their committed positions: reader 1
    // has served "abc", "de", "f"; reader 2 has served "abcd".
    committed(restored.deliver(b"read:1,2").unwrap());
    committed(restored.deliver(b"read:2,2").unwrap());
    // The receiver drops re-released frames whose acknowledgement had not
    // been made durable before the crash.
    let mut receiver = DuplicateSuppressor::with_watermarks([("vat".to_string(), last_live)]);
    let fresh: Vec<ReleasableFrame> = restored
        .sink()
        .0
        .iter()
        .filter(|f| receiver.receive(f) == Received::Fresh)
        .cloned()
        .collect();
    assert_eq!(payloads(&fresh), vec![b"gh".to_vec(), b"ef".to_vec()]);

    // The oracle: the same deliveries run live with no crash.
    let oracle_dir = tempfile::tempdir().unwrap();
    let oracle_env = fresh_env();
    let mut oracle = open(oracle_dir.path(), &oracle_env, meta(1));
    oracle.start(HEAP_V1).unwrap();
    for inbound in [
        &b"note:a"[..],
        b"open",
        b"read:1,3",
        b"read:1,2",
        b"note:b",
        b"open",
        b"read:2,4",
        b"read:1,1",
        b"read:1,2",
        b"read:2,2",
    ] {
        committed(oracle.deliver(inbound).unwrap());
    }
    let mut expected = live_frames;
    expected.extend(payloads(&fresh));
    assert_eq!(payloads(&oracle.sink().0), expected);
    assert_eq!(
        oracle.worker_mut().unwrap().snapshot().unwrap(),
        restored.worker_mut().unwrap().snapshot().unwrap()
    );
}

/// Deliver `panicking` after one committed crank, then recover.
fn panic_then_recover(
    dir: &Path,
    env: &Shared,
    panicking: &[u8],
    expect: CrankVerdict,
) -> Supervisor<Factory, Wire> {
    let mut supervisor = open(dir, env, meta(1));
    supervisor.start(HEAP_V1).unwrap();
    committed(supervisor.deliver(b"note:a").unwrap());
    let sent = supervisor.sink().0.len();
    match supervisor.deliver(panicking).unwrap() {
        Delivered::Terminated { verdict, .. } => assert_eq!(verdict, expect),
        other => panic!("expected termination, got {other:?}"),
    }
    assert_eq!(
        supervisor.sink().0.len(),
        sent,
        "a discarded crank released a frame"
    );
    assert!(
        supervisor.worker_mut().is_none(),
        "the incarnation survived"
    );
    assert!(matches!(
        supervisor.deliver(b"note:x"),
        Err(SupervisorError::State(_))
    ));
    let recovered = supervisor.recover().unwrap();
    assert_eq!(recovered.replayed, 1);
    assert_eq!(recovered.pending.as_ref().unwrap().inbound, panicking);
    assert_eq!(
        supervisor.worker_mut().unwrap().snapshot().unwrap(),
        b"\x01a"
    );
    supervisor
}

#[test]
fn meter_abort_retries_the_same_snapshot_after_a_config_change() {
    let dir = tempfile::tempdir().unwrap();
    let env = fresh_env();
    let mut supervisor = panic_then_recover(dir.path(), &env, b"spin:50", CrankVerdict::Panicked);
    assert!(matches!(
        supervisor.retry(PanicSource::MeterAbort, RetryFix::ExternalCondition),
        Err(SupervisorError::FixNotAdmitted { .. })
    ));
    // A pending delivery blocks new ones until it is resolved.
    assert!(matches!(
        supervisor.deliver(b"note:x"),
        Err(SupervisorError::State(_))
    ));
    env.borrow_mut().meter_limit = 100;
    committed(
        supervisor
            .retry(PanicSource::MeterAbort, RetryFix::ConfigChange)
            .unwrap(),
    );
    assert_eq!(
        supervisor.worker_mut().unwrap().snapshot().unwrap(),
        b"\x01aspun"
    );
    assert_eq!(
        payloads(&supervisor.sink().0),
        vec![b"a".to_vec(), b"spun".to_vec()]
    );
}

#[test]
fn a_guest_bug_retries_only_under_a_new_snapshot() {
    let dir = tempfile::tempdir().unwrap();
    let env = fresh_env();
    let mut supervisor = panic_then_recover(dir.path(), &env, b"bug", CrankVerdict::Panicked);
    for fix in [RetryFix::ConfigChange, RetryFix::ExternalCondition] {
        assert!(matches!(
            supervisor.retry(PanicSource::GuestBug, fix),
            Err(SupervisorError::FixNotAdmitted { .. })
        ));
    }
    // The fixed build's state at the committed watermark.
    let fixed = RetryFix::NewSnapshot {
        heap: b"\x02a".to_vec(),
        meta: meta(2),
    };
    committed(supervisor.retry(PanicSource::GuestBug, fixed).unwrap());
    assert_eq!(
        supervisor.worker_mut().unwrap().snapshot().unwrap(),
        b"\x02afixed"
    );
    let snapshot = supervisor.transcript().latest_snapshot().unwrap().unwrap();
    assert_eq!(snapshot.meta, meta(2));

    // The next recovery restores the fixed snapshot and replays the retried
    // crank under the fixed build.
    drop(supervisor);
    let mut again = open(dir.path(), &env, meta(2));
    let recovered = again.recover().unwrap();
    assert_eq!(recovered.replayed, 1);
    assert_eq!(recovered.pending, None);
    assert_eq!(
        again.worker_mut().unwrap().snapshot().unwrap(),
        b"\x02afixed"
    );
    // Recovering under the superseded configuration is refused.
    drop(again);
    let mut stale = open(dir.path(), &env, meta(1));
    assert!(matches!(
        stale.recover(),
        Err(SupervisorError::Transcript(_))
    ));
}

#[test]
fn an_input_driven_stack_overflow_retries_after_the_external_condition_changes() {
    let dir = tempfile::tempdir().unwrap();
    let env = fresh_env();
    env.borrow_mut().depth_answer = 1000;
    let mut supervisor = panic_then_recover(dir.path(), &env, b"deep", CrankVerdict::Panicked);
    assert!(matches!(
        supervisor.retry(PanicSource::StackOverflow, RetryFix::ConfigChange),
        Err(SupervisorError::FixNotAdmitted { .. })
    ));
    env.borrow_mut().depth_answer = 7;
    committed(
        supervisor
            .retry(PanicSource::StackOverflow, RetryFix::ExternalCondition)
            .unwrap(),
    );
    assert_eq!(
        payloads(&supervisor.sink().0),
        vec![b"a".to_vec(), b"depth7".to_vec()]
    );
}

#[test]
fn an_escaped_throw_terminates_discards_and_is_never_redelivered_automatically() {
    let dir = tempfile::tempdir().unwrap();
    let env = fresh_env();
    let mut supervisor = panic_then_recover(dir.path(), &env, b"throw", CrankVerdict::Uncaught);
    // Its frame and heap mutation are gone.
    assert_eq!(payloads(&supervisor.sink().0), vec![b"a".to_vec()]);
    assert!(matches!(
        supervisor.retry(PanicSource::UncaughtThrow, RetryFix::ConfigChange),
        Err(SupervisorError::FixNotAdmitted { .. })
    ));
    let dropped = supervisor.discard_pending().unwrap();
    assert_eq!(dropped.inbound, b"throw");
    committed(supervisor.deliver(b"note:b").unwrap());
    let transcript = supervisor.transcript();
    assert_eq!(
        transcript.crank_state(dropped.crank).unwrap().as_deref(),
        Some("aborted")
    );

    // A later recovery no longer offers the discarded delivery.
    drop(supervisor);
    let mut again = open(dir.path(), &env, meta(1));
    let recovered = again.recover().unwrap();
    assert_eq!(recovered.pending, None);
    assert_eq!(again.worker_mut().unwrap().snapshot().unwrap(), b"\x01ab");
}

#[test]
fn a_replay_that_diverges_from_the_record_stops_recovery() {
    let dir = tempfile::tempdir().unwrap();
    let env = fresh_env();
    let mut live = open(dir.path(), &env, meta(1));
    live.start(HEAP_V1).unwrap();
    committed(live.deliver(b"note:a").unwrap());
    let mut restored = crash(dir.path(), live, &env);
    env.borrow_mut().frame_prefix = "v2:";
    assert!(matches!(
        restored.recover(),
        Err(SupervisorError::Replay(ReplayStop::Mismatch { .. }))
    ));
    assert!(restored.worker_mut().is_none());
}

#[test]
fn a_committed_barrier_halts_replay_instead_of_repeating_its_effect() {
    let dir = tempfile::tempdir().unwrap();
    let env = fresh_env();
    let mut live = open(dir.path(), &env, meta(1));
    live.start(HEAP_V1).unwrap();
    committed(live.deliver(b"write:x").unwrap());
    let mut restored = crash(dir.path(), live, &env);
    assert!(matches!(
        restored.recover(),
        Err(SupervisorError::Replay(ReplayStop::Barrier { .. }))
    ));
}

#[test]
fn retry_stays_stopped_while_a_barrier_escaped_or_a_handle_is_broken() {
    // A barrier that ran in the panicking crank may have escaped.
    let dir = tempfile::tempdir().unwrap();
    let env = fresh_env();
    let mut escaped = open(dir.path(), &env, meta(1));
    escaped.start(HEAP_V1).unwrap();
    committed(escaped.deliver(b"note:a").unwrap());
    assert!(matches!(
        escaped.deliver(b"wspin:y").unwrap(),
        Delivered::Terminated { .. }
    ));
    escaped.recover().unwrap();
    env.borrow_mut().meter_limit = 100;
    assert!(matches!(
        escaped.retry(PanicSource::MeterAbort, RetryFix::ConfigChange),
        Err(SupervisorError::Stopped(
            RecoveryStop::EscapedBarrier { .. }
        ))
    ));
    env.borrow_mut().meter_limit = 10;

    // A handle whose resource cannot be rebuilt: replay that does not touch
    // it proceeds, but retry waits for a replacement or a loss notice.
    let dir3 = tempfile::tempdir().unwrap();
    let mut broken = open(dir3.path(), &env, meta(1));
    broken.start(HEAP_V1).unwrap();
    committed(broken.deliver(b"open").unwrap());
    committed(broken.deliver(b"note:a").unwrap());
    env.borrow_mut().meter_limit = 0;
    assert!(matches!(
        broken.deliver(b"spin:1").unwrap(),
        Delivered::Terminated { .. }
    ));
    let mut broken = crash(dir3.path(), broken, &env);
    env.borrow_mut().fail_reseat = true;
    let recovered = broken.recover().unwrap();
    assert_eq!(recovered.reseat.broken.len(), 1);
    env.borrow_mut().meter_limit = 10;
    assert_eq!(
        broken.retry(PanicSource::MeterAbort, RetryFix::ConfigChange),
        Err(SupervisorError::Stopped(RecoveryStop::BrokenHandles(vec![
            1
        ])))
    );
}
