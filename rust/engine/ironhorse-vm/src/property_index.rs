//! Derived lookup over the authoritative newest-first named-property chains.
//! Only long chains are indexed. No entry is a GC root or snapshot payload.
use crate::value::{Slot, SlotIndex};
use std::collections::{HashMap, HashSet};

#[derive(Default)]
struct Owner {
    head: Option<SlotIndex>,
    names: HashMap<u16, SlotIndex>,
    nodes: Vec<SlotIndex>,
}
struct Watched {
    id: u16,
    next: SlotIndex,
    owners: HashSet<SlotIndex>,
}
#[derive(Default)]
pub(crate) struct PropertyIndex {
    owners: HashMap<SlotIndex, Owner>,
    watched: HashMap<SlotIndex, Watched>,
    // Cheap write-path prefilter. Most writes are not to indexed nodes.
    watched_slots: Vec<bool>,
    // One additional bool (one byte) per slot up to the highest cached owner. Together
    // with watched_slots this avoids hashing ordinary garbage during sweep.
    owner_slots: Vec<bool>,
    pending: HashSet<SlotIndex>,
}
impl PropertyIndex {
    pub(crate) fn will_mutate(&mut self, slot: SlotIndex) {
        if self
            .watched_slots
            .get(slot.0 as usize)
            .copied()
            .unwrap_or(false)
        {
            self.pending.insert(slot);
        }
    }
    fn drop_owner(&mut self, owner: SlotIndex) {
        if let Some(cache) = self.owners.remove(&owner) {
            self.owner_slots[owner.0 as usize] = false;
            for node in cache.nodes {
                if let Some(watch) = self.watched.get_mut(&node) {
                    watch.owners.remove(&owner);
                    if watch.owners.is_empty() {
                        self.watched.remove(&node);
                        self.watched_slots[node.0 as usize] = false;
                        self.pending.remove(&node);
                    }
                }
            }
        }
    }
    pub(crate) fn free(&mut self, slot: SlotIndex) {
        let offset = slot.0 as usize;
        if !self.owner_slots.get(offset).copied().unwrap_or(false)
            && !self.watched_slots.get(offset).copied().unwrap_or(false)
        {
            return;
        }
        self.drop_owner(slot);
        let dependents = self.watched.get(&slot).map(|watch| watch.owners.clone());
        if let Some(owners) = dependents {
            for owner in owners {
                self.drop_owner(owner);
            }
        }
    }
    fn synchronize(&mut self, read: &impl Fn(SlotIndex) -> Slot) {
        // A raw &mut Slot cannot outlive the arena borrow. Comparing after
        // that borrow ends permits ordinary value/flag writes to keep indexes.
        let pending = std::mem::take(&mut self.pending);
        for slot in pending {
            if let Some(watch) = self.watched.get(&slot) {
                let current = read(slot);
                if (current.id, current.next) != (watch.id, watch.next) {
                    let owners = watch.owners.clone();
                    for owner in owners {
                        self.drop_owner(owner);
                    }
                }
            }
        }
    }
    pub(crate) fn find(
        &mut self,
        owner: SlotIndex,
        id: u16,
        read: impl Fn(SlotIndex) -> Slot,
    ) -> Option<SlotIndex> {
        self.synchronize(&read);
        let head = read(owner).next;
        if !self.owners.contains_key(&owner) {
            // Most boot objects have short chains. Preserve their allocation-
            // free lookup; only a scan that reaches 32 nodes builds an index.
            let mut cur = head;
            for _ in 0..32 {
                if cur.is_null() {
                    return None;
                }
                let slot = read(cur);
                if slot.id == id {
                    return Some(cur);
                }
                cur = slot.next;
            }
        }
        let previous = self.owners.get(&owner).and_then(|cache| cache.head);
        if previous != Some(head) {
            let mut prefix = Vec::new();
            let mut seen = HashSet::new();
            let mut cur = head;
            while !cur.is_null() && Some(cur) != previous {
                if !seen.insert(cur) {
                    // Public arena edits can make a cyclic chain. A linear
                    // lookup could still find a name before the cycle; do not
                    // hang while trying to index the rest of that chain.
                    self.drop_owner(owner);
                    return prefix
                        .iter()
                        .find_map(|&(node, name, _)| (name == id).then_some(node));
                }
                let slot = read(cur);
                // Finding a name must not read any later, possibly invalid
                // or unfaulted suffix. Misses build complete indexes; hits
                // leave this prefix uncached rather than publishing a
                // partial index as if it were complete.
                if slot.id == id {
                    return Some(cur);
                }
                prefix.push((cur, slot.id, slot.next));
                cur = slot.next;
            }
            if Some(cur) != previous {
                self.drop_owner(owner);
            }
            if self.owner_slots.len() <= owner.0 as usize {
                self.owner_slots.resize(owner.0 as usize + 1, false);
            }
            let cache = self.owners.entry(owner).or_default();
            self.owner_slots[owner.0 as usize] = true;
            cache.head = Some(head);
            // Reverse insertion makes the newest duplicate name win, exactly
            // as a linear scan would, including across a newly added prefix.
            for &(node, name, next) in prefix.iter().rev() {
                cache.names.insert(name, node);
                cache.nodes.push(node);
                if self.watched_slots.len() <= node.0 as usize {
                    self.watched_slots.resize(node.0 as usize + 1, false);
                }
                self.watched_slots[node.0 as usize] = true;
                self.watched
                    .entry(node)
                    .or_insert_with(|| Watched {
                        id: name,
                        next,
                        owners: HashSet::new(),
                    })
                    .owners
                    .insert(owner);
            }
        }
        self.owners
            .get(&owner)
            .and_then(|cache| cache.names.get(&id).copied())
    }
}

