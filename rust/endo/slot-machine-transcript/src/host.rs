//! Host functions are messages too (designs/ironhorse-panic.md § Host
//! functions are messages too).
//!
//! An XS snapshot keeps callback-table positions but not the native
//! resources behind them, so every host function that reads
//! nondeterministic state, performs an effect, or returns an open handle
//! goes through the transcript like a vat message:
//!
//! - [`CallbackRegistry::admit`] gives every callback one of the five
//!   classifications ([`HostClass`]) and, for a retryable worker, refuses an
//!   unclassified callback or a non-idempotent outbound provider. Such a
//!   provider must gain an idempotency protocol or be declared a
//!   [`HostClass::Barrier`].
//! - [`Transcript::host_call`] stages each `read` or `transactional` call's
//!   request and reply as `host-request` / `host-reply` events that commit
//!   with the crank, so an aborted crank leaves none. An `outbound` call is
//!   not invoked during the crank. It is staged as a `host-effect` event and
//!   becomes releasable only after commit ([`Transcript::releasable_effects`]),
//!   keyed by `<worker>:<seq>` for the provider's idempotency protocol. A
//!   `barrier` call's request is made durable in its own transaction
//!   *before* invocation, so even a crash mid-crank leaves a record that an
//!   effect may have escaped.
//! - A handle-producing reply gets a durable logical [`HandleId`] with an
//!   optional reconstruction descriptor in the `host_handle` table. The
//!   guest keeps the logical id, never a native resource. On restart
//!   [`Transcript::reseat_handles`] rebuilds each open handle from its
//!   descriptor. A handle with no descriptor, or one whose reconstruction
//!   fails, is re-seated as **broken**: a use returns
//!   [`HostCallError::BrokenHandle`] without invoking the adapter, and
//!   [`Transcript::recovery_gate`] stays stopped until the adapter supplies
//!   a replacement under the same logical id
//!   ([`Transcript::supply_replacement`]) or the application handles a
//!   delivery that reports the loss ([`Transcript::acknowledge_loss`]).
//! - [`HostReplay`] returns the recorded replies of the committed suffix
//!   without invoking any adapter, checks each request byte for byte, and
//!   halts at a recorded barrier rather than re-running its effect.
//!
//! The event log is authoritative for handle state. The `host_handle.open`
//! column is a cache refreshed in the same transaction that appends the
//! event that opens or closes the handle.

use std::collections::{BTreeMap, VecDeque};

use rusqlite::{params, OptionalExtension};

use crate::{CrankId, Operation, Seq, Transcript, TranscriptError};

/// A durable logical handle id. The guest heap stores this, never an OS
/// file descriptor or native pointer.
pub type HandleId = u64;

/// The five host-callback classifications.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum HostClass {
    /// Deterministic, no effect: not recorded.
    Pure,
    /// Reads nondeterministic state: recorded so replay returns the value.
    Read,
    /// A local effect that joins the worker's crank commit.
    Transactional,
    /// A non-transactional external effect, invoked only after commit.
    /// `idempotent` says whether the provider honors an idempotency key;
    /// without one it is inadmissible to a retryable worker.
    Outbound { idempotent: bool },
    /// Cannot be made replay-safe: recovery stops at it for an operator.
    Barrier,
}

impl HostClass {
    fn tag(self) -> &'static str {
        match self {
            HostClass::Pure => "pure",
            HostClass::Read => "read",
            HostClass::Transactional => "transactional",
            HostClass::Outbound { .. } => "outbound",
            HostClass::Barrier => "barrier",
        }
    }
}

/// Why a callback table was refused at worker startup.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AdmissionError {
    /// Callbacks registered with no classification.
    Unclassified(Vec<String>),
    /// Outbound providers with no idempotency protocol and no declared
    /// barrier.
    NonIdempotentOutbound(Vec<String>),
}

impl std::fmt::Display for AdmissionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AdmissionError::Unclassified(names) => write!(
                f,
                "retryable worker refuses unclassified host callbacks: {}",
                names.join(", ")
            ),
            AdmissionError::NonIdempotentOutbound(names) => write!(
                f,
                "retryable worker refuses non-idempotent outbound providers \
                 (add an idempotency protocol or declare a barrier): {}",
                names.join(", ")
            ),
        }
    }
}

