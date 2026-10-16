//! Derived lookup over the authoritative newest-first named-property chains.
//! Only long chains are indexed. No entry is a GC root or snapshot payload.
use crate::value::{Slot, SlotIndex};
use std::collections::{HashMap, HashSet};

#[derive(Default)]
struct Owner {
    head: Option<SlotIndex>,
    names: HashMap<u16, SlotIndex>,
    nodes: Vec<SlotIndex>,
    // The last node indexed, while the index stops short of the chain's end.
    frontier: Option<SlotIndex>,
}
struct Watched {
    id: u16,
    next: SlotIndex,
    owners: HashSet<SlotIndex>,
}
/// Deep hits on an owner with no index, and how many it takes to build one.
struct DeepHits {
    count: u16,
    threshold: u16,
}
/// The most deep hits an owner waits for before its index is rebuilt.
const MAX_DEEP_HITS: u16 = 256;
#[derive(Default)]
pub(crate) struct PropertyIndex {
    owners: HashMap<SlotIndex, Owner>,
    watched: HashMap<SlotIndex, Watched>,
    // Cheap write-path prefilter. Most writes are not to indexed nodes.
    watched_slots: Vec<bool>,
    // One additional bool (one byte) per slot up to the highest cached or
    // counted owner. Together with watched_slots this avoids hashing ordinary
    // garbage during sweep.
    owner_slots: Vec<bool>,
    pending: HashSet<SlotIndex>,
    // A hit past the linear prefix indexes the chain down to it only once the
    // owner has had `threshold` of them, which doubles with each index built
    // for it: a name read once costs only its walk, and an owner whose index
    // edits keep dropping rebuilds it ever more rarely.
    deep_hits: HashMap<SlotIndex, DeepHits>,
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
            self.owner_slots[owner.0 as usize] = self.deep_hits.contains_key(&owner);
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
        if self.deep_hits.remove(&slot).is_some() {
            self.owner_slots[offset] = false;
        }
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
        let previous = self.owners.get(&owner).and_then(|cache| cache.head);
        if previous != Some(head) {
            // No index, or names prepended or the head removed since it was
            // built. Most boot objects have short chains, and a name near the
            // head is the common case after an edit, so scan linearly first,
            // allocating nothing, as far as 32 nodes or the indexed part.
            let mut cur = head;
            for _ in 0..32 {
                if cur.is_null() {
                    return None;
                }
                if Some(cur) == previous {
                    break;
                }
                let slot = read(cur);
                if slot.id == id {
                    return Some(cur);
                }
                cur = slot.next;
            }
            match walk(cur, previous, id, &read) {
                Walk::Found(node) => {
                    if !self.deep_hit(owner) {
                        return Some(node);
                    }
                    // Index the chain down to the name and stop there:
                    // finding a name must not read any later, possibly
                    // invalid or unfaulted, suffix. A later lookup answers
                    // from this prefix or continues below it.
                    self.drop_owner(owner);
                    let prefix = collect(head, Some(node), SlotIndex::NULL, &read);
                    self.publish(owner, &prefix, false);
                    let cache = self.owners.entry(owner).or_default();
                    cache.head = Some(head);
                    cache.frontier = Some(node);
                    return Some(node);
                }
                Walk::Cycle => {
                    self.drop_owner(owner);
                    return None;
                }
                Walk::End => {
                    self.drop_owner(owner);
                    let chain = collect(head, None, SlotIndex::NULL, &read);
                    self.publish(owner, &chain, false);
                    self.owners.entry(owner).or_default().head = Some(head);
                    return None;
                }
                Walk::Reached(indexed) => {
                    // Names prepended to an indexed chain: index them too,
                    // ahead of it, so the newest duplicate still wins.
                    let prefix = collect(head, None, indexed, &read);
                    self.publish(owner, &prefix, true);
                    self.owners.entry(owner).or_default().head = Some(head);
                }
            }
        }
        let cache = self.owners.get(&owner)?;
        if let Some(&node) = cache.names.get(&id) {
            return Some(node);
        }
        // A partial index continues below its frontier, to the name or the
        // end of the chain, never past the name. The frontier is watched, so
        // its link is the one the index was built through.
        let frontier = cache.frontier?;
        let below = read(frontier).next;
        match walk(below, None, id, &read) {
            Walk::Found(node) => {
                let suffix = collect(below, Some(node), SlotIndex::NULL, &read);
                self.publish(owner, &suffix, false);
                self.owners.get_mut(&owner)?.frontier = Some(node);
                Some(node)
            }
            Walk::End => {
                let suffix = collect(below, None, SlotIndex::NULL, &read);
                self.publish(owner, &suffix, false);
                self.owners.get_mut(&owner)?.frontier = None;
                None
            }
            Walk::Cycle | Walk::Reached(_) => {
                self.drop_owner(owner);
                None
            }
        }
    }

    /// Count a hit past the linear prefix on `owner`, which has no index for
    /// it, and say whether to index the chain down to it now.
    fn deep_hit(&mut self, owner: SlotIndex) -> bool {
        if self.owner_slots.len() <= owner.0 as usize {
            self.owner_slots.resize(owner.0 as usize + 1, false);
        }
        self.owner_slots[owner.0 as usize] = true;
        let hits = self.deep_hits.entry(owner).or_insert(DeepHits {
            count: 0,
            threshold: 2,
        });
        hits.count += 1;
        if hits.count < hits.threshold {
            return false;
        }
        hits.count = 0;
        hits.threshold = hits.threshold.saturating_mul(2).min(MAX_DEEP_HITS);
        true
    }

    /// Index `nodes`, contiguous in `owner`'s chain and newest first, and
    /// watch each one's name and link. `newer` says they precede every node
    /// already indexed, so they take a shared name from it; otherwise they
    /// follow it and leave it the name. Either way the newest duplicate wins,
    /// as in a linear scan.
    fn publish(&mut self, owner: SlotIndex, nodes: &[(SlotIndex, u16, SlotIndex)], newer: bool) {
        if self.owner_slots.len() <= owner.0 as usize {
            self.owner_slots.resize(owner.0 as usize + 1, false);
        }
        self.owner_slots[owner.0 as usize] = true;
        let cache = self.owners.entry(owner).or_default();
        if newer {
            for &(node, name, _) in nodes.iter().rev() {
                cache.names.insert(name, node);
            }
        } else {
            for &(node, name, _) in nodes {
                cache.names.entry(name).or_insert(node);
            }
        }
        cache.nodes.extend(nodes.iter().map(|&(node, _, _)| node));
        for &(node, name, next) in nodes {
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
}

/// Where a walk down a chain stopped.
enum Walk {
    /// At the first node holding the name.
    Found(SlotIndex),
    /// At the indexed part, without the name.
    Reached(SlotIndex),
    /// At the chain's end, without the name.
    End,
    /// On a cycle, without the name.
    Cycle,
}

/// Walk from `cur` to the name, `until`, or the end. Public arena edits can
/// make a cyclic chain; Brent's check (a marker moved to the walk's position
/// at each power of two) stops the walk without allocating, so a hit costs
/// only its reads. A linear lookup could still find a name before the cycle.
fn walk(
    mut cur: SlotIndex,
    until: Option<SlotIndex>,
    id: u16,
    read: &impl Fn(SlotIndex) -> Slot,
) -> Walk {
    let mut marker = SlotIndex::NULL;
    let (mut steps, mut power) = (0u32, 1u32);
    loop {
        if cur.is_null() {
            return Walk::End;
        }
        if Some(cur) == until {
            return Walk::Reached(cur);
        }
        if cur == marker {
            return Walk::Cycle;
        }
        if steps == power {
            marker = cur;
            power = power.saturating_mul(2);
            steps = 0;
        }
        steps += 1;
        let slot = read(cur);
        if slot.id == id {
            return Walk::Found(cur);
        }
        cur = slot.next;
    }
}

/// The nodes from `from` through `last`, or else up to `stop`, which a
/// [`walk`] has shown the chain reaches without a cycle, with each one's name
/// and link. The last node's own link may lead anywhere, back up the chain
/// included, so it is never the stopping test.
fn collect(
    from: SlotIndex,
    last: Option<SlotIndex>,
    stop: SlotIndex,
    read: &impl Fn(SlotIndex) -> Slot,
) -> Vec<(SlotIndex, u16, SlotIndex)> {
    let mut nodes = Vec::new();
    let mut node = from;
    while node != stop {
        let slot = read(node);
        nodes.push((node, slot.id, slot.next));
        if Some(node) == last {
            break;
        }
        node = slot.next;
    }
    nodes
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

    fn cold_chain(ids: &[u16]) -> (SlotArena, SlotIndex, Vec<SlotIndex>) {
        let mut arena = SlotArena::new();
        let owner = arena.alloc(Slot::undefined());
        let mut nodes = Vec::new();
        for &id in ids.iter().rev() {
            let mut property = Slot::integer(i32::from(id));
            property.id = id;
            property.next = arena.get(owner).next;
            let node = arena.alloc(property);
            arena.get_mut(owner).next = node;
            nodes.push(node);
        }
        nodes.reverse();
        (arena, owner, nodes)
    }

    /// A name read once past the linear prefix costs only its walk: nothing
    /// is indexed.
    #[test]
    fn a_name_read_once_past_the_linear_prefix_builds_no_index() {
        let ids: Vec<u16> = (1..=100).collect();
        let (arena, owner, nodes) = cold_chain(&ids);
        let mut index = super::PropertyIndex::default();
        let read = |slot: SlotIndex| arena.get(slot);
        assert_eq!(index.find(owner, 60, read), Some(nodes[59]));
        assert!(!index.owners.contains_key(&owner));
        assert!(index.watched.is_empty());
    }

    /// A name read again past the linear prefix indexes the chain down to
    /// itself and no further: a bad link right below it stays unread, and
    /// names above it answer from the index.
    #[test]
    fn a_repeated_deep_hit_indexes_down_to_itself_and_reads_no_further() {
        let ids: Vec<u16> = (1..=100).collect();
        let (mut arena, owner, nodes) = cold_chain(&ids);
        arena.get_mut(nodes[59]).next = SlotIndex(u32::MAX - 1);
        let mut index = super::PropertyIndex::default();
        let read = |slot: SlotIndex| arena.get(slot);
        for _ in 0..3 {
            assert_eq!(index.find(owner, 60, read), Some(nodes[59]));
            assert_eq!(index.find(owner, 45, read), Some(nodes[44]));
        }
        let cache = &index.owners[&owner];
        assert_eq!(cache.frontier, Some(nodes[59]));
        assert_eq!(cache.nodes.len(), 60);
        assert_eq!(cache.names[&45], nodes[44]);
    }

    /// Index a chain down to `id` by reading it twice past the linear prefix.
    fn index_down_to(
        index: &mut super::PropertyIndex,
        arena: &SlotArena,
        owner: SlotIndex,
        id: u16,
    ) -> Option<SlotIndex> {
        let read = |slot: SlotIndex| arena.get(slot);
        let first = index.find(owner, id, read);
        assert_eq!(index.find(owner, id, read), first);
        first
    }

    /// A name below the frontier continues the walk from it, to the name and
    /// no further, and a miss completes the index.
    #[test]
    fn a_partial_index_continues_below_its_frontier() {
        let ids: Vec<u16> = (1..=100).collect();
        let (mut arena, owner, nodes) = cold_chain(&ids);
        let mut index = super::PropertyIndex::default();
        assert_eq!(
            index_down_to(&mut index, &arena, owner, 40),
            Some(nodes[39])
        );
        arena.get_mut(nodes[69]).next = SlotIndex(u32::MAX - 1);
        let read = |slot: SlotIndex| arena.get(slot);
        assert_eq!(index.find(owner, 70, read), Some(nodes[69]));
        assert_eq!(index.owners[&owner].frontier, Some(nodes[69]));
        assert_eq!(index.owners[&owner].nodes.len(), 70);
        assert_eq!(index.find(owner, 55, read), Some(nodes[54]));
        // Repairing the frontier's link is an edit the index sees.
        arena.get_mut(nodes[69]).next = nodes[70];
        let read = |slot: SlotIndex| arena.get(slot);
        assert_eq!(index.find(owner, 999, read), None);
        assert_eq!(index.owners[&owner].frontier, None);
        assert_eq!(index.owners[&owner].nodes.len(), 100);
        assert_eq!(index.find(owner, 100, read), Some(nodes[99]));
    }

    /// The newest duplicate wins on either side of the frontier.
    #[test]
    fn a_partial_index_keeps_the_newest_duplicate() {
        let mut ids: Vec<u16> = (1..=100).collect();
        ids[69] = 5;
        ids[89] = 70;
        let (arena, owner, nodes) = cold_chain(&ids);
        let mut index = super::PropertyIndex::default();
        let read = |slot: SlotIndex| arena.get(slot);
        assert_eq!(
            index_down_to(&mut index, &arena, owner, 40),
            Some(nodes[39])
        );
        assert_eq!(index.find(owner, 70, read), Some(nodes[89]));
        assert_eq!(index.find(owner, 5, read), Some(nodes[4]));
        assert_eq!(index.find(owner, 999, read), None);
        assert_eq!(index.find(owner, 5, read), Some(nodes[4]));
        assert_eq!(index.find(owner, 70, read), Some(nodes[89]));
    }

    /// A cycle below the frontier ends a miss and drops the index; a name on
    /// the way to it is still found.
    #[test]
    fn a_cycle_below_the_frontier_ends_a_miss() {
        let ids: Vec<u16> = (1..=100).collect();
        let (mut arena, owner, nodes) = cold_chain(&ids);
        let mut index = super::PropertyIndex::default();
        assert_eq!(
            index_down_to(&mut index, &arena, owner, 40),
            Some(nodes[39])
        );
        arena.get_mut(nodes[80]).next = nodes[70];
        let read = |slot: SlotIndex| arena.get(slot);
        assert_eq!(index.find(owner, 999, read), None);
        assert!(!index.owners.contains_key(&owner));
        assert_eq!(index.find(owner, 76, read), Some(nodes[75]));
        // Into the indexed part as well.
        arena.get_mut(nodes[80]).next = nodes[10];
        let read = |slot: SlotIndex| arena.get(slot);
        assert_eq!(
            index_down_to(&mut index, &arena, owner, 40),
            Some(nodes[39])
        );
        assert_eq!(index.find(owner, 999, read), None);
        assert_eq!(index.find(owner, 81, read), Some(nodes[80]));
    }

    /// A name whose link leads back up the chain is indexed with every node
    /// above it, so editing that link later is an edit the index sees.
    #[test]
    fn a_hit_linking_back_up_the_chain_indexes_every_node_above_it() {
        let ids: Vec<u16> = (1..=100).collect();
        let (mut arena, owner, nodes) = cold_chain(&ids);
        arena.get_mut(nodes[59]).next = nodes[40];
        let mut index = super::PropertyIndex::default();
        assert_eq!(
            index_down_to(&mut index, &arena, owner, 60),
            Some(nodes[59])
        );
        assert_eq!(index.owners[&owner].nodes.len(), 60);
        index.will_mutate(nodes[59]);
        arena.get_mut(nodes[59]).next = SlotIndex::NULL;
        let read = |slot: SlotIndex| arena.get(slot);
        assert_eq!(index.find(owner, 50, read), Some(nodes[49]));
        assert_eq!(index.find(owner, 61, read), None);
    }

    /// After the head moves, a name near it is found by the linear prefix,
    /// which allocates nothing, and the index waits for a name below it.
    #[test]
    fn a_name_near_a_moved_head_is_found_without_the_index() {
        let ids: Vec<u16> = (1..=100).collect();
        let (mut arena, owner, nodes) = cold_chain(&ids);
        let mut index = super::PropertyIndex::default();
        let read = |slot: SlotIndex| arena.get(slot);
        assert_eq!(index.find(owner, 999, read), None);
        // The head removed.
        arena.get_mut(owner).next = nodes[1];
        let read = |slot: SlotIndex| arena.get(slot);
        assert_eq!(index.find(owner, 21, read), Some(nodes[20]));
        assert_eq!(index.owners[&owner].head, Some(nodes[0]));
        assert_eq!(index.find(owner, 1, read), None);
        assert_eq!(index.find(owner, 80, read), Some(nodes[79]));
        // Twelve names prepended.
        let mut fresh = Vec::new();
        for id in 1001..=1012u16 {
            let mut property = Slot::integer(0);
            property.id = id;
            property.next = arena.get(owner).next;
            let node = arena.alloc(property);
            arena.get_mut(owner).next = node;
            fresh.push(node);
        }
        let read = |slot: SlotIndex| arena.get(slot);
        let before = index.owners.get(&owner).map(|cache| cache.head);
        assert_eq!(index.find(owner, 1002, read), Some(fresh[1]));
        assert_eq!(index.owners.get(&owner).map(|cache| cache.head), before);
        assert_eq!(index.find(owner, 80, read), Some(nodes[79]));
        assert_eq!(index.find(owner, 1001, read), Some(fresh[0]));
        assert_eq!(index.find(owner, 2, read), Some(nodes[1]));
    }

    /// Each index built for an owner doubles the deep hits its next one
    /// waits for, up to a limit, and freeing the owner forgets them.
    #[test]
    fn an_index_edits_keep_dropping_is_rebuilt_ever_more_rarely() {
        let ids: Vec<u16> = (1..=100).collect();
        let (mut arena, owner, nodes) = cold_chain(&ids);
        let mut index = super::PropertyIndex::default();
        let mut builds = Vec::new();
        for hit in 1..=2000u32 {
            let link = if hit % 2 == 0 { nodes[7] } else { nodes[6] };
            arena.get_mut(nodes[5]).next = link;
            index.will_mutate(nodes[5]);
            let read = |slot: SlotIndex| arena.get(slot);
            assert_eq!(index.find(owner, 80, read), Some(nodes[79]));
            if index.owners.contains_key(&owner) {
                builds.push(hit);
            }
        }
        let gaps: Vec<u32> = builds.windows(2).map(|pair| pair[1] - pair[0]).collect();
        assert_eq!(&gaps[..7], &[4, 8, 16, 32, 64, 128, 256]);
        assert!(gaps[7..].iter().all(|&gap| gap == 256), "{gaps:?}");
        index.free(owner);
        assert!(!index.deep_hits.contains_key(&owner));
        assert!(!index.owner_slots[owner.0 as usize]);
    }

    /// A cycle below the linear prefix ends a miss, and a name on the way to
    /// it, or on the cycle itself, is still found.
    #[test]
    fn a_cycle_below_the_linear_prefix_ends_a_miss() {
        let ids: Vec<u16> = (1..=64).collect();
        let (mut arena, owner, nodes) = cold_chain(&ids);
        arena.get_mut(nodes[50]).next = nodes[45];
        assert_eq!(arena.find_property(owner, 500), None);
        assert_eq!(arena.find_property(owner, 40), Some(nodes[39]));
        assert_eq!(arena.find_property(owner, 46), Some(nodes[45]));
        assert_eq!(arena.find_property(owner, 51), Some(nodes[50]));
        assert_eq!(arena.find_property(owner, 500), None);
        // A self-link stops at once.
        arena.get_mut(nodes[50]).next = nodes[50];
        assert_eq!(arena.find_property(owner, 500), None);
        assert_eq!(arena.find_property(owner, 51), Some(nodes[50]));
    }

    /// Partial indexes agree with a linear scan through random edits: every
    /// deep hit indexes (the counts are cleared each round), so lookups keep
    /// building, continuing and resynchronizing them.
    #[test]
    fn randomized_partial_indexes_match_a_linear_scan() {
        fn linear(arena: &SlotArena, owner: SlotIndex, id: u16) -> Option<SlotIndex> {
            let mut visited = std::collections::HashSet::new();
            let mut node = arena.get(owner).next;
            while !node.is_null() && visited.insert(node) {
                let slot = arena.get(node);
                if slot.id == id {
                    return Some(node);
                }
                node = slot.next;
            }
            None
        }
        for seed in 1..=24u32 {
            let ids: Vec<u16> = (1..=120).map(|id| (id % 90) + 1).collect();
            let (mut arena, owner, mut nodes) = cold_chain(&ids);
            let mut index = super::PropertyIndex::default();
            let mut random = seed;
            let mut draw = |bound: usize| {
                random ^= random << 13;
                random ^= random >> 17;
                random ^= random << 5;
                random as usize % bound
            };
            for step in 0..200 {
                let i = draw(nodes.len());
                let node = nodes[i];
                match draw(8) {
                    0 => {
                        index.will_mutate(node);
                        arena.get_mut(node).id = (draw(100) + 1) as u16;
                    }
                    1 => {
                        index.will_mutate(node);
                        arena.get_mut(node).value = Slot::integer(step).value;
                    }
                    2 => {
                        let mut property = Slot::integer(step);
                        property.id = (draw(100) + 1) as u16;
                        property.next = arena.get(owner).next;
                        let newest = arena.alloc(property);
                        arena.get_mut(owner).next = newest;
                        nodes.push(newest);
                    }
                    3 if i > 0 => {
                        index.will_mutate(nodes[i - 1]);
                        arena.get_mut(nodes[i - 1]).next = arena.get(node).next;
                    }
                    4 => {
                        // The head removed.
                        let head = arena.get(owner).next;
                        if !head.is_null() {
                            arena.get_mut(owner).next = arena.get(head).next;
                        }
                    }
                    5 | 6 => {
                        // Any link, a cycle included.
                        index.will_mutate(node);
                        arena.get_mut(node).next = nodes[draw(nodes.len())];
                    }
                    _ => {
                        // Repair a link to the node below, as built.
                        if let Some(&below) = nodes.get(i + 1).filter(|_| i < ids.len()) {
                            index.will_mutate(node);
                            arena.get_mut(node).next = below;
                        }
                    }
                }
                index.deep_hits.clear();
                for (offset, bit) in index.owner_slots.iter_mut().enumerate() {
                    *bit = index.owners.contains_key(&SlotIndex(offset as u32));
                }
                for _ in 0..24 {
                    let id = draw(102) as u16;
                    let read = |slot: SlotIndex| arena.get(slot);
                    assert_eq!(
                        index.find(owner, id, read),
                        linear(&arena, owner, id),
                        "seed={seed}, step={step}, id={id}"
                    );
                }
            }
        }
    }

    /// Hits and misses on long chains agree with a linear scan that stops
    /// where it would revisit a node, through random edits that include
    /// cycles, prepends and splices.
    #[test]
    fn randomized_long_chain_lookups_match_a_linear_scan() {
        fn linear(arena: &SlotArena, owner: SlotIndex, id: u16) -> Option<SlotIndex> {
            let mut visited = std::collections::HashSet::new();
            let mut node = arena.get(owner).next;
            while !node.is_null() && visited.insert(node) {
                let slot = arena.get(node);
                if slot.id == id {
                    return Some(node);
                }
                node = slot.next;
            }
            None
        }
        for seed in 1..=16u32 {
            let ids: Vec<u16> = (1..=96).map(|id| (id % 70) + 1).collect();
            let (mut arena, owner, mut nodes) = cold_chain(&ids);
            let mut random = seed;
            let mut draw = |bound: usize| {
                random ^= random << 13;
                random ^= random >> 17;
                random ^= random << 5;
                random as usize % bound
            };
            for step in 0..160 {
                let i = draw(nodes.len());
                let node = nodes[i];
                match draw(6) {
                    0 => arena.get_mut(node).id = (draw(80) + 1) as u16,
                    1 => arena.get_mut(node).value = Slot::integer(step).value,
                    2 => {
                        let mut property = Slot::integer(step);
                        property.id = (draw(80) + 1) as u16;
                        property.next = arena.get(owner).next;
                        let newest = arena.alloc(property);
                        arena.get_mut(owner).next = newest;
                        nodes.push(newest);
                    }
                    3 if i > 0 => arena.get_mut(nodes[i - 1]).next = arena.get(node).next,
                    4 if draw(4) == 0 => {
                        // Any link, a cycle included.
                        arena.get_mut(node).next = nodes[draw(nodes.len())];
                    }
                    _ => {}
                }
                for _ in 0..24 {
                    let id = draw(82) as u16;
                    assert_eq!(
                        arena.find_property(owner, id),
                        linear(&arena, owner, id),
                        "seed={seed}, step={step}, id={id}"
                    );
                }
            }
        }
    }
}
