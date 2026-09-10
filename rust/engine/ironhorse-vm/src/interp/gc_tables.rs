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
        $(#[boot_new($boot_new:expr)]
          #[boot_template($boot_template:expr)]
          #[gc_root($root:ident)]
          #[quiescent($boundary:ident)]
          #[persist_refs($persist:ident)]
          #[runtime_keys($runtime_keys:ident)]
          #[gc_hook($phase:ident, $policy:ident)]
          #[gc_chunk($chunk:ident)]
          #[gc_slots($shape:ident, $row:ident)]
          #[gc_weak($weak:ident)]
          #[snapshot_table($($snapshot:tt)*)]
          $(#[$attr:meta])* $field_vis:vis $field:ident: $ty:ty,)*
    } boot_context { $($boot_context:tt)* } external_tables { $($external:tt)* }) => {
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

// Per-row slot policies are shared by precise full marking and conservative
// partial-page enumeration. Only collection strength differs between the walks.
macro_rules! gc_slot_row {
    ($emit:ident, $vm:ident, $row:ident, $visit:ident, $full:expr, none) => {
        $emit! {}
    };
    ($emit:ident, $vm:ident, $row:ident, $visit:ident, $full:expr, function) => {
        $emit! {
            $visit($row.closures);
            // The `super` home object: for a method
            // detached from a dead class, this is the prototype's
            // only remaining edge.
            $visit($row.home);

        }
    };
    ($emit:ident, $vm:ident, $row:ident, $visit:ident, $full:expr, bound) => {
        $emit! {
            $visit($row.target);
            $row.this_arg.each_ref_slot(&mut *$visit);
            for s in &$row.args {
                s.each_ref_slot(&mut *$visit);
        }

        }
    };
    ($emit:ident, $vm:ident, $row:ident, $visit:ident, $full:expr, owner) => {
        $emit! {
            $visit(*$row);

        }
    };
    ($emit:ident, $vm:ident, $row:ident, $visit:ident, $full:expr, slot) => {
        $emit! {
            $row.each_ref_slot(&mut *$visit);

        }
    };
    ($emit:ident, $vm:ident, $row:ident, $visit:ident, $full:expr, proxy) => {
        $emit! {
            $visit($row.target);
            $visit($row.handler);

        }
    };
    ($emit:ident, $vm:ident, $row:ident, $visit:ident, $full:expr, disposal) => {
        $emit! {
            for r in &$row.records {
                r.resource.each_ref_slot(&mut *$visit);
                r.method.each_ref_slot(&mut *$visit);
        }

        }
    };
    ($emit:ident, $vm:ident, $row:ident, $visit:ident, $full:expr, queued_frame) => {
        $emit! {
            if let Some(f) = &$row.frame {
                saved_frame_slots(f, $visit);
        }
        for rq in $row.requests.iter().chain($row.active.as_ref()) {
            rq.value.each_ref_slot(&mut *$visit);
            rq.resolve.each_ref_slot(&mut *$visit);
            rq.reject.each_ref_slot(&mut *$visit);
        }

        }
    };
    ($emit:ident, $vm:ident, $row:ident, $visit:ident, $full:expr, segments) => {
        $emit! {
            $visit($row.segments_inst);

        }
    };
    ($emit:ident, $vm:ident, $row:ident, $visit:ident, $full:expr, number_format) => {
        $emit! {
            if let Some(bf) = $row.bound_format {
                $visit(bf);
        }

        }
    };
    ($emit:ident, $vm:ident, $row:ident, $visit:ident, $full:expr, indexed) => {
        $emit! {
            for s in $row.items().values() {
                s.each_ref_slot(&mut *$visit);
        }

        }
    };
    ($emit:ident, $vm:ident, $row:ident, $visit:ident, $full:expr, collection) => {
        $emit! {
            // Full tracing keeps weak entries only through ephemerons. The partial
            // collector conservatively pins their pages through SideRefCounts.
            if !$full || matches!($row.kind, CollKind::Map | CollKind::Set) {
                for (k, v) in $row.live_entries() {
                    k.each_ref_slot(&mut *$visit);
                    v.each_ref_slot(&mut *$visit);
                }
        }

        }
    };
    ($emit:ident, $vm:ident, $row:ident, $visit:ident, $full:expr, buffer) => {
        $emit! {
            $visit($row.buffer);

        }
    };
    ($emit:ident, $vm:ident, $row:ident, $visit:ident, $full:expr, iterator) => {
        $emit! {
            $visit($row.iterable);
            $visit($row.result);

        }
    };
    ($emit:ident, $vm:ident, $row:ident, $visit:ident, $full:expr, promise) => {
        $emit! {
            $row.result.each_ref_slot(&mut *$visit);
            for r in &$row.reactions {
                r.on_fulfilled.each_ref_slot(&mut *$visit);
                r.on_rejected.each_ref_slot(&mut *$visit);
                r.resolve.each_ref_slot(&mut *$visit);
                r.reject.each_ref_slot(&mut *$visit);
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
                    | ReactionKind::AsyncGeneratorReturn(inst) => $visit(inst),
                    ReactionKind::Combine(ci, _) | ReactionKind::CombineDirect(ci, _) => {
                        if let Some(c) = $vm.combinators.get(ci as usize) {
                            c.resolve.each_ref_slot(&mut *$visit);
                            c.reject.each_ref_slot(&mut *$visit);
                            $visit(c.results);
                        }
                    }
                    ReactionKind::FromAsyncNext(fa)
                    | ReactionKind::FromAsyncElem(fa)
                    | ReactionKind::FromAsyncMap(fa)
                    | ReactionKind::FromAsyncClose(fa) => {
                        if let Some(d) = $vm.from_async.get(fa as usize) {
                            d.resolve.each_ref_slot(&mut *$visit);
                            d.reject.each_ref_slot(&mut *$visit);
                            $visit(d.target);
                            d.mapfn.each_ref_slot(&mut *$visit);
                            d.this_arg.each_ref_slot(&mut *$visit);
                            d.iterator.each_ref_slot(&mut *$visit);
                            d.next_method.each_ref_slot(&mut *$visit);
                            d.array_like.each_ref_slot(&mut *$visit);
                            d.close_error.each_ref_slot(&mut *$visit);
                        }
                    }
                    ReactionKind::User
                    | ReactionKind::FinallyReturn
                    | ReactionKind::FinallyAwait(_) => {}
                }
        }

        }
    };
    ($emit:ident, $vm:ident, $row:ident, $visit:ident, $full:expr, frame) => {
        $emit! {
            if let Some(f) = &$row.frame {
                saved_frame_slots(f, $visit);
        }

        }
    };
    ($emit:ident, $vm:ident, $row:ident, $visit:ident, $full:expr, async_frame) => {
        $emit! {
            $visit($row.result_promise);
            $row.resolve_fn.each_ref_slot(&mut *$visit);
            $row.reject_fn.each_ref_slot(&mut *$visit);
            if let Some(f) = &$row.frame {
                saved_frame_slots(f, $visit);
        }

        }
    };
    ($emit:ident, $vm:ident, $row:ident, $visit:ident, $full:expr, promise_owner) => {
        $emit! {
            $visit($row.promise);

        }
    };
    ($emit:ident, $vm:ident, $row:ident, $visit:ident, $full:expr, accessor) => {
        $emit! {
            if let Some(g) = &$row.get {
                g.each_ref_slot(&mut *$visit);
        }
        if let Some(s) = &$row.set {
            s.each_ref_slot(&mut *$visit);
        }

        }
    };
}

