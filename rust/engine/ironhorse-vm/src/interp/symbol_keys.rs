//! Symbol property identities with a maintained reverse lookup.
//!
//! The reverse table is derived, never serialized. All mutation goes through
//! this type so boot cloning, GC pruning and snapshot restoration cannot leave
//! it stale. There is deliberately no mutable map/value access.
use crate::value::SlotIndex;
use std::collections::HashMap;
use std::ops::Deref;

#[derive(Clone, Default)]
pub(super) struct SymbolKeys {
    forward: HashMap<SlotIndex, u16>,
    reverse: HashMap<u16, SlotIndex>,
}

impl SymbolKeys {
    pub(super) fn descriptor(&self, id: u16) -> Option<SlotIndex> {
        self.reverse.get(&id).copied()
    }

    pub(super) fn insert(&mut self, descriptor: SlotIndex, id: u16) -> Option<u16> {
        assert!(self.descriptor(id).is_none_or(|old| old == descriptor));
        let old = self.forward.insert(descriptor, id);
        if let Some(old_id) = old {
            self.reverse.remove(&old_id);
        }
        self.reverse.insert(id, descriptor);
        old
    }

    pub(super) fn remove(&mut self, descriptor: &SlotIndex) -> Option<u16> {
        let id = self.forward.remove(descriptor)?;
        self.reverse.remove(&id);
        Some(id)
    }

    pub(super) fn retain(&mut self, mut keep: impl FnMut(&SlotIndex, &u16) -> bool) {
        // Remove both entries inside the predicate so even a predicate panic
        // leaves all completed removals reflected in the reverse table.
        let reverse = &mut self.reverse;
        self.forward.retain(|descriptor, id| {
            if keep(descriptor, id) {
                true
            } else {
                reverse.remove(id);
                false
            }
        });
    }
}

impl Deref for SymbolKeys {
    type Target = HashMap<SlotIndex, u16>;
    fn deref(&self) -> &Self::Target {
        &self.forward
    }
}

impl<'a> IntoIterator for &'a SymbolKeys {
    type Item = (&'a SlotIndex, &'a u16);
    type IntoIter = std::collections::hash_map::Iter<'a, SlotIndex, u16>;
    fn into_iter(self) -> Self::IntoIter {
        self.forward.iter()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reverse_identity_survives_replacement_pruning_and_clone() {
        let mut keys = SymbolKeys::default();
        keys.insert(SlotIndex(1), 100);
        keys.insert(SlotIndex(2), 99);
        keys.insert(SlotIndex(1), 98);
        assert_eq!(keys.descriptor(100), None);
        assert_eq!(keys.descriptor(98), Some(SlotIndex(1)));
        let mut copy = keys.clone();
        keys.remove(&SlotIndex(1));
        assert_eq!(keys.descriptor(98), None);
        assert_eq!(copy.descriptor(98), Some(SlotIndex(1)));
        copy.retain(|_, id| *id == 99);
        assert_eq!(copy.descriptor(98), None);
        assert_eq!(copy.descriptor(99), Some(SlotIndex(2)));
        copy.insert(SlotIndex(1), 97);
        assert_eq!(copy.descriptor(97), Some(SlotIndex(1)));
    }
}
