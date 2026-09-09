//! Root walks selected by the interpreter field roster.
//!
//! Symbol registries are strong; symbol-key descriptors remain ephemeron edges.
//! Pending jobs root their reaction payloads even after a halted crank. Root
//! order here is immaterial because the public entry point sorts and deduplicates.
use super::*;
use crate::value::SlotIndex;

macro_rules! gc_root {
    ($emit:ident, $vm:ident, $field:ident, $roots:ident, none) => {
        $emit! {}
    };
    ($emit:ident, $vm:ident, $field:ident, $roots:ident, slot) => {
        $emit! { slot_roots(&$vm.$field, $roots); }
    };
    ($emit:ident, $vm:ident, $field:ident, $roots:ident, index) => {
        $emit! { $roots.push($vm.$field); }
    };
    // Lazy installation cannot keep these identities alive through a property
    // edge until a crank first names that property.
    ($emit:ident, $vm:ident, $field:ident, $roots:ident, error_accessor) => {
        $emit! { if let Some((holder, getter, setter)) = $vm.$field {
            $roots.extend([holder, getter, setter]);
        } }
    };
    ($emit:ident, $vm:ident, $field:ident, $roots:ident, lazy_getters) => {
        $emit! { $roots.extend($vm.$field.iter().filter_map(|(owner, info)| {
            matches!(
                info.method,
                Some(
                    NativeMethod::TypedArrayToStringTagGetter
                        | NativeMethod::PromiseSpeciesGetter
                        | NativeMethod::RegExpSpeciesGetter
                        | NativeMethod::ArrayBufferSpeciesGetter
                )
            )
            .then_some(*owner)
        })); }
    };
    ($emit:ident, $vm:ident, $field:ident, $roots:ident, optional) => {
        $emit! { $roots.extend($vm.$field); }
    };
    ($emit:ident, $vm:ident, $field:ident, $roots:ident, keys) => {
        $emit! { $roots.extend($vm.$field.keys().copied()); }
    };
    ($emit:ident, $vm:ident, $field:ident, $roots:ident, values) => {
        $emit! { $roots.extend($vm.$field.values().copied()); }
    };
    ($emit:ident, $vm:ident, $field:ident, $roots:ident, slots) => {
        $emit! { for s in &$vm.$field {
            slot_roots(s, $roots);
        } }
    };
    ($emit:ident, $vm:ident, $field:ident, $roots:ident, callers) => {
        $emit! { for f in &$vm.$field {
            for s in &f.locals {
                slot_roots(s, $roots);
            }
            for s in &f.args {
                slot_roots(s, $roots);
            }
            slot_roots(&f.this_val, $roots);
            slot_roots(&f.result, $roots);
            slot_roots(&f.env, $roots);
            $roots.push(f.cur_func);
            $roots.push(f.target_func);
        } }
    };
    ($emit:ident, $vm:ident, $field:ident, $roots:ident, jumps) => {
        $emit! { for j in &$vm.$field {
            slot_roots(&j.env, $roots);
        } }
    };
    ($emit:ident, $vm:ident, $field:ident, $roots:ident, symbols) => {
        $emit! { for (_, s) in &$vm.$field {
            slot_roots(s, $roots);
        } }
    };
    ($emit:ident, $vm:ident, $field:ident, $roots:ident, proto_values) => {
        $emit! { for (idx, _, s) in &$vm.$field {
            $roots.push(*idx);
            slot_roots(s, $roots);
        } }
    };
    ($emit:ident, $vm:ident, $field:ident, $roots:ident, proto_methods) => {
        $emit! {
            // Boot groups methods by prototype. Avoid sorting the same holder
            // once per method; revisited holders still emit after a different
            // holder, and the public root set remains sorted and deduplicated.
            let mut previous_holder = None;
            for (holder, _, method) in &$vm.$field {
                if previous_holder != Some(*holder) {
                    $roots.push(*holder);
                    previous_holder = Some(*holder);
                }
                $roots.push(*method);
            }
        }
    };
    ($emit:ident, $vm:ident, $field:ident, $roots:ident, proto_data) => {
        $emit! { for (holder, _, _) in &$vm.$field {
            $roots.push(*holder);
        } }
    };
    ($emit:ident, $vm:ident, $field:ident, $roots:ident, proto_accessors) => {
        $emit! { for (holder, _, getter, setter, _) in &$vm.$field {
            $roots.push(*holder);
            $roots.push(*getter);
            if let Some(setter) = setter {
                $roots.push(*setter);
            }
        } }
    };
    ($emit:ident, $vm:ident, $field:ident, $roots:ident, generators) => {
        $emit! { for f in &$vm.$field {
            $roots.push(f.gen);
        } }
    };
    ($emit:ident, $vm:ident, $field:ident, $roots:ident, async_instances) => {
        $emit! { for f in &$vm.$field {
            $roots.push(f.inst);
        } }
    };
    ($emit:ident, $vm:ident, $field:ident, $roots:ident, jobs) => {
        $emit! { for j in &$vm.$field {
            match j {
                PromiseJob::Reaction {
                    reaction,
                    value,
                    rejected: _,
                } => {
                    slot_roots(&reaction.on_fulfilled, $roots);
                    slot_roots(&reaction.on_rejected, $roots);
                    slot_roots(&reaction.resolve, $roots);
                    slot_roots(&reaction.reject, $roots);
                    slot_roots(value, $roots);
                    match reaction.kind {
                        // Every async-instance-bearing native reaction's only
                        // reference to its suspended instance is this payload.
                        ReactionKind::AsyncAwait(inst)
                        | ReactionKind::AsyncGeneratorAwait(inst)
                        | ReactionKind::AsyncGeneratorYield(inst)
                        | ReactionKind::AsyncGeneratorReturn(inst) => $roots.push(inst),
                        ReactionKind::Combine(ci, _) | ReactionKind::CombineDirect(ci, _) => {
                            if let Some(c) = $vm.combinators.get(ci as usize) {
                                slot_roots(&c.resolve, $roots);
                                slot_roots(&c.reject, $roots);
                                $roots.push(c.results);
                            }
                        }
                        // A `fromAsync` reaction indexes the [`FromAsyncData`]
                        // side table (compacted at sweep to the entries such
                        // reactions still name); the queued reaction
                        // is the only edge to that record at the drain, so
                        // root its reference-bearing slots here (mirrors
                        // `Combine`).
                        ReactionKind::FromAsyncNext(fa)
                        | ReactionKind::FromAsyncElem(fa)
                        | ReactionKind::FromAsyncMap(fa)
                        | ReactionKind::FromAsyncClose(fa) => {
                            if let Some(d) = $vm.from_async.get(fa as usize) {
                                slot_roots(&d.resolve, $roots);
                                slot_roots(&d.reject, $roots);
                                $roots.push(d.target);
                                slot_roots(&d.mapfn, $roots);
                                slot_roots(&d.this_arg, $roots);
                                slot_roots(&d.iterator, $roots);
                                slot_roots(&d.next_method, $roots);
                                slot_roots(&d.array_like, $roots);
                                slot_roots(&d.close_error, $roots);
                            }
                        }
                        ReactionKind::User
                        | ReactionKind::FinallyReturn
                        | ReactionKind::FinallyAwait(_) => {}
                    }
                }
                PromiseJob::Thenable {
                    then,
                    thenable,
                    resolve,
                    reject,
                } => {
                    slot_roots(then, $roots);
                    slot_roots(thenable, $roots);
                    slot_roots(resolve, $roots);
                    slot_roots(reject, $roots);
                }
            }
        } }
    };
}

macro_rules! define_root_walk {
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
        impl Interp {
            pub(super) fn append_gc_roots(&self, roots: &mut Vec<SlotIndex>) {
                $(gc_root!(gc_run, self, $field, roots, $root);)*
            }
        }
        /// Exact executable root-walk tokens for independent registry checks.
        #[doc(hidden)]
        pub const ROOT_SOURCE: &[(&str, &str)] = &[
            $((stringify!($field), gc_root!(gc_text, self, $field, roots, $root)),)*
        ];
    };
}
interp_state!(define_root_walk);

fn slot_roots(s: &Slot, roots: &mut Vec<SlotIndex>) {
    s.each_ref_slot(|e| roots.push(e));
}
