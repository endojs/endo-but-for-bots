//! The top-level SlotMachine: kref registry + session table +
//! refcounts + GC worklists, behind a single `Mutex` for now.
//!
//! The locking strategy is deliberately simple — one coarse mutex
//! around mutable state.  The hot path is a few hash-map lookups
//! per translated slot, so this isn't a bottleneck in the daemon's
//! message-routing loop; if it becomes one, the table can be sharded
//! per session without changing the public API.

use std::collections::HashMap;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::error::{Result, SlotError};
use crate::gc::{RetireReport, Worklists};
use crate::kref::{Kref, KrefAllocator};
use crate::promise::PromiseState;
use crate::refcount::{Pillar, RefTable};
use crate::session::{Session, SessionId};
use crate::vref::{Vref, VrefType};

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq, Serialize, Deserialize)]
pub enum KrefKind {
    Object,
    Promise,
    Answer,
    Device,
}

impl KrefKind {
    pub fn from_type(t: VrefType) -> Self {
        match t {
            VrefType::Object => KrefKind::Object,
            VrefType::Promise => KrefKind::Promise,
            VrefType::Answer => KrefKind::Answer,
            VrefType::Device => KrefKind::Device,
        }
    }

    pub fn to_type(self) -> VrefType {
        match self {
            KrefKind::Object => VrefType::Object,
            KrefKind::Promise => VrefType::Promise,
            KrefKind::Answer => VrefType::Answer,
            KrefKind::Device => VrefType::Device,
        }
    }
}

#[derive(Clone, Debug)]
pub struct KrefEntry {
    pub kref: Kref,
    pub kind: KrefKind,
    /// Optional durable back-pointer into Endo's formula graph
    /// (`"<hex64>:<hex64>"` by convention, but opaque to slot-machine).
    pub formula_id: Option<String>,
    /// Owning session, if known.  Used to route messages to the
    /// worker that hosts the underlying object.
    pub owner: Option<SessionId>,
}

/// Outcome of a cross-session translate: the caller gets the vref to
/// write into the outbound message plus a hint about whether it's a
/// freshly-allocated export (so they can bump pillars appropriately).
#[derive(Clone, Debug)]
pub struct TranslateOutcome {
    pub vref: Vref,
    pub kref: Kref,
    pub newly_exported: bool,
}

#[derive(Debug, Default)]
struct Inner {
    krefs: HashMap<Kref, KrefEntry>,
    sessions: HashMap<SessionId, Session>,
    refs: RefTable,
    worklists: Worklists,
    promises: HashMap<Kref, PromiseState>,
    /// Cross-session index: kref → set of session IDs that hold it.
    /// Kept in lockstep with each session's `vref_to_kref`.
    residents: HashMap<Kref, Vec<SessionId>>,
}

pub struct SlotMachine {
    inner: Mutex<Inner>,
    allocator: KrefAllocator,
}

impl SlotMachine {
    pub fn new() -> Self {
        SlotMachine { inner: Mutex::new(Inner::default()), allocator: KrefAllocator::new() }
    }

    /// Register a fresh session.  Idempotent: re-opening an existing
    /// session keeps its c-list intact so resumed workers see the
    /// identities they held before suspension.
    pub fn open_session(&self, id: SessionId, label: &str) -> Result<()> {
        let mut inner = self.lock();
        inner.sessions.entry(id).or_insert_with(|| Session::new(id, label));
        Ok(())
    }

    /// Pre-bind a `(session, vref)` pair to an existing kref without
    /// allocating a fresh one and without bumping pillars.  Used by
    /// the supervisor's bootstrap-handshake pre-registration to
    /// establish the position-1 root convention before any wire
    /// traffic.  Returns `Conflict` if the pair is already bound to
    /// a different kref.
    pub fn bind_session_kref(
        &self,
        session: SessionId,
        vref: &Vref,
        kref: Kref,
    ) -> Result<()> {
        let mut inner = self.lock();
        let s = inner
            .sessions
            .get_mut(&session)
            .ok_or_else(|| SlotError::NotFound(format!("session {}", hex::encode(session.0))))?;
        s.bind(vref, kref)?;
        let residents = inner.residents.entry(kref).or_default();
        if !residents.contains(&session) {
            residents.push(session);
        }
        Ok(())
    }

