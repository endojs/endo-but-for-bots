//! Worker-side host-call ledger (designs/ironhorse-panic.md § Host functions
//! are messages too).
//!
//! Every callback in `powers/*::CALLBACKS` carries one of the transcript's
//! five classifications ([`admitted_callbacks`]). Once a worker attaches its
//! transcript ([`attach`]), the callbacks behind the file, directory, SQLite
//! and hasher tables run through [`Transcript::host_call`]: the guest receives
//! the transcript's logical handle id, and each handle carries a
//! [`Descriptor`] that tracks the committed position of its native resource.
//! Attaching re-seats every open handle from its descriptor through
//! [`Transcript::reseat_handles`]. A handle that cannot be rebuilt is absent
//! from the native tables, and `host_call` refuses its use without invoking
//! the adapter, so a resumed worker never reaches a resource that was not
//! actually re-seated.
//!
//! Without an attached transcript the callbacks run directly, and a
//! supervised suspend still refuses open native handles: nothing durable
//! could rebuild them.
//!
//! Under a transcript the worker's outbound frames are also staged in the
//! delivery's crank ([`outbound`]), so the committed record carries them.
//! [`replay`] re-runs the committed suffix after the published snapshot a
//! resumed worker was restored from (designs/ironhorse-panic.md § Slot
//! Machine Termination and Retry): outbound frames must match the record and
//! are suppressed, and host calls are answered from the record through
//! [`call_in`] without reaching a native resource. A callback whose reply
//! has no guest-value encoding stops replay rather than guessing.

use std::cell::RefCell;
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicU32, Ordering};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde::{Deserialize, Serialize};
use slot_machine_transcript::{
    AdmittedCallbacks, CallbackRegistry, CasStore, CrankVerdict, HandleRecord, HostCallError,
    HostClass, HostOutcome, HostReply, RecoveryStop, Replay, ReplayStop, Seq, SnapshotMeta,
    Transcript, TranscriptConfig,
};

use crate::ffi::{fxArrayBuffer, fxInteger, fxNull, XsMachine};
use crate::powers::{self, HostPowers};
use crate::worker_io::set_result_string;

/// The most bytes an incremental hasher's descriptor records. A hasher fed
/// more has no descriptor and is re-seated as broken.
pub const HASHER_DESCRIPTOR_LIMIT: usize = 1 << 20;

/// Where a file or directory handle's authority comes from.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum Base {
    /// A named directory in `HostPowers.dirs`.
    Token(String),
    /// An ambiently opened absolute directory (`openDir('root', path)`).
    Ambient(String),
}

/// How to rebuild the native resource behind a logical handle, as of the
/// last committed call on it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub(crate) enum Descriptor {
    Directory {
        base: Base,
        path: String,
    },
    Reader {
        base: Base,
        path: String,
        position: u64,
    },
    Writer {
        base: Base,
        path: String,
        position: u64,
    },
    Database {
        path: String,
    },
    Statement {
        database: u32,
        sql: String,
    },
    Hasher {
        fed: String,
    },
}

impl Descriptor {
    pub(crate) fn encode(&self) -> Vec<u8> {
        serde_json::to_vec(self).expect("descriptor serializes")
    }

    fn decode(bytes: &[u8]) -> Result<Descriptor, String> {
        serde_json::from_slice(bytes).map_err(|e| format!("unreadable descriptor: {e}"))
    }

    pub(crate) fn hasher(fed: &[u8]) -> Option<Descriptor> {
        (fed.len() <= HASHER_DESCRIPTOR_LIMIT).then(|| Descriptor::Hasher {
            fed: BASE64.encode(fed),
        })
    }

    pub(crate) fn hasher_fed(&self) -> Option<Vec<u8>> {
        match self {
            Descriptor::Hasher { fed } => BASE64.decode(fed).ok(),
            _ => None,
        }
    }
}

/// Join a path below a directory descriptor's path.
pub(crate) fn join(parent: &str, child: &str) -> String {
    if parent.is_empty() {
        child.to_string()
    } else {
        format!("{parent}/{child}")
    }
}

/// What a routed callback's native invocation did.
#[derive(Default)]
pub(crate) struct Outcome {
    /// The canonical reply bytes the transcript records.
    pub reply: Vec<u8>,
    /// `Some(descriptor)` if the call opened a native resource.
    pub opens: Option<Option<Descriptor>>,
    /// Whether the call closed its target handle.
    pub closes: bool,
    /// Other handles closed with the target.
    pub also_closes: Vec<u32>,
    /// The target's new descriptor, when its position moved.
    pub redescribes: Option<Option<Descriptor>>,
}

