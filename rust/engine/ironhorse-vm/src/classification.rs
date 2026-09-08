//! Derived instance membership. The table owns every structural mutation;
//! callers can mutate values but cannot bypass membership registration.
use crate::snapshot_dirty::{SnapshotDirt, SnapshotSection};
use crate::value::SlotIndex;
use std::cell::RefCell;
use std::collections::HashMap;
use std::ops::{Deref, Index};
use std::rc::Rc;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct ExoticKind(u32);
impl ExoticKind {
    pub(crate) const ARRAYS: Self = Self(1 << 0);
    pub(crate) const WRAPPER_DATA: Self = Self(1 << 1);
    pub(crate) const TEMPORAL_INSTANTS: Self = Self(1 << 2);
    pub(crate) const TEMPORAL_DURATIONS: Self = Self(1 << 3);
    pub(crate) const TEMPORAL_PLAINS: Self = Self(1 << 4);
    pub(crate) const TEMPORAL_ZONEDS: Self = Self(1 << 5);
    pub(crate) const DISPOSABLE_STACKS: Self = Self(1 << 6);
    pub(crate) const COLLECTIONS: Self = Self(1 << 7);
    pub(crate) const ARRAY_BUFFERS: Self = Self(1 << 8);
    pub(crate) const TYPED_ARRAYS: Self = Self(1 << 9);
    pub(crate) const DATA_VIEWS: Self = Self(1 << 10);
    pub(crate) const REGEXPS: Self = Self(1 << 11);
    pub(crate) const LOCALES: Self = Self(1 << 12);
    pub(crate) const COLLATORS: Self = Self(1 << 13);
    pub(crate) const FUNCTIONS: Self = Self(1 << 14);
    pub(crate) const PROXIES: Self = Self(1 << 15);
    pub(crate) const BOUND_FUNCTIONS: Self = Self(1 << 16);
    pub(crate) const PROMISE_FUNCTIONS: Self = Self(1 << 17);
    pub(crate) const NATIVE: Self = Self(1 << 18);
    pub(crate) const METHOD: Self = Self(1 << 19);
    pub(crate) fn union(self, other: Self) -> Self {
        Self(self.0 | other.0)
    }
    pub(crate) fn has(self, other: Self) -> bool {
        self.0 & other.0 != 0
    }
}

#[derive(Clone, Default)]
pub(crate) struct ClassIndex(
    Rc<RefCell<HashMap<SlotIndex, ExoticKind>>>,
    pub(crate) SnapshotDirt,
);
impl ClassIndex {
    pub(crate) fn get(&self, owner: SlotIndex) -> ExoticKind {
        self.0.borrow().get(&owner).copied().unwrap_or_default()
    }
    fn insert(&self, owner: SlotIndex, kind: ExoticKind) {
        self.0.borrow_mut().entry(owner).or_default().0 |= kind.0;
    }
    fn remove(&self, owner: SlotIndex, kind: ExoticKind) {
        let mut rows = self.0.borrow_mut();
        if let Some(bits) = rows.get_mut(&owner) {
            bits.0 &= !kind.0;
            if bits.0 == 0 {
                rows.remove(&owner);
            }
        }
    }
    fn replace(&self, owner: SlotIndex, mask: ExoticKind, bits: ExoticKind) {
        let mut rows = self.0.borrow_mut();
        let row = rows.entry(owner).or_default();
        row.0 = (row.0 & !mask.0) | bits.0;
    }
    pub(crate) fn fork(&self) -> Self {
        Self(
            Rc::new(RefCell::new(self.0.borrow().clone())),
            SnapshotDirt::default(),
        )
    }
}

