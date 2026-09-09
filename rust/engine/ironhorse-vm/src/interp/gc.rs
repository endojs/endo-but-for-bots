//! Whole-machine collection, side-table projections, and arena compaction.

use super::{gc_tables, is_promise_resolving_guard, Interp, PromiseJob, ReactionKind};

impl Interp {
    /// The machine's complete GC root set (registers, value stack,
    /// frames, globals, boot/proto anchors, run stacks, the completion
    /// register, the pending microtask queue, in-flight combinator
    /// state reachable from queued jobs, and the strong symbol
    /// registry) — the root assembly [`Self::collect_garbage`] marks
    /// from, exposed so store-side collectors (the phase-6
    /// summary-driven partial collect) can ask "which pages hold
    /// roots" without re-enumerating machine internals. Sorted and
    /// deduplicated, so the sequence really is fixed: two of the
    /// sources below are `HashMap`s whose iteration order varies per
    /// process, and the determinism claim on
    /// [`Self::collect_garbage`] must hold by construction, not by
    /// the mark set happening to be order-independent.
    pub fn gc_roots(&self) -> Vec<crate::value::SlotIndex> {
        let mut roots = Vec::new();
        self.append_gc_roots(&mut roots);
        roots.sort_unstable_by_key(|r| r.0);
        roots.dedup();
        roots
    }

    /// Collect garbage across the WHOLE machine: arenas plus every
    /// side table. Roots are [`Self::gc_roots`]; a keyed side-table
    /// entry is an EDGE from its object, so dead objects drop their
    /// entries instead of leaking through them; side-table-held chunk
    /// offsets (function name chunks, ArrayBuffer backing stores,
    /// string `Slot`s stored outside the arena, the interned `typeof`
    /// strings) participate in compaction liveness and are rewritten
    /// like arena-resident strings. Deterministic: trace order is
    /// worklist order from a fixed (sorted) root sequence, sweep is
    /// index order.
    pub fn collect_garbage(&mut self) -> crate::gc::GcStats {
        self.classes.1.mark_all();
        use crate::value::SlotIndex;

        let roots = self.gc_roots();

        let mut hooks = gc_tables!(borrow_gc_tables, self);
        let stats = crate::gc::collect_full(&mut self.slots, &mut self.chunks, &roots, &mut hooks);
        let swept = std::mem::take(&mut hooks.swept);
        let dead: std::collections::HashSet<SlotIndex> = swept.into_iter().collect();
        hooks.prune_late(&dead);
        drop(hooks);

        self.compact_code_segments();
        self.compact_reaction_arenas();

        stats
    }

