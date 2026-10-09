//! A toy deterministic vat and a supervisor loop around the transcript,
//! shared by the protocol tests and the crash-injection matrix.

#![allow(dead_code)]

use std::path::{Path, PathBuf};

use slot_machine_transcript::{
    ContentAddressedStore, FaultPlan, Recovery, ReleasableFrame, SnapshotMeta, SnapshotRecord,
    Transcript, TranscriptConfig, TranscriptError,
};

/// The vat's whole heap.
pub type VatState = u64;

/// Deliver `inbound` to a vat in `state`: the next state and the frames sent.
pub fn deliver(state: VatState, inbound: &[u8]) -> (VatState, Vec<Vec<u8>>) {
    let mut next = state;
    for b in inbound {
        next = next.wrapping_mul(1_000_003).wrapping_add(u64::from(*b));
    }
    let text = String::from_utf8_lossy(inbound);
    (
        next,
        vec![
            format!("ack:{text}:{next}").into_bytes(),
            format!("echo:{text}").into_bytes(),
        ],
    )
}

/// The heap bytes a snapshot of `state` stores.
pub fn snapshot_bytes(state: VatState) -> Vec<u8> {
    format!("vat-state:{state}").into_bytes()
}

/// Decode [`snapshot_bytes`].
pub fn restore(bytes: &[u8]) -> VatState {
    std::str::from_utf8(bytes)
        .ok()
        .and_then(|s| s.strip_prefix("vat-state:"))
        .and_then(|s| s.parse().ok())
        .expect("well-formed snapshot bytes")
}

/// The configuration every snapshot in these tests pins.
pub fn meta() -> SnapshotMeta {
    SnapshotMeta {
        engine_signature: b"toy-vat-v1".to_vec(),
        panic_on_reference_error: false,
    }
}

/// The oracle: the state and frame sequence of delivering `inbounds` live.
pub fn oracle(inbounds: &[&[u8]]) -> (VatState, Vec<Vec<u8>>) {
    let mut state = 0;
    let mut frames = Vec::new();
    for inbound in inbounds {
        let (next, out) = deliver(state, inbound);
        state = next;
        frames.extend(out);
    }
    (state, frames)
}

/// A receiver outside the worker process: it survives a worker crash and
/// drops a re-released frame by its stable sequence.
#[derive(Debug, Default)]
pub struct Wire {
    highest: Option<u64>,
    pub accepted: Vec<Vec<u8>>,
    pub accepted_keys: Vec<String>,
    pub duplicates: usize,
}

impl Wire {
    pub fn receive(&mut self, frame: &ReleasableFrame) {
        if self.highest.is_some_and(|h| frame.sequence <= h) {
            self.duplicates += 1;
            return;
        }
        self.highest = Some(frame.sequence);
        self.accepted.push(frame.payload.clone());
        self.accepted_keys.push(frame.idempotency_key.clone());
    }
}

/// A worker's files.
pub struct WorkerFiles {
    pub directory: PathBuf,
    pub worker: String,
}

impl WorkerFiles {
    pub fn new(root: &Path, worker: &str) -> WorkerFiles {
        WorkerFiles {
            directory: root.join(worker),
            worker: worker.to_string(),
        }
    }

    pub fn transcript(&self) -> PathBuf {
        slot_machine_transcript::transcript_path(&self.directory, &self.worker)
    }

    pub fn cas_directory(&self) -> PathBuf {
        self.directory.join("snapshots")
    }
}

/// The Slot Machine supervisor loop, reduced to what the transcript sees.
pub struct Supervisor {
    pub transcript: Transcript,
    pub blob_store: ContentAddressedStore,
    pub state: VatState,
    pub recovery: Recovery,
    pub replayed: usize,
    plan: Option<FaultPlan>,
}

impl Supervisor {
    /// Start (or restart) a worker: open and reconcile the transcript,
    /// restore the published snapshot, replay the committed suffix (checking
    /// that replay re-derives exactly the recorded frames), and re-release
    /// every unacknowledged committed frame.
    pub fn start(
        files: &WorkerFiles,
        plan: Option<FaultPlan>,
        wire: &mut Wire,
    ) -> Result<Supervisor, TranscriptError> {
        let mut config = TranscriptConfig::new(&files.worker);
        let mut blob_store = ContentAddressedStore::open(files.cas_directory(), &files.worker)
            .expect("blob_store directory");
        if let Some(plan) = &plan {
            config = config.with_fault_plan(plan.clone());
            blob_store = blob_store.with_fault_plan(plan.clone());
        }
        let (transcript, recovery) = Transcript::open(files.transcript(), config)?;
        let mut supervisor = Supervisor {
            transcript,
            blob_store,
            state: 0,
            recovery,
            replayed: 0,
            plan,
        };
        if supervisor.transcript.latest_snapshot()?.is_none() {
            // A fresh worker: the initial durable snapshot precedes the
            // first retryable delivery.
            supervisor.publish()?;
        } else {
            let plan = supervisor
                .transcript
                .replay_plan(&supervisor.blob_store, &meta())?;
            let mut state = restore(&plan.snapshot_bytes);
            for crank in &plan.cranks {
                let (next, out) = deliver(state, &crank.inbound);
                let recorded: Vec<Vec<u8>> =
                    crank.outbound.iter().map(|(_, p)| p.clone()).collect();
                assert_eq!(
                    out, recorded,
                    "replay of crank {} diverged from its recorded frames",
                    crank.crank
                );
                state = next;
            }
            supervisor.replayed = plan.cranks.len();
            supervisor.state = state;
        }
        let frames = supervisor.transcript.releasable()?;
        for frame in &frames {
            wire.receive(frame);
        }
        supervisor
            .transcript
            .mark_released(frames.iter().map(|f| f.sequence));
        Ok(supervisor)
    }

    /// Run one crank to quiescence and release its frames. On any error the
    /// crank is aborted and the vat state is left as it was.
    pub fn crank(&mut self, inbound: &[u8], wire: &mut Wire) -> Result<(), TranscriptError> {
        self.transcript.begin_crank(inbound)?;
        let (next, out) = deliver(self.state, inbound);
        let staged = out
            .into_iter()
            .try_for_each(|frame| self.transcript.stage_outbound(frame));
        let committed = staged.and_then(|()| self.transcript.commit_crank());
        match committed {
            Ok(frames) => {
                self.state = next;
                for frame in &frames {
                    wire.receive(frame);
                }
                self.transcript
                    .mark_released(frames.iter().map(|f| f.sequence));
                Ok(())
            }
            Err(e) => {
                if self.transcript.active_crank().is_some() {
                    let _ = self.transcript.abort_crank();
                }
                Err(e)
            }
        }
    }

    /// Publish a snapshot of the current state.
    pub fn publish(&mut self) -> Result<SnapshotRecord, TranscriptError> {
        self.transcript
            .publish_snapshot(&self.blob_store, &snapshot_bytes(self.state), meta())
    }

    /// Compact, then reclaim superseded blobs (unless the process is dead).
    pub fn compact(&mut self) -> Result<(), TranscriptError> {
        let superseded = self.transcript.compact()?;
        if !self.plan.as_ref().is_some_and(FaultPlan::dead) {
            let mut keep: Vec<String> = Vec::new();
            if let Some(s) = self.transcript.latest_snapshot()? {
                keep.push(s.hash);
            }
            let _ = superseded;
            self.blob_store.reclaim(&keep).expect("reclaim");
        }
        Ok(())
    }
}
