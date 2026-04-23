//! Per-session bidirectional c-list.
//!
//! A session corresponds to one connected worker (or peer).  Each
//! session has its own monotonic counters for local positions and
//! two maps:
//!   * `vref_to_kref` — the import/export table, keyed by canonical
//!     vref string (so durable and multi-faceted vrefs are distinct
//!     entries);
//!   * `kref_to_vref` — the reverse lookup.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::{Result, SlotError};
use crate::kref::Kref;
use crate::vref::{Direction, Vref, VrefType};

/// Deterministic session identity, modelled on OCapN's double-SHA of
/// sorted peer public-key IDs.  For in-process daemon↔worker sessions,
/// callers can use [`SessionId::ephemeral`] for a random ID or
/// [`SessionId::from_label`] to name a session by an ASCII label.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize, Deserialize)]
pub struct SessionId(pub [u8; 32]);

impl SessionId {
    pub fn from_label(label: &str) -> Self {
        let mut h = Sha256::new();
        h.update(b"slots/session/");
        h.update(label.as_bytes());
        let digest = h.finalize();
        let mut out = [0u8; 32];
        out.copy_from_slice(&digest);
        SessionId(out)
    }

    pub fn from_peers(a: &[u8], b: &[u8]) -> Self {
        let (x, y) = if a <= b { (a, b) } else { (b, a) };
        let mut h = Sha256::new();
        h.update(b"slots/ocapn/");
        h.update(x);
        h.update(b"|");
        h.update(y);
        // Double SHA to match OCapN's `prot0` pattern.
        let first = h.finalize();
        let mut h2 = Sha256::new();
        h2.update(first);
        let digest = h2.finalize();
        let mut out = [0u8; 32];
        out.copy_from_slice(&digest);
        SessionId(out)
    }

    pub fn ephemeral() -> Self {
        let mut bytes = [0u8; 32];
        // Cheap, collision-unlikely-enough ephemeral ID.  Uses the
        // system clock + a process-local counter hashed together.
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default();
        let ctr = {
            use std::sync::atomic::{AtomicU64, Ordering};
            static C: AtomicU64 = AtomicU64::new(0);
            C.fetch_add(1, Ordering::SeqCst)
        };
        let mut h = Sha256::new();
        h.update(now.as_nanos().to_le_bytes());
        h.update(ctr.to_le_bytes());
        h.update(std::process::id().to_le_bytes());
        bytes.copy_from_slice(&h.finalize());
        SessionId(bytes)
    }

    pub fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }

    pub fn to_hex(&self) -> String {
        hex::encode(self.0)
    }
}

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize)]
pub(crate) struct NextCounters {
    pub(crate) object: u64,
    pub(crate) promise: u64,
    pub(crate) answer: u64,
    pub(crate) device: u64,
}

impl NextCounters {
    pub(crate) fn advance(&mut self, ty: VrefType) -> u64 {
        let slot = match ty {
            VrefType::Object => &mut self.object,
            VrefType::Promise => &mut self.promise,
            VrefType::Answer => &mut self.answer,
            VrefType::Device => &mut self.device,
        };
        let start = match ty {
            VrefType::Answer => 0u64,
            _ => 1u64,
        };
        if *slot == 0 {
            *slot = start;
        }
        let id = *slot;
        *slot = slot.checked_add(1).expect("slot counter overflow");
        id
    }

    pub(crate) fn observe(&mut self, ty: VrefType, id: u64) {
        let slot = match ty {
            VrefType::Object => &mut self.object,
            VrefType::Promise => &mut self.promise,
            VrefType::Answer => &mut self.answer,
            VrefType::Device => &mut self.device,
        };
        let needed = id.saturating_add(1);
        if needed > *slot {
            *slot = needed;
        }
    }
}

#[derive(Debug)]
pub struct Session {
    id: SessionId,
    label: String,
    next_local: NextCounters,
    vref_to_kref: HashMap<String, Kref>,
    kref_to_vref: HashMap<Kref, String>,
}

impl Session {
    pub fn new(id: SessionId, label: impl Into<String>) -> Self {
        Session {
            id,
            label: label.into(),
            next_local: NextCounters::default(),
            vref_to_kref: HashMap::new(),
            kref_to_vref: HashMap::new(),
        }
    }

    pub fn id(&self) -> SessionId {
        self.id
    }

    pub fn label(&self) -> &str {
        &self.label
    }

    /// Allocate the next local position for a type.  Position 1 for
    /// object/promise/device, position 0 for answers (matching OCapN
    /// convention).
    pub fn alloc_local(&mut self, ty: VrefType) -> Vref {
        let id = self.next_local.advance(ty);
        Vref { ty, dir: Direction::Local, durability: Default::default(), id, subid: None, facet: None }
    }