    /// Compact `combinators`, `from_async`, and `promise_guards`.
    /// An arena index is live while some surviving
    /// holder still names it: a `ReactionKind::Combine`/`FromAsync*`
    /// on a live promise's pending reactions or a queued job
    /// (combinators, fromAsync), or a live resolving-function pair's
    /// `guard` (promise_guards). The compaction keeps live entries in
    /// index order, re-points every holder onto the dense arena, and
    /// drops the rest. Runs at the end of both collectors' sweeps —
    /// deterministic (holder contents only, stable order) and
    /// guest-invisible (indices never surface; nothing is metered).
    fn compact_reaction_arenas(&mut self) {
        use std::collections::BTreeSet;
        let mut live_comb: BTreeSet<u32> = BTreeSet::new();
        let mut live_fa: BTreeSet<u32> = BTreeSet::new();
        {
            let mut note = |kind: &ReactionKind| match *kind {
                ReactionKind::Combine(ci, _) | ReactionKind::CombineDirect(ci, _) => {
                    live_comb.insert(ci);
                }
                ReactionKind::FromAsyncNext(fa)
                | ReactionKind::FromAsyncElem(fa)
                | ReactionKind::FromAsyncMap(fa)
                | ReactionKind::FromAsyncClose(fa) => {
                    live_fa.insert(fa);
                }
                _ => {}
            };
            for p in self.promises.values() {
                for r in &p.reactions {
                    note(&r.kind);
                }
            }
            for j in &self.promise_jobs {
                if let PromiseJob::Reaction { reaction, .. } = j {
                    note(&reaction.kind);
                }
            }
        }
        let live_guards: BTreeSet<usize> = self
            .promise_functions
            .values()
            .filter_map(|d| is_promise_resolving_guard(d.guard).then_some(d.guard))
            .collect();

        // Fully-live arenas need no rewrite (every index below the
        // length is referenced, so every remap would be the identity).
        if live_comb.len() == self.combinators.len()
            && live_fa.len() == self.from_async.len()
            && live_guards.len() == self.promise_guards.len()
        {
            return;
        }

        let comb_map: std::collections::HashMap<u32, u32> = live_comb
            .iter()
            .enumerate()
            .map(|(new, &old)| (old, new as u32))
            .collect();
        let fa_map: std::collections::HashMap<u32, u32> = live_fa
            .iter()
            .enumerate()
            .map(|(new, &old)| (old, new as u32))
            .collect();
        let guard_map: std::collections::HashMap<usize, usize> = live_guards
            .iter()
            .enumerate()
            .map(|(new, &old)| (old, new))
            .collect();

        let repoint = |kind: &mut ReactionKind| match kind {
            ReactionKind::Combine(ci, _) | ReactionKind::CombineDirect(ci, _) => *ci = comb_map[ci],
            ReactionKind::FromAsyncNext(fa)
            | ReactionKind::FromAsyncElem(fa)
            | ReactionKind::FromAsyncMap(fa)
            | ReactionKind::FromAsyncClose(fa) => *fa = fa_map[fa],
            _ => {}
        };
        for p in self.promises.values_mut() {
            for r in &mut p.reactions {
                repoint(&mut r.kind);
            }
        }
        for j in &mut self.promise_jobs {
            if let PromiseJob::Reaction { reaction, .. } = j {
                repoint(&mut reaction.kind);
            }
        }
        for d in self.promise_functions.values_mut() {
            if is_promise_resolving_guard(d.guard) {
                d.guard = guard_map[&d.guard];
            }
        }

        let old = self.combinators.take();
        *self.combinators = old
            .into_iter()
            .enumerate()
            .filter(|(i, _)| live_comb.contains(&(*i as u32)))
            .map(|(_, e)| e)
            .collect();
        let old = std::mem::take(&mut self.from_async);
        self.from_async = old
            .into_iter()
            .enumerate()
            .filter(|(i, _)| live_fa.contains(&(*i as u32)))
            .map(|(_, e)| e)
            .collect();
        let old = self.promise_guards.take();
        *self.promise_guards = old
            .into_iter()
            .enumerate()
            .filter(|(i, _)| live_guards.contains(i))
            .map(|(_, e)| e)
            .collect();
    }

    /// Drop code buffers no live guest function references and remap the
    /// surviving function→segment indices densely.
    fn compact_code_segments(&mut self) {
        let live: std::collections::BTreeSet<usize> =
            self.func_segments.values().copied().collect();
        if live.len() == self.code_segments.len()
            && live.iter().copied().eq(0..self.code_segments.len())
        {
            return;
        }
        let remap: std::collections::BTreeMap<usize, usize> = live
            .iter()
            .enumerate()
            .map(|(new, old)| (*old, new))
            .collect();
        let old = self.code_segments.take();
        *self.code_segments = old
            .into_iter()
            .enumerate()
            .filter_map(|(index, segment)| live.contains(&index).then_some(segment))
            .collect();
        for segment in self.func_segments.values_mut() {
            *segment = remap[segment];
        }
    }
}

// Page-granular freeing for the store-side partial collector.
impl Interp {
    /// Free every live slot in the given pages (deterministic index
    /// order) and drop the side-table entries keyed by them — the
    /// page-granular reclamation the summary-driven partial collector
    /// performs. The caller (the store layer) has proven the pages
    /// unreachable from the machine's [`Self::gc_roots`] **plus**
    /// [`Self::side_table_ref_slots`] via the persisted page-edge
    /// summaries; chunk space held by freed string slots is reclaimed
    /// by the next full [`Self::collect_garbage`] (partial collection
    /// never compacts). Returns the number of slots freed. Freeing
    /// never dirties: no record byte changes — the reclamation
    /// travels as free-list state (free-segment rows plus the
    /// manifest's `free_len`), exactly like a sweep.
    pub fn free_pages(&mut self, pages: &[u32]) -> u32 {
        use crate::value::{SlotIndex, SLOTS_PER_PAGE};
        // A counted-reference failure is permanent for this machine.
        // No caller may free from a projection known to be corrupt.
        if self.side_refs.is_poisoned() {
            return 0;
        }
        let mut freed: Vec<SlotIndex> = Vec::new();
        let mut sorted: Vec<u32> = pages.to_vec();
        sorted.sort_unstable();
        sorted.dedup();
        for &page in &sorted {
            // u64 page math: `page * SLOTS_PER_PAGE` would wrap u32 at
            // the maximal page index, turning an out-of-range page
            // into a bogus in-range sweep.
            let start =
                (page as u64 * SLOTS_PER_PAGE as u64).min(self.slots.capacity() as u64) as u32;
            let end =
                ((start as u64 + SLOTS_PER_PAGE as u64).min(self.slots.capacity() as u64)) as u32;
            for i in start..end {
                let idx = SlotIndex(i);
                if !self.slots.is_free_index(idx) {
                    self.slots.free(idx);
                    freed.push(idx);
                }
            }
        }
        let dead: std::collections::HashSet<SlotIndex> = freed.iter().copied().collect();
        self.prune_dead_tables(&dead);
        self.compact_code_segments();
        self.compact_reaction_arenas();
        freed.len() as u32
    }

