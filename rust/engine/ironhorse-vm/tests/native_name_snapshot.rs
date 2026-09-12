use ironhorse_vm::{Interp, RestoreSession};

fn session() -> RestoreSession {
    let source = Interp::new();
    let meter = source.meter_state();
    let (slots, chunks) = source.into_arenas();
    let mut restored = Interp::begin_restore();
    restored
        .restore_snapshot_state(slots, chunks, vec![], vec![], meter)
        .unwrap();
    restored
}

#[test]
fn native_name_restore_rejects_non_native_owners_and_invalid_offsets() {
    let valid = Interp::new()
        .function_state_snapshot()
        .native_names
        .unwrap();
    assert!(!valid.is_empty());
    let mut invalid_sets = Vec::new();
    let mut duplicate = valid.clone();
    duplicate.insert(1, duplicate[0]);
    invalid_sets.push(duplicate);
    for owner in [0, u32::MAX] {
        let mut rows = valid.clone();
        rows[0].0 = owner;
        invalid_sets.push(rows);
    }
    for offset in [0, 3, u32::MAX - 1] {
        let mut rows = valid.clone();
        rows[0].1 = offset;
        invalid_sets.push(rows);
    }
    for rows in invalid_sets {
        let mut restored = session();
        let error = restored.restore_native_names(Some(&rows)).unwrap_err();
        assert_eq!(error.row, "native_names");
        assert_eq!(restored.restore_dates(vec![]).unwrap_err(), error);
        assert_eq!(restored.finish().err().unwrap(), error);
    }
}

#[test]
fn pruning_followed_by_invalid_guest_metadata_cannot_publish_a_machine() {
    let mut restored = session();
    restored.restore_native_names(Some(&[])).unwrap();
    let mut invalid = ironhorse_vm::snapshot_api::FunctionStateSnapshot::default();
    invalid.ctor_prototypes.push((0, 0));
    let error = restored.restore_function_state(invalid).unwrap_err();
    assert_eq!(error.row, "Functions");
    assert_eq!(restored.finish().err().unwrap(), error);
}
