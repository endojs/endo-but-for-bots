use ironhorse_vm::Interp;

#[test]
fn native_name_restore_rejects_non_native_owners_and_invalid_offsets() {
    let source = Interp::new();
    let valid = source.function_state_snapshot();
    assert!(!valid.native_names.as_ref().unwrap().is_empty());

    let mut duplicate = valid.clone();
    let rows = duplicate.native_names.as_mut().unwrap();
    rows.insert(1, rows[0]);
    let mut restored = Interp::new();
    assert!(!restored.restore_function_state(duplicate));
    assert_eq!(restored.function_state_snapshot(), valid);

    // A valid authoritative empty native subset must not be applied before
    // unrelated malformed guest-function metadata is rejected.
    let mut invalid_guest = valid.clone();
    invalid_guest.native_names = Some(vec![]);
    invalid_guest.ctor_prototypes.push((0, 0));
    let mut restored = Interp::new();
    assert!(!restored.restore_function_state(invalid_guest));
    assert_eq!(restored.function_state_snapshot(), valid);

    for invalid_owner in [0, u32::MAX] {
        let mut state = valid.clone();
        state.native_names.as_mut().unwrap()[0].0 = invalid_owner;
        let mut restored = Interp::new();
        let before = restored.function_state_snapshot();
        assert!(!restored.restore_function_state(state));
        assert_eq!(restored.function_state_snapshot(), before);
    }

    for invalid_offset in [0, 3, u32::MAX - 1] {
        let mut state = valid.clone();
        state.native_names.as_mut().unwrap()[0].1 = invalid_offset;
        let mut restored = Interp::new();
        let before = restored.function_state_snapshot();
        assert!(!restored.restore_function_state(state));
        assert_eq!(restored.function_state_snapshot(), before);
    }
}