#[cfg(test)]
mod tests {
    use crate::value::{Slot, SlotArena, SlotIndex};

    fn fixture() -> (SlotArena, SlotIndex, Vec<SlotIndex>) {
        let mut arena = SlotArena::new();
        let owner = arena.alloc(Slot::undefined());
        let mut nodes = Vec::new();
        for id in 1..=64 {
            let mut property = Slot::integer(i32::from(id));
            property.id = id;
            property.next = arena.get(owner).next;
            let node = arena.alloc(property);
            arena.get_mut(owner).next = node;
            nodes.push(node);
        }
        assert_eq!(arena.find_property(owner, 0), None);
        (arena, owner, nodes)
    }

    #[test]
    fn prepends_and_duplicate_names_preserve_first_match() {
        let (mut arena, owner, nodes) = fixture();
        assert_eq!(arena.find_property(owner, 1), Some(nodes[0]));
        let mut property = Slot::integer(999);
        property.id = 1;
        property.next = arena.get(owner).next;
        let newest = arena.alloc(property);
        arena.get_mut(owner).next = newest;
        assert_eq!(arena.find_property(owner, 1), Some(newest));
        assert_eq!(arena.find_property(owner, 2), Some(nodes[1]));
    }

    #[test]
    fn raw_mutations_revalidate_names_and_links_but_keep_value_writes_correct() {
        let (mut arena, owner, nodes) = fixture();
        arena.get_mut(nodes[20]).id = 100;
        assert_eq!(arena.find_property(owner, 21), None);
        assert_eq!(arena.find_property(owner, 100), Some(nodes[20]));
        arena.get_mut(nodes[20]).next = SlotIndex::NULL;
        assert_eq!(arena.find_property(owner, 1), None);
        assert_eq!(arena.find_property(owner, 22), Some(nodes[21]));
        arena.get_mut(nodes[21]).value = Slot::integer(999).value;
        assert_eq!(arena.find_property(owner, 22), Some(nodes[21]));
        assert_eq!(arena.get(nodes[21]).value, Slot::integer(999).value);
        let replacement = arena.alloc(Slot::integer(5));
        arena.get_mut(replacement).id = 500;
        arena.get_mut(owner).next = replacement;
        assert_eq!(arena.find_property(owner, 64), None);
        assert_eq!(arena.find_property(owner, 500), Some(replacement));
    }