macro_rules! gc_slot_table {
    ($emit:ident, $mode:ident, $vm:ident, $field:ident, $idx:ident, $visit:ident, none, $row:ident) => {
        $emit! {}
    };
    ($emit:ident, full, $vm:ident, $field:ident, $idx:ident, $visit:ident, keys, $row:ident) => {
        $emit! {}
    };
    ($emit:ident, tail, $vm:ident, $field:ident, $idx:ident, $visit:ident, bulk, $row:ident) => {
        $emit! {}
    };
    ($emit:ident, $mode:ident, $vm:ident, $field:ident, $idx:ident, $visit:ident, bulk, $row:ident) => {
        gc_slot_table!($emit, $mode, $vm, $field, $idx, $visit, map, $row)
    };
    ($emit:ident, full, $vm:ident, $field:ident, $idx:ident, $visit:ident, map, $row:ident) => {
        $emit! {
            if let Some(row) = $vm.$field.get(&$idx) {
                gc_slot_row!(gc_run, $vm, row, $visit, true, $row);
            }
        }
    };
    ($emit:ident, full, $vm:ident, $field:ident, $idx:ident, $visit:ident, owner_pairs, $row:ident) => {
        $emit! {
            // Pair-keyed tables have no per-owner index; preserve their filtered scan.
            for ((owner, _), row) in $vm.$field.iter() {
                if *owner == $idx { gc_slot_row!(gc_run, $vm, row, $visit, true, $row); }
            }
        }
    };
    ($emit:ident, full, $vm:ident, $field:ident, $idx:ident, $visit:ident, private_pairs, $row:ident) => {
        $emit! {
            for ((owner, cell), row) in $vm.$field.iter() {
                if *owner == $idx {
                    $visit(*cell);
                    gc_slot_row!(gc_run, $vm, row, $visit, true, $row);
                }
            }
        }
    };
    ($emit:ident, $mode:ident, $vm:ident, $field:ident, $idx:ident, $visit:ident, owner_pairs, $row:ident) => {
        gc_slot_table!($emit, $mode, $vm, $field, $idx, $visit, map, $row)
    };
    ($emit:ident, $mode:ident, $vm:ident, $field:ident, $idx:ident, $visit:ident, map, $row:ident) => {
        $emit! {
            for row in $vm.$field.values() { gc_slot_row!(gc_run, $vm, row, $visit, false, $row); }
        }
    };
    ($emit:ident, $mode:ident, $vm:ident, $field:ident, $idx:ident, $visit:ident, private_pairs, $row:ident) => {
        $emit! {
            for ((_, cell), row) in $vm.$field.iter() {
                $visit(*cell);
                gc_slot_row!(gc_run, $vm, row, $visit, false, $row);
            }
        }
    };
    ($emit:ident, $mode:ident, $vm:ident, $field:ident, $idx:ident, $visit:ident, keys, $row:ident) => {
        $emit! { for key in $vm.$field.keys() { $visit(*key); } }
    };
}
macro_rules! define_slot_walks {
    (() $vis:vis struct $name:ident {
        $(#[boot_new($boot_new:expr)]
          #[boot_template($boot_template:expr)]
          #[gc_root($root:ident)]
          #[quiescent($boundary:ident)]
          #[persist_refs($persist:ident)]
          #[runtime_keys($runtime_keys:ident)]
          #[gc_hook($phase:ident, $policy:ident)]
          #[gc_chunk($chunk:ident)]
          #[gc_slots($shape:ident, $row:ident)]
          #[gc_weak($weak:ident)]
          #[snapshot_table($($snapshot:tt)*)]
          $(#[$attr:meta])* $field_vis:vis $field:ident: $ty:ty,)*
    } boot_context { $($boot_context:tt)* } external_tables { $($external:tt)* }) => {
        impl Hooks<'_> {
            fn visit_owner_slots(&self, idx: SlotIndex, visit: &mut dyn FnMut(SlotIndex)) {
                $(gc_slot_table!(gc_run, full, self, $field, idx, visit, $shape, $row);)*
            }
        }
        impl Interp {
            /// Enumerate all side-table value edges for integrity checks.
            pub(super) fn each_side_table_ref(&self, visit: &mut dyn FnMut(SlotIndex)) {
                $(gc_slot_table!(gc_run, all, self, $field, idx, visit, $shape, $row);)*
            }
            /// Enumerate the tail; the three bulk tables use standing page counts.
            pub(super) fn each_side_table_ref_tail(&self, visit: &mut dyn FnMut(SlotIndex)) {
                $(gc_slot_table!(gc_run, tail, self, $field, idx, visit, $shape, $row);)*
            }
        }
        /// Row bodies paired with their generated table call sites.
        pub const ROW_EDGE_SOURCE: &[(&str, &str, &str, &str)] = &[
            $((stringify!($field), stringify!($row),
                gc_slot_row!(gc_text, self, row, visit, true, $row),
                gc_slot_row!(gc_text, self, row, visit, false, $row)),)*
        ];
        /// Expanded production full-marking table walks.
        pub const FULL_EDGE_SOURCE: &[&str] = &[
            $(gc_slot_table!(gc_text, full, self, $field, idx, visit, $shape, $row),)*
        ];
        /// Expanded production conservative table walks.
        pub const PARTIAL_EDGE_SOURCE: &[&str] = &[
            $(gc_slot_table!(gc_text, all, self, $field, idx, visit, $shape, $row),)*
        ];
        /// Expanded production tail walks, excluding counted bulk tables.
        pub const TAIL_EDGE_SOURCE: &[&str] = &[
            $(gc_slot_table!(gc_text, tail, self, $field, idx, visit, $shape, $row),)*
        ];
    };
}
interp_state!(define_slot_walks);

// Weak-table fixpoint tracing and dead-key pruning share the field inventory.
macro_rules! gc_weak {
    ($emit:ident, $mode:ident, $vm:ident, $field:ident, $slots:ident, $visit:ident, none) => { $emit! {} };
    ($emit:ident, trace, $vm:ident, $field:ident, $slots:ident, $visit:ident, collection) => {
        $emit! {
            // WeakMap values: an entry's value is reachable
            // exactly while its MAP and its KEY both are. WeakSet
            // entries add no edges (membership keeps nothing
            // alive).
            for (inst, c) in $vm.$field.iter() {
                if !$slots.is_marked(*inst) || c.kind != CollKind::WeakMap {
                    continue;
                }
                for (k, v) in c.live_entries() {
                    let mut key_live = false;
                    k.each_ref_slot(|r| {
                        if $slots.is_marked(r) {
                            key_live = true;
                        }
                    });
                    if key_live {
                        v.each_ref_slot(&mut *$visit);
                    }
                }
            }

        }
    };
    ($emit:ident, trace, $vm:ident, $field:ident, $slots:ident, $visit:ident, symbol_keys) => {
        $emit! {            // Symbol-key descriptors: a marked property record
            // whose id is an interned symbol key keeps the
            // descriptor (and its description chunk) alive — the
            // precise replacement for rooting every intern.
            //
            // The scan remains O(capacity) per fixpoint round. Use the shared
            // stored-key projection so internal environment markers and
            // non-keyed records cannot retain a symbol descriptor.
            let wanted: std::collections::HashMap<u16, SlotIndex> = $vm.$field
                .iter()
                .filter(|(d, _)| !$slots.is_marked(**d))
                .map(|(d, id)| (*id, *d))
                .collect();
            if !wanted.is_empty() {
                for i in 0..$slots.capacity() {
                    let idx = SlotIndex(i);
                    if $slots.is_marked(idx) {
                        if let Some(id) = $slots.get(idx).stored_key_id() {
                            if let Some(&d) = wanted.get(&id) {
                                $visit(d);
                            }
                        }
                    }
                }
            }

        }
    };
    ($emit:ident, prune, $vm:ident, $field:ident, $slots:ident, $visit:ident, collection) => {
        $emit! {
            // Dead-keyed weak entries leave their collections
            // (counted decrements) before the sweep reclaims the
            // targets.
            let side_refs = &mut *$vm.side_refs;
            for (inst, c) in $vm.$field.iter_mut() {
                if !$slots.is_marked(*inst) || !matches!(c.kind, CollKind::WeakMap | CollKind::WeakSet) {
                    continue;
                }
                c.prune_entries(side_refs, |k, _v| {
                    let mut key_live = false;
                    k.each_ref_slot(|r| {
                        if $slots.is_marked(r) {
                            key_live = true;
                        }
                    });
                    key_live
                });
            }

        }
    };
    ($emit:ident, prune, $vm:ident, $field:ident, $slots:ident, $visit:ident, symbol_keys) => {
        $emit! {            // An intern whose descriptor stayed unmarked through
            // the fixpoint has no live property using its id and
            // no other reference: drop the mapping (the sweep
            // reclaims the descriptor slot itself).
            $vm.$field.retain(|d, _| $slots.is_marked(*d));

        }
    };
}

macro_rules! define_weak_walks {
    (() $vis:vis struct $name:ident {
        $(#[boot_new($boot_new:expr)]
          #[boot_template($boot_template:expr)]
          #[gc_root($root:ident)]
          #[quiescent($boundary:ident)]
          #[persist_refs($persist:ident)]
          #[runtime_keys($runtime_keys:ident)]
          #[gc_hook($phase:ident, $policy:ident)]
          #[gc_chunk($chunk:ident)]
          #[gc_slots($shape:ident, $row:ident)]
          #[gc_weak($weak:ident)]
          #[snapshot_table($($snapshot:tt)*)]
          $(#[$attr:meta])* $field_vis:vis $field:ident: $ty:ty,)*
    } boot_context { $($boot_context:tt)* } external_tables { $($external:tt)* }) => {
        impl Hooks<'_> {
            fn visit_ephemerons(&self, slots: &SlotArena, visit: &mut dyn FnMut(SlotIndex)) {
                $(gc_weak!(gc_run, trace, self, $field, slots, visit, $weak);)*
            }
            fn prune_ephemerons(&mut self, slots: &SlotArena) {
                $(gc_weak!(gc_run, prune, self, $field, slots, visit, $weak);)*
            }
        }
        /// Expanded production weak-table tracing tokens.
        pub const EPHEMERON_SOURCE: &[&str] = &[
            $(gc_weak!(gc_text, trace, self, $field, slots, visit, $weak),)*
        ];
        /// Expanded production weak-table pruning tokens.
        pub const WEAK_PRUNE_SOURCE: &[&str] = &[
            $(gc_weak!(gc_text, prune, self, $field, slots, visit, $weak),)*
        ];
    };
}
interp_state!(define_weak_walks);

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
        self.visit_owner_slots(idx, visit);
    }

    fn swept(&mut self, idx: SlotIndex) {
        // Drop chunk-bearing rows before this collection's compaction.
        self.prune_swept(idx);
        self.swept.push(idx);
    }

    fn ephemeron_edges(&self, slots: &SlotArena, visit: &mut dyn FnMut(SlotIndex)) {
        self.visit_ephemerons(slots, visit);
    }

    fn prune_dead_keyed(&mut self, slots: &SlotArena) {
        self.prune_ephemerons(slots);
    }

    fn external_chunk_refs(&mut self, visit: &mut dyn FnMut(&mut ChunkOffset)) {
        self.visit_chunks(visit);
    }
}