struct Ledger {
    transcript: Transcript,
    callbacks: AdmittedCallbacks,
    heaps: CasStore,
}

// Handle identifiers are globally allocated while no transcript is attached,
// so a sibling worker's handle never aliases an entry in this worker's tables.
static NEXT_HANDLE: AtomicU32 = AtomicU32::new(1);

/// The guest's result of a host call, as its recorded reply encodes it,
/// so replay can hand the guest the same value without the native call.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum GuestValue {
    /// The callback leaves the result unset (or returns a handle it opened).
    Unset,
    Null,
    Text(String),
    Bytes(Vec<u8>),
}

impl GuestValue {
    pub(crate) fn encode(&self) -> Vec<u8> {
        let (tag, body): (&[u8], &[u8]) = match self {
            GuestValue::Unset => return Vec::new(),
            GuestValue::Null => (b"n", b""),
            GuestValue::Text(text) => (b"s", text.as_bytes()),
            GuestValue::Bytes(bytes) => (b"b", bytes),
        };
        [tag, body].concat()
    }

    fn decode(reply: &[u8]) -> Result<GuestValue, String> {
        match reply.split_first() {
            None => Ok(GuestValue::Unset),
            Some((b'n', [])) => Ok(GuestValue::Null),
            Some((b's', text)) => String::from_utf8(text.to_vec())
                .map(GuestValue::Text)
                .map_err(|_| "recorded text reply is not UTF-8".to_string()),
            Some((b'b', bytes)) => Ok(GuestValue::Bytes(bytes.to_vec())),
            Some(_) => Err("recorded reply has no guest-value encoding".to_string()),
        }
    }

    /// Set the guest's result.
    ///
    /// # Safety
    /// `the` must be the machine running the host callback.
    unsafe fn set(&self, the: *mut XsMachine) {
        match self {
            GuestValue::Unset => return,
            GuestValue::Null => fxNull(the, &mut (*the).scratch),
            GuestValue::Text(text) => return set_result_string(the, text),
            GuestValue::Bytes(bytes) => {
                let mut bytes = bytes.clone();
                fxArrayBuffer(
                    the,
                    &mut (*the).scratch,
                    bytes.as_mut_ptr() as *mut _,
                    bytes.len() as i32,
                    bytes.len() as i32,
                );
            }
        }
        *(*the).frame.add(1) = (*the).scratch;
    }
}

struct Replaying {
    replay: Replay,
    suppressed: Vec<Seq>,
    stop: Option<ReplayStop>,
}

impl Replaying {
    fn note<T>(&mut self, result: Result<T, ReplayStop>) -> Result<T, String> {
        result.map_err(|stop| {
            let message = format!("Error: replay stopped: {stop:?}");
            self.stop.get_or_insert(stop);
            message
        })
    }
}

thread_local! {
    static LEDGER: RefCell<Option<Ledger>> = const { RefCell::new(None) };
    static REPLAY: RefCell<Option<Replaying>> = const { RefCell::new(None) };
    /// The descriptor of every handle open in this worker, used to compose a
    /// child's authority from its parent directory or database.
    static DESCRIPTORS: RefCell<HashMap<u32, Option<Descriptor>>> = RefCell::new(HashMap::new());
}

/// The descriptor of an open handle in this worker, if it has one.
pub(crate) fn descriptor(handle: u32) -> Option<Descriptor> {
    DESCRIPTORS.with(|d| d.borrow().get(&handle).cloned().flatten())
}

/// Every xsnap host callback, classified.
pub fn classified_callbacks() -> Vec<(&'static str, HostClass)> {
    let mut all = Vec::new();
    all.extend_from_slice(powers::fs::CLASSES);
    all.extend_from_slice(powers::crypto::CLASSES);
    all.extend_from_slice(powers::modules::CLASSES);
    all.extend_from_slice(powers::process::CLASSES);
    all.extend_from_slice(powers::sqlite::CLASSES);
    all
}

/// The admitted callback table for a retryable worker.
pub fn admitted_callbacks() -> AdmittedCallbacks {
    classified_callbacks()
        .into_iter()
        .fold(CallbackRegistry::new(), |r, (name, class)| {
            r.classify(name, class)
        })
        .admit(true)
        .expect("every xsnap host callback is admissible to a retryable worker")
}

