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

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicU32, Ordering};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde::{Deserialize, Serialize};
use slot_machine_transcript::{
    AdmittedCallbacks, CallbackRegistry, Cas, HandleRecord, HostCallError, HostClass, HostOutcome,
    HostReply, RecoveryStop, SnapshotMeta, Transcript, TranscriptConfig,
};

use crate::powers::{self, HostPowers};

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
    heaps: Cas,
    /// Why a crank failed to commit, once one has: the heap now runs ahead
    /// of the log, so no later snapshot may be published against it.
    lost_crank: Option<String>,
}

// Handle identifiers are globally allocated while no transcript is attached,
// so a sibling worker's handle never aliases an entry in this worker's tables.
static NEXT_HANDLE: AtomicU32 = AtomicU32::new(1);

thread_local! {
    static LEDGER: RefCell<Option<Ledger>> = const { RefCell::new(None) };
    /// Set while [`call`] is inside the transcript. An `fxAbort` in the
    /// native operation longjmps over that frame and leaves this set, so the
    /// crank's end knows a host call was abandoned mid-flight.
    static CALLING: Cell<bool> = const { Cell::new(false) };
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
    CALLING.with(Cell::get) || LEDGER.with(|l| l.borrow().is_some())
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
///
/// Descriptors record each handle's position as of the latest committed
/// crank, so re-seating is only sound on the heap of the latest published
/// snapshot with no committed host calls past its watermark. `resumed` is
/// the hash of the heap the worker resumed from, when it resumed one:
/// attaching refuses when it is not the published snapshot, refuses when
/// it is absent though the transcript has published one, and refuses
/// while committed host calls lie past the watermark, since nothing yet
/// replays them.
pub fn attach(
    path: &Path,
    worker: &str,
    resumed: Option<&str>,
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
    let snapshot = transcript.latest_snapshot().map_err(|e| e.to_string())?;
    match (resumed, &snapshot) {
        (Some(resumed), Some(snapshot)) if snapshot.hash == resumed => {}
        (Some(resumed), Some(snapshot)) => {
            return Err(format!(
                "resumed heap {resumed} is not the transcript's published snapshot {}",
                snapshot.hash
            ))
        }
        (Some(resumed), None) => {
            return Err(format!(
                "resumed heap {resumed}, but the transcript has no published snapshot"
            ))
        }
        (None, Some(snapshot)) => {
            return Err(format!(
                "the transcript's published snapshot is {}, but no resumed heap was named; \
                 re-seating is only sound on that heap",
                snapshot.hash
            ))
        }
        (None, None) => {}
    }
    let unreplayed = transcript
        .host_replay()
        .map_err(|e| format!("host replay: {e}"))?
        .cranks();
    if let Some(crank) = unreplayed.first() {
        return Err(format!(
            "committed host calls from crank {crank} lie past the snapshot watermark \
             {}; re-seating would run handles ahead of the heap",
            snapshot.as_ref().map_or(0, |s| s.watermark_crank)
        ));
    }
    let heaps =
        Cas::open(path.with_extension("heaps")).map_err(|e| format!("open heap store: {e}"))?;
    // Re-seating registers native handles as it goes, so a failure from
    // here on drops them all: `has_native_handles` refused entry, so every
    // open handle is one this attach registered, and none may outlive a
    // refused attach to run unrecorded.
    let mut descriptors = HashMap::new();
    let finish = (|| {
        let report = transcript
            .reseat_handles(|record| {
                let descriptor = reseat(record, powers)?;
                let handle =
                    u32::try_from(record.handle).map_err(|_| "handle out of range".to_string())?;
                descriptors.insert(handle, Some(descriptor));
                Ok(())
            })
            .map_err(|e| format!("re-seat handles: {e}"))?;
        if snapshot.is_none() {
            transcript
                .publish_snapshot(&heaps, &heap()?, snapshot_meta())
                .map_err(|e| format!("publish initial heap: {e}"))?;
        }
        let stopped = transcript
            .recovery_gate()
            .map_err(|e| format!("recovery gate: {e}"))?
            .err();
        Ok::<_, String>((report, stopped))
    })();
    let (report, stopped) = match finish {
        Ok(done) => done,
        Err(e) => {
            drop_native_handles();
            return Err(e);
        }
    };
    DESCRIPTORS.with(|d| *d.borrow_mut() = descriptors);
    LEDGER.with(|l| {
        *l.borrow_mut() = Some(Ledger {
            transcript,
            callbacks: admitted_callbacks(),
            heaps,
            lost_crank: None,
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
    end_delivery(true)?;
    LEDGER.with(|l| match l.borrow_mut().as_mut() {
        Some(Ledger {
            lost_crank: Some(e),
            ..
        }) => Err(format!(
            "publish heap: an earlier crank did not commit: {e}"
        )),
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
    if let Err(e) = end_delivery(true) {
        eprintln!("{e}");
    }
    LEDGER.with(|l| l.borrow_mut().take()).map(|l| l.transcript)
}

fn drop_native_handles() {
    powers::fs::drop_open_handles();
    powers::sqlite::drop_open_handles();
    powers::crypto::drop_open_handles();
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

/// The inbound record of a crank opened by a host call made outside any
/// delivery: promise jobs a resumed heap carried across a suspend taken
/// mid-pump run before the next delivery begins.
const PENDING_JOBS: &[u8] = b"pending-promise-jobs";

/// Open a delivery's crank if a transcript is attached and none is open.
/// An error means the transcript refused the crank (backpressure, say), so
/// the caller must refuse the delivery rather than run it unrecorded.
pub(crate) fn begin_delivery(inbound: &[u8]) -> Result<(), String> {
    if CALLING.with(Cell::get) {
        return Err("host transcript: a host call re-entered the ledger".into());
    }
    LEDGER.with(|l| {
        let mut ledger = l.borrow_mut();
        let Some(ledger) = ledger.as_mut() else {
            return Ok(());
        };
        // The heap already runs ahead of the log: recording more cranks on
        // top of the gap would only grow a log that cannot be replayed.
        if let Some(lost) = &ledger.lost_crank {
            return Err(format!("host transcript: a crank was lost: {lost}"));
        }
        if ledger.transcript.active_crank().is_some() {
            return Ok(());
        }
        ledger
            .transcript
            .begin_crank(inbound)
            .map(drop)
            .map_err(|e| format!("host transcript: begin crank: {e}"))
    })
}

/// Close the open delivery's crank: commit it, or abort it when the
/// delivery died or was metered out. An error means the crank did not
/// commit, so its host calls are not in the log: a caller that goes on to
/// snapshot must not.
pub(crate) fn end_delivery(commit: bool) -> Result<(), String> {
    // A host call an `fxAbort` abandoned left its crank half-recorded: it
    // must not commit.
    let abandoned = CALLING.with(|c| c.replace(false));
    let commit = commit && !abandoned;
    LEDGER.with(|l| {
        let mut ledger = l.borrow_mut();
        let Some(ledger) = ledger.as_mut() else {
            return Ok(());
        };
        if ledger.transcript.active_crank().is_none() {
            return Ok(());
        }
        let redescriptions = powers::crypto::take_redescriptions();
        let result = if commit {
            redescriptions
                .into_iter()
                .try_for_each(|(handle, descriptor)| {
                    ledger.transcript.redescribe(
                        u64::from(handle),
                        descriptor.as_ref().map(Descriptor::encode),
                    )
                })
                .and_then(|()| ledger.transcript.commit_crank().map(drop))
                // A crank whose descriptors cannot be staged must
                // not commit without them.
                .or_else(|e| match ledger.transcript.active_crank() {
                    Some(_) => ledger.transcript.abort_crank().and(Err(e)),
                    None => Err(e),
                })
        } else {
            ledger.transcript.abort_crank()
        };
        result.map_err(|e| {
            let e = format!("host transcript: end crank: {e}");
            if commit {
                ledger.lost_crank.get_or_insert_with(|| e.clone());
            }
            e
        })
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
/// A call made outside any delivery opens a crank of its own ([`PENDING_JOBS`]),
/// which the worker loop commits or aborts at the crank's end like any other.
///
/// Coerce every guest argument before calling: `invoke` runs while the
/// ledger is borrowed and must not re-enter guest code.
pub(crate) fn call(
    callback: &str,
    target: Option<u32>,
    request: &[u8],
    invoke: impl FnOnce() -> Outcome,
) -> Result<Option<u32>, String> {
    begin_delivery(PENDING_JOBS).map_err(|e| format!("Error: {e}"))?;
    let mut invoke = Some(invoke);
    let mut done: Option<Outcome> = None;
    let routed = LEDGER.with(|l| {
        if l.borrow().is_none() {
            return None;
        }
        // `invoke` sets the guest's result, which allocates on the XS heap.
        // An `fxAbort` there longjmps over this frame without running
        // destructors, so a `RefMut` held across it would stay borrowed and
        // turn the crank-end abort into a `BorrowMutError` panic. Reach the
        // ledger through the cell's pointer instead, and mark the window with
        // `CALLING` so a stranded call is seen and nothing re-borrows it.
        // SAFETY: the ledger is present (checked above), no borrow is live,
        // and while `CALLING` is set every other entry point refuses or
        // answers without borrowing, so this is the only reference.
        let ledger = unsafe { (*l.as_ptr()).as_mut()? };
        CALLING.with(|c| c.set(true));
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
        CALLING.with(|c| c.set(false));
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
    fn every_descriptor_round_trips_through_its_encoding() {
        let fed = vec![0u8, 1, 0xff, b'"', b'\\'];
        let descriptors = [
            Descriptor::Directory {
                base: Base::Token("test".into()),
                path: String::new(),
            },
            Descriptor::Reader {
                base: Base::Token("t\u{e9}st".into()),
                path: "a/b \"c\".txt".into(),
                position: u64::MAX,
            },
            Descriptor::Writer {
                base: Base::Ambient("/tmp/x".into()),
                path: "w.log".into(),
                position: 0,
            },
            Descriptor::Database {
                path: ":memory:".into(),
            },
            Descriptor::Statement {
                database: u32::MAX,
                sql: "SELECT ?1, ',' FROM t".into(),
            },
            Descriptor::hasher(&fed).unwrap(),
            Descriptor::hasher(&[]).unwrap(),
        ];
        for descriptor in descriptors {
            assert_eq!(Descriptor::decode(&descriptor.encode()).unwrap(), descriptor);
        }
        assert_eq!(Descriptor::hasher(&fed).unwrap().hasher_fed(), Some(fed));
        let limit = vec![7u8; HASHER_DESCRIPTOR_LIMIT];
        assert_eq!(Descriptor::hasher(&limit).unwrap().hasher_fed(), Some(limit));
        assert!(Descriptor::hasher(&vec![7u8; HASHER_DESCRIPTOR_LIMIT + 1]).is_none());
        assert!(Descriptor::decode(b"{\"kind\":\"reader\"}").is_err());
    }

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