impl std::error::Error for AdmissionError {}

/// The host callbacks a worker is built with, before admission.
#[derive(Clone, Debug, Default)]
pub struct CallbackRegistry {
    entries: BTreeMap<String, Option<HostClass>>,
}

impl CallbackRegistry {
    /// An empty registry.
    pub fn new() -> CallbackRegistry {
        CallbackRegistry::default()
    }

    /// Register `name` with its classification.
    pub fn classify(mut self, name: &str, class: HostClass) -> CallbackRegistry {
        self.entries.insert(name.to_string(), Some(class));
        self
    }

    /// Register `name` without a classification.
    pub fn unclassified(mut self, name: &str) -> CallbackRegistry {
        self.entries.insert(name.to_string(), None);
        self
    }

    /// Check the table at startup. A retryable worker refuses an
    /// unclassified callback and a non-idempotent outbound provider. A
    /// non-retryable worker admits everything, treating an unclassified
    /// callback as a barrier.
    pub fn admit(self, retryable: bool) -> Result<AdmittedCallbacks, AdmissionError> {
        if retryable {
            let unclassified: Vec<String> = self
                .entries
                .iter()
                .filter(|(_, c)| c.is_none())
                .map(|(n, _)| n.clone())
                .collect();
            if !unclassified.is_empty() {
                return Err(AdmissionError::Unclassified(unclassified));
            }
            let unsafe_outbound: Vec<String> = self
                .entries
                .iter()
                .filter(|(_, c)| **c == Some(HostClass::Outbound { idempotent: false }))
                .map(|(n, _)| n.clone())
                .collect();
            if !unsafe_outbound.is_empty() {
                return Err(AdmissionError::NonIdempotentOutbound(unsafe_outbound));
            }
        }
        Ok(AdmittedCallbacks {
            classes: self
                .entries
                .into_iter()
                .map(|(n, c)| (n, c.unwrap_or(HostClass::Barrier)))
                .collect(),
        })
    }
}

/// A callback table that passed admission.
#[derive(Clone, Debug)]
pub struct AdmittedCallbacks {
    classes: BTreeMap<String, HostClass>,
}

impl AdmittedCallbacks {
    /// The classification of `name`, if registered.
    pub fn class(&self, name: &str) -> Option<HostClass> {
        self.classes.get(name).copied()
    }
}

/// What an adapter returns from a live invocation.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct HostOutcome {
    /// The canonical reply (or failure) bytes returned to the guest.
    pub reply: Vec<u8>,
    /// `Some(descriptor)` if the call opened a native resource. The
    /// descriptor records enough authority and position to rebuild it;
    /// `None` inside means it cannot be rebuilt (a live socket).
    pub opens: Option<Option<Vec<u8>>>,
    /// Whether the call closed its target handle.
    pub closes: bool,
    /// Other handles the call closed along with its target: closing a
    /// database finalizes its statements.
    pub also_closes: Vec<HandleId>,
    /// `Some(descriptor)` replaces the target handle's reconstruction
    /// descriptor when the crank commits, so it tracks the committed
    /// position (a reader's offset, a hasher's fed bytes). `Some(None)`
    /// records that the resource can no longer be rebuilt.
    pub redescribes: Option<Option<Vec<u8>>>,
}

/// What the guest gets back from a host call.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum HostReply {
    /// The reply, and the logical id of a handle the call opened.
    Reply {
        reply: Vec<u8>,
        opened: Option<HandleId>,
    },
    /// An outbound effect staged for release after commit. Any answer from
    /// the provider arrives as a later inbound delivery.
    Deferred,
}

/// Why a host call was refused. None of these invoke the adapter.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum HostCallError {
    /// The callback is not in the admitted table.
    UnknownCallback(String),
    /// The target handle is not open.
    UnknownHandle(HandleId),
    /// The target handle was re-seated as broken: its native resource is
    /// gone and nothing may stand in for it.
    BrokenHandle(HandleId),
    /// The transcript refused the write.
    Transcript(TranscriptError),
}

impl From<TranscriptError> for HostCallError {
    fn from(e: TranscriptError) -> HostCallError {
        HostCallError::Transcript(e)
    }
}

