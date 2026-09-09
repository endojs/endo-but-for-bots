//! Traversal of stored references to natives that restore cannot reconstruct.
//!
//! These policies inspect carried values, including the callable raw indices
//! in bound functions and proxies. Early host/unsupported-state refusals and
//! the dirty-page heap scan remain in the admission algorithm.
use super::*;

macro_rules! persist_run {
    ($($code:tt)*) => { $($code)* };
}
macro_rules! persist_text {
    ($($code:tt)*) => { stringify!($($code)*) };
}

macro_rules! persist_holder {
    ($emit:ident, $vm:ident, $field:ident, $names:ident, $index:ident, none) => {
        $emit! { false }
    };
    ($emit:ident, $vm:ident, $field:ident, $names:ident, $index:ident, slots) => {
        $emit! { $vm.$field.iter().any($names) }
    };
    ($emit:ident, $vm:ident, $field:ident, $names:ident, $index:ident, indexed) => {
        $emit! { $vm.$field.values().flat_map(|a| a.items().iter().map(|(_, v)| v)).any($names) }
    };
    ($emit:ident, $vm:ident, $field:ident, $names:ident, $index:ident, collections) => {
        $emit! { $vm.$field.values().flat_map(|c| c.entries().iter().flatten().flat_map(|e| [&e.0, &e.1])).any($names) }
    };
    ($emit:ident, $vm:ident, $field:ident, $names:ident, $index:ident, accessors) => {
        $emit! { $vm.$field.values().any(|d| d.get.as_ref().is_some_and($names) || d.set.as_ref().is_some_and($names)) }
    };
    ($emit:ident, $vm:ident, $field:ident, $names:ident, $index:ident, values) => {
        $emit! { $vm.$field.values().any($names) }
    };
    ($emit:ident, $vm:ident, $field:ident, $names:ident, $index:ident, bound) => {
        $emit! { $vm.$field.values().any(|d| $index(d.target.0) || $names(&d.this_arg) || d.args.iter().any($names)) }
    };
    ($emit:ident, $vm:ident, $field:ident, $names:ident, $index:ident, proxies) => {
        $emit! { $vm.$field.values().any(|p| $index(p.target.0) || $index(p.handler.0)) }
    };
    ($emit:ident, $vm:ident, $field:ident, $names:ident, $index:ident, disposable) => {
        $emit! { $vm.$field.values().flat_map(|d| d.records.iter()).any(|r| $names(&r.resource) || $names(&r.method)) }
    };
    ($emit:ident, $vm:ident, $field:ident, $names:ident, $index:ident, promises) => {
        $emit! { $vm.$field.values().any(|p| $names(&p.result) || p.reactions.iter().any(|r| {
            $names(&r.on_fulfilled) || $names(&r.on_rejected) || $names(&r.resolve) || $names(&r.reject)
        })) }
    };
    ($emit:ident, $vm:ident, $field:ident, $names:ident, $index:ident, combinators) => {
        $emit! { $vm.$field.iter().any(|c| $names(&c.resolve) || $names(&c.reject)) }
    };
    ($emit:ident, $vm:ident, $field:ident, $names:ident, $index:ident, generators) => {
        $emit! { $vm.$field.values().filter_map(|g| g.frame.as_ref()).any(|f| saved_frame_contains(f, $names)) }
    };
    ($emit:ident, $vm:ident, $field:ident, $names:ident, $index:ident, async_instances) => {
        $emit! { $vm.$field.values().any(|a| a.frame.as_ref().is_some_and(|f| saved_frame_contains(f, $names))
            || $names(&a.resolve_fn) || $names(&a.reject_fn)) }
    };
}

macro_rules! define_persist_holders {
    (() $vis:vis struct $name:ident {
        $(#[gc_root($root:ident)]
          #[quiescent($boundary:ident)]
          #[persist_refs($persist:ident)]
          #[gc_hook($phase:ident, $policy:ident)]
          #[gc_chunk($chunk:ident)]
          #[gc_slots($shape:ident, $row:ident)]
          #[gc_weak($weak:ident)]
          #[snapshot_table($($snapshot:tt)*)]
          $(#[$attr:meta])* $field_vis:vis $field:ident: $ty:ty,)*
    } external_tables { $($external:tt)* }) => {
        impl Interp {
            pub(super) fn persisted_holders_contain(
                &self, names: &impl Fn(&Slot) -> bool, index: &impl Fn(u32) -> bool,
            ) -> bool {
                false $(|| persist_holder!(persist_run, self, $field, names, index, $persist))*
            }
        }
        /// Executed holder predicates for independent structural verification.
        #[doc(hidden)]
        pub const PERSIST_HOLDER_SOURCE: &[(&str, &str)] = &[
            $((stringify!($field), persist_holder!(persist_text, self, $field, names, index, $persist)),)*
        ];
    };
}
interp_state!(define_persist_holders);

fn saved_frame_contains(f: &SavedFrame, names: &impl Fn(&Slot) -> bool) -> bool {
    f.locals.iter().any(names)
        || f.args.iter().any(names)
        || f.stack_slice.iter().any(names)
        || names(&f.this_val)
        || names(&f.env)
        || names(&f.result)
        || f.jumps.iter().any(|j| names(&j.env))
}