pub(crate) struct ClassMap<V> {
    snapshot_mask: u32,
    rows: HashMap<SlotIndex, V>,
    kind: ExoticKind,
    index: ClassIndex,
    refinement: Option<fn(&V) -> ExoticKind>,
    refinement_mask: ExoticKind,
}
// Refresh classification when a mutation callback returns or unwinds. The
// callback cannot retain a mutable value reference beyond this guard.
struct ValueUpdate<'a, V> {
    value: &'a mut V,
    key: SlotIndex,
    index: &'a ClassIndex,
    kind: ExoticKind,
    mask: ExoticKind,
    refinement: Option<fn(&V) -> ExoticKind>,
}
impl<V> Drop for ValueUpdate<'_, V> {
    fn drop(&mut self) {
        if let Some(refine) = self.refinement {
            let bits = refine(self.value);
            assert_eq!(
                bits.0 & !self.mask.0,
                0,
                "classification outside refinement mask"
            );
            self.index
                .replace(self.key, self.kind.union(self.mask), self.kind.union(bits));
        }
    }
}

impl<V> ClassMap<V> {
    pub(crate) fn new(kind: ExoticKind, index: ClassIndex) -> Self {
        let map = Self {
            snapshot_mask: Self::dirty_mask(kind),
            rows: HashMap::new(),
            kind,
            index,
            refinement: None,
            refinement_mask: ExoticKind::default(),
        };
        map.mark_dirty();
        map
    }
    pub(crate) fn new_refined(
        kind: ExoticKind,
        refinement_mask: ExoticKind,
        refinement: fn(&V) -> ExoticKind,
        index: ClassIndex,
    ) -> Self {
        assert!(!kind.has(refinement_mask));
        Self {
            refinement: Some(refinement),
            refinement_mask,
            ..Self::new(kind, index)
        }
    }
    fn dirty_mask(kind: ExoticKind) -> u32 {
        let mut mask = 0;
        if kind.has(ExoticKind::ARRAYS) {
            mask |= SnapshotSection::Arrays.mask();
        }
        if kind.has(ExoticKind::WRAPPER_DATA) {
            mask |= SnapshotSection::Wrappers.mask();
        }
        if kind.has(ExoticKind::TEMPORAL_INSTANTS) {
            mask |= SnapshotSection::Temporal.mask();
        }
        if kind.has(ExoticKind::TEMPORAL_DURATIONS) {
            mask |= SnapshotSection::Temporal.mask();
        }
        if kind.has(ExoticKind::TEMPORAL_PLAINS) {
            mask |= SnapshotSection::Temporal.mask();
        }
        if kind.has(ExoticKind::TEMPORAL_ZONEDS) {
            mask |= SnapshotSection::Temporal.mask();
        }
        if kind.has(ExoticKind::DISPOSABLE_STACKS) {
            mask |= SnapshotSection::DisposableStacks.mask();
        }
        if kind.has(ExoticKind::COLLECTIONS) {
            mask |= SnapshotSection::Collections.mask() | SnapshotSection::Iterators.mask();
        }
        if kind.has(ExoticKind::ARRAY_BUFFERS) {
            mask |= SnapshotSection::Buffers.mask();
        }
        if kind.has(ExoticKind::TYPED_ARRAYS) {
            mask |= SnapshotSection::TypedArrays.mask();
        }
        if kind.has(ExoticKind::DATA_VIEWS) {
            mask |= SnapshotSection::DataViews.mask();
        }
        if kind.has(ExoticKind::REGEXPS) {
            mask |= SnapshotSection::Regexps.mask();
        }
        if kind.has(ExoticKind::LOCALES) {
            mask |= SnapshotSection::Intl.mask();
        }
        if kind.has(ExoticKind::COLLATORS) {
            mask |= SnapshotSection::Intl.mask();
        }
        if kind.has(ExoticKind::FUNCTIONS) {
            mask |= SnapshotSection::Functions.mask()
                | SnapshotSection::IntlBoundFunctions.mask()
                | SnapshotSection::Promises.mask();
        }
        if kind.has(ExoticKind::PROXIES) {
            mask |= SnapshotSection::Proxies.mask();
        }
        if kind.has(ExoticKind::BOUND_FUNCTIONS) {
            mask |= SnapshotSection::Functions.mask();
        }
        if kind.has(ExoticKind::PROMISE_FUNCTIONS) {
            mask |= SnapshotSection::Promises.mask() | SnapshotSection::AsyncInstances.mask();
        }
        mask
    }
    fn mark_dirty(&self) {
        self.index.1.mark(self.snapshot_mask);
    }
    fn refresh(&self, key: SlotIndex) {
        let bits = self
            .refinement
            .map_or(ExoticKind::default(), |refine| refine(&self.rows[&key]));
        assert_eq!(
            bits.0 & !self.refinement_mask.0,
            0,
            "classification outside refinement mask"
        );
        self.index.replace(
            key,
            self.kind.union(self.refinement_mask),
            self.kind.union(bits),
        );
    }
    fn assert_unrefined(&self) {
        assert!(
            self.refinement.is_none(),
            "refined classification requires tracked mutation"
        );
    }
    pub(crate) fn update<R>(
        &mut self,
        key: &SlotIndex,
        update: impl FnOnce(&mut V) -> R,
    ) -> Option<R> {
        self.mark_dirty();
        let guard = ValueUpdate {
            value: self.rows.get_mut(key)?,
            key: *key,
            index: &self.index,
            kind: self.kind,
            mask: self.refinement_mask,
            refinement: self.refinement,
        };
        Some(update(guard.value))
    }
    pub(crate) fn update_or_default<R>(
        &mut self,
        key: SlotIndex,
        update: impl FnOnce(&mut V) -> R,
    ) -> R
    where
        V: Default,
    {
        self.mark_dirty();
        self.index.insert(key, self.kind);
        let guard = ValueUpdate {
            value: self.rows.entry(key).or_default(),
            key,
            index: &self.index,
            kind: self.kind,
            mask: self.refinement_mask,
            refinement: self.refinement,
        };
        update(guard.value)
    }
    pub(crate) fn update_values(&mut self, mut update: impl FnMut(&mut V)) {
        self.mark_dirty();
        for (key, value) in &mut self.rows {
            let guard = ValueUpdate {
                value,
                key: *key,
                index: &self.index,
                kind: self.kind,
                mask: self.refinement_mask,
                refinement: self.refinement,
            };
            update(guard.value);
        }
    }
    pub(crate) fn from_rows(
        rows: HashMap<SlotIndex, V>,
        kind: ExoticKind,
        index: ClassIndex,
    ) -> Self {
        for &owner in rows.keys() {
            index.insert(owner, kind);
        }
        Self {
            rows,
            ..Self::new(kind, index)
        }
    }
    /// Only used when the pristine boot template's complete index was forked.
    pub(crate) fn copy_to(&self, index: ClassIndex) -> Self
    where
        V: Clone,
    {
        index.1.mark(self.snapshot_mask);
        Self {
            snapshot_mask: self.snapshot_mask,
            rows: self.rows.clone(),
            kind: self.kind,
            index,
            refinement: self.refinement,
            refinement_mask: self.refinement_mask,
        }
    }
    pub(crate) fn insert(&mut self, key: SlotIndex, value: V) -> Option<V> {
        self.mark_dirty();
        let previous = self.rows.insert(key, value);
        self.refresh(key);
        previous
    }
    pub(crate) fn remove(&mut self, key: &SlotIndex) -> Option<V> {
        let previous = self.rows.remove(key);
        if previous.is_some() {
            self.mark_dirty();
            self.index
                .remove(*key, self.kind.union(self.refinement_mask));
        }
        previous
    }
    /// Filter membership without exposing values or reclassifying survivors.
    /// A predicate that only sees keys cannot change refinement state.
    pub(crate) fn retain_keys(&mut self, mut keep: impl FnMut(&SlotIndex) -> bool) {
        self.rows.retain(|key, _| {
            if keep(key) {
                true
            } else {
                self.index.1.mark(self.snapshot_mask);
                self.index
                    .remove(*key, self.kind.union(self.refinement_mask));
                false
            }
        });
    }
    pub(crate) fn retain(&mut self, mut keep: impl FnMut(&SlotIndex, &mut V) -> bool) {
        self.mark_dirty();
        self.rows.retain(|key, value| {
            let retained = {
                let guard = ValueUpdate {
                    value,
                    key: *key,
                    index: &self.index,
                    kind: self.kind,
                    mask: self.refinement_mask,
                    refinement: self.refinement,
                };
                keep(key, guard.value)
            };
            if retained {
                true
            } else {
                self.index
                    .remove(*key, self.kind.union(self.refinement_mask));
                false
            }
        });
    }
    pub(crate) fn get_mut(&mut self, key: &SlotIndex) -> Option<&mut V> {
        self.mark_dirty();
        self.assert_unrefined();
        self.rows.get_mut(key)
    }
    pub(crate) fn values_mut(&mut self) -> std::collections::hash_map::ValuesMut<'_, SlotIndex, V> {
        self.mark_dirty();
        self.assert_unrefined();
        self.rows.values_mut()
    }
    pub(crate) fn iter_mut(&mut self) -> std::collections::hash_map::IterMut<'_, SlotIndex, V> {
        self.mark_dirty();
        self.assert_unrefined();
        self.rows.iter_mut()
    }
}
impl<V> Deref for ClassMap<V> {
    type Target = HashMap<SlotIndex, V>;
    fn deref(&self) -> &Self::Target {
        &self.rows
    }
}
impl<V> Index<&SlotIndex> for ClassMap<V> {
    type Output = V;
    fn index(&self, key: &SlotIndex) -> &V {
        &self.rows[key]
    }
}
impl<'a, V> IntoIterator for &'a ClassMap<V> {
    type Item = (&'a SlotIndex, &'a V);
    type IntoIter = std::collections::hash_map::Iter<'a, SlotIndex, V>;
    fn into_iter(self) -> Self::IntoIter {
        self.rows.iter()
    }
}
impl<'a, V> IntoIterator for &'a mut ClassMap<V> {
    type Item = (&'a SlotIndex, &'a mut V);
    type IntoIter = std::collections::hash_map::IterMut<'a, SlotIndex, V>;
    fn into_iter(self) -> Self::IntoIter {
        self.mark_dirty();
        self.assert_unrefined();
        self.rows.iter_mut()
    }
}
#[cfg(test)]
mod tests {
    use super::*;

