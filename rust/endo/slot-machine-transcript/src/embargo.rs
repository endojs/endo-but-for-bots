//! The Slot Machine message embargo (designs/ironhorse-panic.md § The Slot
//! Machine Message Embargo Contract).
//!
//! [`Embargo`] is the worker's one release authority. It owns the
//! worker's [`Transcript`] and a [`FrameSink`] that stands for the
//! transport. Guest sends go to [`Embargo::send`], which stages them in the
//! transcript's pending batch; nothing reaches the sink until
//! [`Embargo::settle`] is given the crank's [`CrankVerdict`]:
//!
//! - [`CrankVerdict::Quiesced`] commits the crank in one transaction and
//!   only then releases its frames, in sequence order, behind any earlier
//!   committed frames still waiting.
//! - [`CrankVerdict::Uncaught`] and [`CrankVerdict::Panicked`] discard the
//!   staged frames and record the crank aborted. No non-`Quiesced` outcome
//!   releases anything, `MeterAbort` included; the verdict is chosen from
//!   the engine's `ExecutionOutcome` arm, never from the halt's reason.
//!
//! Release is at-least-once. A frame handed to the sink is acknowledged by
//! the transcript's next transaction, so a crash after the send and before
//! that acknowledgment re-releases it on restart. Each released frame
//! carries its stable event sequence, and a receiver's
//! [`DuplicateSuppressor`] drops any sequence at or below the highest it
//! has delivered for that worker, so the peer observes every frame exactly
//! once.
//!
//! Scope split with `designs/worker-quiescence-embargo.md` (#989): that
//! design owns the admission/quiescence boundary and the in-memory
//! buffering in front of it. In durable mode this module replaces its
//! release-at-quiescence step with release-after-durable-commit; there is
//! one pending batch per worker (the transcript's) and one release
//! authority (this type), never two stacked buffers.

use std::collections::{BTreeMap, VecDeque};

use crate::{CrankId, ReleasableFrame, Seq, Transcript, TranscriptError};

/// How the crank ended, as the supervisor's commit decision reads it: the
/// three arms of the engine's `ExecutionOutcome`, without its reasons.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CrankVerdict {
    /// The delivery ran to quiescence. A delivery whose result was an
    /// ordinary rejection (a CapTP error reply) also ends here: the
    /// rejection is itself a committed outbound frame (§ Open Questions,
    /// uncaught throw versus rejected delivery).
    Quiesced,
    /// A throw escaped every handler of the delivery. Discard and
    /// terminate; not placed on the restore-and-replay path.
    Uncaught,
    /// The run terminated uncatchably. Discard and terminate; the crank is
    /// eligible for the retry policy.
    Panicked,
}

impl CrankVerdict {
    /// Whether the crank's staged frames may be released.
    pub fn commits(self) -> bool {
        matches!(self, CrankVerdict::Quiesced)
    }

    /// Whether the worker incarnation ends with this crank.
    pub fn terminates(self) -> bool {
        !self.commits()
    }

    /// Whether the aborted crank may be re-driven after restore and replay.
    /// Only panics are; retry itself is the supervisor's policy.
    pub fn retryable(self) -> bool {
        matches!(self, CrankVerdict::Panicked)
    }
}

/// The transport, reduced to what release needs. An error means the frame
/// was not handed off; it stays queued and a later [`Embargo::pump`]
/// retries it, still in sequence order.
pub trait FrameSink {
    /// The transport's error.
    type Error: std::fmt::Debug;

    /// Hand one committed frame to the transport.
    fn deliver(&mut self, frame: &ReleasableFrame) -> Result<(), Self::Error>;
}

/// What [`Embargo::settle`] did.
#[derive(Debug, PartialEq, Eq)]
pub enum Settlement<E> {
    /// The crank committed. `released` are the sequences handed to the sink
    /// by this call, which may include earlier committed frames that were
    /// waiting; `blocked` is the sink error that stopped release early, if
    /// any.
    Committed {
        crank: CrankId,
        released: Vec<Seq>,
        blocked: Option<E>,
    },
    /// The crank's staged frames were discarded and it is recorded aborted.
    Discarded {
        crank: CrankId,
        verdict: CrankVerdict,
        frames: usize,
    },
}

/// The per-worker release authority. See the module documentation.
pub struct Embargo<S: FrameSink> {
    transcript: Transcript,
    sink: S,
    /// Committed frames not yet handed to the sink, in sequence order.
    queue: VecDeque<ReleasableFrame>,
    staged: usize,
}

impl<S: FrameSink> Embargo<S> {
    /// Take over a freshly opened transcript. Every committed frame its
    /// recovery found unacknowledged is queued ahead of any new crank's
    /// output; call [`Embargo::pump`] to re-release them.
    pub fn new(transcript: Transcript, sink: S) -> Result<Embargo<S>, TranscriptError> {
        let queue = transcript.releasable()?.into();
        Ok(Embargo {
            transcript,
            sink,
            queue,
            staged: 0,
        })
    }

    /// The transcript, for snapshot publication, compaction, and audit.
    pub fn transcript(&self) -> &Transcript {
        &self.transcript
    }

    /// The transcript, mutably. Crank protocol calls must go through the
    /// embargo instead.
    pub fn transcript_mut(&mut self) -> &mut Transcript {
        &mut self.transcript
    }

    /// The sink.
    pub fn sink(&self) -> &S {
        &self.sink
    }