    #[test]
    fn shared_tails_and_freed_reused_owners_cannot_retain_stale_rows() {
        let (mut arena, owner, nodes) = fixture();
        let other = arena.alloc(arena.get(owner));
        assert_eq!(arena.find_property(other, 0), None);
        arena.get_mut(nodes[2]).id = 200;
        for object in [owner, other] {
            assert_eq!(arena.find_property(object, 3), None);
            assert_eq!(arena.find_property(object, 200), Some(nodes[2]));
        }
        arena.free(owner);
        let replacement = arena.alloc(Slot::undefined());
        assert_eq!(replacement, owner);
        assert_eq!(arena.find_property(replacement, 64), None);
        assert_eq!(arena.find_property(other, 64), Some(nodes[63]));
    }

    #[test]
    fn free_prefilter_preserves_dependents_and_unaffected_cached_lookups() {
        let (mut arena, owner, nodes) = fixture();
        let shared = arena.alloc(arena.get(owner));
        let unindexed = arena.alloc(Slot::undefined());
        let independent = arena.alloc(Slot::undefined());
        for id in 1..=64 {
            let mut property = Slot::integer(i32::from(id));
            property.id = id;
            property.next = arena.get(independent).next;
            let node = arena.alloc(property);
            arena.get_mut(independent).next = node;
        }
        let mut index = super::PropertyIndex::default();
        let check_bits = |index: &super::PropertyIndex| {
            for i in 0..arena.capacity() {
                assert_eq!(
                    index.owner_slots.get(i as usize).copied().unwrap_or(false),
                    index.owners.contains_key(&SlotIndex(i))
                );
                assert_eq!(
                    index
                        .watched_slots
                        .get(i as usize)
                        .copied()
                        .unwrap_or(false),
                    index.watched.contains_key(&SlotIndex(i))
                );
            }
        };
        for object in [owner, shared, independent] {
            assert_eq!(index.find(object, 0, |slot| arena.get(slot)), None);
        }
        check_bits(&index);
        // Ordinary nonmembers, including slots beyond either bitmap, leave
        // every cache intact. Freeing a shared node invalidates both owners.
        index.free(unindexed);
        index.free(SlotIndex(arena.capacity() + 100));
        index.free(nodes[2]);
        assert!(!index.owners.contains_key(&owner));
        assert!(!index.owners.contains_key(&shared));
        assert!(index.owners.contains_key(&independent));
        check_bits(&index);
        let reads = std::cell::Cell::new(0);
        assert_eq!(
            index.find(independent, 0, |slot| {
                reads.set(reads.get() + 1);
                arena.get(slot)
            }),
            None
        );
        assert_eq!(reads.get(), 1, "the surviving cache only reads its owner");
        // Rebuild the dependent caches, then free an owner rather than a
        // watched property. The other shared owner must remain indexed.
        for object in [owner, shared] {
            assert_eq!(index.find(object, 0, |slot| arena.get(slot)), None);
        }
        index.free(owner);
        assert!(!index.owners.contains_key(&owner));
        assert!(index.owners.contains_key(&shared));
        check_bits(&index);
        arena.free(owner);
        let reused = arena.alloc(Slot::undefined());
        assert_eq!(reused, owner);
        assert_eq!(index.find(reused, 64, |slot| arena.get(slot)), None);
        assert_eq!(
            index.find(shared, 64, |slot| arena.get(slot)),
            Some(nodes[63])
        );
    }