    /// Allocate a fresh kref and bind it as `session`'s `Local`
    /// export of the given vref, recording the session as the owner.
    /// Equivalent to `receive(session, &local_vref)` for a vref the
    /// session has not yet exported, but exposed as a public API for
    /// the supervisor's bootstrap pre-registration.  Idempotent: if
    /// the vref is already bound, returns the existing kref.
    pub fn intern_local(
        &self,
        session: SessionId,
        vref: &Vref,
    ) -> Result<Kref> {
        let mut inner = self.lock();
        let s = inner
            .sessions
            .get_mut(&session)
            .ok_or_else(|| SlotError::NotFound(format!("session {}", hex::encode(session.0))))?;
        if let Some(k) = s.kref_for_vref(vref) {
            return Ok(k);
        }
        let kref = self.allocator.alloc();
        let kind = KrefKind::from_type(vref.ty);
        s.bind(vref, kref)?;
        inner.krefs.insert(
            kref,
            KrefEntry {
                kref,
                kind,
                formula_id: None,
                owner: Some(session),
            },
        );
        inner.residents.entry(kref).or_default().push(session);
        let counts = inner.refs.entry_mut(kref);
        counts.inc(Pillar::CList, 1);
        Ok(kref)
    }

    /// Drop an entire session: every c-list row goes away and each
    /// kref loses one CList pillar.  Returns the list of krefs that
    /// became retirable as a result.
    pub fn close_session(&self, id: SessionId) -> Result<RetireReport> {
        let mut inner = self.lock();
        let session = match inner.sessions.remove(&id) {
            Some(s) => s,
            None => return Ok(RetireReport::new()),
        };
        let krefs: Vec<Kref> = session.entries().map(|(_, k)| k).collect();
        let mut report = RetireReport::new();
        for k in krefs {
            Self::unlink_resident(&mut inner, k, id);
            // If this session is the owner, it contributed only a
            // CList pillar when receive() allocated the kref; any
            // other session contributed CList+Export via send().
            let is_owner = inner
                .krefs
                .get(&k)
                .and_then(|e| e.owner)
                .map(|o| o == id)
                .unwrap_or(false);
            let counts = inner.refs.entry_mut(k);
            counts.dec(Pillar::CList, 1);
            if !is_owner {
                counts.dec(Pillar::Export, 1);
            }
            if counts.is_zero() {
                Self::retire(&mut inner, k);
                report.push_retired(k);
            } else {
                report.push_still_live(k);
            }
        }
        Ok(report)
    }

    /// Translate a vref that has just arrived *from* `from`.  If the
    /// vref is unknown on that session, allocate a new kref and
    /// record it as an import (the kref's kind follows the vref's
    /// type, the session becomes a resident of the kref).
    pub fn receive(
        &self,
        from: SessionId,
        vref: &Vref,
    ) -> Result<Kref> {
        let mut inner = self.lock();
        let session = inner
            .sessions
            .get_mut(&from)
            .ok_or_else(|| SlotError::NotFound(format!("session {}", hex::encode(from.0))))?;
        if let Some(k) = session.kref_for_vref(vref) {
            let counts = inner.refs.entry_mut(k);
            counts.inc(Pillar::Ram, 1);
            return Ok(k);
        }
        let kref = self.allocator.alloc();
        let kind = KrefKind::from_type(vref.ty);
        session.bind(vref, kref)?;
        // Wire up indices.
        inner.krefs.insert(
            kref,
            KrefEntry { kref, kind, formula_id: None, owner: if vref.is_local() { Some(from) } else { None } },
        );
        inner.residents.entry(kref).or_default().push(from);
        let counts = inner.refs.entry_mut(kref);
        counts.inc(Pillar::Ram, 1);
        counts.inc(Pillar::CList, 1);
        Ok(kref)
    }