    fn refined(index: ClassIndex) -> ClassMap<u8> {
        ClassMap::new_refined(
            ExoticKind::FUNCTIONS,
            ExoticKind::NATIVE.union(ExoticKind::METHOD),
            |value| match value {
                1 => ExoticKind::NATIVE,
                2 => ExoticKind::METHOD,
                _ => ExoticKind::default(),
            },
            index,
        )
    }

    #[test]
    fn refinement_tracks_replacement_updates_retention_and_fork() {
        let index = ClassIndex::default();
        let owner = SlotIndex(8);
        let mut functions = refined(index.clone());
        let mut proxies = ClassMap::new(ExoticKind::PROXIES, index.clone());
        proxies.insert(owner, ());
        functions.insert(owner, 1);
        assert!(index.get(owner).has(ExoticKind::NATIVE));
        functions.insert(owner, 0);
        assert!(!index.get(owner).has(ExoticKind::NATIVE));
        assert_eq!(
            functions.update(&owner, |value| {
                *value = 2;
                7
            }),
            Some(7)
        );
        assert!(index.get(owner).has(ExoticKind::METHOD));
        assert_eq!(functions.update(&SlotIndex(9), |_| ()), None);
        functions.update_or_default(SlotIndex(9), |value| *value = 1);
        assert!(index.get(SlotIndex(9)).has(ExoticKind::NATIVE));
        functions.update_values(|value| *value = 2);
        assert!(!index.get(SlotIndex(9)).has(ExoticKind::NATIVE));
        assert!(index.get(SlotIndex(9)).has(ExoticKind::METHOD));
        let fork = index.fork();
        let mut copy = functions.copy_to(fork.clone());
        copy.update(&owner, |value| *value = 1);
        assert!(fork.get(owner).has(ExoticKind::NATIVE));
        assert!(!index.get(owner).has(ExoticKind::NATIVE));
        functions.retain(|key, value| {
            *value = 1;
            *key == owner
        });
        assert_eq!(index.get(SlotIndex(9)), ExoticKind::default());
        assert!(index.get(owner).has(ExoticKind::NATIVE));
        assert!(!index.get(owner).has(ExoticKind::METHOD));
        functions.remove(&owner);
        assert_eq!(index.get(owner), ExoticKind::PROXIES);
    }

