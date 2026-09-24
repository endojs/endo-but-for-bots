//! Schema migration under the current boot identity, plus refusal of frozen
//! historical fixtures that lack a mechanically derived boot fingerprint.
//! Matching-boot v5 stores are synthesized below without changing the frozen
//! artifacts: layout migration must never authorize foreign boot metadata.

mod common;
mod migration_fixtures;

use common::TempDir;
use ironhorse_snapshot::store::HeapStoreCommit;
use ironhorse_snapshot::CommitToken;
use migration_fixtures::{write_stage1_file_store, FIXTURE_CRANKS, FIXTURE_RESULTS, STAGE1_PROBE};

use ironhorse_snapshot::machine::{checkpoint_to_store, resume_from_store};
use ironhorse_snapshot::store::{
    export_to_container, import_from_container, migrate_store, root_hash, store_to_image,
    validate_store, validate_store_content, HeapStore, MemoryStore, StoreError, StoreManifest,
    STORE_SCHEMA_VERSION,
};
use ironhorse_snapshot::store_file::FileStore;
use ironhorse_snapshot::{Signature, SnapshotError};

fn sig() -> Signature {
    Signature::new("ironhorse-worker-v1")
}

fn fixture(name: &str) -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(name)
}

fn current_boot_fixture_image() -> ironhorse_snapshot::image::MachineImage {
    use ironhorse_snapshot::machine::MachineSnapshot;
    let mut m = ironhorse_vm::Interp::new();
    for source in FIXTURE_CRANKS {
        let (code, symbols) = ironhorse_compile::compile_atoms(source).unwrap();
        let code = m
            .relink_crank(&code, &ironhorse_vm::parse_symbols(&symbols))
            .unwrap();
        assert!(m.run(&code).completed);
    }
    m.snapshot_image_for_testing(&sig()).unwrap()
}

/// A schema-5 store of the current boot's fixture machine, in what an older
/// build left that migration reads: the rows as this build writes them, the
/// small state cut back to schema 5's six sections, and the manifest in
/// schema 5's layout, written through the migration hook. The file is in the
/// current layout, without the row-leaf hashes an older build's file kept,
/// which migration drops anyway (the legacy layout's own read is
/// `store_file`'s to test).
fn write_matching_boot_v5_fixture(path: &std::path::Path) {
    use ironhorse_snapshot::store::image_to_batch_unchecked;
    let image = current_boot_fixture_image();
    let mut store = FileStore::open(path).unwrap();
    store
        .commit(&image_to_batch_unchecked(&image, 1, CommitToken::ZERO))
        .unwrap();
    let current = store.manifest().unwrap();
    let mut small = store.read_small_state().unwrap();
    // Schema 5 contains the original six sections. All later fixture state
    // is boot-derived or empty, so the ladder may append empty new tables.
    let mut end = 0;
    for _ in 0..6 {
        let len = u32::from_be_bytes(small[end..end + 4].try_into().unwrap()) as usize;
        end += 4 + len;
    }
    small.truncate(end);
    let v5 = StoreManifest {
        store_schema: 5,
        cranks: 0,
        ..current.clone()
    };
    store.replace_for_migration(&current, &v5, &small).unwrap();
}

#[test]
fn historical_unfingerprinted_store_and_container_refuse_without_migration() {
    let dir = TempDir::new("ih-migrate-legacy-boot");
    let path = dir.join("store.ihstore");
    std::fs::copy(fixture("store-v5.ihstore"), &path).unwrap();
    let before = std::fs::read(&path).unwrap();
    let mut store = FileStore::open(&path).unwrap();
    let legacy_sig = store.manifest().unwrap().signature;
    for expected in [sig(), legacy_sig] {
        assert!(matches!(
            migrate_store(&mut store, &expected),
            Err(StoreError::Snapshot(
                SnapshotError::BootLayoutMismatch { .. }
            ))
        ));
        let bytes = std::fs::read(fixture("store-v5.container")).unwrap();
        assert!(matches!(
            import_from_container(&bytes, &expected, &mut MemoryStore::new()),
            Err(StoreError::Snapshot(
                SnapshotError::BootLayoutMismatch { .. }
            ))
        ));
    }
    assert_eq!(std::fs::read(&path).unwrap(), before);
}

