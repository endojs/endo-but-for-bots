//! The Slot Machine per-worker write-ahead transcript
//! (designs/ironhorse-panic.md § Slot Machine per-worker write-ahead
//! transcript).
//!
//! Each Endor worker owns one SQLite database,
//! `<endo-directory>/workers/<handle>/transcript.sqlite` ([`transcript_path`]),
//! holding:
//!
//! - `snapshot`: published CAS snapshot identities with the transcript
//!   watermark each covers, the engine/callback-table signature, and the
//!   `panic-on-reference-error` setting pinned for replay;
//! - `crank`: monotonic crank ids with `started` / `committed` / `aborted`
//!   state, the inbound event that started each, and its starting epoch;
//! - `event`: inbound, outbound, host-call request/reply, and post-commit
//!   host-effect rows with monotonic sequence numbers that are never reused,
//!   so `<worker>:<sequence>` is a stable idempotency key;
//! - `host_call` and `host_handle`: the classification of each recorded host
//!   call, and durable logical handles with their reconstruction
//!   descriptors (§ Host functions are messages too; see the `host` module
//!   and [`Transcript::host_call`]).
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
//! **Backend discipline: XS/CAS watermark ordering** (§ Open Questions, "Which
//! worker backend"). A heap snapshot is a content-addressed blob
//! written outside any transaction, so it cannot join a SQLite commit.
//! [`Transcript::publish_snapshot`] therefore orders the steps: the
//! transcript's cranks are already committed; the blob is written, synced,
//! renamed, and its directory synced ([`ContentAddressedStore::write_blob`]); only then is
//! its hash recorded with the committed watermark it covers (the latest
//! committed crank and sequence, never below the previous snapshot's, since
//! compaction may have dropped the rows that snapshot covered); and only
//! after that record is durable may [`Transcript::compact`] drop the covered
//! prefix. A crash anywhere leaves the previous published snapshot and its
//! full replay suffix. A published snapshot never covers an uncommitted
//! crank, and the suffix after it survives until a newer one is published.
//!
//! **Durability** (§ Open Questions, "fsync cost bounded for a single
//! busy vat"): WAL with
//! `synchronous=FULL`, never `NORMAL`, because effects are released after
//! COMMIT and `NORMAL` may forget a recent commit on power loss. Per crank the
//! transcript pays one admission transaction and one release transaction;
//! acknowledgments of released frames ride the next transaction instead of
//! paying their own. Outbound events and recorded host calls per crank are
//! bounded by [`TranscriptLimits`] and refused, not truncated, past the bound.
//!
//! **Storage failures** (§ Open Questions, "SQLite I/O failure inside a
//! transcript write") surface as a
//! supervisor-owned [`TranscriptFault`], never as an engine panic. A fault
//! poisons the transcript: it refuses admission, commit, and snapshot
//! publication until the supervisor drops it and reopens, and reopening
//! reconciles to the last proven durable state. A `started` crank with no
//! proven commit is recovered as aborted with its inbound row kept for
//! diagnosis and explicit retry; the transcript never re-drives it.
//!
//! The release side of the contract, one release authority per worker
//! driven by the crank's verdict, and the receiver's duplicate suppression
//! live in [`Embargo`] and [`DuplicateSuppressor`] (§ The Slot Machine
//! Message Embargo Contract).
//!
//! The deterministic fault-injection seam that drives the crash matrix is
//! [`FaultPlan`].

mod cas;
mod embargo;
mod fault;
mod host;

use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, OpenFlags, OptionalExtension};

pub use cas::{blob_hash, sync_directory, ContentAddressedStore, ContentAddressedStoreError};
pub use embargo::{CrankVerdict, DuplicateSuppressor, Embargo, FrameSink, Received, Settlement};
pub use fault::{FaultMode, FaultPlan};
pub use host::{
    AdmissionError, AdmittedCallbacks, CallbackRegistry, HandleId, HandleRecord, HostCallError,
    HostClass, HostOutcome, HostReplay, HostReply, RecoveryStop, ReleasableEffect, ReplayStop,
    ReseatReport, TransactionalWrite,
};

