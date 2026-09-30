//! The release side of the Slot Machine message embargo
//! (designs/ironhorse-panic.md § The Slot Machine Message Embargo Contract
//! and § Verification, "Idempotency / duplicate-suppression property").

mod common;

use std::cell::RefCell;
use std::rc::Rc;

use common::{meta, snapshot_bytes, WorkerFiles};
use slot_machine_transcript::{
    Cas, CrankVerdict, DuplicateSuppressor, Embargo, FrameSink, Received, ReleasableFrame,
    Settlement, Transcript, TranscriptConfig,
};

/// A peer outside the worker process. It survives a worker crash, and it
/// delivers each frame it accepts from the wire exactly once.
#[derive(Debug, Default)]
struct Peer {
    suppressor: DuplicateSuppressor,
    /// Every frame that reached the wire, duplicates included.
    wire: Vec<(String, u64)>,
    /// Frames the peer delivered, in order.
    delivered: Vec<Vec<u8>>,
    duplicates: usize,
}

/// The transport into a [`Peer`]. It may be told to crash the worker after
/// a fixed number of hand-offs: the frame is on the wire, but the worker
/// never records the acknowledgment.
struct Link {
    peer: Rc<RefCell<Peer>>,
    handoffs: usize,
    crash_after: Option<usize>,
}

#[derive(Debug, PartialEq, Eq)]
struct Crashed;

impl FrameSink for Link {
    type Error = Crashed;

    fn deliver(&mut self, frame: &ReleasableFrame) -> Result<(), Crashed> {
        if self.crash_after.is_some_and(|n| self.handoffs >= n) {
            return Err(Crashed);
        }
        self.handoffs += 1;
        let mut peer = self.peer.borrow_mut();
        peer.wire.push((frame.idempotency_key.clone(), frame.seq));
        match peer.suppressor.receive(frame) {
            Received::Fresh => peer.delivered.push(frame.payload.clone()),
            Received::Duplicate => peer.duplicates += 1,
            Received::Malformed => panic!("malformed key {}", frame.idempotency_key),
        }
        Ok(())
    }
}

fn open(
    files: &WorkerFiles,
    peer: &Rc<RefCell<Peer>>,
    crash_after: Option<usize>,
) -> (Embargo<Link>, Cas) {
    let cas = Cas::open(files.cas_dir()).expect("cas dir");
    let (mut transcript, _recovery) =
        Transcript::open(files.transcript(), TranscriptConfig::new(&files.worker))
            .expect("open transcript");
    if transcript.latest_snapshot().expect("read").is_none() {
        transcript
            .publish_snapshot(&cas, &snapshot_bytes(0), meta())
            .expect("initial snapshot");
    }
    let link = Link {
        peer: peer.clone(),
        handoffs: 0,
        crash_after,
    };
    (Embargo::new(transcript, link).expect("embargo"), cas)
}

fn frames(crank: usize, n: usize) -> Vec<Vec<u8>> {
    (0..n)
        .map(|i| format!("c{crank}f{i}").into_bytes())
        .collect()
}

#[test]
fn a_quiesced_crank_releases_nothing_until_commit_then_all_in_order() {
    let root = tempfile::tempdir().unwrap();
    let files = WorkerFiles::new(root.path(), "w1");
    let peer = Rc::new(RefCell::new(Peer::default()));
    let (mut embargo, _cas) = open(&files, &peer, None);

    let crank = embargo.admit(b"deliver").unwrap();
    for frame in frames(1, 3) {
        embargo.send(frame).unwrap();
        assert!(
            peer.borrow().wire.is_empty(),
            "a staged frame reached the wire"
        );
    }
    assert_eq!(embargo.staged(), 3);

    let Settlement::Committed {
        crank: settled,
        released,
        blocked,
    } = embargo.settle(CrankVerdict::Quiesced).unwrap()
    else {
        panic!("a quiesced crank must commit");
    };
    assert_eq!(settled, crank);
    assert_eq!(blocked, None);
    assert_eq!(
        embargo.transcript().crank_state(crank).unwrap().as_deref(),
        Some("committed")
    );
    assert!(
        released.windows(2).all(|w| w[0] < w[1]),
        "release out of order: {released:?}"
    );
    let peer = peer.borrow();
    assert_eq!(peer.delivered, frames(1, 3));
    assert_eq!(
        peer.wire.iter().map(|(_, s)| *s).collect::<Vec<_>>(),
        released
    );
    assert!(peer.wire.iter().all(|(k, s)| *k == format!("w1:{s}")));
}

