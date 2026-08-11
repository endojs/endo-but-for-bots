//! Instantiates the **backend-parameterized store acceptance suite**
//! (`ironhorse_snapshot::store_suite` — the six-way metamorphic
//! determinism runner and the lazy working-set bound) against the two
//! in-crate reference backends. The daemon-side SQLite backend
//! instantiates the same suite in its own crate
//! (`rust/endo/ironhorse-store-sqlite/tests/store_suite.rs`), so every
//! backend runs the same instrument.

use ironhorse_snapshot::store::MemoryStore;
use ironhorse_snapshot::store_file::FileStore;
use ironhorse_snapshot::store_suite::{lazy_working_set_bound, metamorphic_suite};

#[test]
fn memory_store_agrees_six_ways() {
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
fn file_store_agrees_six_ways() {
    with_file_stores("six-ways", |fresh| metamorphic_suite(fresh));
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
        "c36f161dea7e80c5144bc5b3134c5a38105b2e94e8150aa7a496bc1e927d3e2f",
        "canonical final blob hash"
    );
    // Seal re-pinned 2026-08-11 for store schema v3 (the manifest
    // gained the row-hash tree root, which the seal signs); the blob
    // hash above was unchanged by that schema bump — exactly the
    // container/store independence this vector exists to prove.
    assert_eq!(
        store.manifest().unwrap().seal,
        "091d91850d6d522ae9e7bf134ccd1852708986465579c48f08e178fa7c37ee87",
        "epoch-3 seal chain"
    );
}
