//! The Slot Machine per-worker write-ahead transcript
//! (designs/ironhorse-panic.md § Slot Machine per-worker write-ahead
//! transcript).
//!
//! Each Endor worker owns one SQLite database,
//! `<endo-dir>/workers/<handle>/transcript.sqlite` ([`transcript_path`]),
//! holding:
//!
//! - `snapshot`: published CAS snapshot identities with the transcript
//!   watermark each covers, the engine/callback-table signature, and the
//!   `panic-on-reference-error` setting pinned for replay;
//! - `crank`: monotonic crank ids with `started` / `committed` / `aborted`
//!   state, the inbound event that started each, and its starting epoch;
//! - `event`: inbound and outbound rows with monotonic sequence numbers that
//!   are never reused, so `<worker>:<seq>` is a stable idempotency key.
//!
//! The supervisor is the only writer, and the crank protocol is the design's:
//!
//! 1. [`Transcript::begin_crank`] durably appends the inbound delivery and a
//!    `started` crank row before the guest runs.
//! 2. [`Transcript::stage_outbound`] holds outbound frames as pending rows
//!    that nothing outside the vat can observe.
//! 3. [`Transcript::commit_crank`] writes every pending row and marks the
//!    crank committed in one transaction. Only its successful return makes
//!    the frames releasable, so the release commit is one transaction per
//!    crank, never one per frame.
//! 4. [`Transcript::abort_crank`] discards pending rows. No outbound effect of
//!    an aborted crank is ever written, so none can be released.
//!
//! **Backend discipline: XS/CAS watermark ordering** (§ Backend selection and
//! snapshot ordering (Q3)). A heap snapshot is a content-addressed blob
//! written outside any transaction, so it cannot join a SQLite commit.
//! [`Transcript::publish_snapshot`] therefore orders the steps: the
//! transcript's cranks are already committed; the blob is written, synced,
//! renamed, and its directory synced ([`CasStore::write_blob`]); only then is
//! its hash recorded with the exact committed watermark it covers; and only
//! after that record is durable may [`Transcript::compact`] drop the covered
//! prefix. A crash anywhere leaves the previous published snapshot and its
//! full replay suffix. A published snapshot never covers an uncommitted
//! crank, and the suffix after it survives until a newer one is published.
//!
//! **Durability** (§ Single-vat durability cost (Q7)): WAL with
//! `synchronous=FULL`, never `NORMAL`, because effects are released after
//! COMMIT and `NORMAL` may forget a recent commit on power loss. Per crank the
//! transcript pays one admission transaction and one release transaction;
//! acknowledgements of released frames ride the next transaction instead of
//! paying their own. Outbound events per crank are bounded by
//! [`TranscriptLimits`] and refused, not truncated, past the bound.
//!
//! **Storage failures** (§ Transcript storage failures (Q6)) surface as a
//! supervisor-owned [`TranscriptFault`], never as an engine panic. A fault
//! poisons the transcript: it refuses admission, commit, and snapshot
//! publication until the supervisor drops it and reopens, and reopening
//! reconciles to the last proven durable state. A `started` crank with no
//! proven commit is recovered as aborted with its inbound row kept for
//! diagnosis and explicit retry; the transcript never re-drives it.
//!
//! The deterministic fault-injection seam that drives the crash matrix is
//! [`FaultPlan`].

mod cas;
mod fault;

use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, OpenFlags, OptionalExtension};

pub use cas::{blob_hash, sync_dir, CasError, CasStore};
pub use fault::{FaultMode, FaultPlan};

/// The schema version this crate writes.
pub const SCHEMA_VERSION: i64 = 1;

/// The per-worker transcript database path.
pub fn transcript_path(endo_dir: &Path, worker_handle: &str) -> PathBuf {
    endo_dir
        .join("workers")
        .join(worker_handle)
        .join("transcript.sqlite")
}

/// A crank id. Monotonic per worker and never reused.
pub type CrankId = u64;
/// An event sequence number. Monotonic per worker and never reused.
pub type Seq = u64;

/// The durability operation a [`TranscriptFault`] interrupted.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Operation {
    Open,
    Recover,
    Admit,
    Commit,
    Abort,
    AcknowledgeRelease,
    WriteSnapshotBlob,
    PublishSnapshot,
    Compact,
    Read,
}

/// A transcript storage failure, owned by the supervisor rather than the
/// engine: it is not a `PanicKind` (§ Transcript storage failures (Q6)).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TranscriptFault {
    /// The worker whose transcript failed.
    pub worker: String,
    /// The crank in flight, if any.
    pub crank: Option<CrankId>,
    /// The event sequence involved, if known.
    pub seq: Option<Seq>,
    /// The interrupted operation.
    pub operation: Operation,
    /// SQLite's primary result code, when the failure came from SQLite.
    pub sqlite_primary: Option<i32>,
    /// SQLite's extended result code, when the failure came from SQLite.
    pub sqlite_extended: Option<i32>,
    /// Whether the transaction's outcome is known. `false` means COMMIT
    /// itself failed: the change may or may not be durable, and only a
    /// reopen can tell.
    pub commit_outcome_known: bool,
    /// Human-readable detail.
    pub detail: String,
}