    /// Associate `kref` with `vref` in this session.  If either side
    /// is already bound to a *different* counterpart, returns
    /// [`SlotError::Conflict`].  Idempotent on equal bindings.
    pub fn bind(&mut self, vref: &Vref, kref: Kref) -> Result<bool> {
        let key = vref.to_canonical();
        if let Some(&existing) = self.vref_to_kref.get(&key) {
            if existing != kref {
                return Err(SlotError::Conflict(format!(
                    "session {} already has {} bound to {}, cannot rebind to {}",
                    self.label, key, existing, kref
                )));
            }
            return Ok(false);
        }
        if let Some(existing) = self.kref_to_vref.get(&kref) {
            if existing != &key {
                return Err(SlotError::Conflict(format!(
                    "session {} already has kref {} bound to {}, cannot rebind to {}",
                    self.label, kref, existing, key
                )));
            }
            return Ok(false);
        }
        self.vref_to_kref.insert(key.clone(), kref);
        self.kref_to_vref.insert(kref, key);
        // If we're bound to a remote vref, lift the counter so future
        // allocations (if any — locals only) don't collide.
        if vref.is_local() {
            self.next_local.observe(vref.ty, vref.id);
        }
        Ok(true)
    }

    pub fn kref_for_vref(&self, vref: &Vref) -> Option<Kref> {
        self.vref_to_kref.get(&vref.to_canonical()).copied()
    }

    pub fn vref_for_kref(&self, kref: Kref) -> Option<Vref> {
        self.kref_to_vref
            .get(&kref)
            .and_then(|s| Vref::parse(s).ok())
    }

    pub fn drop_kref(&mut self, kref: Kref) -> Option<Vref> {
        let v = self.kref_to_vref.remove(&kref)?;
        self.vref_to_kref.remove(&v);
        Vref::parse(&v).ok()
    }

    pub fn len(&self) -> usize {
        self.vref_to_kref.len()
    }

    pub fn is_empty(&self) -> bool {
        self.vref_to_kref.is_empty()
    }

    pub(crate) fn counters(&self) -> NextCounters {
        self.next_local
    }

    pub(crate) fn restore(
        id: SessionId,
        label: String,
        counters: NextCounters,
        entries: impl IntoIterator<Item = (String, Kref)>,
    ) -> Self {
        let mut s = Session { id, label, next_local: counters, vref_to_kref: HashMap::new(), kref_to_vref: HashMap::new() };
        for (v, k) in entries {
            s.vref_to_kref.insert(v.clone(), k);
            s.kref_to_vref.insert(k, v);
        }
        s
    }

    pub fn entries(&self) -> impl Iterator<Item = (&str, Kref)> {
        self.vref_to_kref.iter().map(|(v, k)| (v.as_str(), *k))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn alloc_local_monotonic() {
        let mut s = Session::new(SessionId::from_label("w1"), "w1");
        let a = s.alloc_local(VrefType::Object);
        let b = s.alloc_local(VrefType::Object);
        assert_eq!(a.id, 1);
        assert_eq!(b.id, 2);
        // promise counter is independent
        assert_eq!(s.alloc_local(VrefType::Promise).id, 1);
        // answers start at 0
        assert_eq!(s.alloc_local(VrefType::Answer).id, 0);
        assert_eq!(s.alloc_local(VrefType::Answer).id, 1);
    }

    #[test]
    fn bind_is_idempotent_and_detects_conflict() {
        let mut s = Session::new(SessionId::from_label("w"), "w");
        let v = Vref::object_local(1);
        assert!(s.bind(&v, Kref(10)).unwrap());
        assert!(!s.bind(&v, Kref(10)).unwrap());
        assert!(s.bind(&v, Kref(11)).is_err());
        let v2 = Vref::object_local(2);
        assert!(s.bind(&v2, Kref(10)).is_err());
    }

    #[test]
    fn lookup_roundtrip() {
        let mut s = Session::new(SessionId::from_label("w"), "w");
        let v = Vref::object_remote(7);
        s.bind(&v, Kref(123)).unwrap();
        assert_eq!(s.kref_for_vref(&v), Some(Kref(123)));
        assert_eq!(s.vref_for_kref(Kref(123)).unwrap(), v);
        s.drop_kref(Kref(123));
        assert_eq!(s.kref_for_vref(&v), None);
    }

    #[test]
    fn session_id_symmetric() {
        let a = SessionId::from_peers(b"alice", b"bob");
        let b = SessionId::from_peers(b"bob", b"alice");
        assert_eq!(a, b);
    }
}