    /// Translate a kref for transmission *to* `to`.  If the session
    /// already has a binding, return it; otherwise allocate a local
    /// vref in that session and record the new binding.
    pub fn send(&self, to: SessionId, kref: Kref) -> Result<TranslateOutcome> {
        let mut inner = self.lock();
        let kind = inner
            .krefs
            .get(&kref)
            .ok_or_else(|| SlotError::NotFound(format!("kref {kref}")))?
            .kind;
        let session = inner
            .sessions
            .get_mut(&to)
            .ok_or_else(|| SlotError::NotFound(format!("session {}", hex::encode(to.0))))?;
        if let Some(v) = session.vref_for_kref(kref) {
            let counts = inner.refs.entry_mut(kref);
            counts.inc(Pillar::Export, 1);
            return Ok(TranslateOutcome { vref: v, kref, newly_exported: false });
        }
        let vref = session.alloc_local(kind.to_type());
        session.bind(&vref, kref)?;
        inner.residents.entry(kref).or_default().push(to);
        let counts = inner.refs.entry_mut(kref);
        counts.inc(Pillar::CList, 1);
        counts.inc(Pillar::Export, 1);
        Ok(TranslateOutcome { vref, kref, newly_exported: true })
    }

    /// Drop a single RAM-pillar reference for a kref from a session.
    /// Called when a worker tells us it has released the capability.
    pub fn drop_ram(&self, _session: SessionId, kref: Kref, delta: u64) -> Result<()> {
        let mut inner = self.lock();
        let counts = inner.refs.entry_mut(kref);
        counts.dec(Pillar::Ram, delta);
        if counts.get(Pillar::Ram) == 0 {
            inner.worklists.mark_possibly_dead(kref);
        }
        Ok(())
    }

    /// Drop a CList pillar for one session's entry, removing that
    /// session's c-list row.  Mirrors OCapN's `op:gc-export` wire
    /// delta from the sender's point of view.
    pub fn drop_clist(&self, session: SessionId, kref: Kref, wire_delta: u64) -> Result<()> {
        let mut inner = self.lock();
        if let Some(s) = inner.sessions.get_mut(&session) {
            let _ = s.drop_kref(kref);
        }
        Self::unlink_resident(&mut inner, kref, session);
        let counts = inner.refs.entry_mut(kref);
        counts.dec(Pillar::CList, 1);
        counts.dec(Pillar::Export, wire_delta);
        if counts.is_zero() {
            Self::retire(&mut inner, kref);
        } else if counts.get(Pillar::CList) == 0 {
            inner.worklists.mark_possibly_retired(kref);
        }
        Ok(())
    }

    pub fn bump(&self, kref: Kref, pillar: Pillar, delta: u64) -> Result<u64> {
        let mut inner = self.lock();
        let counts = inner.refs.entry_mut(kref);
        Ok(counts.inc(pillar, delta))
    }

    pub fn kref_entry(&self, kref: Kref) -> Option<KrefEntry> {
        self.lock().krefs.get(&kref).cloned()
    }

    pub fn kref_for_session_vref(&self, session: SessionId, vref: &Vref) -> Option<Kref> {
        self.lock().sessions.get(&session).and_then(|s| s.kref_for_vref(vref))
    }

    pub fn vref_for_session_kref(&self, session: SessionId, kref: Kref) -> Option<Vref> {
        self.lock().sessions.get(&session).and_then(|s| s.vref_for_kref(kref))
    }

    pub fn set_formula_id(&self, kref: Kref, formula_id: String) -> Result<()> {
        let mut inner = self.lock();
        let entry = inner
            .krefs
            .get_mut(&kref)
            .ok_or_else(|| SlotError::NotFound(format!("kref {kref}")))?;
        entry.formula_id = Some(formula_id);
        Ok(())
    }

