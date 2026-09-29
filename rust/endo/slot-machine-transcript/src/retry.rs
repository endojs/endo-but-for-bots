//! Terminate, restore, replay, and retry (designs/ironhorse-panic.md
//! § Slot Machine Termination and Retry).
//!
//! When a crank ends in anything but quiescence, the [`Supervisor`] discards
//! its staged frames and drops the worker incarnation. Recovery restores the
//! latest published snapshot and replays the committed suffix after its
//! watermark through [`Replay`]: each replayed delivery must send exactly the
//! recorded outbound frames, which are suppressed rather than released, and
//! its host calls are answered from the record without invoking an adapter.
//! Any divergence is a deterministic [`ReplayStop`]. Replay ends at the state
//! immediately before the aborted delivery, which stays pending until an
//! operator retries it under a fix the panic source admits ([`PanicSource`],
//! [`RetryFix`]) or discards it.
//!
//! Handles are re-seated from their durable descriptors before the restored
//! worker runs, so the first live call after replay continues from the last
//! committed position. A replayed call never reaches a native resource.

use std::collections::VecDeque;

use crate::{
    AbortedCrank, AdmittedCallbacks, CasStore, CrankId, CrankVerdict, Embargo, FrameSink, HandleId,
    HandleRecord, HostCallError, HostOutcome, HostReplay, HostReply, RecoveryStop, ReplayStop,
    ReseatReport, Seq, Settlement, SnapshotMeta, SnapshotRecord, Transcript, TranscriptError,
};

/// What ended the incarnation, as the retry policy reads it (§ What "fixed"
/// means in practice).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PanicSource {
    /// A guest logic bug, including a panic-on-reference-error fault. The
    /// same bundle deterministically panics again.
    GuestBug,
    /// A Rust engine logic bug. The same engine panics again until fixed.
    EngineBug,
    /// The crank's hard meter limit.
    MeterAbort,
    /// Stack exhaustion, possibly driven by the delivery's input.
    StackOverflow,
    /// A throw escaped the delivery adapter (§ Uncaught throws versus
    /// rejected deliveries (Q5)). Discarded and terminated like a panic,
    /// never redelivered automatically.
    UncaughtThrow,
}

/// The change that makes a retry of the pending delivery worth attempting.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RetryFix {
    /// A code or engine fix. `heap` is the fixed build's restored state at
    /// the committed watermark; it is published as a new snapshot, and
    /// `meta` becomes the pinned configuration.
    NewSnapshot { heap: Vec<u8>, meta: SnapshotMeta },
    /// The same snapshot under a changed configuration, such as a raised
    /// meter limit, applied to the restored worker before the retry.
    ConfigChange,
    /// The same snapshot and delivery, after a condition outside the worker
    /// changed (a host call now answers differently).
    ExternalCondition,
}

impl PanicSource {
    /// Whether `fix` can change the outcome of re-delivering the pending
    /// crank. An unmodified retry of a deterministic failure is refused.
    pub fn admits(self, fix: &RetryFix) -> bool {
        matches!(
            (self, fix),
            (_, RetryFix::NewSnapshot { .. })
                | (PanicSource::MeterAbort, RetryFix::ConfigChange)
                | (
                    PanicSource::StackOverflow | PanicSource::UncaughtThrow,
                    RetryFix::ExternalCondition,
                )
        )
    }
}

/// A committed crank's recorded outbound frames, in sequence order.
type RecordedFrames = VecDeque<(Seq, Vec<u8>)>;

/// Replays the committed suffix after the latest published snapshot.
#[derive(Debug)]
pub struct Replay {
    snapshot: SnapshotRecord,
    snapshot_bytes: Vec<u8>,
    cranks: VecDeque<(CrankId, Vec<u8>, RecordedFrames)>,
    host: HostReplay,
    current: Option<(CrankId, RecordedFrames)>,
    pending: Option<AbortedCrank>,
}