/// A durable handle record.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HandleRecord {
    /// The logical id.
    pub handle: HandleId,
    /// The callback that opened it.
    pub callback: String,
    /// The `host-request` event that opened it.
    pub created_by: Seq,
    /// The reconstruction descriptor, if the resource can be rebuilt.
    pub descriptor: Option<Vec<u8>>,
    /// The derived open/closed cache.
    pub open: bool,
    /// Whether it was re-seated as broken.
    pub broken: bool,
}

/// What [`Transcript::reseat_handles`] did.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ReseatReport {
    /// Handles rebuilt from their descriptors.
    pub reseated: Vec<HandleId>,
    /// Handles re-seated as broken, with the reason.
    pub broken: Vec<(HandleId, String)>,
}

/// Why recovery or retry must stay stopped.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RecoveryStop {
    /// A barrier callback ran in a crank that never committed, so its
    /// effect may have escaped. An operator must clear it.
    EscapedBarrier {
        crank: CrankId,
        seq: Seq,
        callback: String,
    },
    /// Handles re-seated as broken and not yet replaced or reported lost.
    BrokenHandles(Vec<HandleId>),
}

/// Why replay stopped short.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ReplayStop {
    /// The recorded call is a barrier: replay halts here instead of
    /// re-invoking the effect.
    Barrier {
        crank: CrankId,
        seq: Seq,
        callback: String,
    },
    /// The replayed guest's call differs from the recorded one in callback,
    /// target handle, or request bytes: a deterministic replay fault.
    Mismatch { crank: CrankId, detail: String },
    /// The replayed call targets a handle re-seated as broken.
    BrokenHandle(HandleId),
}

/// One call staged in the active crank.
pub(crate) enum Staged {
    Call {
        callback: String,
        class: HostClass,
        handle: Option<HandleId>,
        request: Vec<u8>,
        /// Set for a barrier whose request row is already durable.
        request_seq: Option<Seq>,
        reply: Vec<u8>,
        opens: Option<(HandleId, Option<Vec<u8>>)>,
        closes: bool,
        also_closes: Vec<HandleId>,
        redescribes: Option<Option<Vec<u8>>>,
    },
    Effect {
        callback: String,
        request: Vec<u8>,
    },
    Loss {
        handle: HandleId,
    },
    Redescribe {
        handle: HandleId,
        descriptor: Option<Vec<u8>>,
    },
}

/// A committed outbound effect awaiting release to its provider.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReleasableEffect {
    /// The `host-effect` event sequence.
    pub seq: Seq,
    /// The crank that committed it.
    pub crank: CrankId,
    /// `<worker>:<seq>`: the provider's idempotency key.
    pub idempotency_key: String,
    /// The provider callback.
    pub callback: String,
    /// The request bytes.
    pub request: Vec<u8>,
}

pub(crate) const SCHEMA: &str = "
    CREATE TABLE IF NOT EXISTS host_call (
        request_seq INTEGER PRIMARY KEY,
        crank_id INTEGER NOT NULL,
        callback TEXT NOT NULL,
        class TEXT NOT NULL,
        handle_id INTEGER,
        reply_seq INTEGER,
        opened_handle INTEGER,
        closes INTEGER NOT NULL DEFAULT 0,
        cleared INTEGER NOT NULL DEFAULT 0
    ) STRICT;
    CREATE INDEX IF NOT EXISTS host_call_by_crank ON host_call (crank_id, request_seq);
    CREATE TABLE IF NOT EXISTS host_handle (
        handle_id INTEGER PRIMARY KEY,
        created_by_seq INTEGER NOT NULL,
        callback TEXT NOT NULL,
        descriptor BLOB,
        open INTEGER NOT NULL,
        broken INTEGER NOT NULL DEFAULT 0
    ) STRICT;";

fn insert_event(
    tx: &rusqlite::Transaction<'_>,
    crank: CrankId,
    kind: &str,
    payload: &[u8],
) -> rusqlite::Result<Seq> {
    tx.execute(
        "INSERT INTO event (crank_id, kind, payload) VALUES (?1, ?2, ?3)",
        params![crank as i64, kind, payload],
    )?;
    Ok(tx.last_insert_rowid() as Seq)
}

