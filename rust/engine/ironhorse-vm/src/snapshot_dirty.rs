//! Mutation tracking for snapshot section extraction. Derived, never persisted.
use std::cell::Cell;
use std::ops::{Deref, DerefMut};
use std::rc::Rc;

macro_rules! define_snapshot_sections {
    ($($name:ident = $id:literal,)*) => {
        /// VM inputs to the snapshot layer. The store maps its persisted identities
        /// to these semantic groups; the VM does not depend on storage machinery.
        #[derive(Clone, Copy, Debug, PartialEq, Eq)]
        #[repr(u8)]
        pub enum SnapshotSection {
            $($name = $id,)*
        }
        // Dirty masks have one bit per semantic section. Growing the roster
        // requires widening the tracker before introducing another identity.
        const _: () = {
            $(assert!($id < u32::BITS);)*
        };
    };
}
crate::snapshot_sections!(define_snapshot_sections);
impl SnapshotSection {
    pub(crate) const fn mask(self) -> u32 {
        1u32 << self as u8
    }
}

#[derive(Clone, Copy, Debug)]
pub struct SnapshotDirty(u32);
impl SnapshotDirty {
    pub fn contains(self, section: SnapshotSection) -> bool {
        self.0 & section.mask() != 0
    }
    pub const fn all() -> Self {
        Self(u32::MAX)
    }
}

#[derive(Clone)]
pub(crate) struct SnapshotDirt(Rc<Cell<u32>>);
impl Default for SnapshotDirt {
    fn default() -> Self {
        Self(Rc::new(Cell::new(u32::MAX)))
    }
}
impl SnapshotDirt {
    pub(crate) fn mark(&self, mask: u32) {
        self.0.set(self.0.get() | mask);
    }
    pub(crate) fn mark_all(&self) {
        self.0.set(u32::MAX);
    }
    pub(crate) fn clear(&self) {
        self.0.set(0);
    }
    pub(crate) fn snapshot(&self) -> SnapshotDirty {
        SnapshotDirty(self.0.get())
    }
}

/// All mutable access marks dirt before a reference escapes, including unwind.
/// No Default or Clone: replacement and realm cloning must preserve/rebind the
/// explicit tracker rather than silently manufacturing or sharing a baseline.
pub(crate) struct Tracked<T> {
    value: T,
    dirt: SnapshotDirt,
    mask: u32,
}
impl<T> Tracked<T> {
    pub(crate) fn new(value: T, dirt: SnapshotDirt, mask: u32) -> Self {
        dirt.mark(mask);
        Self { value, dirt, mask }
    }
    pub(crate) fn replace(&mut self, value: T) -> T {
        self.dirt.mark(self.mask);
        std::mem::replace(&mut self.value, value)
    }
    pub(crate) fn take(&mut self) -> T
    where
        T: Default,
    {
        self.replace(T::default())
    }
    pub(crate) fn copy_to(&self, dirt: SnapshotDirt) -> Self
    where
        T: Clone,
    {
        Self::new(self.value.clone(), dirt, self.mask)
    }
}
// The former classification maps need only snapshot tracking now. These
// callback helpers preserve their mutation API without a derived type index.
impl<V> Tracked<std::collections::HashMap<crate::value::SlotIndex, V>> {
    pub(crate) fn update<R>(
        &mut self,
        key: &crate::value::SlotIndex,
        update: impl FnOnce(&mut V) -> R,
    ) -> Option<R> {
        self.dirt.mark(self.mask);
        self.value.get_mut(key).map(update)
    }

    pub(crate) fn update_or_default<R>(
        &mut self,
        key: crate::value::SlotIndex,
        update: impl FnOnce(&mut V) -> R,
    ) -> R
    where
        V: Default,
    {
        self.dirt.mark(self.mask);
        update(self.value.entry(key).or_default())
    }

    pub(crate) fn update_values(&mut self, update: impl FnMut(&mut V)) {
        self.dirt.mark(self.mask);
        self.value.values_mut().for_each(update);
    }

    /// GC sees keys only. Mark before each removal so panic/unwind cannot
    /// hide an earlier removal, while a no-op sweep keeps its baseline clean.
    pub(crate) fn retain_keys(&mut self, mut keep: impl FnMut(&crate::value::SlotIndex) -> bool) {
        self.value.retain(|key, _| {
            let retained = keep(key);
            if !retained {
                self.dirt.mark(self.mask);
            }
            retained
        });
    }
}

impl<T> Deref for Tracked<T> {
    type Target = T;
    fn deref(&self) -> &T {
        &self.value
    }
}
impl<T> DerefMut for Tracked<T> {
    fn deref_mut(&mut self) -> &mut T {
        self.dirt.mark(self.mask);
        &mut self.value
    }
}
impl<'a, T> IntoIterator for &'a Tracked<T>
where
    &'a T: IntoIterator,
{
    type Item = <&'a T as IntoIterator>::Item;
    type IntoIter = <&'a T as IntoIterator>::IntoIter;
    fn into_iter(self) -> Self::IntoIter {
        (&self.value).into_iter()
    }
}
impl<'a, T> IntoIterator for &'a mut Tracked<T>
where
    &'a mut T: IntoIterator,
{
    type Item = <&'a mut T as IntoIterator>::Item;
    type IntoIter = <&'a mut T as IntoIterator>::IntoIter;
    fn into_iter(self) -> Self::IntoIter {
        self.dirt.mark(self.mask);
        (&mut self.value).into_iter()
    }
}