impl Transcript {
    /// Begin recovery: the verified latest snapshot, the committed suffix
    /// after it, its recorded host calls, and the aborted delivery that
    /// ended the last incarnation, if it has not been retried or discarded.
    pub fn replay(&self, cas: &CasStore) -> Result<Replay, TranscriptError> {
        let plan = self.replay_plan(cas)?;
        let host = self.host_replay()?;
        let last_committed = plan
            .cranks
            .last()
            .map_or(plan.snapshot.watermark_crank, |c| c.crank);
        let pending = self
            .aborted_cranks()?
            .into_iter()
            .rfind(|c| c.crank > last_committed);
        Ok(Replay {
            cranks: plan
                .cranks
                .into_iter()
                .map(|c| (c.crank, c.inbound, c.outbound.into_iter().collect()))
                .collect(),
            snapshot: plan.snapshot,
            snapshot_bytes: plan.snapshot_bytes,
            host,
            current: None,
            pending,
        })
    }
}

impl Replay {
    /// The snapshot replay starts from.
    pub fn snapshot(&self) -> &SnapshotRecord {
        &self.snapshot
    }

    /// Its verified heap bytes.
    pub fn snapshot_bytes(&self) -> &[u8] {
        &self.snapshot_bytes
    }

    /// The delivery that ended the last incarnation and was never
    /// committed: the retry candidate.
    pub fn pending(&self) -> Option<&AbortedCrank> {
        self.pending.as_ref()
    }

    /// Committed cranks not yet replayed.
    pub fn remaining(&self) -> usize {
        self.cranks.len()
    }

    /// Start replaying the next committed crank, returning its id and
    /// inbound delivery, or `None` at the end of the suffix.
    pub fn next_crank(&mut self) -> Option<(CrankId, Vec<u8>)> {
        let (crank, inbound, outbound) = self.cranks.pop_front()?;
        self.host.begin_crank(crank);
        self.current = Some((crank, outbound));
        Some((crank, inbound))
    }

    /// The replayed worker sent `frame`. It must equal the next recorded
    /// outbound frame of the crank; it is suppressed, never released.
    /// Returns the recorded sequence.
    pub fn send(&mut self, frame: &[u8]) -> Result<Seq, ReplayStop> {
        let Some((crank, outbound)) = &mut self.current else {
            return Err(ReplayStop::Mismatch {
                crank: 0,
                detail: "outbound frame outside a replayed crank".into(),
            });
        };
        match outbound.pop_front() {
            Some((seq, recorded)) if recorded == frame => Ok(seq),
            Some((seq, _)) => Err(ReplayStop::Mismatch {
                crank: *crank,
                detail: format!("replayed frame differs from the one recorded at seq {seq}"),
            }),
            None => Err(ReplayStop::Mismatch {
                crank: *crank,
                detail: "replayed an unrecorded outbound frame".into(),
            }),
        }
    }

    /// Answer the replayed worker's host call from the record.
    pub fn host_call(
        &mut self,
        callback: &str,
        handle: Option<HandleId>,
        request: &[u8],
    ) -> Result<HostReply, ReplayStop> {
        self.host.call(callback, handle, request)
    }

    /// Finish the replayed crank. It must have quiesced and consumed every
    /// recorded frame and host call.
    pub fn end_crank(&mut self, verdict: CrankVerdict) -> Result<(), ReplayStop> {
        let Some((crank, outbound)) = self.current.take() else {
            return Err(ReplayStop::Mismatch {
                crank: 0,
                detail: "no replayed crank to end".into(),
            });
        };
        if verdict != CrankVerdict::Quiesced {
            return Err(ReplayStop::Mismatch {
                crank,
                detail: format!("committed crank replayed as {verdict:?}"),
            });
        }
        if !outbound.is_empty() {
            return Err(ReplayStop::Mismatch {
                crank,
                detail: format!("{} recorded outbound frames not replayed", outbound.len()),
            });
        }
        self.host.end_crank()
    }
}

/// Why a supervised crank could not send or call out. The worker reports
/// it to the guest as a failed operation.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum IoRefusal {
    /// The live transcript or embargo refused.
    Host(HostCallError),
    /// Replay diverged or reached a barrier or broken handle.
    Replay(ReplayStop),
}