/// Write a crank's staged host calls inside its commit transaction.
pub(crate) fn commit_staged(
    tx: &rusqlite::Transaction<'_>,
    crank: CrankId,
    staged: &[Staged],
) -> rusqlite::Result<()> {
    for s in staged {
        match s {
            Staged::Call {
                callback,
                class,
                handle,
                request,
                request_seq,
                reply,
                opens,
                closes,
                also_closes,
                redescribes,
            } => {
                let request_seq = match request_seq {
                    Some(seq) => *seq,
                    None => {
                        let seq = insert_event(tx, crank, "host-request", request)?;
                        tx.execute(
                            "INSERT INTO host_call (request_seq, crank_id, callback, class, handle_id)
                             VALUES (?1, ?2, ?3, ?4, ?5)",
                            params![seq as i64, crank as i64, callback, class.tag(), handle.map(|h| h as i64)],
                        )?;
                        seq
                    }
                };
                let reply_seq = insert_event(tx, crank, "host-reply", reply)?;
                tx.execute(
                    "UPDATE host_call SET reply_seq = ?1, opened_handle = ?2, closes = ?3
                     WHERE request_seq = ?4",
                    params![
                        reply_seq as i64,
                        opens.as_ref().map(|(h, _)| *h as i64),
                        *closes as i64,
                        request_seq as i64
                    ],
                )?;
                if let Some((h, descriptor)) = opens {
                    tx.execute(
                        "INSERT INTO host_handle (handle_id, created_by_seq, callback, descriptor, open)
                         VALUES (?1, ?2, ?3, ?4, 1)",
                        params![*h as i64, request_seq as i64, callback, descriptor],
                    )?;
                }
                if let (Some(descriptor), Some(h)) = (redescribes, handle) {
                    tx.execute(
                        "UPDATE host_handle SET descriptor = ?1 WHERE handle_id = ?2",
                        params![descriptor, *h as i64],
                    )?;
                }
                let target = handle.filter(|_| *closes);
                for h in target.iter().chain(also_closes) {
                    tx.execute(
                        "UPDATE host_handle SET open = 0 WHERE handle_id = ?1",
                        [*h as i64],
                    )?;
                }
            }
            Staged::Effect { callback, request } => {
                let seq = insert_event(tx, crank, "host-effect", request)?;
                tx.execute(
                    "INSERT INTO host_call (request_seq, crank_id, callback, class)
                     VALUES (?1, ?2, ?3, 'outbound')",
                    params![seq as i64, crank as i64, callback],
                )?;
            }
            Staged::Loss { handle } => {
                tx.execute(
                    "UPDATE host_handle SET open = 0, broken = 0 WHERE handle_id = ?1",
                    [*handle as i64],
                )?;
            }
            Staged::Redescribe { handle, descriptor } => {
                tx.execute(
                    "UPDATE host_handle SET descriptor = ?1 WHERE handle_id = ?2",
                    params![descriptor, *handle as i64],
                )?;
            }
        }
    }
    Ok(())
}

impl Transcript {
    fn handle_row(&self, handle: HandleId) -> Result<Option<HandleRecord>, TranscriptError> {
        self.connection
            .query_row(
                "SELECT handle_id, callback, created_by_seq, descriptor, open, broken
                 FROM host_handle WHERE handle_id = ?1",
                [handle as i64],
                read_handle,
            )
            .optional()
            .map_err(|e| self.read_error(&e))
    }

    /// Every handle the log says is open, including broken ones.
    pub fn open_handles(&self) -> Result<Vec<HandleRecord>, TranscriptError> {
        let read = || -> rusqlite::Result<Vec<HandleRecord>> {
            let mut statement = self.connection.prepare(
                "SELECT handle_id, callback, created_by_seq, descriptor, open, broken
                 FROM host_handle WHERE open = 1 ORDER BY handle_id",
            )?;
            let rows = statement.query_map([], read_handle)?;
            rows.collect()
        };
        read().map_err(|e| self.read_error(&e))
    }