    /// Every slot index held in a side-table VALUE — the same edge
    /// set [`Self::collect_garbage`]'s `extra_edges` hook reports,
    /// but enumerated over every entry regardless of its key's
    /// liveness. The summary-driven partial collector must root these
    /// pages: the persisted page-edge summaries carry only ARENA
    /// edges (`Slot.next` + `Payload::Reference`), so a reference
    /// held in a Rust-side table — an Array's element map, a Map/Set
    /// entry, a captured closure record, a bound function's target, a
    /// suspended generator/async frame, a pending reaction — is
    /// invisible to the stored graph, and a page reachable only
    /// through one would otherwise be freed while live.
    /// Treating every side-table value as a
    /// page root is strictly conservative: an entry whose key is dead
    /// keeps its values' pages one partial collection longer; the
    /// full [`Self::collect_garbage`] reclaims exactly.
    pub fn side_table_ref_slots(&self) -> Vec<crate::value::SlotIndex> {
        let mut out: Vec<crate::value::SlotIndex> = Vec::new();
        self.each_side_table_ref(&mut |r| out.push(r));
        out.sort_unstable_by_key(|r| r.0);
        out.dedup();
        out
    }

    /// One flag per [`crate::value::SLOTS_PER_PAGE`]-slot page of the
    /// arena: whether any side-table value references a slot on it —
    /// the page-granular projection the summary-driven partial
    /// collector roots from. Bulk tables use standing page counts;
    /// the remaining tables are enumerated directly. In debug builds
    /// and with `store-integrity`, a full enumeration verifies the
    /// projection. A mismatch or counted-state underflow/overflow
    /// permanently prevents quiescence and page freeing, and returns
    /// all pages as roots. Out-of-arena indices (including the null
    /// sentinel) fall outside the bitmap and are skipped.
    pub fn side_table_ref_page_bits(&self) -> Vec<bool> {
        let pages = self.slots.capacity().div_ceil(crate::value::SLOTS_PER_PAGE) as usize;
        let mut bits = vec![false; pages];
        // The TAIL tables (functions, promises, iterators, …) stay an
        // O(small) walk; the BULK tables (array items, ordinary index properties,
        // and collection entries) use the standing per-page refcounts the
        // counted accessors maintain (design § Plan: counted
        // side-table ref-page accessors) — O(pages-with-refs) instead
        // of O(live entries).
        self.each_side_table_ref_tail(&mut |r| {
            if !r.is_null() {
                if let Some(b) = bits.get_mut((r.0 / crate::value::SLOTS_PER_PAGE) as usize) {
                    *b = true;
                }
            }
        });
        self.side_refs.or_into_bits(&mut bits);
        // Parity net: the standing counts must agree
        // with a fresh enumeration of every side table — a missed
        // counted mutation shows up HERE, before the collector can
        // free a live page or pin a dead one.
        #[cfg(any(debug_assertions, feature = "store-integrity"))]
        {
            let mut walked = vec![false; pages];
            self.each_side_table_ref(&mut |r| {
                if !r.is_null() {
                    if let Some(b) = walked.get_mut((r.0 / crate::value::SLOTS_PER_PAGE) as usize) {
                        *b = true;
                    }
                }
            });
            if bits != walked {
                self.side_refs.poison();
            }
        }
        // Preserve the bitmap API conservatively. Store callers check
        // quiescence after this projection and return a refusal; other
        // callers receive no reclaimable pages, and free_pages is gated.
        if self.side_refs.is_poisoned() {
            bits.fill(true);
        }
        bits
    }
}
