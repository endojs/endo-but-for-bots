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

mod common;

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
    let dir = common::TempDir::new(&format!(
        "ironhorse-metamorphic-file-{name}-{}",
        std::process::id()
    ));
    let mut n = 0u32;
    let mut fresh = {
        let dir = dir.to_path_buf();
        move || {
            n += 1;
            FileStore::open(dir.join(format!("heap-{n}.ihstore"))).unwrap()
        }
    };
    run(&mut fresh);
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
        hex_sha256(&session.machine().write_snapshot(&sig).expect("quiescent machine snapshots")),
        "d34c62fc6ac11563e01c14e0a2316a846e872f0a2368f0ec931243772dc733ea",
        "canonical final blob hash"
    );
    // Seal re-pinned 2026-08-11 as the schema evolved, once per
    // format commit: v3 (row-hash tree root), v3+phase 6 (page-edge
    // summaries in the seal, including the NULL-edge exclusion), v4
    // (segmented free list: free_len in the manifest, free rows in
    // the seal), and v5 (summaries folded into the root; counts
    // header and length-prefixed edge entries in root and seal).
    // The blob hash above was unchanged by ALL of those format
    // commits — the container/store independence this vector proves.
    // Both pins moved together on 2026-08-18 for a CONTENT reason,
    // not a format one: the boot heap deliberately changed (native
    // function instances chain to %Function.prototype% now).
    // Seal re-pinned again 2026-08-18 for schema v6 (class-tree
    // root: the manifest root formula changed from the flat v5
    // combine to per-class Merkle trees, and the seal signs the
    // manifest). The blob hash above did NOT move — v6 changed the
    // root formula only, never the container format.
    // Seal re-pinned again 2026-08-24 for schema v7 (the side-table
    // ledger: the small state grew the arrays/collections/registry
    // sections, so every small leaf — and thus root and seal —
    // moved). The blob hash above did NOT move: this machine carries
    // no side-table state, and the ledger atoms are emitted only
    // when non-empty, which is precisely the container-stability
    // property the two-pin split exists to prove.
    // Seal re-pinned again 2026-08-25 for schema v8 (the durable
    // completed-crank counter): the seal signs the whole manifest, and
    // the manifest grew a `u64` tail. The blob hash above did NOT move
    // — the counter is store metadata and the container carries no
    // manifest at all, which is the same two-pin split again.
    // BOTH pins re-pinned 2026-08-26 for the llm rebase: a CONTENT
    // move (the language-completion boot heap: Intl, Temporal, the
    // test262 host, and the boot-link name-table appends), not a
    // format one — the container grammar, store schema 8, and the
    // canonical-empty SYMB/KEYS encodings are all unchanged.
    // Seal re-pinned again 2026-08-27 for schema v9 (the error-data
    // row: the small state grew the ERRD section and the manifest
    // stamps schema 9, so every small leaf — and thus root and seal —
    // moved). The blob hash above did NOT move: this machine holds no
    // error rows, and the ERRD atom is emitted only when non-empty —
    // the same container-stability property the two-pin split proves.
    assert_eq!(
        store.manifest().unwrap().seal,
        "c79e465f2d95fcc1f18ca69ff502b417bfcb339f9ee403111c4fb19587f39782",
        "epoch-3 seal chain"
    );
}