/// The schema version this crate writes.
pub const SCHEMA_VERSION: i64 = 2;

/// The per-worker transcript database path.
pub fn transcript_path(endo_directory: &Path, worker_handle: &str) -> PathBuf {
    endo_directory
        .join("workers")
        .join(worker_handle)
        .join("transcript.sqlite")
}

/// A crank id. Monotonic per worker and never reused.
pub type CrankId = u64;
/// An event sequence number. Monotonic per worker and never reused.
pub type Sequence = u64;

/// The durability operation a [`TranscriptFault`] interrupted.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Operation {
    Open,
    Recover,
    Admit,
    Commit,
    /// A barrier's request made durable before its effect runs.
    HostBarrier,
    /// A handle effect recorded after the transcript refused its call.
    HostEscape,
    Abort,
    AcknowledgeRelease,
    WriteSnapshotBlob,
    PublishSnapshot,
    Compact,
    Read,
}

/// A transcript storage failure, owned by the supervisor rather than the
/// engine: it is not a `PanicKind` (§ Open Questions, "SQLite I/O failure
/// inside a transcript write").
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TranscriptFault {
    /// The worker whose transcript failed.
    pub worker: String,
    /// The crank in flight, if any.
    pub crank: Option<CrankId>,
    /// The event sequence involved, if known.
    pub sequence: Option<Sequence>,
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
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "transcript fault in worker {} during {:?} (crank {:?}, sequence {:?}, sqlite {:?}/{:?}, outcome {}): {}",
            self.worker,
            self.operation,
            self.crank,
            self.sequence,
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
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TranscriptError::Fault(fault) => write!(formatter, "{fault}"),
            TranscriptError::Poisoned(fault) => {
                write!(formatter, "transcript poisoned by earlier fault: {fault}")
            }
            TranscriptError::Backpressure(s) => write!(formatter, "transcript backpressure: {s}"),
            TranscriptError::Protocol(s) => write!(formatter, "transcript protocol error: {s}"),
        }
    }
}

impl std::error::Error for TranscriptError {}

/// Per-crank admission bounds (§ Open Questions, "fsync cost bounded for a
/// single busy vat": "bound
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
    /// Most recorded (non-`pure`) host calls one crank may stage.
    pub max_host_calls: usize,
    /// Most host-call request and reply bytes one crank may stage.
    pub max_host_bytes: usize,
}

impl Default for TranscriptLimits {
    fn default() -> Self {
        TranscriptLimits {
            max_outbound_events: 4096,
            max_outbound_bytes: 16 << 20,
            max_inbound_bytes: 16 << 20,
            max_host_calls: 4096,
            max_host_bytes: 16 << 20,
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
    pub watermark_sequence: Sequence,
    /// The pinned replay configuration.
    pub meta: SnapshotMeta,
}

/// An outbound frame the supervisor may release, carrying its stable
/// identity so a receiver can drop a duplicate re-release.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReleasableFrame {
    /// The event sequence.
    pub sequence: Sequence,
    /// The crank that committed it.
    pub crank: CrankId,
    /// `<worker>:<sequence>`, stable across restarts.
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
    pub outbound: Vec<(Sequence, Vec<u8>)>,
}

/// A crank that never committed, kept for diagnosis and explicit retry.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AbortedCrank {
    /// The crank id.
    pub crank: CrankId,
    /// The inbound event's sequence.
    pub inbound_sequence: Sequence,
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
    /// Standalone acknowledgment flushes committed.
    pub acknowledgment_flushes: u64,
}

struct ActiveCrank {
    crank: CrankId,
    pending: Vec<Vec<u8>>,
    pending_bytes: usize,
    host: Vec<host::Staged>,
}

/// One worker's write-ahead transcript. See the crate documentation.
pub struct Transcript {
    connection: Connection,
    worker: String,
    limits: TranscriptLimits,
    active: Option<ActiveCrank>,
    pending_acknowledgments: Vec<Sequence>,
    poisoned: Option<TranscriptFault>,
    stats: TranscriptStats,
}