/// What a worker may do during a crank.
pub trait CrankIo {
    /// Send an outbound frame.
    fn send(&mut self, frame: Vec<u8>) -> Result<(), IoRefusal>;

    /// Make a host call. `invoke` runs the live adapter and is never called
    /// during replay.
    fn host_call(
        &mut self,
        callback: &str,
        handle: Option<HandleId>,
        request: &[u8],
        invoke: &mut dyn FnMut(&[u8]) -> HostOutcome,
    ) -> Result<HostReply, IoRefusal>;
}

/// One worker incarnation.
pub trait Worker {
    /// Run one delivery to its verdict.
    fn deliver(&mut self, inbound: &[u8], io: &mut dyn CrankIo) -> CrankVerdict;

    /// The quiescent heap bytes.
    fn snapshot(&mut self) -> Result<Vec<u8>, String>;
}

/// Builds incarnations and owns the native resources behind handles.
pub trait WorkerFactory {
    /// The incarnation type.
    type Worker: Worker;

    /// Restore an incarnation from heap bytes.
    fn restore(&mut self, heap: &[u8]) -> Result<Self::Worker, String>;

    /// Rebuild the native resource behind a handle from its descriptor.
    fn reseat(&mut self, record: &HandleRecord) -> Result<(), String>;
}

/// A supervised delivery's result.
#[derive(Debug, PartialEq, Eq)]
pub enum Delivered {
    /// Committed; `released` frames were handed to the sink.
    Committed { crank: CrankId, released: Vec<Seq> },
    /// Discarded; the incarnation was dropped and the crank is pending.
    Terminated {
        crank: CrankId,
        verdict: CrankVerdict,
    },
}

/// What recovery did.
#[derive(Debug, PartialEq, Eq)]
pub struct Recovered {
    /// The snapshot restored.
    pub snapshot: SnapshotRecord,
    /// Committed cranks replayed.
    pub replayed: usize,
    /// Frames suppressed during replay.
    pub suppressed: Vec<Seq>,
    /// The handle re-seat report.
    pub reseat: ReseatReport,
    /// The aborted delivery awaiting retry.
    pub pending: Option<AbortedCrank>,
}

/// Why the supervisor refused.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SupervisorError {
    /// The transcript refused.
    Transcript(TranscriptError),
    /// Replay diverged, or reached a barrier or a broken handle.
    Replay(ReplayStop),
    /// Retry must wait for operator intervention.
    Stopped(RecoveryStop),
    /// The fix cannot change a deterministic outcome.
    FixNotAdmitted {
        source: PanicSource,
        fix: &'static str,
    },
    /// Restoring or snapshotting the worker failed.
    Worker(String),
    /// The operation does not fit the supervisor's state.
    State(&'static str),
}

impl From<TranscriptError> for SupervisorError {
    fn from(e: TranscriptError) -> SupervisorError {
        SupervisorError::Transcript(e)
    }
}

struct LiveIo<'a, S: FrameSink> {
    embargo: &'a mut Embargo<S>,
    callbacks: &'a AdmittedCallbacks,
}

impl<S: FrameSink> CrankIo for LiveIo<'_, S> {
    fn send(&mut self, frame: Vec<u8>) -> Result<(), IoRefusal> {
        self.embargo
            .send(frame)
            .map_err(|e| IoRefusal::Host(HostCallError::Transcript(e)))
    }

    fn host_call(
        &mut self,
        callback: &str,
        handle: Option<HandleId>,
        request: &[u8],
        invoke: &mut dyn FnMut(&[u8]) -> HostOutcome,
    ) -> Result<HostReply, IoRefusal> {
        self.embargo
            .transcript_mut()
            .host_call(self.callbacks, callback, handle, request, |r| invoke(r))
            .map_err(IoRefusal::Host)
    }
}

struct ReplayIo<'a> {
    replay: &'a mut Replay,
    suppressed: &'a mut Vec<Seq>,
    stop: Option<ReplayStop>,
}

