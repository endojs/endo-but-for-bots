#![cfg(test)]

use super::{Interp, NativeMethod};
use crate::value::{Kind, Payload, Slot};

#[test]
fn copy_object_in_recycled_boot_slot_is_not_a_boot_native() {
    let mut m = Interp::new();
    // Seed a disposable boot-range object so this admission test does not
    // depend on incorrectly collecting a lazily installed intrinsic.
    let disposable = m.slots.alloc(Slot::instance(m.object_proto));
    m.boot_slot_count = m.slots.capacity();
    m.collect_garbage().unwrap();
    let function = m.alloc_method(NativeMethod::CopyObject);
    assert_eq!(
        function, disposable,
        "fixture must recycle the seeded object"
    );
    assert!(
        function.0 < m.boot_slot_count,
        "fixture must reuse a boot slot"
    );
    // This internal callable may remain on a suspended async operand stack
    // while the spread source awaits. Retain it in a checked root here to
    // isolate admission from the compiler's incidental allocation order.
    m.stack
        .push(Slot::of(Kind::Reference, Payload::Reference(function)));
    assert!(!m.function_persists(function));
    assert!(!m
        .function_state_snapshot()
        .native_names
        .unwrap()
        .iter()
        .any(|&(owner, _)| owner == function.0));
    assert_eq!(
        m.stored_unpersistable_row(),
        Some("a stored reference to a non-persisted native function")
    );
}
