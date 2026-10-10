//! Compare repeated collection and slot reuse against an independent graph.
use std::collections::{BTreeMap, BTreeSet};

use ironhorse_vm::gc::Heap;
use ironhorse_vm::{Kind, Payload, Slot, SlotIndex};

struct Record {
    next: SlotIndex,
    target: SlotIndex,
    bytes: Option<Vec<u8>>,
}

fn next(state: &mut u32) -> u32 {
    *state ^= *state << 13;
    *state ^= *state >> 17;
    *state ^= *state << 5;
    *state
}

#[test]
fn graph_payloads_and_free_slots_remain_consistent_across_repeated_gc() {
    for seed in [1, 17, 0xdead_beef] {
        let mut random = seed;
        let mut heap = Heap::new();
        let mut model: BTreeMap<u32, Record> = BTreeMap::new();
        for round in 0..40 {
            for _ in 0..24 {
                let string = next(&mut random) & 1 == 0;
                let bytes = string.then(|| {
                    let len = (next(&mut random) % 2048) as usize;
                    (0..len)
                        .map(|i| (i as u8).wrapping_add(round))
                        .collect::<Vec<_>>()
                });
                let slot = match &bytes {
                    Some(bytes) => {
                        Slot::of(Kind::String, Payload::String(heap.chunks.alloc(bytes)))
                    }
                    None => Slot::instance(SlotIndex::NULL),
                };
                let id = heap.slots.alloc(slot);
                assert!(
                    model
                        .insert(
                            id.0,
                            Record {
                                next: SlotIndex::NULL,
                                target: SlotIndex::NULL,
                                bytes
                            }
                        )
                        .is_none(),
                    "allocator reused a live model node"
                );
            }
            let ids: Vec<_> = model.keys().copied().collect();
            // Rewire both edge families, including cycles and disconnected
            // islands. The model does not call the collector's edge walker.
            for (&id, record) in &mut model {
                let mut choose = || {
                    let n = next(&mut random) as usize % (ids.len() + 1);
                    ids.get(n)
                        .copied()
                        .map(SlotIndex)
                        .unwrap_or(SlotIndex::NULL)
                };
                record.next = choose();
                heap.slots.get_mut(SlotIndex(id)).next = record.next;
                if record.bytes.is_none() {
                    record.target = choose();
                    heap.slots.get_mut(SlotIndex(id)).value = Payload::Reference(record.target);
                }
            }
            let roots: Vec<_> = (0..3)
                .map(|_| SlotIndex(ids[next(&mut random) as usize % ids.len()]))
                .collect();
            let mut reachable = BTreeSet::new();
            let mut pending = roots.clone();
            while let Some(id) = pending.pop() {
                if id.is_null() || !reachable.insert(id.0) {
                    continue;
                }
                let record = &model[&id.0];
                pending.extend([record.next, record.target]);
            }
            heap.collect(&roots);
            model.retain(|id, _| reachable.contains(id));
            assert_eq!(heap.slots.live_count() as usize, model.len());
            for id in 0..heap.slots.capacity() {
                assert_eq!(
                    heap.slots.is_free_index(SlotIndex(id)),
                    !model.contains_key(&id)
                );
            }
            let mut chunks = Vec::new();
            for (&id, record) in &model {
                let slot = heap.slots.get(SlotIndex(id));
                assert_eq!(slot.next, record.next);
                if let Some(bytes) = &record.bytes {
                    let offset = slot.chunk_ref().unwrap();
                    chunks.push(offset);
                    assert_eq!(
                        &*heap.chunks.payload(offset),
                        bytes,
                        "seed {seed}, round {round}, slot {id}"
                    );
                } else {
                    assert_eq!(slot.value, Payload::Reference(record.target));
                }
            }
            heap.chunks.validate_references(&chunks).unwrap();
            let before = heap.chunks.raw_vec();
            let free = heap.slots.free_list().to_vec();
            let stats = heap.collect(&roots);
            assert_eq!(stats.slots_reclaimed, 0);
            assert_eq!(
                heap.chunks.raw_vec(),
                before,
                "second collection must be idempotent"
            );
            assert_eq!(heap.slots.free_list(), free);
        }
    }
}