/// Whether this worker's host calls go through a transcript.
pub fn attached() -> bool {
    LEDGER.with(|l| l.borrow().is_some())
}

/// What attaching re-seated.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Attachment {
    /// Handles rebuilt from their descriptors.
    pub reseated: Vec<u64>,
    /// Handles re-seated as broken, with the reason.
    pub broken: Vec<(u64, String)>,
    /// Why replay or retry must stay stopped, if it must.
    pub stopped: Option<RecoveryStop>,
}

impl Attachment {
    pub fn to_json(&self) -> String {
        let stopped = self.stopped.as_ref().map(|s| format!("{s:?}"));
        serde_json::json!({
            "reseated": self.reseated,
            "broken": self.broken,
            "stopped": stopped,
        })
        .to_string()
    }
}

/// Open the worker's transcript and re-seat every handle it records as
/// open, before any replay or delivery can use one. Refuses while this
/// worker holds native handles opened without a transcript, since their
/// ids mean nothing to the log. A transcript with no published snapshot
/// gets `heap` as its first, so deliveries can begin.
pub fn attach(
    path: &Path,
    worker: &str,
    powers: &HostPowers,
    heap: impl FnOnce() -> Result<Vec<u8>, String>,
) -> Result<Attachment, String> {
    if attached() {
        return Err("a host transcript is already attached".into());
    }
    if has_native_handles() {
        return Err("attach the host transcript before opening native handles".into());
    }
    let (mut transcript, _) = Transcript::open(path, TranscriptConfig::new(worker))
        .map_err(|e| format!("open host transcript: {e}"))?;
    let mut descriptors = HashMap::new();
    let report = transcript
        .reseat_handles(|record| {
            let descriptor = reseat(record, powers)?;
            descriptors.insert(record.handle as u32, Some(descriptor));
            Ok(())
        })
        .map_err(|e| format!("re-seat handles: {e}"))?;
    let heaps = CasStore::open(path.with_extension("heaps"))
        .map_err(|e| format!("open heap store: {e}"))?;
    if transcript
        .latest_snapshot()
        .map_err(|e| e.to_string())?
        .is_none()
    {
        transcript
            .publish_snapshot(&heaps, &heap()?, snapshot_meta())
            .map_err(|e| format!("publish initial heap: {e}"))?;
    }
    let stopped = transcript
        .recovery_gate()
        .map_err(|e| format!("recovery gate: {e}"))?
        .err();
    DESCRIPTORS.with(|d| *d.borrow_mut() = descriptors);
    LEDGER.with(|l| {
        *l.borrow_mut() = Some(Ledger {
            transcript,
            callbacks: admitted_callbacks(),
            heaps,
        })
    });
    Ok(Attachment {
        reseated: report.reseated,
        broken: report.broken,
        stopped,
    })
}

fn snapshot_meta() -> SnapshotMeta {
    SnapshotMeta {
        engine_signature: crate::SNAPSHOT_SIGNATURE.to_vec(),
        panic_on_reference_error: false,
    }
}

/// Commit any open delivery and publish the suspended heap, so the
/// transcript's watermark and handle descriptors agree with it.
pub(crate) fn publish_heap(heap: &[u8]) -> Result<(), String> {
    end_delivery(true);
    LEDGER.with(|l| match l.borrow_mut().as_mut() {
        Some(ledger) => ledger
            .transcript
            .publish_snapshot(&ledger.heaps, heap, snapshot_meta())
            .map(drop)
            .map_err(|e| format!("publish heap: {e}")),
        None => Ok(()),
    })
}

/// Detach the transcript, committing any open delivery.
pub fn detach() -> Option<Transcript> {
    end_delivery(true);
    LEDGER.with(|l| l.borrow_mut().take()).map(|l| l.transcript)
}

fn has_native_handles() -> bool {
    powers::fs::has_open_handles()
        || powers::sqlite::has_open_handles()
        || powers::crypto::has_open_handles()
}

/// Whether a supervised suspend must refuse: open native handles are only
/// suspendable once the transcript can rebuild them.
pub(crate) fn suspend_blocked() -> bool {
    !attached() && has_native_handles()
}