/// Resume the migrated store and re-run the fixture's second crank —
/// it dereferences state written by the frozen cranks (`keep.v +
/// keep.w`), so the pinned completion value proves the CONTENT
/// survived migration, not just the version stamp. Then checkpoint,
/// proving the migrated store continues its succession chain.
fn assert_resumes_and_reads(store: &mut dyn HeapStore) {
    let (bytecode, _symbols) =
        ironhorse_compile::compile_atoms(FIXTURE_CRANKS[1]).expect("read crank compiles");
    let epoch_before = store.manifest().expect("manifest").epoch;
    let mut session = resume_from_store(store, &sig()).expect("resume from migrated store");
    let o = session.machine_mut().run(&bytecode);
    assert!(o.completed, "read crank completes: {}", o.result);
    assert_eq!(o.result, FIXTURE_RESULTS[1]);
    let epoch = checkpoint_to_store(&mut session, &sig(), store).expect("checkpoint after migrate");
    assert_eq!(epoch, epoch_before + 1, "epoch chain continues");
    validate_store_content(store, &sig()).expect("the extended store validates");
}

#[test]
fn v5_file_store_migrates_in_place_and_keeps_working() {
    let dir = TempDir::new("ih-migrate-file");
    let path = dir.join("store.ihstore");
    write_matching_boot_v5_fixture(&path);

    // Open no longer migrates (review wave 4, F2): the caller runs the
    // signature-gated migration explicitly.
    let mut store = FileStore::open(&path).expect("open v5 store");
    assert!(
        migrate_store(&mut store, &sig()).expect("migrate v5 store"),
        "migrate_store reports it ran the ladder"
    );
    let manifest = store.manifest().expect("manifest");
    assert_eq!(
        manifest.store_schema, STORE_SCHEMA_VERSION,
        "migration restamped the store to the current schema"
    );
    validate_store_content(&store, &sig()).expect("the migrated store validates");
    drop(store);

    // Reopen before mutating: migration is idempotent — the second
    // migrate finds a current-schema store, returns false, and leaves
    // the file byte-stable (no rewrite loop on every open).
    let bytes_after_first = std::fs::read(&path).expect("read migrated file");
    let mut store = FileStore::open(&path).expect("reopen migrated store");
    assert!(
        !migrate_store(&mut store, &sig()).expect("re-migrate is a no-op"),
        "an already-current store reports no migration"
    );
    assert_eq!(
        store.manifest().expect("manifest").store_schema,
        STORE_SCHEMA_VERSION
    );
    drop_guard_bytes(&path, &bytes_after_first);
    assert_resumes_and_reads(&mut store);
}

#[test]
fn v5_resume_without_migrate_fails_needs_migration() {
    // Open opens the raw store; resuming an un-migrated older store
    // fails closed by name rather than silently adopting it (review
    // wave 4, F2/F3 — open() no longer hides the migration step).
    let dir = TempDir::new("ih-migrate-needs");
    let path = dir.join("store.ihstore");
    write_matching_boot_v5_fixture(&path);

    let store = FileStore::open(&path).expect("open v5 store");
    match resume_from_store(&store, &sig()) {
        Err(StoreError::NeedsMigration { found: 5 }) => {}
        other => panic!("expected NeedsMigration {{ found: 5 }}, got {other:?}"),
    }
}