fn sqlite_codes(error: &rusqlite::Error) -> (Option<i32>, Option<i32>) {
    match error {
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
        let open_fault = |detail: String, error: Option<&rusqlite::Error>| {
            let (primary, extended) = error.map(sqlite_codes).unwrap_or((None, None));
            TranscriptError::Fault(TranscriptFault {
                worker: worker.clone(),
                crank: None,
                sequence: None,
                operation: Operation::Open,
                sqlite_primary: primary,
                sqlite_extended: extended,
                commit_outcome_known: true,
                detail,
            })
        };
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| {
                open_fault(format!("create {}: {error}", parent.display()), None)
            })?;
        }
        let flags = OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_CREATE
            | OpenFlags::SQLITE_OPEN_NO_MUTEX;
        let connection = match &config.fault {
            Some(plan) => Connection::open_with_flags_and_vfs(path, flags, plan.vfs_name()),
            None => Connection::open_with_flags(path, flags),
        }
        .map_err(|error| open_fault(format!("open {}: {error}", path.display()), Some(&error)))?;
        // The supervisor is the only writer: hold the file exclusively (the
        // heap store's discipline), which also keeps the WAL index in
        // process memory rather than a `-shm` file, and choose WAL with FULL
        // synchronous durability.
        let setup = || -> rusqlite::Result<String> {
            connection.query_row("PRAGMA locking_mode=EXCLUSIVE", [], |row| {
                row.get::<_, String>(0)
            })?;
            let mode: String =
                connection.query_row("PRAGMA journal_mode=WAL", [], |row| row.get(0))?;
            connection.execute_batch("PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;")?;
            Ok(mode)
        };
        let mode =
            setup().map_err(|error| open_fault(format!("configure: {error}"), Some(&error)))?;
        if !mode.eq_ignore_ascii_case("wal") {
            return Err(open_fault(format!("journal_mode is {mode}, not wal"), None));
        }
        let mut transcript = Transcript {
            connection,
            worker: config.worker,
            limits: config.limits,
            active: None,
            pending_acknowledgments: Vec::new(),
            poisoned: None,
            stats: TranscriptStats::default(),
        };
        transcript.init_schema()?;
        let recovery = transcript.recover()?;
        Ok((transcript, recovery))
    }

    fn fault(
        &mut self,
        operation: Operation,
        crank: Option<CrankId>,
        known: bool,
        error: &rusqlite::Error,
    ) -> TranscriptError {
        let (primary, extended) = sqlite_codes(error);
        self.poison(TranscriptFault {
            worker: self.worker.clone(),
            crank,
            sequence: None,
            operation,
            sqlite_primary: primary,
            sqlite_extended: extended,
            commit_outcome_known: known,
            detail: error.to_string(),
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
            Some(fault) => Err(TranscriptError::Poisoned(fault.clone())),
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
        self.active.as_ref().map(|active| active.crank)
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
            let transaction = self
                .connection
                .transaction()
                .map_err(|error| (true, error))?;
            let value = body(&transaction).map_err(|error| (true, error))?;
            transaction.commit().map_err(|error| (false, error))?;
            Ok(value)
        })();
        result.map_err(|(known, error)| self.fault(operation, crank, known, &error))
    }

    fn init_schema(&mut self) -> Result<(), TranscriptError> {
        let worker = self.worker.clone();
        let existing = self.transact(Operation::Open, None, |transaction| {
            transaction.execute_batch(
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
                     watermark_sequence INTEGER NOT NULL
                 ) STRICT;
                 CREATE TABLE IF NOT EXISTS crank (
                     crank_id INTEGER PRIMARY KEY AUTOINCREMENT,
                     inbound_sequence INTEGER,
                     start_epoch INTEGER NOT NULL,
                     state TEXT NOT NULL CHECK (state IN ('started', 'committed', 'aborted'))
                 ) STRICT;
                 CREATE TABLE IF NOT EXISTS event (
                     sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                     crank_id INTEGER NOT NULL REFERENCES crank (crank_id),
                     kind TEXT NOT NULL CHECK (kind IN ('inbound', 'outbound', 'host-request', 'host-reply', 'host-effect', 'host-escape')),
                     payload BLOB NOT NULL,
                     released INTEGER NOT NULL DEFAULT 0
                 ) STRICT;
                 CREATE INDEX IF NOT EXISTS event_by_crank ON event (crank_id, sequence);
                 CREATE INDEX IF NOT EXISTS crank_by_state ON crank (state, crank_id);",
            )?;
            transaction.execute_batch(host::SCHEMA)?;
            let existing: Option<String> = transaction
                .query_row("SELECT value FROM meta WHERE key = 'worker'", [], |row| row.get(0))
                .optional()?;
            if existing.is_none() {
                transaction.execute(
                    "INSERT INTO meta (key, value) VALUES ('worker', ?1), ('schema_version', ?2)",
                    params![worker, SCHEMA_VERSION.to_string()],
                )?;
            }
            let schema_version: Option<String> = transaction
                .query_row(
                    "SELECT value FROM meta WHERE key = 'schema_version'",
                    [],
                    |row| row.get(0),
                )
                .optional()?;
            Ok((existing, schema_version))
        })?;
        let (existing, schema_version) = existing;
        if let Some(existing) = existing {
            if existing != self.worker {
                return Err(TranscriptError::Protocol(format!(
                    "transcript belongs to worker {existing}, not {}",
                    self.worker
                )));
            }
        }
        // A transcript written by another schema version may lack tables or
        // columns this crate relies on, or carry ones it does not know: refuse
        // it rather than replay from a misread record.
        if schema_version.as_deref() != Some(SCHEMA_VERSION.to_string().as_str()) {
            return Err(TranscriptError::Protocol(format!(
                "transcript schema version {}, not {SCHEMA_VERSION}",
                schema_version.as_deref().unwrap_or("absent")
            )));
        }
        Ok(())
    }

    /// Resolve every `started` crank to `aborted`: without a proven commit,
    /// none of its effects may be released, and the transcript never
    /// re-drives it on its own.
    fn recover(&mut self) -> Result<Recovery, TranscriptError> {
        let in_doubt = self
            .cranks_in_state("started")
            .map_err(|error| self.fault(Operation::Recover, None, true, &error))?;
        if !in_doubt.is_empty() {
            self.transact(Operation::Recover, None, |transaction| {
                transaction.execute(
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
        let mut statement = self.connection.prepare(
            "SELECT crank.crank_id, entry.sequence, entry.payload FROM crank
             JOIN event entry ON entry.sequence = crank.inbound_sequence
             WHERE crank.state = ?1 ORDER BY crank.crank_id",
        )?;
        let rows = statement.query_map([state], |row| {
            Ok(AbortedCrank {
                crank: row.get::<_, i64>(0)? as u64,
                inbound_sequence: row.get::<_, i64>(1)? as u64,
                inbound: row.get(2)?,
            })
        })?;
        rows.collect()
    }

    /// Every aborted crank still on record, with its inbound delivery.
    pub fn aborted_cranks(&self) -> Result<Vec<AbortedCrank>, TranscriptError> {
        self.cranks_in_state("aborted")
            .map_err(|error| self.read_error(&error))
    }

    fn read_error(&self, error: &rusqlite::Error) -> TranscriptError {
        let (primary, extended) = sqlite_codes(error);
        TranscriptError::Fault(TranscriptFault {
            worker: self.worker.clone(),
            crank: self.active_crank(),
            sequence: None,
            operation: Operation::Read,
            sqlite_primary: primary,
            sqlite_extended: extended,
            commit_outcome_known: true,
            detail: error.to_string(),
        })
    }

    /// The latest published snapshot, if any.
    pub fn latest_snapshot(&self) -> Result<Option<SnapshotRecord>, TranscriptError> {
        self.connection
            .query_row(
                "SELECT epoch, hash, watermark_crank, watermark_sequence, engine_signature, panic_on_reference_error
                 FROM snapshot ORDER BY epoch DESC LIMIT 1",
                [],
                |row| {
                    Ok(SnapshotRecord {
                        epoch: row.get::<_, i64>(0)? as u64,
                        hash: row.get(1)?,
                        watermark_crank: row.get::<_, i64>(2)? as u64,
                        watermark_sequence: row.get::<_, i64>(3)? as u64,
                        meta: SnapshotMeta {
                            engine_signature: row.get(4)?,
                            panic_on_reference_error: row.get::<_, i64>(5)? != 0,
                        },
                    })
                },
            )
            .optional()
            .map_err(|error| self.read_error(&error))
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
        let acknowledgments = std::mem::take(&mut self.pending_acknowledgments);
        let acknowledgments_for_retry = acknowledgments.clone();
        let result = self.transact(Operation::Admit, None, |transaction| {
            flush_acknowledgments(transaction, &acknowledgments)?;
            transaction.execute(
                "INSERT INTO crank (start_epoch, state) VALUES (?1, 'started')",
                [snapshot.epoch as i64],
            )?;
            let crank = transaction.last_insert_rowid();
            transaction.execute(
                "INSERT INTO event (crank_id, kind, payload) VALUES (?1, 'inbound', ?2)",
                params![crank, inbound],
            )?;
            let sequence = transaction.last_insert_rowid();
            transaction.execute(
                "UPDATE crank SET inbound_sequence = ?1 WHERE crank_id = ?2",
                params![sequence, crank],
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
                    host: Vec::new(),
                });
                Ok(crank)
            }
            Err(error) => {
                self.pending_acknowledgments = acknowledgments_for_retry;
                Err(error)
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
        if active
            .pending_bytes
            .checked_add(payload.len())
            .is_none_or(|sum| sum > limits.max_outbound_bytes)
        {
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
        if let Some(active) = &self.active {
            if active
                .host
                .iter()
                .any(|staged| matches!(staged, host::Staged::RefusedBarrier))
            {
                return Err(TranscriptError::Protocol(format!(
                    "crank {} refused a barrier's reply and must abort",
                    active.crank
                )));
            }
        }
        let Some(active) = self.active.take() else {
            return Err(TranscriptError::Protocol("no active crank".into()));
        };
        let crank = active.crank;
        let worker = self.worker.clone();
        let frames = self.transact(Operation::Commit, Some(crank), |transaction| {
            host::commit_staged(transaction, crank, &active.host)?;
            let mut frames = Vec::with_capacity(active.pending.len());
            {
                let mut insert = transaction.prepare(
                    "INSERT INTO event (crank_id, kind, payload) VALUES (?1, 'outbound', ?2)",
                )?;
                for payload in active.pending {
                    insert.execute(params![crank as i64, payload])?;
                    let sequence = transaction.last_insert_rowid() as u64;
                    frames.push(ReleasableFrame {
                        sequence,
                        crank,
                        idempotency_key: format!("{worker}:{sequence}"),
                        payload,
                    });
                }
            }
            let changed = transaction.execute(
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
    ///
    /// A staged host call whose adapter already ran may have opened or
    /// closed a native resource that the abort cannot take back. The abort
    /// transaction records each such handle as broken, as
    /// [`Transcript::host_call`] does for a refused call, so its logical id
    /// is never reissued and [`Transcript::recovery_gate`] stops until the
    /// adapter supplies a replacement or the application acknowledges the
    /// loss.
    pub fn abort_crank(&mut self) -> Result<(), TranscriptError> {
        let Some(active) = self.active.take() else {
            return Err(TranscriptError::Protocol("no active crank".into()));
        };
        self.check_healthy()?;
        let crank = active.crank;
        let escapes = host::aborted_escapes(&active.host);
        drop(active);
        self.transact(Operation::Abort, Some(crank), |transaction| {
            host::record_aborted_escapes(transaction, crank, &escapes)?;
            transaction.execute(
                "UPDATE crank SET state = 'aborted' WHERE crank_id = ?1 AND state = 'started'",
                [crank as i64],
            )
        })?;
        self.stats.aborts += 1;
        Ok(())
    }

    /// Note that frames were handed to the transport. The acknowledgment is
    /// made durable by the next transaction (or [`Transcript::flush_acknowledgments`]);
    /// a crash first merely re-releases them, and receivers drop the
    /// duplicates by sequence.
    pub fn mark_released(&mut self, seqs: impl IntoIterator<Item = Sequence>) {
        self.pending_acknowledgments.extend(seqs);
    }

    /// Make pending release acknowledgments durable now.
    pub fn flush_acknowledgments(&mut self) -> Result<(), TranscriptError> {
        self.check_healthy()?;
        if self.pending_acknowledgments.is_empty() {
            return Ok(());
        }
        let acknowledgments = std::mem::take(&mut self.pending_acknowledgments);
        let acknowledgments_for_retry = acknowledgments.clone();
        let result = self.transact(Operation::AcknowledgeRelease, None, |transaction| {
            flush_acknowledgments(transaction, &acknowledgments)
        });
        result.inspect_err(|_| {
            self.pending_acknowledgments = acknowledgments_for_retry;
        })?;
        self.stats.acknowledgment_flushes += 1;
        Ok(())
    }

    /// Committed outbound frames not durably acknowledged, in sequence order.
    pub fn releasable(&self) -> Result<Vec<ReleasableFrame>, TranscriptError> {
        let mut statement = self
            .connection
            .prepare(
                "SELECT entry.sequence, entry.crank_id, entry.payload FROM event entry
                 JOIN crank ON crank.crank_id = entry.crank_id
                 WHERE entry.kind = 'outbound' AND entry.released = 0 AND crank.state = 'committed'
                 ORDER BY entry.sequence",
            )
            .map_err(|error| self.read_error(&error))?;
        let rows = statement
            .query_map([], |row| {
                let sequence = row.get::<_, i64>(0)? as u64;
                Ok(ReleasableFrame {
                    sequence,
                    crank: row.get::<_, i64>(1)? as u64,
                    idempotency_key: format!("{}:{sequence}", self.worker),
                    payload: row.get(2)?,
                })
            })
            .and_then(|rows| rows.collect::<rusqlite::Result<Vec<_>>>());
        rows.map_err(|error| self.read_error(&error))
    }

    /// Durably publish a snapshot of the worker's current heap, which must
    /// reflect exactly the committed cranks (a quiescent heap between cranks,
    /// or one restored and replayed after an abort). Commit the transcript
    /// first (there is no active crank), write and sync the blob and its
    /// directory, then record its hash with the committed watermark.
    pub fn publish_snapshot(
        &mut self,
        blob_store: &ContentAddressedStore,
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
        let (live_crank, live_sequence) = self
            .connection
            .query_row(
                "SELECT COALESCE(MAX(crank.crank_id), 0), COALESCE(MAX(entry.sequence), 0) FROM crank
                 JOIN event entry ON entry.crank_id = crank.crank_id WHERE crank.state = 'committed'",
                [],
                |row| Ok((row.get::<_, i64>(0)? as u64, row.get::<_, i64>(1)? as u64)),
            )
            .map_err(|error| self.read_error(&error))?;
        let watermark_crank = live_crank.max(
            previous
                .as_ref()
                .map_or(0, |snapshot| snapshot.watermark_crank),
        );
        let watermark_sequence = live_sequence.max(
            previous
                .as_ref()
                .map_or(0, |snapshot| snapshot.watermark_sequence),
        );
        let hash = match blob_store.write_blob(blob) {
            Ok(hash) => hash,
            Err(error) => {
                return Err(self.poison(TranscriptFault {
                    worker: self.worker.clone(),
                    crank: None,
                    sequence: None,
                    operation: Operation::WriteSnapshotBlob,
                    sqlite_primary: None,
                    sqlite_extended: None,
                    commit_outcome_known: true,
                    detail: error.to_string(),
                }))
            }
        };
        let acknowledgments = std::mem::take(&mut self.pending_acknowledgments);
        let acknowledgments_for_retry = acknowledgments.clone();
        let record_hash = hash.clone();
        let record_meta = meta.clone();
        let result = self.transact(Operation::PublishSnapshot, None, |transaction| {
            flush_acknowledgments(transaction, &acknowledgments)?;
            transaction.execute(
                "INSERT INTO snapshot (hash, engine_signature, panic_on_reference_error, watermark_crank, watermark_sequence)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    record_hash,
                    record_meta.engine_signature,
                    record_meta.panic_on_reference_error as i64,
                    watermark_crank as i64,
                    watermark_sequence as i64
                ],
            )?;
            Ok(transaction.last_insert_rowid() as u64)
        });
        let epoch = result.inspect_err(|_| {
            self.pending_acknowledgments = acknowledgments_for_retry;
        })?;
        self.stats.publications += 1;
        Ok(SnapshotRecord {
            epoch,
            hash,
            watermark_crank,
            watermark_sequence,
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
        let acknowledgments = std::mem::take(&mut self.pending_acknowledgments);
        let acknowledgments_for_retry = acknowledgments.clone();
        let result = self.transact(Operation::Compact, None, |transaction| {
            flush_acknowledgments(transaction, &acknowledgments)?;
            let watermark = snapshot.watermark_crank as i64;
            transaction.execute(
                "DELETE FROM event WHERE crank_id <= ?1
                   AND crank_id IN (SELECT crank_id FROM crank WHERE state = 'committed')
                   AND (kind NOT IN ('outbound', 'host-effect') OR released = 1)",
                [watermark],
            )?;
            transaction.execute(
                "DELETE FROM host_call WHERE NOT EXISTS
                   (SELECT 1 FROM event entry WHERE entry.sequence = host_call.request_sequence)",
                [],
            )?;
            transaction.execute(
                "DELETE FROM crank WHERE crank_id <= ?1 AND state = 'committed'
                   AND NOT EXISTS (SELECT 1 FROM event entry WHERE entry.crank_id = crank.crank_id)",
                [watermark],
            )?;
            let superseded = {
                let mut statement = transaction
                    .prepare("SELECT hash FROM snapshot WHERE epoch < ?1 ORDER BY epoch")?;
                let rows =
                    statement.query_map([snapshot.epoch as i64], |row| row.get::<_, String>(0))?;
                rows.collect::<rusqlite::Result<Vec<_>>>()?
            };
            transaction.execute(
                "DELETE FROM snapshot WHERE epoch < ?1",
                [snapshot.epoch as i64],
            )?;
            Ok(superseded)
        });
        let superseded = result.inspect_err(|_| {
            self.pending_acknowledgments = acknowledgments_for_retry;
        })?;
        self.stats.compactions += 1;
        Ok(superseded
            .into_iter()
            .filter(|hash| *hash != snapshot.hash)
            .collect())
    }

    /// Reject resuming for replay under a configuration other than the one
    /// the latest snapshot pinned (designs/ironhorse-panic.md § Coda: An
    /// Option to Panic on Reference Errors; a replay under a different
    /// `panic-on-reference-error` setting could diverge from the run that
    /// produced the transcript).
    /// Returns the snapshot checked. [`Transcript::replay_plan`] and
    /// [`Transcript::host_replay`] run this check themselves.
    pub fn check_resume(&self, meta: &SnapshotMeta) -> Result<SnapshotRecord, TranscriptError> {
        let Some(snapshot) = self.latest_snapshot()? else {
            return Err(TranscriptError::Protocol("no published snapshot".into()));
        };
        if snapshot.meta != *meta {
            return Err(TranscriptError::Protocol(format!(
                "resume configuration {meta:?} differs from snapshot epoch {} pinned {:?}",
                snapshot.epoch, snapshot.meta
            )));
        }
        Ok(snapshot)
    }

    /// The latest published snapshot, verified, and the committed cranks
    /// after its watermark. `expected` is the configuration the caller will
    /// replay under; it must equal the one the snapshot pinned
    /// ([`Transcript::check_resume`]), checked before any bytes are returned.
    /// A missing or corrupt blob is a storage fault: recovery stops rather
    /// than falling back to another snapshot.
    pub fn replay_plan(
        &self,
        blob_store: &ContentAddressedStore,
        expected: &SnapshotMeta,
    ) -> Result<ReplayPlan, TranscriptError> {
        let snapshot = self.check_resume(expected)?;
        let snapshot_bytes = blob_store.read_blob(&snapshot.hash).map_err(|error| {
            TranscriptError::Fault(TranscriptFault {
                worker: self.worker.clone(),
                crank: None,
                sequence: None,
                operation: Operation::Read,
                sqlite_primary: None,
                sqlite_extended: None,
                commit_outcome_known: true,
                detail: format!("published snapshot epoch {}: {error}", snapshot.epoch),
            })
        })?;
        let read = || -> rusqlite::Result<Vec<CommittedCrank>> {
            let mut cranks_stmt = self.connection.prepare(
                "SELECT crank.crank_id, entry.payload FROM crank JOIN event entry ON entry.sequence = crank.inbound_sequence
                 WHERE crank.state = 'committed' AND crank.crank_id > ?1 ORDER BY crank.crank_id",
            )?;
            let mut out_stmt = self
                .connection
                .prepare("SELECT sequence, payload FROM event WHERE crank_id = ?1 AND kind = 'outbound' ORDER BY sequence")?;
            let heads = cranks_stmt
                .query_map([snapshot.watermark_crank as i64], |row| {
                    Ok((row.get::<_, i64>(0)?, row.get::<_, Vec<u8>>(1)?))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            let mut cranks = Vec::with_capacity(heads.len());
            for (crank, inbound) in heads {
                let outbound = out_stmt
                    .query_map([crank], |row| {
                        Ok((row.get::<_, i64>(0)? as u64, row.get::<_, Vec<u8>>(1)?))
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
        let cranks = read().map_err(|error| self.read_error(&error))?;
        Ok(ReplayPlan {
            snapshot,
            snapshot_bytes,
            cranks,
        })
    }

    /// The durable state of one crank, if it is still on record.
    pub fn crank_state(&self, crank: CrankId) -> Result<Option<String>, TranscriptError> {
        self.connection
            .query_row(
                "SELECT state FROM crank WHERE crank_id = ?1",
                [crank as i64],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| self.read_error(&error))
    }

    /// Every outbound event on record with its crank's state, in sequence
    /// order: an audit view for tests and diagnosis.
    pub fn outbound_audit(&self) -> Result<Vec<(Sequence, CrankId, String)>, TranscriptError> {
        let mut statement = self
            .connection
            .prepare(
                "SELECT entry.sequence, entry.crank_id, crank.state FROM event entry JOIN crank ON crank.crank_id = entry.crank_id
                 WHERE entry.kind = 'outbound' ORDER BY entry.sequence",
            )
            .map_err(|error| self.read_error(&error))?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, i64>(0)? as u64,
                    row.get::<_, i64>(1)? as u64,
                    row.get(2)?,
                ))
            })
            .and_then(|rows| rows.collect::<rusqlite::Result<Vec<_>>>());
        rows.map_err(|error| self.read_error(&error))
    }
}

fn flush_acknowledgments(
    transaction: &rusqlite::Transaction<'_>,
    acknowledgments: &[Sequence],
) -> rusqlite::Result<()> {
    if acknowledgments.is_empty() {
        return Ok(());
    }
    let mut statement = transaction.prepare(
        "UPDATE event SET released = 1 WHERE sequence = ?1 AND kind IN ('outbound', 'host-effect')",
    )?;
    for sequence in acknowledgments {
        statement.execute([*sequence as i64])?;
    }
    Ok(())
}
