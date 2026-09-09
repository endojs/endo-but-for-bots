//! GC table inventory and generated sweep operations.
//!
//! Early rows must disappear before chunk compaction. Late rows carry no chunks
//! requiring rewrite, and held rows participate in tracing without owner pruning.
//! Counted rows release their page references in both collectors. Private-element
//! keys depend on both the receiver and cell; accessor keys depend on the owner.
use super::*;
use crate::value::{ChunkOffset, SlotIndex};

macro_rules! gc_tables {
    ($consumer:ident $(, $arg:ident)*) => {
        interp_state! { select_gc_tables, $consumer $(, $arg)* }
    };
}

macro_rules! gc_run {
    ($($code:tt)*) => {{ $($code)* }};
}
macro_rules! gc_text {
    ($($code:tt)*) => { stringify!($($code)*) };
}

// Each rule emits either executable tokens or their exact source spelling. The
// independent registry checks the latter, including its call sites, so metadata
// alone never counts as evidence that a table is actually pruned.
macro_rules! gc_remove {
    ($emit:ident, $vm:ident, $field:ident, $idx:ident, keys) => {
        gc_remove!($emit, $vm, $field, $idx, map)
    };
    ($emit:ident, $vm:ident, $field:ident, $idx:ident, map) => {
        $emit! { $vm.$field.remove(&$idx); }
    };
    ($emit:ident, $vm:ident, $field:ident, $idx:ident, counted) => {
        $emit! {
            if let Some(row) = $vm.$field.remove(&$idx) {
                row.drop_refs(&mut $vm.side_refs);
            }
        }
    };
    ($emit:ident, $vm:ident, $field:ident, $idx:ident, owner_pair) => {
        $emit! { $vm.$field.retain(|(owner, _), _| *owner != $idx); }
    };
    ($emit:ident, $vm:ident, $field:ident, $idx:ident, both_pair) => {
        $emit! {
            $vm.$field.retain(|(owner, cell), _| *owner != $idx && *cell != $idx);
        }
    };
}
macro_rules! gc_retain {
    ($emit:ident, $vm:ident, $field:ident, $dead:ident, keys) => {
        $emit! { $vm.$field.retain_keys(|key| !$dead.contains(key)); }
    };
    ($emit:ident, $vm:ident, $field:ident, $dead:ident, map) => {
        $emit! { $vm.$field.retain(|key, _| !$dead.contains(key)); }
    };
    ($emit:ident, $vm:ident, $field:ident, $dead:ident, set) => {
        $emit! { $vm.$field.retain(|key| !$dead.contains(key)); }
    };
    ($emit:ident, $vm:ident, $field:ident, $dead:ident, pair_set) => {
        $emit! { $vm.$field.retain(|(key, _)| !$dead.contains(key)); }
    };
    ($emit:ident, $vm:ident, $field:ident, $dead:ident, owner_pair) => {
        $emit! { $vm.$field.retain(|(owner, _), _| !$dead.contains(owner)); }
    };
    ($emit:ident, $vm:ident, $field:ident, $dead:ident, both_pair) => {
        $emit! {
            $vm.$field.retain(|(owner, cell), _| {
                !$dead.contains(owner) && !$dead.contains(cell)
            });
        }
    };
    ($emit:ident, $vm:ident, $field:ident, $dead:ident, counted) => {
        $emit! {
            let refs = &mut $vm.side_refs;
            $vm.$field.retain(|key, row| {
                let keep = !$dead.contains(key);
                if !keep {
                    row.drop_refs(refs);
                }
                keep
            });
        }
    };
}
macro_rules! gc_borrow_type {
    ($life:lifetime, mutable, $ty:ty) => { &$life mut $ty };
    ($life:lifetime, shared, $ty:ty) => { &$life $ty };
}
macro_rules! gc_borrow {
    ($vm:ident, $field:ident, mutable) => {
        &mut $vm.$field
    };
    ($vm:ident, $field:ident, shared) => {
        &$vm.$field
    };
}
macro_rules! define_gc_tables {
    (()
     early { $($early:ident: $early_ty:ty => $early_shape:ident,)* }
     late { $($late:ident: $late_ty:ty => $late_shape:ident,)* }
     held { $($held:ident: $borrow:ident $held_ty:ty,)* }) => {
        pub(super) struct Hooks<'a> {
            $(pub(super) $early: &'a mut $early_ty,)*
            $(pub(super) $late: &'a mut $late_ty,)*
            $(pub(super) $held: gc_borrow_type!('a, $borrow, $held_ty),)*
            pub(super) swept: Vec<SlotIndex>,
        }
        impl Hooks<'_> {
            pub(super) fn prune_swept(&mut self, idx: SlotIndex) {
                $(gc_remove!(gc_run, self, $early, idx, $early_shape);)*
            }
            pub(super) fn prune_late(&mut self, dead: &std::collections::HashSet<SlotIndex>) {
                $(gc_retain!(gc_run, self, $late, dead, $late_shape);)*
            }
        }
        impl Interp {
            pub(super) fn prune_dead_tables(&mut self, dead: &std::collections::HashSet<SlotIndex>) {
                $(gc_retain!(gc_run, self, $early, dead, $early_shape);)*
                $(gc_retain!(gc_run, self, $late, dead, $late_shape);)*
            }
        }
        /// Expanded production pruning tokens, consumed by the independent source lock.
        pub const FULL_SWEEP_SOURCE: &[&str] = &[
            $(gc_remove!(gc_text, self, $early, idx, $early_shape),)*
            $(gc_retain!(gc_text, self, $late, dead, $late_shape),)*
        ];
        /// Expanded production pruning tokens, consumed by the independent source lock.
        pub const PARTIAL_SWEEP_SOURCE: &[&str] = &[
            $(gc_retain!(gc_text, self, $early, dead, $early_shape),)*
            $(gc_retain!(gc_text, self, $late, dead, $late_shape),)*
        ];
    };
}
gc_tables!(define_gc_tables);

// This stays an expression at the caller so the borrow is split by field;
// returning Hooks from a method on &mut Interp would also borrow the arenas.
macro_rules! borrow_gc_tables {
    (($vm:ident)
     early { $($early:ident: $early_ty:ty => $early_shape:ident,)* }
     late { $($late:ident: $late_ty:ty => $late_shape:ident,)* }
     held { $($held:ident: $borrow:ident $held_ty:ty,)* }) => {
        gc_tables::Hooks {
            $($early: &mut $vm.$early,)*
            $($late: &mut $vm.$late,)*
            $($held: gc_borrow!($vm, $held, $borrow),)*
            swept: Vec::new(),
        }
    };
}

// A policy emits the same tokens for execution and the independent source lock.
macro_rules! gc_chunk {
    ($emit:ident, $vm:ident, $field:ident, $visit:ident, none) => {
        $emit! {}
    };
    ($emit:ident, $vm:ident, $field:ident, $visit:ident, function_names) => {
        $emit! {
            $vm.$field.update_values(|f| $visit(&mut f.name_chunk));
        }
    };
    ($emit:ident, $vm:ident, $field:ident, $visit:ident, buffer_data) => {
        $emit! {
            for b in $vm.$field.values_mut() {
                $visit(&mut b.data);
        }
        }
    };
    ($emit:ident, $vm:ident, $field:ident, $visit:ident, bound) => {
        $emit! {
            for b in $vm.$field.values_mut() {
                slot_chunk(&mut b.this_arg, $visit);
                for s in &mut b.args {
                    slot_chunk(s, $visit);
                }
        }
        }
    };
    ($emit:ident, $vm:ident, $field:ident, $visit:ident, slot_values) => {
        $emit! {
            for s in $vm.$field.values_mut() {
                slot_chunk(s, $visit);
        }
        }
    };
    ($emit:ident, $vm:ident, $field:ident, $visit:ident, indexed) => {
        $emit! {
            for a in $vm.$field.values_mut() {
                a.for_each_value_mut_chunk_remap(|s| slot_chunk(s, $visit));
        }
        }
    };
    ($emit:ident, $vm:ident, $field:ident, $visit:ident, collection) => {
        $emit! {
            for c in $vm.$field.values_mut() {
                c.for_each_entry_mut_chunk_remap(|s| slot_chunk(s, $visit));
        }
        }
    };
    ($emit:ident, $vm:ident, $field:ident, $visit:ident, promise) => {
        $emit! {
            for p in $vm.$field.values_mut() {
                slot_chunk(&mut p.result, $visit);
                for r in &mut p.reactions {
                    slot_chunk(&mut r.on_fulfilled, $visit);
                    slot_chunk(&mut r.on_rejected, $visit);
                    slot_chunk(&mut r.resolve, $visit);
                    slot_chunk(&mut r.reject, $visit);
                }
        }
        }
    };
    ($emit:ident, $vm:ident, $field:ident, $visit:ident, from_async) => {
        $emit! {
            // In-flight `Array.fromAsync` state stores raw
            // Slot COPIES (a string thisArg, a captured close error);
            // their chunk offsets relocate with compaction like any
            // other external holder's.
            for d in $vm.$field.iter_mut() {
                slot_chunk(&mut d.resolve, $visit);
                slot_chunk(&mut d.reject, $visit);
                slot_chunk(&mut d.mapfn, $visit);
                slot_chunk(&mut d.this_arg, $visit);
                slot_chunk(&mut d.iterator, $visit);
                slot_chunk(&mut d.next_method, $visit);
                slot_chunk(&mut d.array_like, $visit);
                slot_chunk(&mut d.close_error, $visit);
        }
        }
    };
    ($emit:ident, $vm:ident, $field:ident, $visit:ident, frame) => {
        $emit! {
            for g in $vm.$field.values_mut() {
                if let Some(f) = &mut g.frame {
                    saved_frame_chunks(f, $visit);
                }
        }
        }
    };
    ($emit:ident, $vm:ident, $field:ident, $visit:ident, async_frame) => {
        $emit! {
            for a in $vm.$field.values_mut() {
                slot_chunk(&mut a.resolve_fn, $visit);
                slot_chunk(&mut a.reject_fn, $visit);
                if let Some(f) = &mut a.frame {
                    saved_frame_chunks(f, $visit);
                }
        }
        }
    };
    ($emit:ident, $vm:ident, $field:ident, $visit:ident, queued_frame) => {
        $emit! {
            for g in $vm.$field.values_mut() {
                if let Some(f) = &mut g.frame {
                    saved_frame_chunks(f, $visit);
                }
                for rq in g.requests.iter_mut().chain(g.active.as_mut()) {
                    slot_chunk(&mut rq.value, $visit);
                    slot_chunk(&mut rq.resolve, $visit);
                    slot_chunk(&mut rq.reject, $visit);
                }
        }
        }
    };
    ($emit:ident, $vm:ident, $field:ident, $visit:ident, disposal) => {
        $emit! {
            for d in $vm.$field.values_mut() {
                for r in &mut d.records {
                    slot_chunk(&mut r.resource, $visit);
                    slot_chunk(&mut r.method, $visit);
                }
        }
        }
    };
    ($emit:ident, $vm:ident, $field:ident, $visit:ident, slot_vec) => {
        $emit! {
            for s in $vm.$field.iter_mut() {
                slot_chunk(s, $visit);
        }
        }
    };
    ($emit:ident, $vm:ident, $field:ident, $visit:ident, slot) => {
        $emit! {
            slot_chunk($vm.$field, $visit);
        }
    };
    ($emit:ident, $vm:ident, $field:ident, $visit:ident, static_strings) => {
        $emit! {
            // The interned `typeof` strings: eight chunk offsets
            // held directly by the machine, allocated once at
            // construction and referenced by every later `typeof`
            // — never resident in any slot unless a result
            // happens to be live, so they MUST be enumerated here
            // or compaction drops and dangles them.
            $visit(&mut $vm.$field.undefined);
            $visit(&mut $vm.$field.object);
            $visit(&mut $vm.$field.boolean);
            $visit(&mut $vm.$field.number);
            $visit(&mut $vm.$field.string);
            $visit(&mut $vm.$field.function);
            $visit(&mut $vm.$field.symbol);
            $visit(&mut $vm.$field.bigint);
        }
    };
    ($emit:ident, $vm:ident, $field:ident, $visit:ident, jobs) => {
        $emit! {
            // Queued microtask jobs' captured slots (rooted for
            // marking in `gc_roots`; their string payloads need
            // the same compaction treatment).
            for j in $vm.$field.iter_mut() {
                match j {
                    PromiseJob::Reaction {
                        reaction,
                        value,
                        rejected: _,
                    } => {
                        slot_chunk(&mut reaction.on_fulfilled, $visit);
                        slot_chunk(&mut reaction.on_rejected, $visit);
                        slot_chunk(&mut reaction.resolve, $visit);
                        slot_chunk(&mut reaction.reject, $visit);
                        slot_chunk(value, $visit);
                    }
                    PromiseJob::Thenable {
                        then,
                        thenable,
                        resolve,
                        reject,
                    } => {
                        slot_chunk(then, $visit);
                        slot_chunk(thenable, $visit);
                        slot_chunk(resolve, $visit);
                        slot_chunk(reject, $visit);
                    }
                }
        }
        }
    };
    ($emit:ident, $vm:ident, $field:ident, $visit:ident, callers) => {
        $emit! {
            for f in $vm.$field.iter_mut() {
                for s in &mut f.locals {
                    slot_chunk(s, $visit);
                }
                for s in &mut f.args {
                    slot_chunk(s, $visit);
                }
                slot_chunk(&mut f.this_val, $visit);
                slot_chunk(&mut f.result, $visit);
        }
        }
    };
    ($emit:ident, $vm:ident, $field:ident, $visit:ident, pair_slots) => {
        $emit! {
            for (_, s) in $vm.$field.iter_mut() {
                slot_chunk(s, $visit);
        }
        }
    };
    ($emit:ident, $vm:ident, $field:ident, $visit:ident, triple_slots) => {
        $emit! {
            for (_, _, s) in $vm.$field.iter_mut() {
                slot_chunk(s, $visit);
        }
        }
    };
}

macro_rules! define_chunk_walk {
    (() $vis:vis struct $name:ident {
        $(#[gc_hook($phase:ident, $policy:ident)]
          #[gc_chunk($chunk:ident)]
          $(#[$attr:meta])* $field_vis:vis $field:ident: $ty:ty,)*
    }) => {
        impl Hooks<'_> {
            fn visit_chunks(&mut self, visit: &mut dyn FnMut(&mut ChunkOffset)) {
                $(gc_chunk!(gc_run, self, $field, visit, $chunk);)*
            }
        }
        /// Expanded production chunk-walk tokens, checked by the independent registry.
        pub const CHUNK_WALK_SOURCE: &[&str] = &[
            $(gc_chunk!(gc_text, self, $field, visit, $chunk),)*
        ];
    };
}
interp_state!(define_chunk_walk);

fn saved_frame_slots(f: &SavedFrame, visit: &mut dyn FnMut(SlotIndex)) {
    for s in &f.locals {
        s.each_ref_slot(&mut *visit);
    }
    for s in &f.args {
        s.each_ref_slot(&mut *visit);
    }
    for s in &f.stack_slice {
        s.each_ref_slot(&mut *visit);
    }
    f.this_val.each_ref_slot(&mut *visit);
    f.result.each_ref_slot(&mut *visit);
    // The suspended `with`/eval environment head and the saved
    // handlers' restore environments: the frame is
    // an environment instance's SOLE holder across a suspension.
    f.env.each_ref_slot(&mut *visit);
    for j in &f.jumps {
        j.env.each_ref_slot(&mut *visit);
    }
    visit(f.cur_func);
    visit(f.target_func);
}

// Rewrite a chunk offset carried INSIDE a stored Slot.
fn slot_chunk(s: &mut Slot, visit: &mut dyn FnMut(&mut ChunkOffset)) {
    if let Some(off) = s.chunk_ref() {
        let mut o = off;
        visit(&mut o);
        if o != off {
            s.set_chunk_ref(o);
        }
    }
}

fn saved_frame_chunks(f: &mut SavedFrame, visit: &mut dyn FnMut(&mut ChunkOffset)) {
    for s in &mut f.locals {
        slot_chunk(s, visit);
    }
    for s in &mut f.args {
        slot_chunk(s, visit);
    }
    for s in &mut f.stack_slice {
        slot_chunk(s, visit);
    }
    slot_chunk(&mut f.this_val, visit);
    slot_chunk(&mut f.result, visit);
}

impl crate::gc::GcHooks for Hooks<'_> {
    fn extra_edges(&self, idx: SlotIndex, visit: &mut dyn FnMut(SlotIndex)) {
        if let Some(f) = self.functions.get(&idx) {
            visit(f.closures);
            // The `super` home object: for a method
            // detached from a dead class, this is the prototype's
            // only remaining edge.
            visit(f.home);
        }
        if let Some(b) = self.bound_functions.get(&idx) {
            visit(b.target);
            b.this_arg.each_ref_slot(&mut *visit);
            for s in &b.args {
                s.each_ref_slot(&mut *visit);
            }
        }
        if let Some(p) = self.ctor_prototype.get(&idx) {
            visit(*p);
        }
        if let Some(s) = self.wrapper_data.get(&idx) {
            s.each_ref_slot(&mut *visit);
        }
        // Internal slots can be the only owners of proxy targets, accessor
        // closures, or resources. Trace them before sweeping their targets;
        // gc_side_tables.rs pins survival across collection and slot reuse.
        if let Some(p) = self.proxies.get(&idx) {
            visit(p.target);
            visit(p.handler);
        }
        if let Some(px) = self.proxy_revokers.get(&idx) {
            visit(*px);
        }
        if let Some(d) = self.disposable_stacks.get(&idx) {
            for r in &d.records {
                r.resource.each_ref_slot(&mut *visit);
                r.method.each_ref_slot(&mut *visit);
            }
        }
        if let Some(g) = self.async_generators.get(&idx) {
            if let Some(f) = &g.frame {
                saved_frame_slots(f, visit);
            }
            for rq in g.requests.iter().chain(g.active.as_ref()) {
                rq.value.each_ref_slot(&mut *visit);
                rq.resolve.each_ref_slot(&mut *visit);
                rq.reject.each_ref_slot(&mut *visit);
            }
        }
        if let Some(si) = self.segment_iterators.get(&idx) {
            visit(si.segments_inst);
        }
        if let Some(owner) = self.collator_compare_functions.get(&idx) {
            visit(*owner);
        }
        if let Some(owner) = self.number_format_bound_functions.get(&idx) {
            visit(*owner);
        }
        if let Some(nf) = self.number_formats.get(&idx) {
            if let Some(bf) = nf.bound_format {
                visit(bf);
            }
        }
        // Tuple-keyed tables (owner, id/cell): a per-owner index
        // does not exist, so these are filtered scans — O(table)
        // per marked owner. Accessor/private tables are small in
        // practice; a counted per-owner index is the named
        // upgrade if that stops holding.
        for ((owner, _id), a) in self.accessors.iter() {
            if *owner == idx {
                if let Some(g) = &a.get {
                    g.each_ref_slot(&mut *visit);
                }
                if let Some(s) = &a.set {
                    s.each_ref_slot(&mut *visit);
                }
            }
        }
        for ((recv, cell), v) in self.private_values.iter() {
            if *recv == idx {
                visit(*cell);
                v.each_ref_slot(&mut *visit);
            }
        }
        for ((recv, cell), a) in self.private_accessors.iter() {
            if *recv == idx {
                visit(*cell);
                if let Some(g) = &a.get {
                    g.each_ref_slot(&mut *visit);
                }
                if let Some(s) = &a.set {
                    s.each_ref_slot(&mut *visit);
                }
            }
        }
        if let Some(a) = self.arrays.get(&idx) {
            for s in a.items().values() {
                s.each_ref_slot(&mut *visit);
            }
        }
        // An ordinary object's index properties are strong edges
        // exactly as an array's items are: `o[0] = {}` is the only
        // reference to that object, and a collector that did not walk
        // here would sweep it and hand its slot to the next
        // allocation.
        if let Some(a) = self.index_props.get(&idx) {
            for s in a.items().values() {
                s.each_ref_slot(&mut *visit);
            }
        }
        if let Some(c) = self.collections.get(&idx) {
            match c.kind {
                CollKind::Map | CollKind::Set => {
                    for (k, v) in c.live_entries() {
                        k.each_ref_slot(&mut *visit);
                        v.each_ref_slot(&mut *visit);
                    }
                }
                // WEAK collections hold nothing strongly: a
                // key lives only through outside references,
                // and a WeakMap value only through the
                // ephemeron pass (marked while its key is
                // marked, `GcHooks::ephemeron_edges`);
                // dead-keyed entries are pruned before the
                // sweep. Locked by the gc_machine ephemeron
                // tests (the old conservative-retention pin
                // flipped when this landed).
                CollKind::WeakMap | CollKind::WeakSet => {}
            }
        }
        if let Some(t) = self.typed_arrays.get(&idx) {
            visit(t.buffer);
        }
        if let Some(d) = self.data_views.get(&idx) {
            visit(d.buffer);
        }
        if let Some(i) = self.iterators.get(&idx) {
            visit(i.iterable);
            visit(i.result);
        }
        if let Some(p) = self.promises.get(&idx) {
            p.result.each_ref_slot(&mut *visit);
            for r in &p.reactions {
                r.on_fulfilled.each_ref_slot(&mut *visit);
                r.on_rejected.each_ref_slot(&mut *visit);
                r.resolve.each_ref_slot(&mut *visit);
                r.reject.each_ref_slot(&mut *visit);
                // A native reaction's real payload rides its
                // KIND, not the four handler slots (which it
                // leaves unused): an `AsyncAwait` reaction's
                // only reference to the suspended async
                // instance is here, and a `Combine` reaction
                // will index the combinator's capability callbacks
                // and accumulator Array at the drain.
                match r.kind {
                    ReactionKind::AsyncAwait(inst)
                    | ReactionKind::AsyncGeneratorAwait(inst)
                    | ReactionKind::AsyncGeneratorYield(inst)
                    | ReactionKind::AsyncGeneratorReturn(inst) => visit(inst),
                    ReactionKind::Combine(ci, _) | ReactionKind::CombineDirect(ci, _) => {
                        if let Some(c) = self.combinators.get(ci as usize) {
                            c.resolve.each_ref_slot(&mut *visit);
                            c.reject.each_ref_slot(&mut *visit);
                            visit(c.results);
                        }
                    }
                    ReactionKind::FromAsyncNext(fa)
                    | ReactionKind::FromAsyncElem(fa)
                    | ReactionKind::FromAsyncMap(fa)
                    | ReactionKind::FromAsyncClose(fa) => {
                        if let Some(d) = self.from_async.get(fa as usize) {
                            d.resolve.each_ref_slot(&mut *visit);
                            d.reject.each_ref_slot(&mut *visit);
                            visit(d.target);
                            d.mapfn.each_ref_slot(&mut *visit);
                            d.this_arg.each_ref_slot(&mut *visit);
                            d.iterator.each_ref_slot(&mut *visit);
                            d.next_method.each_ref_slot(&mut *visit);
                            d.array_like.each_ref_slot(&mut *visit);
                            d.close_error.each_ref_slot(&mut *visit);
                        }
                    }
                    ReactionKind::User
                    | ReactionKind::FinallyReturn
                    | ReactionKind::FinallyAwait(_) => {}
                }
            }
        }
        if let Some(g) = self.generators.get(&idx) {
            if let Some(f) = &g.frame {
                saved_frame_slots(f, visit);
            }
        }
        if let Some(a) = self.async_instances.get(&idx) {
            visit(a.result_promise);
            a.resolve_fn.each_ref_slot(&mut *visit);
            a.reject_fn.each_ref_slot(&mut *visit);
            if let Some(f) = &a.frame {
                saved_frame_slots(f, visit);
            }
        }
        if let Some(p) = self.promise_functions.get(&idx) {
            visit(p.promise);
        }
    }

    fn swept(&mut self, idx: SlotIndex) {
        // Drop chunk-bearing rows before this collection's compaction.
        self.prune_swept(idx);
        self.swept.push(idx);
    }

    fn ephemeron_edges(&self, slots: &SlotArena, visit: &mut dyn FnMut(SlotIndex)) {
        // WeakMap values: an entry's value is reachable
        // exactly while its MAP and its KEY both are. WeakSet
        // entries add no edges (membership keeps nothing
        // alive).
        for (inst, c) in self.collections.iter() {
            if !slots.is_marked(*inst) || c.kind != CollKind::WeakMap {
                continue;
            }
            for (k, v) in c.live_entries() {
                let mut key_live = false;
                k.each_ref_slot(|r| {
                    if slots.is_marked(r) {
                        key_live = true;
                    }
                });
                if key_live {
                    v.each_ref_slot(&mut *visit);
                }
            }
        }
        // Symbol-key descriptors: a marked property record
        // whose id is an interned symbol key keeps the
        // descriptor (and its description chunk) alive — the
        // precise replacement for rooting every intern.
        //
        // Conservative on two axes, both retention-only — this pass can only keep
        // a descriptor alive, never free one, so neither can
        // cause a use-after-free or a wrong answer:
        //
        //  - it walks the whole arena per fixpoint round rather
        //    than an index of property records, so the cost is
        //    O(capacity) × rounds even when `wanted` is tiny;
        //  - it compares `slot.id` on every marked slot without
        //    filtering by kind, and `id` doubles as the argument
        //    count on frame slots, so a frame with N arguments
        //    where N equals a wanted key's id retains that
        //    descriptor spuriously.
        //
        // Both want the same thing to fix properly: a reverse
        // index from key id to the property records using it,
        // maintained where properties are written. Until the
        // ledger's KEYS row makes that index durable anyway,
        // over-retaining a handful of descriptors is the cheaper
        // trade.
        let wanted: std::collections::HashMap<u16, SlotIndex> = self
            .symbol_key_ids
            .iter()
            .filter(|(d, _)| !slots.is_marked(**d))
            .map(|(d, id)| (*id, *d))
            .collect();
        if !wanted.is_empty() {
            for i in 0..slots.capacity() {
                let idx = SlotIndex(i);
                if slots.is_marked(idx) {
                    if let Some(&d) = wanted.get(&slots.get(idx).id) {
                        visit(d);
                    }
                }
            }
        }
    }

    fn prune_dead_keyed(&mut self, slots: &SlotArena) {
        // Dead-keyed weak entries leave their collections
        // (counted decrements) before the sweep reclaims the
        // targets.
        let side_refs = &mut *self.side_refs;
        for (inst, c) in self.collections.iter_mut() {
            if !slots.is_marked(*inst) || !matches!(c.kind, CollKind::WeakMap | CollKind::WeakSet) {
                continue;
            }
            c.prune_entries(side_refs, |k, _v| {
                let mut key_live = false;
                k.each_ref_slot(|r| {
                    if slots.is_marked(r) {
                        key_live = true;
                    }
                });
                key_live
            });
        }
        // An intern whose descriptor stayed unmarked through
        // the fixpoint has no live property using its id and
        // no other reference: drop the mapping (the sweep
        // reclaims the descriptor slot itself).
        self.symbol_key_ids.retain(|d, _| slots.is_marked(*d));
    }

    fn external_chunk_refs(&mut self, visit: &mut dyn FnMut(&mut ChunkOffset)) {
        self.visit_chunks(visit);
    }
}