#[test]
fn migrate_refuses_incompatible_signature_without_touching_bytes() {
    // A daemon whose callback-table signature the store predates must
    // NOT restamp it: the signature gate fires before any write, so the
    // rightful older owner still finds its bytes intact (review wave 4,
    // F2/F3).
    let dir = TempDir::new("ih-migrate-sig");
    let path = dir.join("store.ihstore");
    write_matching_boot_v5_fixture(&path);
    let before = std::fs::read(&path).expect("read v5 fixture");

    let mut store = FileStore::open(&path).expect("open v5 store");
    match migrate_store(&mut store, &Signature::new("some-other-host")) {
        Err(StoreError::Snapshot(SnapshotError::SignatureMismatch { .. })) => {}
        other => panic!("expected SignatureMismatch, got {other:?}"),
    }
    drop(store);
    assert_eq!(
        std::fs::read(&path).expect("reread"),
        before,
        "a signature-refused migration leaves the store byte-identical"
    );
}

/// Review finding 8: a store whose meter ran under a DIFFERENT cost
/// table can never resume on this engine — `validate_store` refuses
/// it after any migration — so the ladder restamping it forward first
/// would wedge it: the new implementation still refuses it and the
/// old one no longer recognizes the schema. The wrapper serves a
/// small state whose cost-table version differs and PANICS on any
/// write, so the lock proves the refusal lands BEFORE any mutation.
struct ForeignCostTableStore(FileStore);

impl HeapStore for ForeignCostTableStore {
    fn manifest(&self) -> Result<ironhorse_snapshot::store::StoreManifest, StoreError> {
        self.0.manifest()
    }
    fn read_small_state(&self) -> Result<Vec<u8>, StoreError> {
        let mut bytes = self.0.read_small_state()?;
        let needle = ironhorse_vm::COST_TABLE_VERSION.as_bytes();
        let at = bytes
            .windows(needle.len())
            .position(|w| w == needle)
            .expect("the fixture's meter section carries the current cost-table version");
        bytes[at + needle.len() - 1] = b'0';
        Ok(bytes)
    }
    fn read_slot_page(&self, page: u32) -> Result<Vec<u8>, StoreError> {
        self.0.read_slot_page(page)
    }
    fn read_chunk_extent(&self, ext: u32) -> Result<Vec<u8>, StoreError> {
        self.0.read_chunk_extent(ext)
    }
    fn inventory(&self) -> Result<(Vec<usize>, Vec<usize>), StoreError> {
        self.0.inventory()
    }
    fn read_free_seg(&self, seg: u32) -> Result<Vec<u8>, StoreError> {
        self.0.read_free_seg(seg)
    }
    fn page_edges(&self) -> Result<Vec<Vec<u32>>, StoreError> {
        self.0.page_edges()
    }
    fn commit_verified(
        &mut self,
        _verify: &mut ironhorse_snapshot::store::CommitVerifier<'_>,
    ) -> Result<(), StoreError> {
        panic!("migration must not commit to a store it cannot resume");
    }
    fn replace_for_migration(
        &mut self,
        _from: &StoreManifest,
        _to: &StoreManifest,
        _small: &[u8],
    ) -> Result<(), StoreError> {
        panic!("migration must not restamp a store it cannot resume");
    }
}

#[test]
fn migrate_refuses_a_foreign_cost_table_before_any_restamp() {
    let dir = TempDir::new("ih-migrate-cost");
    let path = dir.join("store.ihstore");
    write_matching_boot_v5_fixture(&path);
    let before = std::fs::read(&path).expect("read v5 fixture");
    let mut store = ForeignCostTableStore(FileStore::open(&path).expect("open v5 store"));
    match migrate_store(&mut store, &sig()) {
        Err(StoreError::Snapshot(SnapshotError::CostTableMismatch { expected, found })) => {
            assert_eq!(expected, ironhorse_vm::COST_TABLE_VERSION);
            assert_eq!(found, "ironhorse-meter-0");
        }
        other => panic!("expected CostTableMismatch, got {other:?}"),
    }
    drop(store);
    assert_eq!(
        std::fs::read(&path).expect("reread"),
        before,
        "a cost-refused migration leaves the store byte-identical"
    );
}

/// Assert the file at `path` currently holds exactly `expected` —
/// named so the call site reads as the idempotence lock it is.
fn drop_guard_bytes(path: &std::path::Path, expected: &[u8]) {
    let now = std::fs::read(path).expect("reread migrated file");
    assert_eq!(
        now, expected,
        "reopening an already-migrated store rewrites nothing"
    );
}

