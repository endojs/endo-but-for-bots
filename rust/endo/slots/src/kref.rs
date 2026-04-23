//! Kref: the daemon-wide identity for a capability that has crossed at
//! least one session boundary.
//!
//! Krefs are allocated monotonically.  Each kref has a [`KrefKind`]
//! (object/promise/answer/device) and optionally a durable
//! back-pointer into Endo's formula graph.

use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Default, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize, Deserialize)]
pub struct Kref(pub u64);

impl std::fmt::Display for Kref {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "k{}", self.0)
    }
}

/// Monotonic kref allocator.
///
/// The counter is persisted via [`crate::store::SlotStore::save_next_kref`]
/// at checkpoint time.  On restart, seed [`KrefAllocator::resume`] with
/// the max-used-plus-one value read from SQLite so no kref is reissued.
pub struct KrefAllocator {
    next: AtomicU64,
}

impl KrefAllocator {
    pub fn new() -> Self {
        KrefAllocator { next: AtomicU64::new(1) }
    }

    pub fn resume(from: u64) -> Self {
        KrefAllocator { next: AtomicU64::new(from.max(1)) }
    }

    pub fn alloc(&self) -> Kref {
        Kref(self.next.fetch_add(1, Ordering::SeqCst))
    }

    pub fn peek(&self) -> u64 {
        self.next.load(Ordering::SeqCst)
    }
}

impl Default for KrefAllocator {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allocates_monotonically() {
        let a = KrefAllocator::new();
        assert_eq!(a.alloc(), Kref(1));
        assert_eq!(a.alloc(), Kref(2));
        assert_eq!(a.alloc(), Kref(3));
    }

    #[test]
    fn resume_continues_from_checkpoint() {
        let a = KrefAllocator::resume(100);
        assert_eq!(a.alloc(), Kref(100));
        assert_eq!(a.peek(), 101);
    }
}