#[test]
fn every_non_quiesced_verdict_discards_the_crank_and_releases_nothing_ever() {
    for verdict in [CrankVerdict::Uncaught, CrankVerdict::Panicked] {
        let root = tempfile::tempdir().unwrap();
        let files = WorkerFiles::new(root.path(), "w1");
        let peer = Rc::new(RefCell::new(Peer::default()));
        let (mut embargo, _cas) = open(&files, &peer, None);

        let crank = embargo.admit(b"doomed").unwrap();
        for frame in frames(1, 4) {
            embargo.send(frame).unwrap();
        }
        assert_eq!(
            embargo.settle(verdict).unwrap(),
            Settlement::Discarded {
                crank,
                verdict,
                frames: 4
            }
        );
        assert!(verdict.terminates());
        assert_eq!(verdict.retryable(), verdict == CrankVerdict::Panicked);
        assert_eq!(
            embargo.transcript().crank_state(crank).unwrap().as_deref(),
            Some("aborted")
        );
        assert!(embargo.transcript().releasable().unwrap().is_empty());
        assert!(embargo.transcript().outbound_audit().unwrap().is_empty());
        assert!(embargo.queued().is_empty());

        // Nor after a restart: an aborted crank's frames were never written.
        drop(embargo);
        let (mut embargo, _cas) = open(&files, &peer, None);
        assert!(embargo.queued().is_empty());
        embargo.pump();
        assert!(peer.borrow().wire.is_empty(), "{verdict:?} leaked a frame");
        let aborted = embargo.transcript().aborted_cranks().unwrap();
        assert_eq!(aborted.len(), 1);
        assert_eq!(aborted[0].inbound, b"doomed");
    }
}

#[test]
fn a_discarded_crank_between_commits_leaves_no_gap_in_delivery() {
    let root = tempfile::tempdir().unwrap();
    let files = WorkerFiles::new(root.path(), "w1");
    let peer = Rc::new(RefCell::new(Peer::default()));
    let (mut embargo, _cas) = open(&files, &peer, None);

    let script = [
        (CrankVerdict::Quiesced, 2),
        (CrankVerdict::Panicked, 3),
        (CrankVerdict::Quiesced, 1),
        (CrankVerdict::Uncaught, 2),
        (CrankVerdict::Quiesced, 2),
    ];
    let mut expected = Vec::new();
    for (i, (verdict, n)) in script.into_iter().enumerate() {
        embargo.admit(format!("in{i}").as_bytes()).unwrap();
        for frame in frames(i, n) {
            embargo.send(frame).unwrap();
        }
        if verdict.commits() {
            expected.extend(frames(i, n));
        }
        embargo.settle(verdict).unwrap();
    }
    assert_eq!(peer.borrow().delivered, expected);
    assert_eq!(peer.borrow().duplicates, 0);
}

#[test]
fn a_blocked_sink_holds_later_cranks_behind_earlier_frames() {
    let root = tempfile::tempdir().unwrap();
    let files = WorkerFiles::new(root.path(), "w1");
    let peer = Rc::new(RefCell::new(Peer::default()));
    let (mut embargo, _cas) = open(&files, &peer, Some(1));

    embargo.admit(b"a").unwrap();
    for frame in frames(0, 3) {
        embargo.send(frame).unwrap();
    }
    let Settlement::Committed {
        released, blocked, ..
    } = embargo.settle(CrankVerdict::Quiesced).unwrap()
    else {
        panic!("commit");
    };
    assert_eq!(released.len(), 1);
    assert_eq!(blocked, Some(Crashed));
    assert_eq!(embargo.queued().len(), 2);

    // The next crank commits while two earlier frames wait; its frames must
    // queue behind them, or the receiver's high-water mark would later drop
    // the earlier ones as duplicates.
    embargo.admit(b"b").unwrap();
    for frame in frames(1, 2) {
        embargo.send(frame).unwrap();
    }
    embargo.settle(CrankVerdict::Quiesced).unwrap();
    assert_eq!(peer.borrow().delivered.len(), 1);

    embargo.sink_mut().crash_after = None;
    let (released, blocked) = embargo.pump();
    assert_eq!(released.len(), 4);
    assert_eq!(blocked, None);
    let mut expected = frames(0, 3);
    expected.extend(frames(1, 2));
    assert_eq!(peer.borrow().delivered, expected);
}

