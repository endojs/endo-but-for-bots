use ironhorse_snapshot::{
    machine::{checkpoint_to_store, resume_from_store, MachineSnapshot},
    store::{
        compute_root, image_to_batch_unchecked, migrate_store, seal_commit, HeapStore,
        HeapStoreCommit, MemoryStore, STORE_SCHEMA_VERSION,
    },
    store_sections::framed_root,
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
        .commit(&image_to_batch_unchecked(&image, 1, ""))
        .unwrap();
    let small = store.read_small_state().unwrap();
    let mut manifest = store.manifest().unwrap();
    manifest.store_schema = 28;
    let (pages, exts) = store.leaf_hashes().unwrap();
    let frees = store.free_leaf_hashes().unwrap();
    let edges = store.page_edges().unwrap();
    manifest.root = compute_root(
        &manifest,
        &framed_root(&small).unwrap(),
        &pages,
        &exts,
        &frees,
        &edges,
    );
    manifest.seal = seal_commit(&manifest.parent_seal, &manifest, &[], &[], &[], &[], &[]);
    store.replace_manifest_for_migration(&manifest).unwrap();

    assert!(migrate_store(&mut store, &signature).unwrap());
    assert_eq!(store.manifest().unwrap().store_schema, STORE_SCHEMA_VERSION);
    assert_eq!(store.read_small_state().unwrap(), small);
    assert_eq!(store.leaf_hashes().unwrap(), (pages, exts));
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