impl CrankIo for ReplayIo<'_> {
    fn send(&mut self, frame: Vec<u8>) -> Result<(), IoRefusal> {
        let result = self
            .replay
            .send(&frame)
            .map(|seq| self.suppressed.push(seq));
        self.note(result)
    }

    fn host_call(
        &mut self,
        callback: &str,
        handle: Option<HandleId>,
        request: &[u8],
        _invoke: &mut dyn FnMut(&[u8]) -> HostOutcome,
    ) -> Result<HostReply, IoRefusal> {
        let result = self.replay.host_call(callback, handle, request);
        self.note(result)
    }
}

impl ReplayIo<'_> {
    fn note<T>(&mut self, result: Result<T, ReplayStop>) -> Result<T, IoRefusal> {
        result.map_err(|stop| {
            self.stop.get_or_insert(stop.clone());
            IoRefusal::Replay(stop)
        })
    }
}

/// Drives one worker through its transcript: live deliveries under the
/// embargo, termination on any non-quiescent verdict, recovery, and retry.
pub struct Supervisor<F: WorkerFactory, S: FrameSink> {
    embargo: Embargo<S>,
    cas: CasStore,
    factory: F,
    callbacks: AdmittedCallbacks,
    meta: SnapshotMeta,
    worker: Option<F::Worker>,
    pending: Option<AbortedCrank>,
}

impl<F: WorkerFactory, S: FrameSink> Supervisor<F, S> {
    /// Supervise a worker with no live incarnation yet; call
    /// [`Supervisor::recover`] (or [`Supervisor::start`] for a fresh one).
    pub fn new(
        embargo: Embargo<S>,
        cas: CasStore,
        factory: F,
        callbacks: AdmittedCallbacks,
        meta: SnapshotMeta,
    ) -> Supervisor<F, S> {
        Supervisor {
            embargo,
            cas,
            factory,
            callbacks,
            meta,
            worker: None,
            pending: None,
        }
    }

    /// Start a fresh worker from `heap`, publishing it as the initial
    /// snapshot that every retryable crank needs.
    pub fn start(&mut self, heap: &[u8]) -> Result<SnapshotRecord, SupervisorError> {
        if self.worker.is_some() {
            return Err(SupervisorError::State("a worker is already running"));
        }
        let worker = self
            .factory
            .restore(heap)
            .map_err(SupervisorError::Worker)?;
        let record =
            self.embargo
                .transcript_mut()
                .publish_snapshot(&self.cas, heap, self.meta.clone())?;
        self.worker = Some(worker);
        Ok(record)
    }

    /// The transcript, for inspection.
    pub fn transcript(&self) -> &Transcript {
        self.embargo.transcript()
    }

    /// The sink, for inspection.
    pub fn sink(&self) -> &S {
        self.embargo.sink()
    }

    /// The factory, to change configuration before a retry.
    pub fn factory_mut(&mut self) -> &mut F {
        &mut self.factory
    }

    /// The live incarnation, if one is running.
    pub fn worker_mut(&mut self) -> Option<&mut F::Worker> {
        self.worker.as_mut()
    }

    /// The delivery awaiting retry.
    pub fn pending(&self) -> Option<&AbortedCrank> {
        self.pending.as_ref()
    }

    /// Deliver `inbound` to the live worker. On any verdict but
    /// `Quiesced`, the staged frames are discarded and the incarnation is
    /// dropped.
    pub fn deliver(&mut self, inbound: &[u8]) -> Result<Delivered, SupervisorError> {
        let Some(worker) = self.worker.as_mut() else {
            return Err(SupervisorError::State("no live worker; recover first"));
        };
        if self.pending.is_some() {
            return Err(SupervisorError::State(
                "a pending delivery must be retried or discarded first",
            ));
        }
        self.embargo.admit(inbound)?;
        let verdict = worker.deliver(
            inbound,
            &mut LiveIo {
                embargo: &mut self.embargo,
                callbacks: &self.callbacks,
            },
        );
        match self.embargo.settle(verdict)? {
            Settlement::Committed {
                crank, released, ..
            } => Ok(Delivered::Committed { crank, released }),
            Settlement::Discarded { crank, verdict, .. } => {
                self.worker = None;
                Ok(Delivered::Terminated { crank, verdict })
            }
        }
    }