    /// Whether `handle` is open (and not broken) as of the active crank's
    /// staged calls.
    fn live_handle_state(&self, handle: HandleId) -> Result<HandleState, TranscriptError> {
        if let Some(active) = &self.active {
            for s in active.host.iter().rev() {
                match s {
                    Staged::Call {
                        handle: Some(h),
                        closes: true,
                        ..
                    } if *h == handle => return Ok(HandleState::Closed),
                    Staged::Call { also_closes, .. } if also_closes.contains(&handle) => {
                        return Ok(HandleState::Closed)
                    }
                    Staged::Call {
                        opens: Some((h, _)),
                        ..
                    } if *h == handle => return Ok(HandleState::Open),
                    Staged::Loss { handle: h } if *h == handle => return Ok(HandleState::Closed),
                    _ => {}
                }
            }
        }
        Ok(match self.handle_row(handle)? {
            Some(r) if r.open && r.broken => HandleState::Broken,
            Some(r) if r.open => HandleState::Open,
            _ => HandleState::Closed,
        })
    }

    fn next_handle_id(&self) -> Result<HandleId, TranscriptError> {
        let durable: i64 = self
            .connection
            .query_row(
                "SELECT COALESCE(MAX(handle_id), 0) FROM host_handle",
                [],
                |r| r.get(0),
            )
            .map_err(|e| self.read_error(&e))?;
        let staged = self.active.as_ref().map_or(0, |a| {
            a.host
                .iter()
                .filter(|s| matches!(s, Staged::Call { opens: Some(_), .. }))
                .count()
        });
        Ok(durable as HandleId + staged as HandleId + 1)
    }

    /// Make a host call during the active crank. `invoke` runs the live
    /// adapter; it is never called for an outbound effect (deferred until
    /// after commit) or for a broken or closed target handle.
    pub fn host_call(
        &mut self,
        callbacks: &AdmittedCallbacks,
        callback: &str,
        handle: Option<HandleId>,
        request: &[u8],
        invoke: impl FnOnce(&[u8]) -> HostOutcome,
    ) -> Result<HostReply, HostCallError> {
        self.check_healthy()?;
        let Some(crank) = self.active_crank() else {
            return Err(TranscriptError::Protocol("no active crank".into()).into());
        };
        let Some(class) = callbacks.class(callback) else {
            return Err(HostCallError::UnknownCallback(callback.to_string()));
        };
        if let Some(h) = handle {
            match self.live_handle_state(h)? {
                HandleState::Open => {}
                HandleState::Broken => return Err(HostCallError::BrokenHandle(h)),
                HandleState::Closed => return Err(HostCallError::UnknownHandle(h)),
            }
        }
        if let HostClass::Outbound { .. } = class {
            self.active
                .as_mut()
                .expect("active crank")
                .host
                .push(Staged::Effect {
                    callback: callback.to_string(),
                    request: request.to_vec(),
                });
            return Ok(HostReply::Deferred);
        }
        // A barrier's request is durable before the effect runs.
        let request_seq = if class == HostClass::Barrier {
            let cb = callback.to_string();
            Some(self.transact(Operation::Commit, Some(crank), |tx| {
                let seq = insert_event(tx, crank, "host-request", request)?;
                tx.execute(
                    "INSERT INTO host_call (request_seq, crank_id, callback, class, handle_id)
                     VALUES (?1, ?2, ?3, 'barrier', ?4)",
                    params![seq as i64, crank as i64, cb, handle.map(|h| h as i64)],
                )?;
                Ok(seq)
            })?)
        } else {
            None
        };
        let outcome = invoke(request);
        if class == HostClass::Pure {
            return Ok(HostReply::Reply {
                reply: outcome.reply,
                opened: None,
            });
        }
        let opened = match outcome.opens {
            Some(descriptor) => Some((self.next_handle_id()?, descriptor)),
            None => None,
        };
        let opened_id = opened.as_ref().map(|(h, _)| *h);
        self.active
            .as_mut()
            .expect("active crank")
            .host
            .push(Staged::Call {
                callback: callback.to_string(),
                class,
                handle,
                request: request.to_vec(),
                request_seq,
                reply: outcome.reply.clone(),
                opens: opened,
                closes: outcome.closes,
                also_closes: outcome.also_closes,
                redescribes: outcome.redescribes,
            });
        Ok(HostReply::Reply {
            reply: outcome.reply,
            opened: opened_id,
        })
    }