    /// The sink, mutably.
    pub fn sink_mut(&mut self) -> &mut S {
        &mut self.sink
    }

    /// Sequences committed but not yet handed to the sink.
    pub fn queued(&self) -> Vec<Seq> {
        self.queue.iter().map(|f| f.seq).collect()
    }

    /// Frames staged by the active crank.
    pub fn staged(&self) -> usize {
        self.staged
    }

    /// Step 1: durably admit an inbound delivery.
    pub fn admit(&mut self, inbound: &[u8]) -> Result<CrankId, TranscriptError> {
        let crank = self.transcript.begin_crank(inbound)?;
        self.staged = 0;
        Ok(crank)
    }

    /// Step 2: the guest sent `frame`. It is staged, not transmitted.
    pub fn send(&mut self, frame: Vec<u8>) -> Result<(), TranscriptError> {
        self.transcript.stage_outbound(frame)?;
        self.staged += 1;
        Ok(())
    }

    /// Steps 3 and 4: settle the active crank by its verdict.
    ///
    /// A commit error releases nothing and leaves the crank to the
    /// transcript's reconciliation on reopen. A discard on a poisoned
    /// transcript still drops the staged frames; the durable `started` row
    /// already withholds them and reopening records the abort.
    pub fn settle(
        &mut self,
        verdict: CrankVerdict,
    ) -> Result<Settlement<S::Error>, TranscriptError> {
        let Some(crank) = self.transcript.active_crank() else {
            return Err(TranscriptError::Protocol("no active crank".into()));
        };
        let frames = std::mem::take(&mut self.staged);
        if !verdict.commits() {
            self.transcript.abort_crank()?;
            return Ok(Settlement::Discarded {
                crank,
                verdict,
                frames,
            });
        }
        let committed = self.transcript.commit_crank()?;
        self.queue.extend(committed);
        let (released, blocked) = self.pump();
        Ok(Settlement::Committed {
            crank,
            released,
            blocked,
        })
    }

    /// Hand queued committed frames to the sink in sequence order, stopping
    /// at the first sink error. Returns the sequences handed off and the
    /// error, if any. Their acknowledgment rides the transcript's next
    /// transaction (or [`Embargo::flush_acks`]).
    pub fn pump(&mut self) -> (Vec<Seq>, Option<S::Error>) {
        let mut released = Vec::new();
        let mut blocked = None;
        while let Some(frame) = self.queue.front() {
            match self.sink.deliver(frame) {
                Ok(()) => {
                    released.push(frame.seq);
                    self.queue.pop_front();
                }
                Err(e) => {
                    blocked = Some(e);
                    break;
                }
            }
        }
        self.transcript.mark_released(released.iter().copied());
        (released, blocked)
    }

    /// Make release acknowledgments durable now.
    pub fn flush_acks(&mut self) -> Result<(), TranscriptError> {
        self.transcript.flush_acks()
    }

    /// Give back the transcript and sink, dropping any queued frames. The
    /// queued frames are still committed and unacknowledged, so the next
    /// open re-releases them.
    pub fn into_parts(self) -> (Transcript, S) {
        (self.transcript, self.sink)
    }
}

/// Whether a received frame is new.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Received {
    /// Deliver it.
    Fresh,
    /// A re-release of a frame already delivered: drop it.
    Duplicate,
    /// The idempotency key does not name the frame's own sequence: refuse
    /// it rather than advance a mark it does not own.
    Malformed,
}

/// The receiver's half of the release contract: drop a re-released frame by
/// its stable event sequence.
///
/// A worker releases its committed frames in strictly increasing sequence
/// order and re-releases only frames it has not durably acknowledged,
/// starting from the oldest, so one high-water mark per worker suffices.
/// A receiver that must survive its own restart persists
/// [`DuplicateSuppressor::watermarks`] alongside the effects of the frames
/// it delivered, and restores them with [`DuplicateSuppressor::with_watermarks`].
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct DuplicateSuppressor {
    highest: BTreeMap<String, Seq>,
}

impl DuplicateSuppressor {
    /// A receiver that has delivered nothing.
    pub fn new() -> DuplicateSuppressor {
        DuplicateSuppressor::default()
    }

    /// Restore a receiver from persisted high-water marks.
    pub fn with_watermarks(
        watermarks: impl IntoIterator<Item = (String, Seq)>,
    ) -> DuplicateSuppressor {
        DuplicateSuppressor {
            highest: watermarks.into_iter().collect(),
        }
    }

    /// The highest delivered sequence per worker.
    pub fn watermarks(&self) -> &BTreeMap<String, Seq> {
        &self.highest
    }

    /// Classify `seq` from `worker`, advancing the mark when it is fresh.
    pub fn receive_seq(&mut self, worker: &str, seq: Seq) -> Received {
        match self.highest.get_mut(worker) {
            Some(highest) if seq <= *highest => Received::Duplicate,
            Some(highest) => {
                *highest = seq;
                Received::Fresh
            }
            None => {
                self.highest.insert(worker.to_string(), seq);
                Received::Fresh
            }
        }
    }

    /// Classify a released frame by its idempotency key (`<worker>:<seq>`).
    pub fn receive(&mut self, frame: &ReleasableFrame) -> Received {
        match frame.idempotency_key.rsplit_once(':') {
            Some((worker, seq)) if seq.parse::<Seq>().ok() == Some(frame.seq) => {
                self.receive_seq(worker, frame.seq)
            }
            _ => Received::Malformed,
        }
    }
}