/// § Verification, "Idempotency / duplicate-suppression property": for
/// every point at which the worker can crash after handing a frame to the
/// wire and before durably recording that hand-off, the peer observes the
/// committed frame sequence exactly once. The crash point ranges over every
/// hand-off, including one before the first frame of a crank that already
/// committed.
#[test]
fn a_crash_after_send_before_ack_is_observed_exactly_once_at_every_point() {
    let cranks: Vec<(Vec<u8>, Vec<Vec<u8>>)> = (0..3)
        .map(|i| (format!("in{i}").into_bytes(), frames(i, i + 2)))
        .collect();
    let expected: Vec<Vec<u8>> = cranks.iter().flat_map(|(_, f)| f.clone()).collect();
    let total = expected.len();

    for crash_at in 0..=total {
        let root = tempfile::tempdir().unwrap();
        let files = WorkerFiles::new(root.path(), "w1");
        let peer = Rc::new(RefCell::new(Peer::default()));

        // Incarnation 1: run every crank until the link crashes the worker.
        // Committed frames past the crash point stay unreleased; a crank
        // not yet admitted is re-delivered by the upstream sender.
        let mut admitted = 0;
        let mut committed = 0;
        {
            let (mut embargo, _cas) = open(&files, &peer, Some(crash_at));
            for (inbound, out) in &cranks {
                embargo.admit(inbound).unwrap();
                for frame in out {
                    embargo.send(frame.clone()).unwrap();
                }
                admitted += 1;
                committed += out.len();
                if let Settlement::Committed {
                    blocked: Some(Crashed),
                    ..
                } = embargo.settle(CrankVerdict::Quiesced).unwrap()
                {
                    break;
                }
            }
            // The process dies here: in-memory acknowledgments are lost.
        }
        let on_wire_before = peer.borrow().wire.len();
        assert_eq!(on_wire_before, crash_at.min(total));

        // Incarnation 2: reopen, re-release, and finish the remaining cranks.
        let (mut embargo, _cas) = open(&files, &peer, None);
        let unacknowledged = embargo.queued().len();
        let (rereleased, blocked) = embargo.pump();
        assert_eq!(rereleased.len(), unacknowledged);
        assert_eq!(blocked, None);
        for (inbound, out) in &cranks[admitted..] {
            embargo.admit(inbound).unwrap();
            for frame in out {
                embargo.send(frame.clone()).unwrap();
            }
            embargo.settle(CrankVerdict::Quiesced).unwrap();
        }
        embargo.flush_acks().unwrap();

        let peer = peer.borrow();
        assert_eq!(peer.delivered, expected, "crash at hand-off {crash_at}");
        // Acknowledgments ride each later admission, so only frames on the
        // wire with no durable acknowledgment are re-sent, and every one of
        // them is dropped by sequence.
        let never_sent = committed - on_wire_before;
        assert_eq!(
            peer.duplicates,
            unacknowledged - never_sent,
            "crash at hand-off {crash_at}"
        );
        // Once acknowledgments are durable, nothing is re-released again.
        drop(peer);
        drop(embargo);
        let (embargo, _cas) = open(&files, &Rc::new(RefCell::new(Peer::default())), None);
        assert!(embargo.queued().is_empty());
    }
}

/// An acknowledgment that rode a later transaction is durable, so a crash
/// after it re-releases only the frames handed off since.
#[test]
fn a_durable_acknowledgment_narrows_re_release_to_the_unacknowledged_suffix() {
    let root = tempfile::tempdir().unwrap();
    let files = WorkerFiles::new(root.path(), "w1");
    let peer = Rc::new(RefCell::new(Peer::default()));
    {
        let (mut embargo, _cas) = open(&files, &peer, None);
        embargo.admit(b"a").unwrap();
        for frame in frames(0, 2) {
            embargo.send(frame).unwrap();
        }
        embargo.settle(CrankVerdict::Quiesced).unwrap();
        // The next admission carries crank a's acknowledgments.
        embargo.admit(b"b").unwrap();
        for frame in frames(1, 3) {
            embargo.send(frame).unwrap();
        }
        embargo.settle(CrankVerdict::Quiesced).unwrap();
    }
    let (mut embargo, _cas) = open(&files, &peer, None);
    assert_eq!(embargo.queued().len(), 3);
    embargo.pump();
    let peer = peer.borrow();
    assert_eq!(peer.duplicates, 3);
    let mut expected = frames(0, 2);
    expected.extend(frames(1, 3));
    assert_eq!(peer.delivered, expected);
}

#[test]
fn the_suppressor_keeps_one_mark_per_worker_and_survives_a_receiver_restart() {
    let frame = |worker: &str, seq: u64| ReleasableFrame {
        seq,
        crank: 1,
        idempotency_key: format!("{worker}:{seq}"),
        payload: Vec::new(),
    };
    let mut s = DuplicateSuppressor::new();
    assert_eq!(s.receive(&frame("a", 5)), Received::Fresh);
    assert_eq!(s.receive(&frame("b", 2)), Received::Fresh);
    assert_eq!(s.receive(&frame("a", 5)), Received::Duplicate);
    assert_eq!(s.receive(&frame("a", 3)), Received::Duplicate);
    assert_eq!(s.receive(&frame("b", 3)), Received::Fresh);
    // A worker name containing ':' still keys correctly.
    assert_eq!(s.receive(&frame("host:w", 1)), Received::Fresh);
    assert_eq!(s.receive(&frame("host:w", 1)), Received::Duplicate);
    // A key naming another sequence is refused, not delivered.
    let mut forged = frame("a", 9);
    forged.idempotency_key = "a:10".into();
    assert_eq!(s.receive(&forged), Received::Malformed);
    assert_eq!(s.watermarks().get("a"), Some(&5));

    let mut restored = DuplicateSuppressor::with_watermarks(s.watermarks().clone());
    assert_eq!(restored.receive(&frame("a", 5)), Received::Duplicate);
    assert_eq!(restored.receive(&frame("a", 6)), Received::Fresh);
}

#[test]
fn settling_without_an_active_crank_is_a_protocol_error() {
    let root = tempfile::tempdir().unwrap();
    let files = WorkerFiles::new(root.path(), "w1");
    let peer = Rc::new(RefCell::new(Peer::default()));
    let (mut embargo, _cas) = open(&files, &peer, None);
    assert!(embargo.settle(CrankVerdict::Quiesced).is_err());
    assert!(embargo.send(b"x".to_vec()).is_err());
}