impl std::fmt::Display for TranscriptFault {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "transcript fault in worker {} during {:?} (crank {:?}, seq {:?}, sqlite {:?}/{:?}, outcome {}): {}",
            self.worker,
            self.operation,
            self.crank,
            self.seq,
            self.sqlite_primary,
            self.sqlite_extended,
            if self.commit_outcome_known { "known" } else { "unknown" },
            self.detail
        )
    }
}

/// A transcript operation's failure.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TranscriptError {
    /// A storage failure just happened; the transcript is now poisoned.
    Fault(TranscriptFault),
    /// An earlier storage failure poisoned the transcript; reopen to
    /// reconcile before serving again.
    Poisoned(TranscriptFault),
    /// A per-crank bound would be exceeded. The crank is still active; the
    /// supervisor decides whether to abort it.
    Backpressure(String),
    /// The caller broke the crank protocol, or replay found the durable
    /// state unusable (a missing or corrupt published snapshot, or a
    /// resume under a different pinned configuration).
    Protocol(String),
}

impl std::fmt::Display for TranscriptError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TranscriptError::Fault(fault) => write!(f, "{fault}"),
            TranscriptError::Poisoned(fault) => {
                write!(f, "transcript poisoned by earlier fault: {fault}")
            }
            TranscriptError::Backpressure(s) => write!(f, "transcript backpressure: {s}"),
            TranscriptError::Protocol(s) => write!(f, "transcript protocol error: {s}"),
        }
    }
}

impl std::error::Error for TranscriptError {}

/// Per-crank admission bounds (§ Single-vat durability cost (Q7): "bound
/// admitted event bytes ... and apply backpressure before exceeding those
/// limits").
#[derive(Clone, Copy, Debug)]
pub struct TranscriptLimits {
    /// Most outbound events one crank may stage.
    pub max_outbound_events: usize,
    /// Most outbound payload bytes one crank may stage.
    pub max_outbound_bytes: usize,
    /// Largest inbound payload admitted.
    pub max_inbound_bytes: usize,
}

impl Default for TranscriptLimits {
    fn default() -> Self {
        TranscriptLimits {
            max_outbound_events: 4096,
            max_outbound_bytes: 16 << 20,
            max_inbound_bytes: 16 << 20,
        }
    }
}

/// How to open a transcript.
#[derive(Clone, Debug)]
pub struct TranscriptConfig {
    /// The worker's stable identity, pinned at creation and part of every
    /// idempotency key.
    pub worker: String,
    /// Per-crank bounds.
    pub limits: TranscriptLimits,
    /// Route SQLite's file operations through this fault plan's VFS.
    pub fault: Option<FaultPlan>,
}

impl TranscriptConfig {
    /// Default limits, no fault injection.
    pub fn new(worker: impl Into<String>) -> TranscriptConfig {
        TranscriptConfig {
            worker: worker.into(),
            limits: TranscriptLimits::default(),
            fault: None,
        }
    }

    /// Route SQLite's file operations through `plan`.
    pub fn with_fault_plan(mut self, plan: FaultPlan) -> TranscriptConfig {
        self.fault = Some(plan);
        self
    }
}

/// The replay-relevant configuration a snapshot pins.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SnapshotMeta {
    /// Engine and callback-table signature the snapshot was taken under.
    pub engine_signature: Vec<u8>,
    /// Whether `panic-on-reference-error` was in force.
    pub panic_on_reference_error: bool,
}

/// A published snapshot record.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SnapshotRecord {
    /// Monotonic snapshot epoch.
    pub epoch: u64,
    /// The CAS blob hash.
    pub hash: String,
    /// The last committed crank the snapshot covers (0 before any crank).
    pub watermark_crank: CrankId,
    /// The last event sequence of a committed crank the snapshot covers.
    pub watermark_seq: Seq,
    /// The pinned replay configuration.
    pub meta: SnapshotMeta,
}

/// An outbound frame the supervisor may release, carrying its stable
/// identity so a receiver can drop a duplicate re-release.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReleasableFrame {
    /// The event sequence.
    pub seq: Seq,
    /// The crank that committed it.
    pub crank: CrankId,
    /// `<worker>:<seq>`, stable across restarts.
    pub idempotency_key: String,
    /// The frame bytes.
    pub payload: Vec<u8>,
}