    /// Committed outbound effects not yet acknowledged, in sequence order.
    /// Invoke each provider with its idempotency key, then acknowledge
    /// with [`Transcript::mark_released`].
    pub fn releasable_effects(&self) -> Result<Vec<ReleasableEffect>, TranscriptError> {
        let read = || -> rusqlite::Result<Vec<ReleasableEffect>> {
            let mut statement = self.connection.prepare(
                "SELECT e.seq, e.crank_id, h.callback, e.payload FROM event e
                 JOIN crank c ON c.crank_id = e.crank_id
                 JOIN host_call h ON h.request_seq = e.seq
                 WHERE e.kind = 'host-effect' AND e.released = 0 AND c.state = 'committed'
                 ORDER BY e.seq",
            )?;
            let rows = statement.query_map([], |r| {
                let seq = r.get::<_, i64>(0)? as Seq;
                Ok(ReleasableEffect {
                    seq,
                    crank: r.get::<_, i64>(1)? as CrankId,
                    idempotency_key: format!("{}:{seq}", self.worker),
                    callback: r.get(2)?,
                    request: r.get(3)?,
                })
            })?;
            rows.collect()
        };
        read().map_err(|e| self.read_error(&e))
    }

    /// On restart, rebuild every open handle from its descriptor through
    /// `reconstruct`. A handle with no descriptor, or whose reconstruction
    /// fails, is durably re-seated as broken.
    pub fn reseat_handles(
        &mut self,
        mut reconstruct: impl FnMut(&HandleRecord) -> Result<(), String>,
    ) -> Result<ReseatReport, TranscriptError> {
        self.check_healthy()?;
        let mut report = ReseatReport::default();
        for record in self.open_handles()? {
            let outcome = match &record.descriptor {
                None => Err("no reconstruction descriptor".to_string()),
                Some(_) => reconstruct(&record),
            };
            match outcome {
                Ok(()) => report.reseated.push(record.handle),
                Err(reason) => report.broken.push((record.handle, reason)),
            }
        }
        let broken: Vec<HandleId> = report.broken.iter().map(|(h, _)| *h).collect();
        let reseated = report.reseated.clone();
        self.transact(Operation::Recover, None, |tx| {
            for h in &broken {
                tx.execute(
                    "UPDATE host_handle SET broken = 1 WHERE handle_id = ?1",
                    [*h as i64],
                )?;
            }
            for h in &reseated {
                tx.execute(
                    "UPDATE host_handle SET broken = 0 WHERE handle_id = ?1",
                    [*h as i64],
                )?;
            }
            Ok(())
        })?;
        Ok(report)
    }

    /// The adapter supplies a replacement for a broken handle under the
    /// same logical id. The new descriptor is recorded only if `reconstruct`
    /// rebuilds the resource from it.
    pub fn supply_replacement(
        &mut self,
        handle: HandleId,
        descriptor: Vec<u8>,
        reconstruct: impl FnOnce(&HandleRecord) -> Result<(), String>,
    ) -> Result<(), TranscriptError> {
        self.check_healthy()?;
        let Some(mut record) = self.handle_row(handle)?.filter(|r| r.open && r.broken) else {
            return Err(TranscriptError::Protocol(format!(
                "handle {handle} is not broken"
            )));
        };
        record.descriptor = Some(descriptor.clone());
        reconstruct(&record).map_err(|e| {
            TranscriptError::Protocol(format!("replacement for handle {handle} failed: {e}"))
        })?;
        self.transact(Operation::Recover, None, |tx| {
            tx.execute(
                "UPDATE host_handle SET descriptor = ?1, broken = 0 WHERE handle_id = ?2",
                params![descriptor, handle as i64],
            )
        })?;
        Ok(())
    }

    /// Within the active crank, which delivers a notice of the loss to the
    /// application, record that a broken handle is gone. Commit closes it.
    pub fn acknowledge_loss(&mut self, handle: HandleId) -> Result<(), TranscriptError> {
        self.check_healthy()?;
        if self.live_handle_state(handle)? != HandleState::Broken {
            return Err(TranscriptError::Protocol(format!(
                "handle {handle} is not broken"
            )));
        }
        let Some(active) = &mut self.active else {
            return Err(TranscriptError::Protocol(
                "a loss is acknowledged by the crank that delivers it".into(),
            ));
        };
        active.host.push(Staged::Loss { handle });
        Ok(())
    }