fn reseat(record: &HandleRecord, powers: &HostPowers) -> Result<Descriptor, String> {
    let descriptor = Descriptor::decode(record.descriptor.as_deref().unwrap_or_default())?;
    let handle = u32::try_from(record.handle).map_err(|_| "handle out of range".to_string())?;
    match &descriptor {
        Descriptor::Directory { .. } | Descriptor::Reader { .. } | Descriptor::Writer { .. } => {
            powers::fs::reseat(handle, &descriptor, powers)?
        }
        Descriptor::Database { .. } | Descriptor::Statement { .. } => {
            powers::sqlite::reseat(handle, &descriptor)?
        }
        Descriptor::Hasher { .. } => powers::crypto::reseat(handle, &descriptor)?,
    }
    Ok(descriptor)
}

/// Open a delivery's crank if a transcript is attached and none is open.
pub(crate) fn begin_delivery(inbound: &[u8]) {
    LEDGER.with(|l| {
        if let Some(ledger) = l.borrow_mut().as_mut() {
            if ledger.transcript.active_crank().is_none() {
                if let Err(e) = ledger.transcript.begin_crank(inbound) {
                    eprintln!("host transcript: begin crank: {e}");
                }
            }
        }
    });
}

/// Close the open delivery's crank: commit it, or abort it when the
/// delivery died or was metered out.
pub(crate) fn end_delivery(commit: bool) {
    LEDGER.with(|l| {
        if let Some(ledger) = l.borrow_mut().as_mut() {
            if ledger.transcript.active_crank().is_some() {
                let result = if commit {
                    // The frames went out as they were sent; the record is
                    // for replay, so nothing is left to release.
                    ledger.transcript.commit_crank().map(|frames| {
                        ledger
                            .transcript
                            .mark_released(frames.iter().map(|f| f.seq))
                    })
                } else {
                    ledger.transcript.abort_crank()
                };
                if let Err(e) = result {
                    eprintln!("host transcript: end crank: {e}");
                }
            }
        }
    });
}

/// Whether the worker should transmit an outbound frame it sent. Under a
/// transcript the frame is staged in the open delivery's crank. During
/// replay it must match the next recorded frame and is suppressed.
pub(crate) fn outbound(frame: &[u8]) -> bool {
    let replayed = REPLAY.with(|r| {
        let mut borrowed = r.borrow_mut();
        let replaying = borrowed.as_mut()?;
        let result = replaying.replay.send(frame);
        if let Ok(seq) = replaying.note(result) {
            replaying.suppressed.push(seq);
        }
        Some(())
    });
    if replayed.is_some() {
        return false;
    }
    LEDGER.with(|l| {
        if let Some(ledger) = l.borrow_mut().as_mut() {
            if ledger.transcript.active_crank().is_some() {
                if let Err(e) = ledger.transcript.stage_outbound(frame.to_vec()) {
                    eprintln!("host transcript: stage outbound: {e}");
                }
            }
        }
    });
    true
}

/// The heap of the latest snapshot the transcript at `path` published,
/// verified: the state a resumed worker is restored from before it
/// attaches and replays.
pub fn published_heap(path: &Path, worker: &str) -> Result<Option<Vec<u8>>, String> {
    let (transcript, _) = Transcript::open(path, TranscriptConfig::new(worker))
        .map_err(|e| format!("open host transcript: {e}"))?;
    let heaps = CasStore::open(path.with_extension("heaps"))
        .map_err(|e| format!("open heap store: {e}"))?;
    match transcript.latest_snapshot().map_err(|e| e.to_string())? {
        None => Ok(None),
        Some(_) => transcript
            .replay_plan(&heaps)
            .map(|plan| Some(plan.snapshot_bytes))
            .map_err(|e| format!("published heap: {e}")),
    }
}

/// What [`replay`] did.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Replayed {
    /// Committed deliveries replayed.
    pub cranks: usize,
    /// Recorded outbound frames the replayed deliveries sent, suppressed.
    pub suppressed: Vec<Seq>,
    /// The aborted delivery that ended the last incarnation, awaiting a
    /// retry or a discard.
    pub pending: Option<Vec<u8>>,
}