/// Arena identity is retained by the committed baseline, so replacing a public
/// arena cannot alias a clean baseline even if both arenas were checkpointed.
#[derive(Default)]
pub(crate) struct ArenaDirt(Cell<u8>);
impl ArenaDirt {
    pub(crate) fn content(&self) {
        self.0.set(self.0.get() | 1);
    }
    pub(crate) fn liveness(&self) {
        self.0.set(self.0.get() | 2);
    }
    pub(crate) fn clear(&self) {
        self.0.set(0);
    }
    pub(crate) fn sections(&self, same_arena: bool) -> u32 {
        let bits = if same_arena { self.0.get() } else { 3 };
        let mut mask = 0;
        if bits & 1 != 0 {
            mask |= SnapshotSection::Regexps.mask();
        }
        if bits & 2 != 0 {
            mask |= SnapshotSection::Iterators.mask()
                | SnapshotSection::Promises.mask()
                | SnapshotSection::AsyncInstances.mask();
        }
        mask
    }
}

/// Session-owned acknowledgement. A later acknowledgement invalidates every
/// older token, including tokens retained by another store session.
pub struct SnapshotBaseline {
    pub(crate) identity: Rc<()>,
    pub(crate) arena: Rc<ArenaDirt>,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn tracked_reads_stay_clean_and_mutation_unwind_marks() {
        let dirt = SnapshotDirt::default();
        let mut values = Tracked::new(vec![1], dirt.clone(), SnapshotSection::Arrays.mask());
        dirt.clear();
        assert_eq!(values[0], 1);
        assert!(!dirt.snapshot().contains(SnapshotSection::Arrays));
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            values[0] = 2;
            panic!("after mutation");
        }));
        assert!(dirt.snapshot().contains(SnapshotSection::Arrays));
        dirt.clear();
        assert_eq!(values.take(), vec![2]);
        assert!(dirt.snapshot().contains(SnapshotSection::Arrays));
    }

    #[test]
    fn tracked_map_callbacks_mark_before_unwind() {
        use crate::value::SlotIndex;
        use std::collections::HashMap;
        for operation in 0..4 {
            let dirt = SnapshotDirt::default();
            let mask = SnapshotSection::Functions.mask() | SnapshotSection::Promises.mask();
            let mut rows = Tracked::new(HashMap::from([(SlotIndex(1), 1)]), dirt.clone(), mask);
            dirt.clear();
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let fail = |value: &mut i32| {
                    *value = 2;
                    panic!("after mutation");
                };
                match operation {
                    0 => {
                        rows.update(&SlotIndex(1), fail);
                    }
                    1 => rows.update_or_default(SlotIndex(1), fail),
                    2 => rows.update_values(fail),
                    _ => rows.retain(|_, value| {
                        fail(value);
                        false
                    }),
                }
            }));
            assert!(result.is_err());
            assert_eq!(rows[&SlotIndex(1)], 2);
            assert!(dirt.snapshot().contains(SnapshotSection::Functions));
            assert!(dirt.snapshot().contains(SnapshotSection::Promises));
            assert!(!dirt.snapshot().contains(SnapshotSection::Arrays));
        }
    }

    #[test]
    fn key_retention_keeps_noop_clean_and_tracks_removals_before_unwind() {
        use crate::value::SlotIndex;
        use std::collections::HashMap;
        let dirt = SnapshotDirt::default();
        let mut rows = Tracked::new(
            HashMap::from([(SlotIndex(1), 1), (SlotIndex(2), 2)]),
            dirt.clone(),
            SnapshotSection::Functions.mask(),
        );
        dirt.clear();
        rows.retain_keys(|_| true);
        assert!(!dirt.snapshot().contains(SnapshotSection::Functions));
        let mut removed = None;
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            rows.retain_keys(|key| {
                assert!(removed.is_none(), "after one completed removal");
                removed = Some(*key);
                false
            });
        }));
        assert!(result.is_err());
        assert_eq!(rows.len(), 1);
        assert!(!rows.contains_key(&removed.unwrap()));
        assert!(dirt.snapshot().contains(SnapshotSection::Functions));
    }

    #[test]
    fn arena_replacement_and_unrelated_acknowledgement_invalidate() {
        let mut interp = crate::Interp::new();
        let baseline = interp.acknowledge_snapshot();
        assert!(!interp
            .snapshot_dirty_sections(&baseline)
            .contains(SnapshotSection::Arrays));
        interp.slots = crate::value::SlotArena::new();
        let dirty = interp.snapshot_dirty_sections(&baseline);
        assert!(dirty.contains(SnapshotSection::Regexps));
        assert!(dirty.contains(SnapshotSection::Promises));
        let _other = interp.acknowledge_snapshot();
        assert!(interp
            .snapshot_dirty_sections(&baseline)
            .contains(SnapshotSection::Arrays));
    }
}