    #[test]
    fn randomized_mutations_match_authoritative_shared_chains() {
        fn linear(arena: &SlotArena, owner: SlotIndex, id: u16) -> Option<SlotIndex> {
            let mut node = arena.get(owner).next;
            while !node.is_null() {
                let slot = arena.get(node);
                if slot.id == id {
                    return Some(node);
                }
                node = slot.next;
            }
            None
        }

        for seed in 1..=8u32 {
            let (mut arena, owner, nodes) = fixture();
            let owners = [
                owner,
                arena.alloc(arena.get(owner)),
                arena.alloc(arena.get(owner)),
            ];
            let mut random = seed;
            let mut draw = |bound: usize| {
                random ^= random << 13;
                random ^= random >> 17;
                random ^= random << 5;
                random as usize % bound
            };
            for step in 0..256 {
                // Rebuild long shared tails periodically so random truncation
                // does not leave the rest of the test exercising short chains.
                if step % 16 == 0 {
                    for (i, &node) in nodes.iter().enumerate() {
                        arena.get_mut(node).next = if i == 0 {
                            SlotIndex::NULL
                        } else {
                            nodes[i - 1]
                        };
                    }
                    for object in owners {
                        arena.get_mut(object).next = nodes[nodes.len() - 1];
                        assert_eq!(arena.find_property(object, 0), None);
                    }
                }
                let i = draw(nodes.len());
                let node = nodes[i];
                match draw(6) {
                    0 => arena.get_mut(node).id = (draw(80) + 1) as u16,
                    1 => arena.get_mut(node).value = Slot::integer(step).value,
                    2 => {
                        arena.get_mut(node).next = if i == 0 {
                            SlotIndex::NULL
                        } else {
                            nodes[draw(i)]
                        }
                    }
                    3 => arena.get_mut(owners[draw(owners.len())]).next = node,
                    4 => {
                        // Detach all incoming links before recycling a property.
                        let successor = arena.get(node).next;
                        for &other in nodes.iter().chain(owners.iter()) {
                            if arena.get(other).next == node {
                                arena.get_mut(other).next = successor;
                            }
                        }
                        arena.free(node);
                        let mut replacement = Slot::integer(step);
                        replacement.id = (draw(80) + 1) as u16;
                        replacement.next = successor;
                        assert_eq!(arena.alloc(replacement), node);
                        // A later node may prepend the recycled slot safely.
                        if i + 1 < nodes.len() {
                            arena.get_mut(nodes[i + 1]).next = node;
                        }
                    }
                    _ => {
                        let object = owners[draw(owners.len())];
                        arena.free(object);
                        let mut replacement = Slot::undefined();
                        replacement.next = node;
                        assert_eq!(arena.alloc(replacement), object);
                    }
                }
                for object in owners {
                    // Misses warm the index; duplicates must resolve to the
                    // first node encountered, including after slot reuse.
                    for id in 0..=81 {
                        assert_eq!(
                            arena.find_property(object, id),
                            linear(&arena, object, id),
                            "seed={seed}, step={step}, owner={object:?}, id={id}"
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn cyclic_suffix_does_not_hide_a_name_beyond_the_linear_prefix() {
        let (mut arena, owner, nodes) = fixture();
        // The sought name (20) is 45 nodes from the head; the cycle is
        // farther down, so the old linear lookup successfully returned it.
        arena.get_mut(nodes[0]).next = nodes[5];
        assert_eq!(arena.find_property(owner, 20), Some(nodes[19]));
        assert_eq!(arena.find_property(owner, 500), None);
        arena.get_mut(nodes[0]).next = SlotIndex(u32::MAX - 1);
        assert_eq!(arena.find_property(owner, 20), Some(nodes[19]));
    }

    #[test]
    fn cyclic_new_prefix_does_not_reuse_an_unreachable_cached_tail() {
        let (mut arena, owner, _) = fixture();
        let mut head = arena.get(owner).next;
        let mut prefix = Vec::new();
        for id in 100..140 {
            let mut slot = Slot::integer(i32::from(id));
            slot.id = id;
            slot.next = head;
            head = arena.alloc(slot);
            prefix.push(head);
        }
        arena.get_mut(prefix[0]).next = prefix[5];
        arena.get_mut(owner).next = head;
        assert_eq!(arena.find_property(owner, 105), Some(prefix[5]));
        assert_eq!(arena.find_property(owner, 1), None);
    }
}