/// Replay the committed suffix after the published snapshot this worker
/// was restored from. The worker must have attached its transcript (which
/// re-seated its handles) and run nothing since. `deliver` runs one
/// delivery and reports whether it quiesced.
pub fn replay(mut deliver: impl FnMut(&[u8]) -> bool) -> Result<Replayed, String> {
    let replay = LEDGER.with(|l| match l.borrow().as_ref() {
        Some(ledger) => ledger
            .transcript
            .replay(&ledger.heaps)
            .map_err(|e| format!("replay: {e}")),
        None => Err("replay needs an attached host transcript".into()),
    })?;
    let pending = replay.pending().map(|c| c.inbound.clone());
    REPLAY.with(|r| {
        *r.borrow_mut() = Some(Replaying {
            replay,
            suppressed: Vec::new(),
            stop: None,
        })
    });
    let mut cranks = 0;
    let outcome = loop {
        let next = REPLAY.with(|r| r.borrow_mut().as_mut().and_then(|r| r.replay.next_crank()));
        let Some((crank, inbound)) = next else {
            break Ok(());
        };
        let verdict = if deliver(&inbound) {
            CrankVerdict::Quiesced
        } else {
            CrankVerdict::Panicked
        };
        let stop = REPLAY.with(|r| {
            let mut borrowed = r.borrow_mut();
            let replaying = borrowed.as_mut().expect("replaying");
            match replaying.stop.take() {
                Some(stop) => Some(stop),
                None => replaying.replay.end_crank(verdict).err(),
            }
        });
        if let Some(stop) = stop {
            break Err(format!("replay of crank {crank} stopped: {stop:?}"));
        }
        cranks += 1;
    };
    let replaying = REPLAY.with(|r| r.borrow_mut().take()).expect("replaying");
    outcome.map(|()| Replayed {
        cranks,
        suppressed: replaying.suppressed,
        pending,
    })
}

fn refusal(e: HostCallError) -> String {
    match e {
        HostCallError::BrokenHandle(h) => format!("Error: handle {h} was not re-seated"),
        HostCallError::UnknownHandle(h) => format!("Error: invalid handle {h}"),
        HostCallError::UnknownCallback(c) => format!("Error: unclassified host callback {c}"),
        HostCallError::Transcript(e) => format!("Error: host transcript: {e}"),
    }
}

/// Run a handle-table callback. `invoke` performs the native operation and
/// sets the guest's result; it does not run when the transcript refuses the
/// call. Returns the id of a handle the call opened, or the refusal the
/// caller reports to the guest. Closing (or finishing) a handle that was
/// re-seated as broken records its loss instead of invoking the adapter.
///
/// Coerce every guest argument before calling: `invoke` runs while the
/// ledger is borrowed and must not re-enter guest code.
pub(crate) fn call(
    callback: &str,
    target: Option<u32>,
    request: &[u8],
    invoke: impl FnOnce() -> Outcome,
) -> Result<Option<u32>, String> {
    if let Some(stopped) = REPLAY.with(|r| {
        r.borrow_mut().as_mut().map(|replaying| {
            let result = replaying
                .replay
                .host_call(callback, target.map(u64::from), request)
                .and_then(|_| {
                    Err(ReplayStop::Mismatch {
                        crank: 0,
                        detail: format!("{callback} has no replayable reply encoding"),
                    })
                });
            replaying.note::<()>(result).unwrap_err()
        })
    }) {
        return Err(stopped);
    }
    call_live(callback, target, request, invoke)
}

/// [`call`] for a callback whose reply is a [`GuestValue`] encoding of the
/// guest's result. During replay the recorded reply sets the result (and a
/// recorded handle is returned to the guest) without running `invoke`, and
/// this returns `Ok(None)`, so the caller builds no native resource.
///
/// # Safety
/// `the` must be the machine running the host callback.
pub(crate) unsafe fn call_in(
    the: *mut XsMachine,
    callback: &str,
    target: Option<u32>,
    request: &[u8],
    invoke: impl FnOnce() -> Outcome,
) -> Result<Option<u32>, String> {
    let replayed = REPLAY.with(|r| {
        r.borrow_mut().as_mut().map(|replaying| {
            let result = replaying
                .replay
                .host_call(callback, target.map(u64::from), request);
            replaying.note(result)
        })
    });
    match replayed {
        None => call_live(callback, target, request, invoke),
        Some(Err(message)) => Err(message),
        Some(Ok(HostReply::Deferred)) => Ok(None),
        Some(Ok(HostReply::Reply { reply, opened })) => {
            let value = GuestValue::decode(&reply).map_err(|detail| {
                REPLAY.with(|r| {
                    let mut borrowed = r.borrow_mut();
                    let replaying = borrowed.as_mut().expect("replaying");
                    replaying
                        .note::<()>(Err(ReplayStop::Mismatch { crank: 0, detail }))
                        .unwrap_err()
                })
            })?;
            value.set(the);
            if let Some(handle) = opened {
                fxInteger(the, &mut (*the).scratch, handle as i32);
                *(*the).frame.add(1) = (*the).scratch;
            }
            Ok(None)
        }
    }
}