/// A committed crank to re-execute on replay.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommittedCrank {
    /// The crank id.
    pub crank: CrankId,
    /// The inbound delivery.
    pub inbound: Vec<u8>,
    /// The outbound frames it committed, in sequence order, for comparison
    /// against the replayed guest's output.
    pub outbound: Vec<(Seq, Vec<u8>)>,
}

/// A crank that never committed, kept for diagnosis and explicit retry.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AbortedCrank {
    /// The crank id.
    pub crank: CrankId,
    /// The inbound event's sequence.
    pub inbound_seq: Seq,
    /// The inbound delivery.
    pub inbound: Vec<u8>,
}

/// What reopening found.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Recovery {
    /// `started` cranks with no proven commit, now recorded as aborted.
    pub in_doubt: Vec<AbortedCrank>,
    /// Committed frames not yet acknowledged as released. Re-release them;
    /// receivers drop duplicates by sequence.
    pub unreleased: usize,
}

/// Everything needed to rebuild the worker's latest committed state.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReplayPlan {
    /// The snapshot to restore.
    pub snapshot: SnapshotRecord,
    /// The verified snapshot bytes.
    pub snapshot_bytes: Vec<u8>,
    /// Committed cranks after the snapshot's watermark, in order.
    pub cranks: Vec<CommittedCrank>,
}

/// Transaction counters for durability accounting.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TranscriptStats {
    /// Admission transactions committed.
    pub admissions: u64,
    /// Release (crank-commit) transactions committed.
    pub releases: u64,
    /// Abort transactions committed.
    pub aborts: u64,
    /// Snapshot-publication transactions committed.
    pub publications: u64,
    /// Compaction transactions committed.
    pub compactions: u64,
    /// Standalone acknowledgement flushes committed.
    pub ack_flushes: u64,
}

struct ActiveCrank {
    crank: CrankId,
    pending: Vec<Vec<u8>>,
    pending_bytes: usize,
}

/// One worker's write-ahead transcript. See the crate documentation.
pub struct Transcript {
    conn: Connection,
    worker: String,
    limits: TranscriptLimits,
    active: Option<ActiveCrank>,
    pending_acks: Vec<Seq>,
    poisoned: Option<TranscriptFault>,
    stats: TranscriptStats,
}

fn sqlite_codes(e: &rusqlite::Error) -> (Option<i32>, Option<i32>) {
    match e {
        rusqlite::Error::SqliteFailure(err, _) => (Some(err.code as i32), Some(err.extended_code)),
        _ => (None, None),
    }
}