    #[test]
    fn absent_removal_preserves_clean_sections_and_unrelated_membership() {
        let index = ClassIndex::default();
        let owner = SlotIndex(8);
        let mut arrays = ClassMap::new(ExoticKind::ARRAYS, index.clone());
        let mut proxies = ClassMap::new(ExoticKind::PROXIES, index.clone());
        arrays.insert(owner, 1);
        proxies.insert(owner, ());
        index.1.clear();
        assert_eq!(arrays.remove(&SlotIndex(9)), None);
        assert!(!index.1.snapshot().contains(SnapshotSection::Arrays));
        assert!(index.get(owner).has(ExoticKind::ARRAYS));
        assert_eq!(arrays.remove(&owner), Some(1));
        assert!(index.1.snapshot().contains(SnapshotSection::Arrays));
        assert_eq!(index.get(owner), ExoticKind::PROXIES);
        index.1.clear();
        assert_eq!(arrays.remove(&owner), None);
        assert!(!index.1.snapshot().contains(SnapshotSection::Arrays));
        assert_eq!(index.get(owner), ExoticKind::PROXIES);
    }

    #[test]
    fn key_retention_keeps_survivors_clean_and_preserves_overlapping_classes() {
        let index = ClassIndex::default();
        let mut functions = refined(index.clone());
        let mut proxies = ClassMap::new(ExoticKind::PROXIES, index.clone());
        let native = SlotIndex(8);
        let method = SlotIndex(9);
        functions.insert(native, 1);
        functions.insert(method, 2);
        proxies.insert(native, ());
        index.1.clear();
        {
            // No-op retention must not even request a mutable classification
            // borrow; every retained function keeps its existing refinement.
            let classes = index.0.borrow();
            functions.retain_keys(|_| true);
            assert!(classes[&native].has(ExoticKind::NATIVE));
            assert!(classes[&method].has(ExoticKind::METHOD));
        }
        for section in [
            SnapshotSection::Functions,
            SnapshotSection::IntlBoundFunctions,
            SnapshotSection::Promises,
        ] {
            assert!(!index.1.snapshot().contains(section));
        }
        functions.retain_keys(|key| *key == method);
        assert!(!functions.contains_key(&native));
        assert_eq!(index.get(native), ExoticKind::PROXIES);
        assert!(index.get(method).has(ExoticKind::METHOD));
        assert!(!index.get(method).has(ExoticKind::NATIVE));
        for section in [
            SnapshotSection::Functions,
            SnapshotSection::IntlBoundFunctions,
            SnapshotSection::Promises,
        ] {
            assert!(index.1.snapshot().contains(section));
        }
    }

