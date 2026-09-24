use ironhorse_snapshot::CommitToken;
use ironhorse_snapshot::{
    machine::{checkpoint_to_store, resume_from_store, MachineSnapshot},
    store::{
        image_to_batch_unchecked, migrate_store, store_to_image, validate_store_content, HeapStore,
        HeapStoreCommit, MemoryStore, StoreManifest,
    },
    Signature,
};
use ironhorse_vm::Interp;

#[test]
fn schema28_native_name_defaults_migrate_without_rewriting_heap() {
    let signature = Signature::new("native-name-migration");
    let m = Interp::new();
    let mut image = m.snapshot_image_for_testing(&signature).unwrap();
    image.version.format_version = 17;
    image.function_state.native_names = None;
    let mut store = MemoryStore::new();
    store
        .commit(&image_to_batch_unchecked(&image, 1, CommitToken::ZERO))
        .unwrap();
    let small = store.read_small_state().unwrap();
    let rows = store_to_image(&store).unwrap();
    let current = store.manifest().unwrap();
    let old = StoreManifest {
        store_schema: 28,
        ..current.clone()
    };
    store.replace_for_migration(&current, &old, &small).unwrap();

    assert!(migrate_store(&mut store, &signature).unwrap());
    assert_eq!(store.manifest().unwrap(), current);
    validate_store_content(&store, &signature).unwrap();
    assert_eq!(store.read_small_state().unwrap(), small);
    assert_eq!(store_to_image(&store).unwrap(), rows);
    assert!(!migrate_store(&mut store, &signature).unwrap());
    let mut resumed = resume_from_store(&store, &signature).unwrap();
    let (code, symbols) = ironhorse_compile::compile_atoms("Proxy.revocable.name").unwrap();
    let code = resumed
        .machine_mut()
        .relink_crank(&code, &ironhorse_vm::parse_symbols(&symbols))
        .unwrap();
    let result = resumed.machine_mut().run(&code);
    assert!(result.completed);
    assert_eq!(result.result, "revocable");
    checkpoint_to_store(&mut resumed, &signature, &mut store).unwrap();
    assert!(resume_from_store(&store, &signature)
        .unwrap()
        .machine()
        .function_state_snapshot()
        .native_names
        .is_some());
}
