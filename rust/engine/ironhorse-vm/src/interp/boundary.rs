//! Field policies for admitting a completed crank to persistence.
//!
//! Retained state has no boundary predicate. Activation state must be cleared;
//! lifecycle and poison latches must independently permit the checkpoint.
use super::*;

macro_rules! boundary_run {
    ($($code:tt)*) => { $($code)* };
}
macro_rules! boundary_text {
    ($($code:tt)*) => { stringify!($($code)*) };
}

// Both the executable predicate and the independent source lock consume these
// exact tokens. A field classification alone is not evidence of enforcement.
macro_rules! boundary_predicate {
    ($emit:ident, $vm:ident, $field:ident, retained) => {
        $emit! { true }
    };
    ($emit:ident, $vm:ident, $field:ident, empty) => {
        $emit! { $vm.$field.is_empty() }
    };
    ($emit:ident, $vm:ident, $field:ident, undefined) => {
        $emit! { $vm.$field.kind == Kind::Undefined }
    };
    ($emit:ident, $vm:ident, $field:ident, null) => {
        $emit! { $vm.$field == crate::value::SlotIndex::NULL }
    };
    ($emit:ident, $vm:ident, $field:ident, false) => {
        $emit! { !$vm.$field }
    };
    ($emit:ident, $vm:ident, $field:ident, zero) => {
        $emit! { $vm.$field == 0 }
    };
    ($emit:ident, $vm:ident, $field:ident, none) => {
        $emit! { $vm.$field.is_none() }
    };
    ($emit:ident, $vm:ident, $field:ident, no_status) => {
        $emit! { $vm.$field == ResumeStatus::NoStatus }
    };
    ($emit:ident, $vm:ident, $field:ident, healthy) => {
        $emit! { !$vm.$field.is_poisoned() }
    };
    ($emit:ident, $vm:ident, $field:ident, completed) => {
        $emit! { $vm.$field }
    };
}

macro_rules! define_boundary {
    (() $vis:vis struct $name:ident {
        $(#[quiescent($boundary:ident)]
          #[persist_refs($persist:ident)]
          #[gc_hook($phase:ident, $policy:ident)]
          #[gc_chunk($chunk:ident)]
          #[gc_slots($shape:ident, $row:ident)]
          #[gc_weak($weak:ident)]
          #[snapshot_table($($snapshot:tt)*)]
          $(#[$attr:meta])* $field_vis:vis $field:ident: $ty:ty,)*
    } external_tables { $($external:tt)* }) => {
        impl Interp {
            pub(super) fn fields_are_quiescent(&self) -> bool {
                true $(&& boundary_predicate!(boundary_run, self, $field, $boundary))*
            }
        }
        /// Exact predicate tokens, checked against independent snapshot policy.
        #[doc(hidden)]
        pub const QUIESCENCE_SOURCE: &str = concat!(
            $(boundary_predicate!(boundary_text, self, $field, $boundary), "\n",)*
        );
    };
}
interp_state!(define_boundary);
