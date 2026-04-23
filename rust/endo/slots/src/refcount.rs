//! Three-pillar refcount tracking, cribbed from liveslots' reachability
//! model.  A kref is retired only when every pillar drops to zero.
//!
//! * [`Pillar::Ram`]     — a worker currently holds the capability.
//! * [`Pillar::CList`]   — the c-list of some session contains an entry.
//! * [`Pillar::Export`]  — the capability has been exported across a
//!                         wire (peer can still recognize it).

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::kref::Kref;

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq, Serialize, Deserialize)]
#[repr(u8)]
pub enum Pillar {
    Ram = 0,
    CList = 1,
    Export = 2,
}

impl Pillar {
    pub(crate) fn code(self) -> u8 {
        self as u8
    }

    pub(crate) fn from_code(code: u8) -> Option<Self> {
        match code {
            0 => Some(Pillar::Ram),
            1 => Some(Pillar::CList),
            2 => Some(Pillar::Export),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct RefCounts {
    ram: u64,
    clist: u64,
    export: u64,
}

impl RefCounts {
    pub fn get(&self, p: Pillar) -> u64 {
        match p {
            Pillar::Ram => self.ram,
            Pillar::CList => self.clist,
            Pillar::Export => self.export,
        }
    }

    pub fn set(&mut self, p: Pillar, v: u64) {
        match p {
            Pillar::Ram => self.ram = v,
            Pillar::CList => self.clist = v,
            Pillar::Export => self.export = v,
        }
    }

    pub fn inc(&mut self, p: Pillar, delta: u64) -> u64 {
        let n = self.get(p).saturating_add(delta);
        self.set(p, n);
        n
    }

    pub fn dec(&mut self, p: Pillar, delta: u64) -> u64 {
        let n = self.get(p).saturating_sub(delta);
        self.set(p, n);
        n
    }

    pub fn is_zero(&self) -> bool {
        self.ram == 0 && self.clist == 0 && self.export == 0
    }
}

/// Central refcount map keyed by kref.  Locked as a whole by
/// [`crate::table::SlotMachine`]; callers don't access it directly.
#[derive(Debug, Default)]
pub(crate) struct RefTable {
    counts: HashMap<Kref, RefCounts>,
}

impl RefTable {
    pub(crate) fn entry_mut(&mut self, k: Kref) -> &mut RefCounts {
        self.counts.entry(k).or_default()
    }

    pub(crate) fn get(&self, k: Kref) -> RefCounts {
        self.counts.get(&k).cloned().unwrap_or_default()
    }

    pub(crate) fn remove(&mut self, k: Kref) {
        self.counts.remove(&k);
    }

    pub(crate) fn iter(&self) -> impl Iterator<Item = (Kref, &RefCounts)> {
        self.counts.iter().map(|(k, v)| (*k, v))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pillar_roundtrip() {
        for p in [Pillar::Ram, Pillar::CList, Pillar::Export] {
            assert_eq!(Pillar::from_code(p.code()), Some(p));
        }
        assert_eq!(Pillar::from_code(42), None);
    }

    #[test]
    fn refcounts_inc_dec_saturating() {
        let mut r = RefCounts::default();
        assert!(r.is_zero());
        r.inc(Pillar::Ram, 3);
        r.inc(Pillar::CList, 2);
        assert_eq!(r.get(Pillar::Ram), 3);
        assert_eq!(r.get(Pillar::CList), 2);
        assert!(!r.is_zero());
        r.dec(Pillar::Ram, 10); // saturating
        assert_eq!(r.get(Pillar::Ram), 0);
        r.dec(Pillar::CList, 2);
        assert!(r.is_zero());
    }
}