    pub fn set_owner(&self, kref: Kref, owner: SessionId) -> Result<()> {
        let mut inner = self.lock();
        let entry = inner
            .krefs
            .get_mut(&kref)
            .ok_or_else(|| SlotError::NotFound(format!("kref {kref}")))?;
        entry.owner = Some(owner);
        Ok(())
    }

    /// Bind a fresh kref to a known formula ID (durable capability).
    /// If a kref already exists for that formula, return it instead.
    pub fn intern_formula(&self, formula_id: &str, kind: KrefKind) -> Kref {
        let mut inner = self.lock();
        for entry in inner.krefs.values() {
            if entry.formula_id.as_deref() == Some(formula_id) {
                return entry.kref;
            }
        }
        let kref = self.allocator.alloc();
        inner.krefs.insert(
            kref,
            KrefEntry { kref, kind, formula_id: Some(formula_id.to_string()), owner: None },
        );
        kref
    }

    pub fn set_promise_state(&self, kref: Kref, state: PromiseState) {
        self.lock().promises.insert(kref, state);
    }

    pub fn promise_state(&self, kref: Kref) -> Option<PromiseState> {
        self.lock().promises.get(&kref).cloned()
    }

    pub fn drain_possibly_dead(&self) -> Vec<Kref> {
        self.lock().worklists.drain_possibly_dead()
    }

    pub fn drain_possibly_retired(&self) -> Vec<Kref> {
        self.lock().worklists.drain_possibly_retired()
    }

    pub fn sessions_holding(&self, kref: Kref) -> Vec<SessionId> {
        self.lock().residents.get(&kref).cloned().unwrap_or_default()
    }

    fn unlink_resident(inner: &mut Inner, kref: Kref, session: SessionId) {
        if let Some(v) = inner.residents.get_mut(&kref) {
            v.retain(|s| *s != session);
            if v.is_empty() {
                inner.residents.remove(&kref);
            }
        }
    }

    fn retire(inner: &mut Inner, kref: Kref) {
        inner.krefs.remove(&kref);
        inner.refs.remove(kref);
        inner.residents.remove(&kref);
        inner.promises.remove(&kref);
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    // ---- Accessors used by the persistence layer ----

    pub(crate) fn snapshot_for_store(&self) -> StoreSnapshot {
        let inner = self.lock();
        let allocator_next = self.allocator.peek();
        let mut krefs = Vec::with_capacity(inner.krefs.len());
        for entry in inner.krefs.values() {
            let counts = inner.refs.get(entry.kref);
            krefs.push((entry.clone(), counts));
        }
        let mut sessions = Vec::with_capacity(inner.sessions.len());
        for (id, sess) in inner.sessions.iter() {
            let counters = sess.counters();
            let entries: Vec<(String, Kref)> =
                sess.entries().map(|(v, k)| (v.to_string(), k)).collect();
            sessions.push((*id, sess.label().to_string(), counters, entries));
        }
        let promises = inner.promises.iter().map(|(k, s)| (*k, s.clone())).collect();
        StoreSnapshot { allocator_next, krefs, sessions, promises }
    }

    pub(crate) fn install_snapshot(&self, snap: StoreSnapshot) {
        let mut inner = self.lock();
        *inner = Inner::default();
        self.allocator_reseat(snap.allocator_next);
        for (entry, counts) in snap.krefs {
            let kref = entry.kref;
            inner.krefs.insert(kref, entry);
            let cell = inner.refs.entry_mut(kref);
            cell.set(Pillar::Ram, counts.get(Pillar::Ram));
            cell.set(Pillar::CList, counts.get(Pillar::CList));
            cell.set(Pillar::Export, counts.get(Pillar::Export));
        }
        for (id, label, counters, entries) in snap.sessions {
            let sess = Session::restore(id, label, counters, entries.iter().cloned());
            for (_, k) in &entries {
                inner.residents.entry(*k).or_default().push(id);
            }
            inner.sessions.insert(id, sess);
        }
        for (k, s) in snap.promises {
            inner.promises.insert(k, s);
        }
    }

    fn allocator_reseat(&self, next: u64) {
        // Replace the interior counter by spinning it up with
        // compare_exchange; since this is test-only on a fresh state,
        // a simple store is fine in practice.
        let cur = self.allocator.peek();
        if next > cur {
            for _ in cur..next {
                let _ = self.allocator.alloc();
            }
        }
    }
}

impl Default for SlotMachine {
    fn default() -> Self {
        Self::new()
    }
}

/// Bundle of durable state that [`crate::store::SlotStore`] serializes
/// to SQLite.  Not part of the public API.
pub(crate) struct StoreSnapshot {
    pub(crate) allocator_next: u64,
    pub(crate) krefs: Vec<(KrefEntry, crate::refcount::RefCounts)>,
    pub(crate) sessions: Vec<(
        SessionId,
        String,
        crate::session::NextCounters,
        Vec<(String, Kref)>,
    )>,
    pub(crate) promises: Vec<(Kref, PromiseState)>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session_id(label: &str) -> SessionId {
        SessionId::from_label(label)
    }