    /// Within the active crank, replace an open handle's descriptor as of
    /// commit. A handle whose state accumulates over many calls in one crank
    /// (an incremental hasher) describes itself once here instead of on
    /// every call, so the staged descriptors stay linear in its state.
    pub fn redescribe(
        &mut self,
        handle: HandleId,
        descriptor: Option<Vec<u8>>,
    ) -> Result<(), TranscriptError> {
        self.check_healthy()?;
        if self.live_handle_state(handle)? != HandleState::Open {
            return Err(TranscriptError::Protocol(format!(
                "handle {handle} is not open"
            )));
        }
        let Some(active) = &mut self.active else {
            return Err(TranscriptError::Protocol(
                "a handle is redescribed within a crank".into(),
            ));
        };
        active.host.push(Staged::Redescribe { handle, descriptor });
        Ok(())
    }

    /// Whether replay or retry may proceed. Stays stopped while a barrier
    /// ran in a crank that never committed, or while any handle is broken.
    pub fn recovery_gate(&self) -> Result<Result<(), RecoveryStop>, TranscriptError> {
        let escaped = self
            .connection
            .query_row(
                "SELECT h.crank_id, h.request_seq, h.callback FROM host_call h
                 JOIN crank c ON c.crank_id = h.crank_id
                 WHERE h.class = 'barrier' AND h.cleared = 0 AND c.state != 'committed'
                 ORDER BY h.request_seq LIMIT 1",
                [],
                |r| {
                    Ok(RecoveryStop::EscapedBarrier {
                        crank: r.get::<_, i64>(0)? as CrankId,
                        seq: r.get::<_, i64>(1)? as Seq,
                        callback: r.get(2)?,
                    })
                },
            )
            .optional()
            .map_err(|e| self.read_error(&e))?;
        if let Some(stop) = escaped {
            return Ok(Err(stop));
        }
        let broken: Vec<HandleId> = self
            .open_handles()?
            .into_iter()
            .filter(|r| r.broken)
            .map(|r| r.handle)
            .collect();
        if !broken.is_empty() {
            return Ok(Err(RecoveryStop::BrokenHandles(broken)));
        }
        Ok(Ok(()))
    }

    /// An operator's intervention: mark a barrier as handled so recovery may
    /// proceed past it.
    pub fn clear_barrier(&mut self, seq: Seq) -> Result<(), TranscriptError> {
        self.check_healthy()?;
        let changed = self.transact(Operation::Recover, None, |tx| {
            tx.execute(
                "UPDATE host_call SET cleared = 1 WHERE request_seq = ?1 AND class = 'barrier'",
                [seq as i64],
            )
        })?;
        if changed != 1 {
            return Err(TranscriptError::Protocol(format!(
                "no barrier at seq {seq}"
            )));
        }
        Ok(())
    }

