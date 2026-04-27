//! GC worklists and scan results.
//!
//! A "possibly dead" kref is one whose RAM pillar just dropped; a
//! "possibly retired" kref is one that lost its last CList pillar.
//! The distinction mirrors liveslots: retirement can propagate to the
//! peer even when a kref is still in some other session's c-list, so
//! the two sets are separately maintained.

use std::collections::HashSet;

use crate::kref::Kref;

#[derive(Clone, Debug, Default)]
pub struct RetireReport {
    pub retired: Vec<Kref>,
    pub still_live: Vec<Kref>,
}

impl RetireReport {
    pub fn new() -> Self {
        RetireReport::default()
    }

    pub fn push_retired(&mut self, k: Kref) {
        self.retired.push(k);
    }

    pub fn push_still_live(&mut self, k: Kref) {
        self.still_live.push(k);
    }
}

#[derive(Debug, Default)]
pub(crate) struct Worklists {
    pub(crate) possibly_dead: HashSet<Kref>,
    pub(crate) possibly_retired: HashSet<Kref>,
}

impl Worklists {
    pub(crate) fn mark_possibly_dead(&mut self, k: Kref) {
        self.possibly_dead.insert(k);
    }

    pub(crate) fn mark_possibly_retired(&mut self, k: Kref) {
        self.possibly_retired.insert(k);
    }

    pub(crate) fn drain_possibly_dead(&mut self) -> Vec<Kref> {
        let out: Vec<_> = self.possibly_dead.iter().copied().collect();
        self.possibly_dead.clear();
        out
    }

    pub(crate) fn drain_possibly_retired(&mut self) -> Vec<Kref> {
        let out: Vec<_> = self.possibly_retired.iter().copied().collect();
        self.possibly_retired.clear();
        out
    }
}