impl Transcript {
    /// Open (creating if absent) the transcript at `path` and reconcile it
    /// to its last proven durable state.
    pub fn open(
        path: impl AsRef<Path>,
        config: TranscriptConfig,
    ) -> Result<(Transcript, Recovery), TranscriptError> {
        let path = path.as_ref();
        let worker = config.worker.clone();
        let open_fault = |detail: String, e: Option<&rusqlite::Error>| {
            let (p, x) = e.map(sqlite_codes).unwrap_or((None, None));
            TranscriptError::Fault(TranscriptFault {
                worker: worker.clone(),
                crank: None,
                seq: None,
                operation: Operation::Open,
                sqlite_primary: p,
                sqlite_extended: x,
                commit_outcome_known: true,
                detail,
            })
        };
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| open_fault(format!("create {}: {e}", parent.display()), None))?;
        }
        let flags = OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_CREATE
            | OpenFlags::SQLITE_OPEN_NO_MUTEX;
        let conn = match &config.fault {
            Some(plan) => Connection::open_with_flags_and_vfs(path, flags, plan.vfs_name()),
            None => Connection::open_with_flags(path, flags),
        }
        .map_err(|e| open_fault(format!("open {}: {e}", path.display()), Some(&e)))?;
        // The supervisor is the only writer: hold the file exclusively (the
        // heap store's discipline), which also keeps the WAL index in
        // process memory rather than a `-shm` file, and choose WAL with FULL
        // synchronous durability.
        let setup = || -> rusqlite::Result<String> {
            conn.query_row("PRAGMA locking_mode=EXCLUSIVE", [], |r| {
                r.get::<_, String>(0)
            })?;
            let mode: String = conn.query_row("PRAGMA journal_mode=WAL", [], |r| r.get(0))?;
            conn.execute_batch("PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;")?;
            Ok(mode)
        };
        let mode = setup().map_err(|e| open_fault(format!("configure: {e}"), Some(&e)))?;
        if !mode.eq_ignore_ascii_case("wal") {
            return Err(open_fault(format!("journal_mode is {mode}, not wal"), None));
        }
        let mut t = Transcript {
            conn,
            worker: config.worker,
            limits: config.limits,
            active: None,
            pending_acks: Vec::new(),
            poisoned: None,
            stats: TranscriptStats::default(),
        };
        t.init_schema()?;
        let recovery = t.recover()?;
        Ok((t, recovery))
    }

    fn fault(
        &mut self,
        operation: Operation,
        crank: Option<CrankId>,
        known: bool,
        e: &rusqlite::Error,
    ) -> TranscriptError {
        let (p, x) = sqlite_codes(e);
        self.poison(TranscriptFault {
            worker: self.worker.clone(),
            crank,
            seq: None,
            operation,
            sqlite_primary: p,
            sqlite_extended: x,
            commit_outcome_known: known,
            detail: e.to_string(),
        })
    }

    fn poison(&mut self, fault: TranscriptFault) -> TranscriptError {
        if self.poisoned.is_none() {
            self.poisoned = Some(fault.clone());
        }
        TranscriptError::Fault(fault)
    }

    fn check_healthy(&self) -> Result<(), TranscriptError> {
        match &self.poisoned {
            Some(f) => Err(TranscriptError::Poisoned(f.clone())),
            None => Ok(()),
        }
    }

    /// The fault that poisoned this transcript, if any.
    pub fn poisoned(&self) -> Option<&TranscriptFault> {
        self.poisoned.as_ref()
    }

    /// The worker identity.
    pub fn worker(&self) -> &str {
        &self.worker
    }

    /// Transaction counters since open.
    pub fn stats(&self) -> TranscriptStats {
        self.stats
    }

    /// The crank in flight, if any.
    pub fn active_crank(&self) -> Option<CrankId> {
        self.active.as_ref().map(|a| a.crank)
    }

    /// Run `body` in one transaction and commit it, distinguishing a failure
    /// before COMMIT (outcome known: nothing durable) from a failure of
    /// COMMIT itself (outcome unknown).
    fn transact<T>(
        &mut self,
        operation: Operation,
        crank: Option<CrankId>,
        body: impl FnOnce(&rusqlite::Transaction<'_>) -> rusqlite::Result<T>,
    ) -> Result<T, TranscriptError> {
        let result = (|| -> Result<T, (bool, rusqlite::Error)> {
            let tx = self.conn.transaction().map_err(|e| (true, e))?;
            let value = body(&tx).map_err(|e| (true, e))?;
            tx.commit().map_err(|e| (false, e))?;
            Ok(value)
        })();
        result.map_err(|(known, e)| self.fault(operation, crank, known, &e))
    }

    fn init_schema(&mut self) -> Result<(), TranscriptError> {
        let worker = self.worker.clone();
        let existing = self.transact(Operation::Open, None, |tx| {
            tx.execute_batch(
                "CREATE TABLE IF NOT EXISTS meta (
                     key TEXT PRIMARY KEY,
                     value TEXT NOT NULL
                 ) STRICT;
                 CREATE TABLE IF NOT EXISTS snapshot (
                     epoch INTEGER PRIMARY KEY AUTOINCREMENT,
                     hash TEXT NOT NULL,
                     engine_signature BLOB NOT NULL,
                     panic_on_reference_error INTEGER NOT NULL,
                     watermark_crank INTEGER NOT NULL,
                     watermark_seq INTEGER NOT NULL
                 ) STRICT;
                 CREATE TABLE IF NOT EXISTS crank (
                     crank_id INTEGER PRIMARY KEY AUTOINCREMENT,
                     inbound_seq INTEGER,
                     start_epoch INTEGER NOT NULL,
                     state TEXT NOT NULL CHECK (state IN ('started', 'committed', 'aborted'))
                 ) STRICT;
                 CREATE TABLE IF NOT EXISTS event (
                     seq INTEGER PRIMARY KEY AUTOINCREMENT,
                     crank_id INTEGER NOT NULL REFERENCES crank (crank_id),
                     kind TEXT NOT NULL CHECK (kind IN ('inbound', 'outbound', 'host-request', 'host-reply')),
                     payload BLOB NOT NULL,
                     released INTEGER NOT NULL DEFAULT 0
                 ) STRICT;
                 CREATE INDEX IF NOT EXISTS event_by_crank ON event (crank_id, seq);
                 CREATE INDEX IF NOT EXISTS crank_by_state ON crank (state, crank_id);",
            )?;
            let existing: Option<String> = tx
                .query_row("SELECT value FROM meta WHERE key = 'worker'", [], |r| r.get(0))
                .optional()?;
            if existing.is_none() {
                tx.execute(
                    "INSERT INTO meta (key, value) VALUES ('worker', ?1), ('schema_version', ?2)",
                    params![worker, SCHEMA_VERSION.to_string()],
                )?;
            }
            Ok(existing)
        })?;
        if let Some(existing) = existing {
            if existing != self.worker {
                return Err(TranscriptError::Protocol(format!(
                    "transcript belongs to worker {existing}, not {}",
                    self.worker
                )));
            }
        }
        Ok(())
    }

    /// Resolve every `started` crank to `aborted`: without a proven commit,
    /// none of its effects may be released, and the transcript never
    /// re-drives it on its own.
    fn recover(&mut self) -> Result<Recovery, TranscriptError> {
        let in_doubt = self
            .cranks_in_state("started")
            .map_err(|e| self.fault(Operation::Recover, None, true, &e))?;
        if !in_doubt.is_empty() {
            self.transact(Operation::Recover, None, |tx| {
                tx.execute(
                    "UPDATE crank SET state = 'aborted' WHERE state = 'started'",
                    [],
                )
            })?;
        }
        let unreleased = self.releasable()?.len();
        Ok(Recovery {
            in_doubt,
            unreleased,
        })
    }

    fn cranks_in_state(&self, state: &str) -> rusqlite::Result<Vec<AbortedCrank>> {
        let mut stmt = self.conn.prepare(
            "SELECT c.crank_id, e.seq, e.payload FROM crank c
             JOIN event e ON e.seq = c.inbound_seq
             WHERE c.state = ?1 ORDER BY c.crank_id",
        )?;
        let rows = stmt.query_map([state], |r| {
            Ok(AbortedCrank {
                crank: r.get::<_, i64>(0)? as u64,
                inbound_seq: r.get::<_, i64>(1)? as u64,
                inbound: r.get(2)?,
            })
        })?;
        rows.collect()
    }

    /// Every aborted crank still on record, with its inbound delivery.
    pub fn aborted_cranks(&self) -> Result<Vec<AbortedCrank>, TranscriptError> {
        self.cranks_in_state("aborted")
            .map_err(|e| self.read_error(&e))
    }

    fn read_error(&self, e: &rusqlite::Error) -> TranscriptError {
        let (p, x) = sqlite_codes(e);
        TranscriptError::Fault(TranscriptFault {
            worker: self.worker.clone(),
            crank: self.active_crank(),
            seq: None,
            operation: Operation::Read,
            sqlite_primary: p,
            sqlite_extended: x,
            commit_outcome_known: true,
            detail: e.to_string(),
        })
    }

    /// The latest published snapshot, if any.
    pub fn latest_snapshot(&self) -> Result<Option<SnapshotRecord>, TranscriptError> {
        self.conn
            .query_row(
                "SELECT epoch, hash, watermark_crank, watermark_seq, engine_signature, panic_on_reference_error
                 FROM snapshot ORDER BY epoch DESC LIMIT 1",
                [],
                |r| {
                    Ok(SnapshotRecord {
                        epoch: r.get::<_, i64>(0)? as u64,
                        hash: r.get(1)?,
                        watermark_crank: r.get::<_, i64>(2)? as u64,
                        watermark_seq: r.get::<_, i64>(3)? as u64,
                        meta: SnapshotMeta {
                            engine_signature: r.get(4)?,
                            panic_on_reference_error: r.get::<_, i64>(5)? != 0,
                        },
                    })
                },
            )
            .optional()
            .map_err(|e| self.read_error(&e))
    }

    /// Step 1: durably admit an inbound delivery and start a crank. The
    /// guest must not run until this returns. A published snapshot must
    /// already exist, so every crank has a snapshot to replay from.
    pub fn begin_crank(&mut self, inbound: &[u8]) -> Result<CrankId, TranscriptError> {
        self.check_healthy()?;
        if let Some(active) = &self.active {
            return Err(TranscriptError::Protocol(format!(
                "crank {} is still active",
                active.crank
            )));
        }
        if inbound.len() > self.limits.max_inbound_bytes {
            return Err(TranscriptError::Backpressure(format!(
                "inbound delivery of {} bytes exceeds {}",
                inbound.len(),
                self.limits.max_inbound_bytes
            )));
        }
        let Some(snapshot) = self.latest_snapshot()? else {
            return Err(TranscriptError::Protocol(
                "no published snapshot: publish an initial snapshot before the first delivery"
                    .into(),
            ));
        };
        let acks = std::mem::take(&mut self.pending_acks);
        let acks_for_retry = acks.clone();
        let result = self.transact(Operation::Admit, None, |tx| {
            flush_acks(tx, &acks)?;
            tx.execute(
                "INSERT INTO crank (start_epoch, state) VALUES (?1, 'started')",
                [snapshot.epoch as i64],
            )?;
            let crank = tx.last_insert_rowid();
            tx.execute(
                "INSERT INTO event (crank_id, kind, payload) VALUES (?1, 'inbound', ?2)",
                params![crank, inbound],
            )?;
            let seq = tx.last_insert_rowid();
            tx.execute(
                "UPDATE crank SET inbound_seq = ?1 WHERE crank_id = ?2",
                params![seq, crank],
            )?;
            Ok(crank as u64)
        });
        match result {
            Ok(crank) => {
                self.stats.admissions += 1;
                self.active = Some(ActiveCrank {
                    crank,
                    pending: Vec::new(),
                    pending_bytes: 0,
                });
                Ok(crank)
            }
            Err(e) => {
                self.pending_acks = acks_for_retry;
                Err(e)
            }
        }
    }

    /// Step 2: stage an outbound frame. It stays invisible outside the vat
    /// until the crank commits.
    pub fn stage_outbound(&mut self, payload: Vec<u8>) -> Result<(), TranscriptError> {
        self.check_healthy()?;
        let limits = self.limits;
        let Some(active) = &mut self.active else {
            return Err(TranscriptError::Protocol("no active crank".into()));
        };
        if active.pending.len() >= limits.max_outbound_events {
            return Err(TranscriptError::Backpressure(format!(
                "crank {} would exceed {} outbound events",
                active.crank, limits.max_outbound_events
            )));
        }
        if active.pending_bytes + payload.len() > limits.max_outbound_bytes {
            return Err(TranscriptError::Backpressure(format!(
                "crank {} would exceed {} outbound bytes",
                active.crank, limits.max_outbound_bytes
            )));
        }
        active.pending_bytes += payload.len();
        active.pending.push(payload);
        Ok(())
    }

    /// Step 3 (`ExecutionOutcome::Quiesced`): commit every pending frame and
    /// the crank in one transaction, returning the frames now releasable in
    /// sequence order. On error nothing may be released; if the fault says
    /// the outcome is unknown, only a reopen can tell whether it committed.
    pub fn commit_crank(&mut self) -> Result<Vec<ReleasableFrame>, TranscriptError> {
        self.check_healthy()?;
        let Some(active) = self.active.take() else {
            return Err(TranscriptError::Protocol("no active crank".into()));
        };
        let crank = active.crank;
        let worker = self.worker.clone();
        let frames = self.transact(Operation::Commit, Some(crank), |tx| {
            let mut frames = Vec::with_capacity(active.pending.len());
            {
                let mut insert = tx.prepare(
                    "INSERT INTO event (crank_id, kind, payload) VALUES (?1, 'outbound', ?2)",
                )?;
                for payload in active.pending {
                    insert.execute(params![crank as i64, payload])?;
                    let seq = tx.last_insert_rowid() as u64;
                    frames.push(ReleasableFrame {
                        seq,
                        crank,
                        idempotency_key: format!("{worker}:{seq}"),
                        payload,
                    });
                }
            }
            let changed = tx.execute(
                "UPDATE crank SET state = 'committed' WHERE crank_id = ?1 AND state = 'started'",
                [crank as i64],
            )?;
            if changed != 1 {
                return Err(rusqlite::Error::StatementChangedRows(changed));
            }
            Ok(frames)
        })?;
        self.stats.releases += 1;
        Ok(frames)
    }

    /// Step 4 (`Panicked` or `Uncaught`): discard the crank's pending frames
    /// and record it aborted. On a poisoned transcript the discard still
    /// happens, but no write is attempted: the durable `started` row without
    /// a commit already withholds every effect, and reopening records it.
    pub fn abort_crank(&mut self) -> Result<(), TranscriptError> {
        let Some(active) = self.active.take() else {
            return Err(TranscriptError::Protocol("no active crank".into()));
        };
        self.check_healthy()?;
        let crank = active.crank;
        drop(active);
        self.transact(Operation::Abort, Some(crank), |tx| {
            tx.execute(
                "UPDATE crank SET state = 'aborted' WHERE crank_id = ?1 AND state = 'started'",
                [crank as i64],
            )
        })?;
        self.stats.aborts += 1;
        Ok(())
    }

    /// Note that frames were handed to the transport. The acknowledgement is
    /// made durable by the next transaction (or [`Transcript::flush_acks`]);
    /// a crash first merely re-releases them, and receivers drop the
    /// duplicates by sequence.
    pub fn mark_released(&mut self, seqs: impl IntoIterator<Item = Seq>) {
        self.pending_acks.extend(seqs);
    }

    /// Make pending release acknowledgements durable now.
    pub fn flush_acks(&mut self) -> Result<(), TranscriptError> {
        self.check_healthy()?;
        if self.pending_acks.is_empty() {
            return Ok(());
        }
        let acks = std::mem::take(&mut self.pending_acks);
        self.transact(Operation::AcknowledgeRelease, None, |tx| {
            flush_acks(tx, &acks)
        })?;
        self.stats.ack_flushes += 1;
        Ok(())
    }

    /// Committed outbound frames not durably acknowledged, in sequence order.
    pub fn releasable(&self) -> Result<Vec<ReleasableFrame>, TranscriptError> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT e.seq, e.crank_id, e.payload FROM event e
                 JOIN crank c ON c.crank_id = e.crank_id
                 WHERE e.kind = 'outbound' AND e.released = 0 AND c.state = 'committed'
                 ORDER BY e.seq",
            )
            .map_err(|e| self.read_error(&e))?;
        let rows = stmt
            .query_map([], |r| {
                let seq = r.get::<_, i64>(0)? as u64;
                Ok(ReleasableFrame {
                    seq,
                    crank: r.get::<_, i64>(1)? as u64,
                    idempotency_key: format!("{}:{seq}", self.worker),
                    payload: r.get(2)?,
                })
            })
            .and_then(|rows| rows.collect::<rusqlite::Result<Vec<_>>>());
        rows.map_err(|e| self.read_error(&e))
    }

    /// Durably publish a snapshot of the worker's current heap, which must
    /// reflect exactly the committed cranks (a quiescent heap between cranks,
    /// or one restored and replayed after an abort). Commit the transcript
    /// first (there is no active crank), write and sync the blob and its
    /// directory, then record its hash with the committed watermark.
    pub fn publish_snapshot(
        &mut self,
        cas: &CasStore,
        blob: &[u8],
        meta: SnapshotMeta,
    ) -> Result<SnapshotRecord, TranscriptError> {
        self.check_healthy()?;
        if let Some(active) = &self.active {
            return Err(TranscriptError::Protocol(format!(
                "cannot publish a snapshot while crank {} is active",
                active.crank
            )));
        }
        // Compaction may have dropped the rows of cranks an earlier snapshot
        // covered, so the watermark never moves below the previous one.
        let previous = self.latest_snapshot()?;
        let (live_crank, live_seq) = self
            .conn
            .query_row(
                "SELECT COALESCE(MAX(c.crank_id), 0), COALESCE(MAX(e.seq), 0) FROM crank c
                 JOIN event e ON e.crank_id = c.crank_id WHERE c.state = 'committed'",
                [],
                |r| Ok((r.get::<_, i64>(0)? as u64, r.get::<_, i64>(1)? as u64)),
            )
            .map_err(|e| self.read_error(&e))?;
        let watermark_crank = live_crank.max(previous.as_ref().map_or(0, |s| s.watermark_crank));
        let watermark_seq = live_seq.max(previous.as_ref().map_or(0, |s| s.watermark_seq));
        let hash = match cas.write_blob(blob) {
            Ok(hash) => hash,
            Err(e) => {
                return Err(self.poison(TranscriptFault {
                    worker: self.worker.clone(),
                    crank: None,
                    seq: None,
                    operation: Operation::WriteSnapshotBlob,
                    sqlite_primary: None,
                    sqlite_extended: None,
                    commit_outcome_known: true,
                    detail: e.to_string(),
                }))
            }
        };
        let acks = std::mem::take(&mut self.pending_acks);
        let record_hash = hash.clone();
        let record_meta = meta.clone();
        let epoch = self.transact(Operation::PublishSnapshot, None, |tx| {
            flush_acks(tx, &acks)?;
            tx.execute(
                "INSERT INTO snapshot (hash, engine_signature, panic_on_reference_error, watermark_crank, watermark_seq)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    record_hash,
                    record_meta.engine_signature,
                    record_meta.panic_on_reference_error as i64,
                    watermark_crank as i64,
                    watermark_seq as i64
                ],
            )?;
            Ok(tx.last_insert_rowid() as u64)
        })?;
        self.stats.publications += 1;
        Ok(SnapshotRecord {
            epoch,
            hash,
            watermark_crank,
            watermark_seq,
            meta,
        })
    }

    /// Drop the prefix the latest published snapshot covers: its committed
    /// cranks' events, except outbound frames not yet acknowledged as
    /// released, and superseded snapshot records. Aborted cranks stay for
    /// diagnosis. Returns the superseded snapshot hashes, which the caller
    /// may reclaim from the CAS store.
    pub fn compact(&mut self) -> Result<Vec<String>, TranscriptError> {
        self.check_healthy()?;
        let Some(snapshot) = self.latest_snapshot()? else {
            return Ok(Vec::new());
        };
        let acks = std::mem::take(&mut self.pending_acks);
        let superseded = self.transact(Operation::Compact, None, |tx| {
            flush_acks(tx, &acks)?;
            let wm = snapshot.watermark_crank as i64;
            tx.execute(
                "DELETE FROM event WHERE crank_id <= ?1
                   AND crank_id IN (SELECT crank_id FROM crank WHERE state = 'committed')
                   AND (kind != 'outbound' OR released = 1)",
                [wm],
            )?;
            tx.execute(
                "DELETE FROM crank WHERE crank_id <= ?1 AND state = 'committed'
                   AND NOT EXISTS (SELECT 1 FROM event e WHERE e.crank_id = crank.crank_id)",
                [wm],
            )?;
            let superseded = {
                let mut stmt =
                    tx.prepare("SELECT hash FROM snapshot WHERE epoch < ?1 ORDER BY epoch")?;
                let rows = stmt.query_map([snapshot.epoch as i64], |r| r.get::<_, String>(0))?;
                rows.collect::<rusqlite::Result<Vec<_>>>()?
            };
            tx.execute(
                "DELETE FROM snapshot WHERE epoch < ?1",
                [snapshot.epoch as i64],
            )?;
            Ok(superseded)
        })?;
        self.stats.compactions += 1;
        Ok(superseded
            .into_iter()
            .filter(|h| *h != snapshot.hash)
            .collect())
    }

    /// Reject resuming for replay under a configuration other than the one
    /// the latest snapshot pinned (§ Coda: a replay under a different
    /// `panic-on-reference-error` setting could diverge from the run that
    /// produced the transcript).
    pub fn check_resume(&self, meta: &SnapshotMeta) -> Result<(), TranscriptError> {
        let Some(snapshot) = self.latest_snapshot()? else {
            return Err(TranscriptError::Protocol("no published snapshot".into()));
        };
        if snapshot.meta != *meta {
            return Err(TranscriptError::Protocol(format!(
                "resume configuration {meta:?} differs from snapshot epoch {} pinned {:?}",
                snapshot.epoch, snapshot.meta
            )));
        }
        Ok(())
    }

    /// The latest published snapshot, verified, and the committed cranks
    /// after its watermark. A missing or corrupt blob is a storage fault:
    /// recovery stops rather than falling back to another snapshot.
    pub fn replay_plan(&self, cas: &CasStore) -> Result<ReplayPlan, TranscriptError> {
        let Some(snapshot) = self.latest_snapshot()? else {
            return Err(TranscriptError::Protocol("no published snapshot".into()));
        };
        let snapshot_bytes = cas.read_blob(&snapshot.hash).map_err(|e| {
            TranscriptError::Fault(TranscriptFault {
                worker: self.worker.clone(),
                crank: None,
                seq: None,
                operation: Operation::Read,
                sqlite_primary: None,
                sqlite_extended: None,
                commit_outcome_known: true,
                detail: format!("published snapshot epoch {}: {e}", snapshot.epoch),
            })
        })?;
        let read = || -> rusqlite::Result<Vec<CommittedCrank>> {
            let mut cranks_stmt = self.conn.prepare(
                "SELECT c.crank_id, e.payload FROM crank c JOIN event e ON e.seq = c.inbound_seq
                 WHERE c.state = 'committed' AND c.crank_id > ?1 ORDER BY c.crank_id",
            )?;
            let mut out_stmt = self
                .conn
                .prepare("SELECT seq, payload FROM event WHERE crank_id = ?1 AND kind = 'outbound' ORDER BY seq")?;
            let heads = cranks_stmt
                .query_map([snapshot.watermark_crank as i64], |r| {
                    Ok((r.get::<_, i64>(0)?, r.get::<_, Vec<u8>>(1)?))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            let mut cranks = Vec::with_capacity(heads.len());
            for (crank, inbound) in heads {
                let outbound = out_stmt
                    .query_map([crank], |r| {
                        Ok((r.get::<_, i64>(0)? as u64, r.get::<_, Vec<u8>>(1)?))
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                cranks.push(CommittedCrank {
                    crank: crank as u64,
                    inbound,
                    outbound,
                });
            }
            Ok(cranks)
        };
        let cranks = read().map_err(|e| self.read_error(&e))?;
        Ok(ReplayPlan {
            snapshot,
            snapshot_bytes,
            cranks,
        })
    }

    /// The durable state of one crank, if it is still on record.
    pub fn crank_state(&self, crank: CrankId) -> Result<Option<String>, TranscriptError> {
        self.conn
            .query_row(
                "SELECT state FROM crank WHERE crank_id = ?1",
                [crank as i64],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| self.read_error(&e))
    }

    /// Every outbound event on record with its crank's state, in sequence
    /// order: an audit view for tests and diagnosis.
    pub fn outbound_audit(&self) -> Result<Vec<(Seq, CrankId, String)>, TranscriptError> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT e.seq, e.crank_id, c.state FROM event e JOIN crank c ON c.crank_id = e.crank_id
                 WHERE e.kind = 'outbound' ORDER BY e.seq",
            )
            .map_err(|e| self.read_error(&e))?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, i64>(0)? as u64,
                    r.get::<_, i64>(1)? as u64,
                    r.get(2)?,
                ))
            })
            .and_then(|rows| rows.collect::<rusqlite::Result<Vec<_>>>());
        rows.map_err(|e| self.read_error(&e))
    }
}

fn flush_acks(tx: &rusqlite::Transaction<'_>, acks: &[Seq]) -> rusqlite::Result<()> {
    if acks.is_empty() {
        return Ok(());
    }
    let mut stmt =
        tx.prepare("UPDATE event SET released = 1 WHERE seq = ?1 AND kind = 'outbound'")?;
    for seq in acks {
        stmt.execute([*seq as i64])?;
    }
    Ok(())
}