    /// The recorded host calls of the committed suffix after the latest
    /// snapshot, for replay.
    pub fn host_replay(&self) -> Result<HostReplay, TranscriptError> {
        let watermark = self.latest_snapshot()?.map_or(0, |s| s.watermark_crank);
        let read = || -> rusqlite::Result<BTreeMap<CrankId, VecDeque<Recorded>>> {
            let mut statement = self.connection.prepare(
                "SELECT h.crank_id, h.request_seq, h.callback, h.class, h.handle_id,
                        req.payload, rep.payload, h.opened_handle, h.cleared
                 FROM host_call h
                 JOIN crank c ON c.crank_id = h.crank_id
                 JOIN event req ON req.seq = h.request_seq
                 LEFT JOIN event rep ON rep.seq = h.reply_seq
                 WHERE c.state = 'committed' AND h.crank_id > ?1
                 ORDER BY h.request_seq",
            )?;
            let rows = statement.query_map([watermark as i64], |r| {
                Ok(Recorded {
                    crank: r.get::<_, i64>(0)? as CrankId,
                    seq: r.get::<_, i64>(1)? as Seq,
                    callback: r.get(2)?,
                    class: r.get(3)?,
                    handle: r.get::<_, Option<i64>>(4)?.map(|h| h as HandleId),
                    request: r.get(5)?,
                    reply: r.get(6)?,
                    opened: r.get::<_, Option<i64>>(7)?.map(|h| h as HandleId),
                    cleared: r.get::<_, i64>(8)? != 0,
                })
            })?;
            let mut by_crank: BTreeMap<CrankId, VecDeque<Recorded>> = BTreeMap::new();
            for row in rows {
                let row = row?;
                by_crank.entry(row.crank).or_default().push_back(row);
            }
            Ok(by_crank)
        };
        let calls = read().map_err(|e| self.read_error(&e))?;
        let broken = self
            .open_handles()?
            .into_iter()
            .filter(|r| r.broken)
            .map(|r| r.handle)
            .collect();
        Ok(HostReplay {
            calls,
            current: None,
            broken,
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum HandleState {
    Open,
    Broken,
    Closed,
}

fn read_handle(r: &rusqlite::Row<'_>) -> rusqlite::Result<HandleRecord> {
    Ok(HandleRecord {
        handle: r.get::<_, i64>(0)? as HandleId,
        callback: r.get(1)?,
        created_by: r.get::<_, i64>(2)? as Seq,
        descriptor: r.get(3)?,
        open: r.get::<_, i64>(4)? != 0,
        broken: r.get::<_, i64>(5)? != 0,
    })
}

#[derive(Clone, Debug)]
struct Recorded {
    crank: CrankId,
    seq: Seq,
    callback: String,
    class: String,
    handle: Option<HandleId>,
    request: Vec<u8>,
    reply: Option<Vec<u8>>,
    opened: Option<HandleId>,
    cleared: bool,
}

/// Replays recorded host calls for the committed suffix. No adapter is
/// invoked: every reply comes from the transcript.
#[derive(Debug)]
pub struct HostReplay {
    calls: BTreeMap<CrankId, VecDeque<Recorded>>,
    current: Option<(CrankId, VecDeque<Recorded>)>,
    broken: std::collections::BTreeSet<HandleId>,
}

impl HostReplay {
    /// The committed cranks whose host calls are still to be replayed, in
    /// order.
    pub fn cranks(&self) -> Vec<CrankId> {
        self.calls.keys().copied().collect()
    }

    /// Start replaying `crank`'s delivery.
    pub fn begin_crank(&mut self, crank: CrankId) {
        let calls = self.calls.remove(&crank).unwrap_or_default();
        self.current = Some((crank, calls));
    }

    /// Answer the replayed guest's host call from the record. A pure call
    /// is not recorded and must be re-run by the caller, so it never
    /// reaches here.
    pub fn call(
        &mut self,
        callback: &str,
        handle: Option<HandleId>,
        request: &[u8],
    ) -> Result<HostReply, ReplayStop> {
        let Some((crank, queue)) = &mut self.current else {
            return Err(ReplayStop::Mismatch {
                crank: 0,
                detail: "host call outside a replayed crank".into(),
            });
        };
        let crank = *crank;
        if let Some(h) = handle {
            if self.broken.contains(&h) {
                return Err(ReplayStop::BrokenHandle(h));
            }
        }
        let Some(record) = queue.pop_front() else {
            return Err(ReplayStop::Mismatch {
                crank,
                detail: format!("unrecorded host call to {callback}"),
            });
        };
        if record.callback != callback || record.handle != handle || record.request != request {
            return Err(ReplayStop::Mismatch {
                crank,
                detail: format!(
                    "recorded {}({:?}) at seq {}, replayed {callback}({handle:?})",
                    record.callback, record.handle, record.seq
                ),
            });
        }
        if record.class == "barrier" && !record.cleared {
            return Err(ReplayStop::Barrier {
                crank,
                seq: record.seq,
                callback: record.callback,
            });
        }
        if record.class == "outbound" {
            return Ok(HostReply::Deferred);
        }
        Ok(HostReply::Reply {
            reply: record.reply.unwrap_or_default(),
            opened: record.opened,
        })
    }

    /// Finish the replayed crank: every recorded call must have been
    /// consumed.
    pub fn end_crank(&mut self) -> Result<(), ReplayStop> {
        match self.current.take() {
            Some((crank, queue)) if !queue.is_empty() => Err(ReplayStop::Mismatch {
                crank,
                detail: format!("{} recorded host calls not replayed", queue.len()),
            }),
            _ => Ok(()),
        }
    }
}