    /// Commit the quiescent heap as a new snapshot, then compact the prefix
    /// it covers.
    pub fn checkpoint(&mut self) -> Result<SnapshotRecord, SupervisorError> {
        let Some(worker) = self.worker.as_mut() else {
            return Err(SupervisorError::State("no live worker to snapshot"));
        };
        let heap = worker.snapshot().map_err(SupervisorError::Worker)?;
        let record =
            self.embargo
                .transcript_mut()
                .publish_snapshot(&self.cas, &heap, self.meta.clone())?;
        self.embargo.transcript_mut().compact()?;
        Ok(record)
    }

    /// Restore the latest snapshot and replay the committed suffix, leaving
    /// the worker at the state immediately before the pending delivery.
    /// Handles are re-seated first. A handle re-seated as broken stops
    /// replay only if a replayed call uses it; retry stays gated on it.
    pub fn recover(&mut self) -> Result<Recovered, SupervisorError> {
        if self.worker.is_some() {
            return Err(SupervisorError::State(
                "terminate the worker before recovering",
            ));
        }
        let transcript = self.embargo.transcript_mut();
        transcript.check_resume(&self.meta)?;
        let factory = &mut self.factory;
        let reseat = transcript.reseat_handles(|record| factory.reseat(record))?;
        let mut replay = transcript.replay(&self.cas)?;
        let mut worker = self
            .factory
            .restore(replay.snapshot_bytes())
            .map_err(SupervisorError::Worker)?;
        let mut suppressed = Vec::new();
        let mut replayed = 0;
        while let Some((_, inbound)) = replay.next_crank() {
            let mut io = ReplayIo {
                replay: &mut replay,
                suppressed: &mut suppressed,
                stop: None,
            };
            let verdict = worker.deliver(&inbound, &mut io);
            if let Some(stop) = io.stop {
                return Err(SupervisorError::Replay(stop));
            }
            replay.end_crank(verdict).map_err(SupervisorError::Replay)?;
            replayed += 1;
        }
        self.worker = Some(worker);
        self.pending = replay.pending().cloned();
        Ok(Recovered {
            snapshot: replay.snapshot().clone(),
            replayed,
            suppressed,
            reseat,
            pending: self.pending.clone(),
        })
    }

    /// Re-deliver the pending crank under `fix`, which `source` must admit.
    /// Refused while a barrier escaped or a handle is broken.
    pub fn retry(
        &mut self,
        source: PanicSource,
        fix: RetryFix,
    ) -> Result<Delivered, SupervisorError> {
        if self.worker.is_none() {
            return Err(SupervisorError::State("recover before retrying"));
        }
        let Some(pending) = self.pending.clone() else {
            return Err(SupervisorError::State("no pending delivery"));
        };
        if !source.admits(&fix) {
            let fix = match fix {
                RetryFix::NewSnapshot { .. } => "new snapshot",
                RetryFix::ConfigChange => "config change",
                RetryFix::ExternalCondition => "external condition",
            };
            return Err(SupervisorError::FixNotAdmitted { source, fix });
        }
        if let Err(stop) = self.embargo.transcript().recovery_gate()? {
            return Err(SupervisorError::Stopped(stop));
        }
        if let RetryFix::NewSnapshot { heap, meta } = fix {
            let worker = self
                .factory
                .restore(&heap)
                .map_err(SupervisorError::Worker)?;
            self.embargo
                .transcript_mut()
                .publish_snapshot(&self.cas, &heap, meta.clone())?;
            self.meta = meta;
            self.worker = Some(worker);
        }
        self.pending = None;
        self.deliver(&pending.inbound)
    }

    /// Give up on the pending delivery; it stays aborted on record and the
    /// worker serves the next one.
    pub fn discard_pending(&mut self) -> Option<AbortedCrank> {
        self.pending.take()
    }

    /// Give back the transcript and sink.
    pub fn into_parts(self) -> (Transcript, S) {
        self.embargo.into_parts()
    }
}
