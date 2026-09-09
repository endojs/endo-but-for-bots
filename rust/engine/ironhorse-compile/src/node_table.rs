//! Sparse per-node compiler data, indexed by parser-assigned identities.

/// A vector-indexed table whose vacant entries are distinct from stored values.
/// In particular, `NodeTable<Option<T>>` distinguishes an unresolved symbol
/// (`Some(&None)`) from a missing scoper entry (`None`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NodeTable<T> {
    // One vector-indexed page pointer per 64 IDs. Most class-only tables have
    // very few entries, even when a class follows a large ordinary program.
    pages: Vec<Option<Box<[Option<T>; PAGE_LEN]>>>,
}

const PAGE_LEN: usize = 64;

impl<T> Default for NodeTable<T> {
    fn default() -> Self {
        Self { pages: Vec::new() }
    }
}

impl<T> NodeTable<T> {
    /// Look up a parser-assigned node ID.
    pub fn get(&self, id: &u32) -> Option<&T> {
        let index = *id as usize;
        self.pages.get(index / PAGE_LEN)?.as_ref()?[index % PAGE_LEN].as_ref()
    }

    /// Record a value, returning the previous entry, if any.
    pub fn insert(&mut self, id: u32, value: T) -> Option<T> {
        assert_ne!(id, u32::MAX, "compiler invariant: unassigned node identity");
        let index = id as usize;
        let page = index / PAGE_LEN;
        if self.pages.len() <= page {
            self.pages.resize_with(page + 1, || None);
        }
        let entries =
            self.pages[page].get_or_insert_with(|| Box::new(std::array::from_fn(|_| None)));
        entries[index % PAGE_LEN].replace(value)
    }

    /// The populated values, in node-ID order.
    pub fn values(&self) -> impl Iterator<Item = &T> {
        self.pages
            .iter()
            .filter_map(Option::as_ref)
            .flat_map(|page| page.iter().filter_map(Option::as_ref))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sparse_pages_preserve_vacancy_unresolved_values_and_clone_independence() {
        let mut table = NodeTable::default();
        assert_eq!(table.insert(63, None::<u32>), None);
        assert_eq!(table.insert(64, Some(7)), None);
        assert_eq!(table.insert(6400, Some(9)), None);
        assert_eq!(table.get(&62), None);
        assert_eq!(table.get(&63), Some(&None));
        assert_eq!(table.get(&64), Some(&Some(7)));
        assert_eq!(table.get(&128), None);
        assert_eq!(table.get(&u32::MAX), None);
        assert_eq!(table.pages.iter().filter(|p| p.is_some()).count(), 3);
        let original = table.clone();
        assert_eq!(table.insert(64, Some(8)), Some(Some(7)));
        assert_eq!(original.get(&64), Some(&Some(7)));
        assert_eq!(
            table.values().copied().collect::<Vec<_>>(),
            [None, Some(8), Some(9)]
        );
    }
}
