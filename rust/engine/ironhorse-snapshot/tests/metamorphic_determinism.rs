//! Instantiates the **backend-parameterized store acceptance suite**
//! (`ironhorse_snapshot::store_suite` — the seven-way metamorphic
//! determinism runner and the lazy working-set bound) against the two
//! in-crate reference backends. The daemon-side SQLite backend
//! instantiates the same suite in its own crate
//! (`rust/endo/ironhorse-store-sqlite/tests/store_suite.rs`), so every
//! backend runs the same instrument.

use ironhorse_snapshot::store::MemoryStore;
use ironhorse_snapshot::store_file::FileStore;
use ironhorse_snapshot::store_suite::{lazy_working_set_bound, metamorphic_suite};

#[test]
fn memory_store_agrees_seven_ways() {
    metamorphic_suite(MemoryStore::new);
}

#[test]
fn memory_store_lazy_resume_faults_only_the_working_set() {
    lazy_working_set_bound(MemoryStore::new);
}

/// Fresh single-file stores under one test-owned temp dir, removed at
/// the end (leaked temp dirs are the usual cause of local-only
/// flakes).
fn with_file_stores(name: &str, run: impl FnOnce(&mut dyn FnMut() -> FileStore)) {
    let dir = std::env::temp_dir().join(format!(
        "ironhorse-metamorphic-file-{name}-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let mut n = 0u32;
    let mut fresh = {
        let dir = dir.clone();
        move || {
            n += 1;
            FileStore::open(dir.join(format!("heap-{n}.ihstore"))).unwrap()
        }
    };
    run(&mut fresh);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn file_store_agrees_seven_ways() {
    with_file_stores("seven-ways", |fresh| metamorphic_suite(fresh));
}

#[test]
fn file_store_lazy_resume_faults_only_the_working_set() {
    with_file_stores("working-set", |fresh| lazy_working_set_bound(&mut *fresh));
}

/// Frozen golden vector (collaborator-review follow-up): every other
/// comparison in the suite is self-referential within one process, so
/// a latent host-endianness or map-iteration dependency would cancel
/// out in-process yet break the cross-host resume claim. These
/// constants pin the canonical blob bytes and the seal chain; an
/// intentional format or cost-table change updates them consciously,
/// with a commit message saying why.
#[test]
fn golden_vector_pins_canonical_bytes_and_seal() {
    use ironhorse_snapshot::machine::{
        begin_store_session, checkpoint_to_store, MachineSnapshot,
    };
    use ironhorse_snapshot::sha256::hex_sha256;
    use ironhorse_snapshot::store::HeapStore;
    use ironhorse_snapshot::Signature;
    use ironhorse_vm::{parse_symbols, Interp};

    let sig = Signature::new("ironhorse-worker-v1");
    let cranks = ["var x = 5;", "x = x + 1;", "x + 10"];
    let compiled: Vec<(Vec<u8>, Vec<String>)> = cranks
        .iter()
        .map(|s| {
            let (b, sy) = ironhorse_compile::compile_atoms(s).expect("compiles");
            (b, parse_symbols(&sy))
        })
        .collect();

    let mut store = MemoryStore::new();
    let mut m = Interp::new();
    m.link_intrinsics(&compiled[0].1);
    assert!(m.run(&compiled[0].0).completed);
    let mut session = begin_store_session(m, &sig, &mut store)
        .map_err(|(_, e)| e)
        .expect("begin");
    for (bytecode, _) in compiled.iter().skip(1) {
        assert!(session.machine_mut().run(bytecode).completed);
        checkpoint_to_store(&mut session, &sig, &mut store).expect("checkpoint");
    }

    assert_eq!(
        hex_sha256(&session.machine().write_snapshot(&sig)),
        "6f821b0c028547b7078d1d8d1f10571a50f2c4bf079345e44d8b6a2c63d36a01",
        "canonical final blob hash"
    );
    // Seal re-pinned 2026-08-11 as the schema evolved, once per
    // format commit: v3 (row-hash tree root), v3+phase 6 (page-edge
    // summaries in the seal, including the NULL-edge exclusion), v4
    // (segmented free list: free_len in the manifest, free rows in
    // the seal), and v5 (summaries folded into the root; counts
    // header and length-prefixed edge entries in root and seal).
    // Those container/store format changes left the blob hash
    // unchanged — the independence this vector exists to prove. Both
    // the blob AND the seal were re-pinned 2026-08-23 when the
    // ironhorse-262 language-completion branch merged `llm` in: that
    // branch grows the machine's live intrinsic/proto state, so the
    // canonical snapshot blob legitimately differs (a MACHINE-STATE
    // change, not a store-format one), and the seal derives from it.
    // The seven-way metamorphic tests above still pass, so the new
    // bytes remain deterministic and cross-host stable. Re-pinned again for
    // the Date intrinsic's new constructor/prototype boot state, then for the
    // collection methods' specified name/length metadata and their distinct
    // Map/Set iterator-prototype boot state, then for the Iterator constructor
    // and helper-method prototype surface, and then for the async-generator
    // constructor/prototype metadata.
    assert_eq!(
        store.manifest().unwrap().seal,
        "a6f4868126703ad0ffc3542d251bc1b942135c1476eb3b5fc16b2c3e2423a02c",
        "epoch-3 seal chain"
    );
}