#[test]
fn migration_refuses_an_externally_truncated_file() {
    // Review wave 4, F6: the migration reads the durable file, not the
    // view cached at open. A file truncated after open must fail closed
    // on the header's own length claim, not panic on a slice.
    let dir = TempDir::new("ih-migrate-truncated");
    let path = dir.join("store.ihstore");
    write_matching_boot_v5_fixture(&path);

    // Open loads the full header + directories; the truncation lands
    // after, exactly as an external writer would do it.
    let mut store = FileStore::open(&path).expect("open v5 store");
    std::fs::OpenOptions::new()
        .write(true)
        .open(&path)
        .expect("reopen for truncate")
        .set_len(20)
        .expect("truncate below the manifest region");

    // The migration reads the manifest DURABLY (review wave 5, the
    // stale-handle window), so the truncation is caught at that read and
    // names the block it could not decode. The write re-reads the file
    // too, for a truncation landing after the migration's read.
    match migrate_store(&mut store, &sig()) {
        Err(StoreError::Snapshot(SnapshotError::Corrupt(msg))) => {
            assert!(
                msg.contains("truncated") || msg.contains("file store"),
                "named failure: {msg}"
            );
        }
        other => panic!("expected a truncation refusal, got {other:?}"),
    }
}

/// A v5 file store that counts the migration's durable reads and writes.
struct CountingMigrationStore {
    inner: FileStore,
    rereads: std::cell::Cell<u32>,
    writes: u32,
}

impl HeapStore for CountingMigrationStore {
    fn manifest(&self) -> Result<StoreManifest, StoreError> {
        self.inner.manifest()
    }
    fn reread_manifest(&self) -> Result<StoreManifest, StoreError> {
        self.rereads.set(self.rereads.get() + 1);
        self.inner.reread_manifest()
    }
    fn read_small_state(&self) -> Result<Vec<u8>, StoreError> {
        self.inner.read_small_state()
    }
    fn read_slot_page(&self, page: u32) -> Result<Vec<u8>, StoreError> {
        self.inner.read_slot_page(page)
    }
    fn read_chunk_extent(&self, ext: u32) -> Result<Vec<u8>, StoreError> {
        self.inner.read_chunk_extent(ext)
    }
    fn inventory(&self) -> Result<(Vec<usize>, Vec<usize>), StoreError> {
        self.inner.inventory()
    }
    fn read_free_seg(&self, seg: u32) -> Result<Vec<u8>, StoreError> {
        self.inner.read_free_seg(seg)
    }
    fn page_edges(&self) -> Result<Vec<Vec<u32>>, StoreError> {
        self.inner.page_edges()
    }
    fn commit_verified(
        &mut self,
        verify: &mut ironhorse_snapshot::store::CommitVerifier<'_>,
    ) -> Result<(), StoreError> {
        self.inner.commit_verified(verify)
    }
    fn replace_for_migration(
        &mut self,
        from: &StoreManifest,
        to: &StoreManifest,
        small: &[u8],
    ) -> Result<(), StoreError> {
        self.writes += 1;
        self.inner.replace_for_migration(from, to, small)
    }
}

/// The ladder runs in memory: the whole v5-to-current migration reads the
/// store's manifest once and writes once, so no backend answer can keep
/// it looping and a crash leaves the store either untouched or current.
#[test]
fn the_ladder_reads_the_manifest_once_and_writes_once() {
    let dir = TempDir::new("ih-migrate-once");
    let path = dir.join("store.ihstore");
    write_matching_boot_v5_fixture(&path);
    let mut store = CountingMigrationStore {
        inner: FileStore::open(&path).expect("open v5 store"),
        rereads: std::cell::Cell::new(0),
        writes: 0,
    };
    assert!(migrate_store(&mut store, &sig()).expect("migrates"));
    assert_eq!((store.rereads.get(), store.writes), (1, 1));
    assert_eq!(
        store.inner.manifest().unwrap().store_schema,
        STORE_SCHEMA_VERSION
    );
    assert!(!migrate_store(&mut store, &sig()).expect("already current"));
    assert_eq!((store.rereads.get(), store.writes), (2, 1));
}