fn call_live(
    callback: &str,
    target: Option<u32>,
    request: &[u8],
    invoke: impl FnOnce() -> Outcome,
) -> Result<Option<u32>, String> {
    let mut invoke = Some(invoke);
    let mut done: Option<Outcome> = None;
    let routed = LEDGER.with(|l| {
        let mut borrowed = l.borrow_mut();
        let ledger = borrowed.as_mut()?;
        let result = ledger.transcript.host_call(
            &ledger.callbacks,
            callback,
            target.map(u64::from),
            request,
            |_| {
                let outcome = invoke.take().expect("invoked once")();
                let host = HostOutcome {
                    reply: outcome.reply.clone(),
                    opens: outcome
                        .opens
                        .as_ref()
                        .map(|d| d.as_ref().map(Descriptor::encode)),
                    closes: outcome.closes,
                    also_closes: outcome.also_closes.iter().map(|h| u64::from(*h)).collect(),
                    redescribes: outcome
                        .redescribes
                        .as_ref()
                        .map(|d| d.as_ref().map(Descriptor::encode)),
                };
                done = Some(outcome);
                host
            },
        );
        Some(match result {
            Err(HostCallError::BrokenHandle(h)) if closing(callback) => {
                Err(match ledger.transcript.acknowledge_loss(h) {
                    Ok(()) => format!("Error: handle {h} was not re-seated; its loss is recorded"),
                    Err(e) => refusal(HostCallError::Transcript(e)),
                })
            }
            Err(e) => Err(refusal(e)),
            Ok(HostReply::Reply { opened, .. }) => opened
                .map(|h| u32::try_from(h).map_err(|_| "Error: handle id out of range".to_string()))
                .transpose(),
            Ok(HostReply::Deferred) => Ok(None),
        })
    });
    let opened = match routed {
        Some(result) => result?,
        None => {
            let outcome = invoke.take().expect("invoked once")();
            let opened = outcome
                .opens
                .is_some()
                .then(|| NEXT_HANDLE.fetch_add(1, Ordering::SeqCst));
            done = Some(outcome);
            opened
        }
    };
    if let Some(outcome) = done {
        DESCRIPTORS.with(|d| {
            let mut d = d.borrow_mut();
            if let (Some(h), Some(descriptor)) = (opened, outcome.opens) {
                d.insert(h, descriptor);
            }
            if let (Some(h), Some(descriptor)) = (target, outcome.redescribes) {
                d.insert(h, descriptor);
            }
            if outcome.closes {
                d.remove(&target.unwrap_or_default());
            }
            for h in outcome.also_closes {
                d.remove(&h);
            }
        });
    }
    Ok(opened)
}

fn closing(callback: &str) -> bool {
    matches!(
        callback,
        "closeReader"
            | "closeWriter"
            | "closeDir"
            | "sqliteClose"
            | "sqliteStmtFinalize"
            | "sha256Finish"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_host_callback_is_classified_by_its_guest_name() {
        for (classes, callbacks) in [
            (powers::fs::CLASSES, powers::fs::CALLBACKS),
            (powers::crypto::CLASSES, powers::crypto::CALLBACKS),
            (powers::modules::CLASSES, powers::modules::CALLBACKS),
            (powers::process::CLASSES, powers::process::CALLBACKS),
            (powers::sqlite::CLASSES, powers::sqlite::CALLBACKS),
        ] {
            assert_eq!(classes.len(), callbacks.len());
        }
        let admitted = admitted_callbacks();
        crate::ensure_shared_cluster();
        let machine = crate::Machine::new(&crate::DEFAULT_CREATION, "classes").unwrap();
        let mut host_powers = HostPowers::new();
        machine.register_powers(&mut host_powers);
        for (name, class) in classified_callbacks() {
            assert_eq!(admitted.class(name), Some(class));
            assert_eq!(
                machine.eval(&format!("typeof {name}")),
                Some(crate::JsValue::String("function".into())),
                "{name} is not a registered host function"
            );
        }
    }
}