    #[test]
    fn receive_allocates_kref_on_first_sight() {
        let m = SlotMachine::new();
        let a = session_id("a");
        m.open_session(a, "a").unwrap();
        let v = Vref::object_local(1);
        let k1 = m.receive(a, &v).unwrap();
        let k2 = m.receive(a, &v).unwrap();
        assert_eq!(k1, k2);
    }

    #[test]
    fn send_translates_through_unified_kref() {
        let m = SlotMachine::new();
        let a = session_id("a");
        let b = session_id("b");
        m.open_session(a, "a").unwrap();
        m.open_session(b, "b").unwrap();
        let from_a = Vref::object_local(7);
        let kref = m.receive(a, &from_a).unwrap();
        let out = m.send(b, kref).unwrap();
        assert!(out.newly_exported);
        assert_eq!(out.vref.ty, VrefType::Object);
        assert!(out.vref.is_local());
        // Second send to the same session reuses the binding.
        let out2 = m.send(b, kref).unwrap();
        assert!(!out2.newly_exported);
        assert_eq!(out2.vref, out.vref);
    }

    #[test]
    fn close_session_drops_clist_pillars() {
        let m = SlotMachine::new();
        let a = session_id("a");
        let b = session_id("b");
        m.open_session(a, "a").unwrap();
        m.open_session(b, "b").unwrap();
        let k = m.receive(a, &Vref::object_local(1)).unwrap();
        let _ = m.send(b, k).unwrap();
        // close B: k should still be live (A holds it)
        let rep = m.close_session(b).unwrap();
        assert_eq!(rep.still_live, vec![k]);
        assert!(rep.retired.is_empty());
        // close A: no sessions left, but RAM pillar still holds it
        // because receive() bumped RAM.  Decrement RAM and close.
        m.drop_ram(a, k, 1).unwrap();
        let rep2 = m.close_session(a).unwrap();
        assert_eq!(rep2.retired, vec![k]);
    }

    #[test]
    fn drop_clist_retires_when_all_pillars_zero() {
        let m = SlotMachine::new();
        let a = session_id("a");
        m.open_session(a, "a").unwrap();
        let v = Vref::object_local(1);
        let k = m.receive(a, &v).unwrap();
        m.drop_ram(a, k, 1).unwrap();
        // one export pillar was set by receive() (no), actually receive
        // only bumps Ram & CList.  Drop the CList and it retires.
        m.drop_clist(a, k, 0).unwrap();
        assert!(m.kref_entry(k).is_none());
    }

    #[test]
    fn intern_formula_dedupes() {
        let m = SlotMachine::new();
        let k1 = m.intern_formula("abc:def", KrefKind::Object);
        let k2 = m.intern_formula("abc:def", KrefKind::Object);
        assert_eq!(k1, k2);
        let k3 = m.intern_formula("abc:xxx", KrefKind::Object);
        assert_ne!(k1, k3);
    }
}
