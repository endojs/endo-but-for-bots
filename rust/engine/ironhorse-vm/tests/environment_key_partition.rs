//! Internal environment markers must not overlap symbol-property ids.
use ironhorse_vm::{Interp, Slot};

#[test]
fn environment_marker_is_not_a_stored_key() {
    let mut slot = Slot::undefined();
    slot.id = ironhorse_vm::diagnostics::XS_ENVIRONMENT_BEHAVIOR_ID;
    assert_eq!(slot.stored_key_id(), Some(u16::MAX));
    slot.flag = ironhorse_vm::diagnostics::XS_INTERNAL_FLAG;
    assert_eq!(slot.stored_key_id(), None);
    slot.value = ironhorse_vm::Payload::At(u16::MAX, 0);
    assert_eq!(
        slot.stored_key_id(),
        Some(u16::MAX),
        "computed keys are never markers"
    );
    slot = Slot::undefined();
    slot.id = u16::MAX - 1;
    assert_eq!(slot.stored_key_id(), Some(u16::MAX - 1));
}

#[test]
fn boot_has_no_runtime_key_witness_and_environment_markers_stay_reserved() {
    let mut vm = Interp::new();
    assert_eq!(vm.stored_runtime_intern(), None);
    let (code, names) = ironhorse_compile::compile_atoms("var o={}; with(o){1}").unwrap();
    vm.link_intrinsics(&ironhorse_vm::parse_symbols(&names));
    let out = vm.run(&code);
    assert!(out.completed, "{:?}", out.halt);
    assert_ne!(vm.stored_runtime_intern(), Some(u16::MAX));
    assert!(vm.symbol_key_table().1.iter().all(|(id, _)| *id < u16::MAX));
}