/// Review wave 5: since `open()` stopped migrating, the gap between
/// opening a store and upgrading it is caller-controlled and unbounded.
/// `FileStore` caches its header at open, so a handle opened BEFORE
/// another handle upgraded the file used to step the ladder from a
/// schema the file no longer had — splicing an intermediate manifest
/// onto a newer body and bricking it, with both handles carrying the
/// correct signature and neither doing anything wrong.
///
/// Reading the manifest durably instead, the stale handle sees the
/// current schema and correctly reports nothing to do.
#[test]
fn a_stale_handle_does_not_splice_over_a_store_another_handle_upgraded() {
    let dir = TempDir::new("ih-migrate-stale");
    let path = dir.join("store.ihstore");
    write_matching_boot_v5_fixture(&path);

    // The stale handle opens FIRST and caches a v5 header.
    let mut stale = FileStore::open(&path).expect("open v5 store");

    // A second handle upgrades the file to the current schema.
    let mut fresh = FileStore::open(&path).expect("second handle");
    assert!(
        migrate_store(&mut fresh, &sig()).expect("migrate"),
        "the ladder ran"
    );
    drop(fresh);
    let after_upgrade = std::fs::read(&path).expect("read upgraded file");

    // The stale handle now runs the ladder. It must see the CURRENT
    // schema and do nothing — not step from its cached v5.
    assert!(
        !migrate_store(&mut stale, &sig()).expect("stale migrate is a no-op"),
        "a handle whose cached schema is stale must read the store, not itself"
    );
    drop(stale);
    assert_eq!(
        std::fs::read(&path).expect("reread"),
        after_upgrade,
        "the stale handle wrote nothing"
    );

    // And the file is still a working store at the current schema.
    let mut store = FileStore::open(&path).expect("reopen");
    assert_eq!(
        store.manifest().expect("manifest").store_schema,
        STORE_SCHEMA_VERSION
    );
    validate_store(&store, &sig()).expect("still validates");
    assert_resumes_and_reads(&mut store);
}

/// Review wave 5: an old-but-decodable store is not corrupt, and the
/// export path must not say it is. `store_to_image` recomputes the root
/// with the CURRENT formula, so a v5 store failed the root check and
/// came back as `BaselineMismatch` — "this store is corrupt" — to
/// callers of `root_hash` and `export_to_container` who had done
/// nothing wrong. It names the real remedy now.
#[test]
fn exporting_an_unmigrated_store_names_migration_not_corruption() {
    let dir = TempDir::new("ih-migrate-export");
    let path = dir.join("store.ihstore");
    write_matching_boot_v5_fixture(&path);
    let mut store = FileStore::open(&path).expect("open v5 store");

    for label in ["store_to_image", "root_hash", "export_to_container"] {
        let err = match label {
            "store_to_image" => store_to_image(&store).err(),
            "root_hash" => root_hash(&store).err(),
            _ => export_to_container(&store).err(),
        };
        match err {
            Some(StoreError::NeedsMigration { found: 5 }) => {}
            other => panic!("{label}: expected NeedsMigration {{ found: 5 }}, got {other:?}"),
        }
    }

    // After migrating, the same calls succeed.
    assert!(migrate_store(&mut store, &sig()).expect("migrate"));
    root_hash(&store).expect("root_hash after migration");
    export_to_container(&store).expect("export after migration");
}

