//! Mutation tracking for snapshot section extraction. Derived, never persisted.
use std::cell::Cell;
use std::ops::{Deref, DerefMut};
use std::rc::Rc;

/// VM inputs to the snapshot layer. The store maps its persisted identities to
/// these semantic groups; the VM does not depend on a storage implementation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum SnapshotSection {
    Stack,
    RetiredFreeList,
    Keys,
    Names,
    Symbols,
    Meter,
    Arrays,
    Collections,
    Registry,
    Errors,
    Buffers,
    TypedArrays,
    DataViews,
    Wrappers,
    Regexps,
    ArgumentsBrands,
    Temporal,
    Intl,
    NameFloor,
    Iterators,
    Dates,
    Functions,
    Proxies,
    Accessors,
    IntlBoundFunctions,
    PrivateElements,
    DisposableStacks,
    Generators,
    ErrorFrames,
    Promises,
    AsyncInstances,
    IndexProperties,
}
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