    #[test]
    fn key_retention_unwind_keeps_completed_removals_tracked() {
        let index = ClassIndex::default();
        let mut functions = refined(index.clone());
        let mut proxies = ClassMap::new(ExoticKind::PROXIES, index.clone());
        let owners = [SlotIndex(10), SlotIndex(11), SlotIndex(12)];
        for owner in owners {
            functions.insert(owner, 1);
            proxies.insert(owner, ());
        }
        index.1.clear();
        let mut removed = None;
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            functions.retain_keys(|key| {
                if removed.is_some() {
                    panic!("after one completed removal");
                }
                removed = Some(*key);
                false
            });
        }));
        assert!(result.is_err());
        assert_eq!(functions.len(), 2);
        for owner in owners {
            let kept = Some(owner) != removed;
            assert_eq!(functions.contains_key(&owner), kept);
            assert_eq!(index.get(owner).has(ExoticKind::FUNCTIONS), kept);
            assert_eq!(index.get(owner).has(ExoticKind::NATIVE), kept);
            assert!(index.get(owner).has(ExoticKind::PROXIES));
        }
        for section in [
            SnapshotSection::Functions,
            SnapshotSection::IntlBoundFunctions,
            SnapshotSection::Promises,
        ] {
            assert!(index.1.snapshot().contains(section));
        }
    }

    #[test]
    fn refinement_refreshes_even_when_mutation_unwinds() {
        for operation in 0..4 {
            let index = ClassIndex::default();
            let mut functions = refined(index.clone());
            let owner = SlotIndex(1);
            functions.insert(owner, 1);
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let fail = |value: &mut u8| {
                    *value = 2;
                    panic!("mutation interrupted")
                };
                match operation {
                    0 => {
                        functions.update(&owner, fail);
                    }
                    1 => functions.update_or_default(owner, fail),
                    2 => functions.update_values(fail),
                    _ => functions.retain(|_, value| {
                        fail(value);
                        false
                    }),
                }
            }));
            assert!(result.is_err());
            assert!(index.get(owner).has(ExoticKind::METHOD));
            assert!(!index.get(owner).has(ExoticKind::NATIVE));
        }
    }

    #[test]
    fn refinement_rejects_untracked_mutation_apis() {
        for bypass in 0..4 {
            let mut functions = refined(ClassIndex::default());
            functions.insert(SlotIndex(1), 1);
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| match bypass {
                0 => {
                    let _ = functions.get_mut(&SlotIndex(1));
                }
                1 => {
                    let _ = functions.values_mut();
                }
                2 => {
                    let _ = functions.iter_mut();
                }
                _ => {
                    let _ = (&mut functions).into_iter();
                }
            }));
            assert!(result.is_err(), "untracked mutation API {bypass}");
        }
    }

    #[test]
    fn overlapping_membership_survives_replacement_removal_and_slot_reuse() {
        let index = ClassIndex::default();
        let owner = SlotIndex(17);
        let mut functions = ClassMap::new(ExoticKind::FUNCTIONS, index.clone());
        let mut proxies = ClassMap::new(ExoticKind::PROXIES, index.clone());
        functions.insert(owner, 1);
        proxies.insert(owner, 2);
        assert_eq!(functions.insert(owner, 3), Some(1));
        assert!(index.get(owner).has(ExoticKind::FUNCTIONS));
        assert!(index.get(owner).has(ExoticKind::PROXIES));
        functions.remove(&owner);
        assert!(!index.get(owner).has(ExoticKind::FUNCTIONS));
        assert!(index.get(owner).has(ExoticKind::PROXIES));
        proxies.retain(|_, _| false);
        assert_eq!(index.get(owner), ExoticKind::default());
        functions.update_or_default(owner, |value| *value = 4);
        assert!(index.get(owner).has(ExoticKind::FUNCTIONS));
        assert!(!index.get(owner).has(ExoticKind::PROXIES));
        assert_eq!(functions[&owner], 4);
    }

    #[test]
    fn boot_fork_membership_and_values_are_independent() {
        let index = ClassIndex::default();
        let owner = SlotIndex(21);
        let mut template = ClassMap::new(ExoticKind::ARRAYS, index.clone());
        template.insert(owner, vec![1]);
        let fork = index.fork();
        let mut realm = template.copy_to(fork.clone());
        realm.get_mut(&owner).unwrap().push(2);
        assert_eq!(template[&owner], vec![1]);
        realm.remove(&owner);
        assert_eq!(fork.get(owner), ExoticKind::default());
        assert!(index.get(owner).has(ExoticKind::ARRAYS));
    }
}