#[test]
fn v5_container_imports_and_round_trips_unchanged() {
    // The container is the interchange format: signature-gated machine
    // image bytes, schema-agnostic. Importing the v5-era container
    // must land directly on the current schema (import re-derives the
    // manifest), and re-exporting must reproduce the container
    // byte-for-byte — the v6 bump changed the root formula, not the
    // container format.
    let mut image = current_boot_fixture_image();
    image.version.format_version = 15;
    let container = ironhorse_snapshot::image::write_machine_unchecked(&image);
    let mut store = MemoryStore::new();
    import_from_container(&container, &sig(), &mut store)
        .expect("import synthetic v5-era container");
    let manifest = store.manifest().expect("manifest");
    assert_eq!(
        manifest.store_schema, STORE_SCHEMA_VERSION,
        "import lands on the current schema"
    );
    validate_store(&store, &sig()).expect("imported store validates");
    assert_eq!(
        export_to_container(&store).expect("export"),
        container,
        "container round-trips byte-identically across the schema bump"
    );
    assert_resumes_and_reads(&mut store);
}

/// The committed stage-1 fixture, a schema-35 store in the file store's
/// layout before schema 36, migrates in place: the file is rewritten in
/// the current layout, passes both validator levels, and resumes where it
/// stopped, and the resumed machine checkpoints into it.
///
/// The fixture's history is frozen, so a build whose boot layout or cost
/// table differs from the one that wrote it cannot migrate it: the
/// migration's signature and cost-table gates refuse before writing. The
/// deterministic-math provider is such a build, and checks that refusal
/// instead; in any other build a refusal fails the test.
#[test]
fn stage1_file_store_fixture_migrates_and_resumes() {
    let dir = TempDir::new("ih-stage1-fixture");
    let path = dir.join("heap.ihstore");
    std::fs::copy(fixture("store-v35-stage1.ihstore"), &path).unwrap();
    let before = std::fs::read(&path).unwrap();
    assert_eq!(&before[..8], b"IHSTORE5");
    let mut store = FileStore::open(&path).unwrap();
    let old = store.manifest().unwrap();
    assert_eq!(old.store_schema, 35);
    match migrate_store(&mut store, &sig()) {
        Ok(ran) => assert!(ran),
        // The fixture was written under the platform math provider, whose
        // boot layout the deterministic-math lane does not share.
        Err(StoreError::Snapshot(
            SnapshotError::BootLayoutMismatch { .. } | SnapshotError::CostTableMismatch { .. },
        )) if ironhorse_vm::MATH_PROVIDER != "platform" => {
            assert_eq!(std::fs::read(&path).unwrap(), before);
            return;
        }
        Err(other) => panic!("the fixture must migrate: {other:?}"),
    }
    assert_eq!(&std::fs::read(&path).unwrap()[..8], b"IHSTORE6");
    let migrated = store.manifest().unwrap();
    assert_eq!(
        migrated,
        StoreManifest {
            store_schema: STORE_SCHEMA_VERSION,
            ..old
        },
        "the token is the stored seal's first half; nothing else moves"
    );
    validate_store(&store, &sig()).expect("metadata-scale validation");
    validate_store_content(&store, &sig()).expect("full validation");
    let mut session = resume_from_store(&store, &sig()).expect("the fixture resumes");
    assert_eq!((session.epoch(), session.token()), (4, migrated.token));
    let (code, symbols) = ironhorse_compile::compile_atoms(STAGE1_PROBE.0).unwrap();
    let code = session
        .machine_mut()
        .relink_crank(&code, &ironhorse_vm::parse_symbols(&symbols))
        .unwrap();
    let o = session.machine_mut().run(&code);
    assert!(o.completed, "{:?}", o.halt);
    assert_eq!(o.result, STAGE1_PROBE.1);
    assert_eq!(
        checkpoint_to_store(&mut session, &sig(), &mut store).expect("checkpoints"),
        5
    );
    validate_store_content(&store, &sig()).expect("validates after the checkpoint");
}

/// The stage-1 fixture's history, written fresh on every run at the current
/// schema: a lazy resume, the first checkpoint after it, a full collection
/// and incremental checkpoints each leave a store that passes the full
/// validator.
#[test]
fn stage1_history_writes_valid_stores() {
    let dir = TempDir::new("ih-stage1-history");
    let path = dir.join("heap.ihstore");
    write_stage1_file_store(&path);
    validate_store_content(&FileStore::open(&path).unwrap(), &sig()).expect("validates");
}
