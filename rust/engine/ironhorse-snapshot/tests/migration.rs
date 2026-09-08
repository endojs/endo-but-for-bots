//! Schema migration under the current boot identity, plus refusal of frozen
//! historical fixtures that lack a mechanically derived boot fingerprint.
//! Matching-boot v5 stores are synthesized below without changing the frozen
//! artifacts: layout migration must never authorize foreign boot metadata.

mod common;
mod migration_fixtures;

use common::TempDir;
use migration_fixtures::{FIXTURE_CRANKS, FIXTURE_RESULTS};

use ironhorse_snapshot::machine::{checkpoint_to_store, resume_from_store};
use ironhorse_snapshot::store::{
    export_to_container, import_from_container, migrate_store, root_hash, store_to_image,
    validate_store, HeapStore, MemoryStore, StoreError, STORE_SCHEMA_VERSION,
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

fn write_matching_boot_v5_fixture(path: &std::path::Path) {
    use ironhorse_snapshot::store::{
        combine_root, image_to_batch_unchecked, leaf_hash, LEAF_SMALL,
    };
    let image = current_boot_fixture_image();
    let mut store = FileStore::open(path).unwrap();
    store
        .commit(&image_to_batch_unchecked(&image, 1, ""))
        .unwrap();
    let mut manifest = store.manifest().unwrap();
    let mut small = store.read_small_state().unwrap();
    // Schema 5 contains the original six sections. All later fixture state
    // is boot-derived or empty, so the ladder may append empty new tables.
    let mut end = 0;
    for _ in 0..6 {
        let len = u32::from_be_bytes(small[end..end + 4].try_into().unwrap()) as usize;
        end += 4 + len;
    }
    small.truncate(end);
    manifest.store_schema = 5;
    manifest.cranks = 0;
    let (pages, exts) = store.leaf_hashes().unwrap();
    manifest.root = combine_root(
        &leaf_hash(LEAF_SMALL, 0, &small),
        &pages,
        &exts,
        &store.free_leaf_hashes().unwrap(),
        &store.page_edges().unwrap(),
    );
    store
        .replace_manifest_and_small_for_migration(&manifest, &small)
        .unwrap();
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
    validate_store(&store, &sig()).expect("migrated store recombines to its v6 root");
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
    fn leaf_hashes(&self) -> Result<(Vec<[u8; 32]>, Vec<[u8; 32]>), StoreError> {
        self.0.leaf_hashes()
    }
    fn read_free_seg(&self, seg: u32) -> Result<Vec<u8>, StoreError> {
        self.0.read_free_seg(seg)
    }
    fn free_leaf_hashes(&self) -> Result<Vec<[u8; 32]>, StoreError> {
        self.0.free_leaf_hashes()
    }
    fn page_edges(&self) -> Result<Vec<Vec<u32>>, StoreError> {
        self.0.page_edges()
    }
    fn commit(
        &mut self,
        _batch: &ironhorse_snapshot::store::CheckpointBatch,
    ) -> Result<(), StoreError> {
        panic!("migration must not commit to a store it cannot resume");
    }
    fn replace_manifest_for_migration(
        &mut self,
        _manifest: &ironhorse_snapshot::store::StoreManifest,
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
fn v5_splice_refuses_an_externally_truncated_file() {
    // Review wave 4, F6: the v5→v6 splice re-reads the durable file
    // while the ladder verified the CACHED view loaded at open. A file
    // truncated in that window must fail closed on the header's own
    // length claim, not panic on the slice. (The 6→7 step already
    // bounds every offset it reads.)
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

    // Since the ladder re-reads the manifest DURABLY before each step
    // (review wave 5, the stale-splice window), the truncation is now
    // caught at that read and names the block it could not decode,
    // rather than at the splice's own length check further in. Either
    // is a named fail-closed refusal, which is the property; the
    // splice's check stays as the backstop for a truncation landing
    // inside the step itself, after the ladder has read.
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

/// A store whose migration writes report success WITHOUT persisting —
/// the out-of-tree backend bug the ladder's progress guard exists for.
/// Everything else delegates to a real v5 `FileStore`, so the ladder
/// takes its genuine first step and only the write is a lie.
struct NoOpMigrationStore(FileStore);

impl HeapStore for NoOpMigrationStore {
    fn manifest(&self) -> Result<ironhorse_snapshot::store::StoreManifest, StoreError> {
        self.0.manifest()
    }
    fn read_small_state(&self) -> Result<Vec<u8>, StoreError> {
        self.0.read_small_state()
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
    fn leaf_hashes(&self) -> Result<(Vec<[u8; 32]>, Vec<[u8; 32]>), StoreError> {
        self.0.leaf_hashes()
    }
    fn read_free_seg(&self, seg: u32) -> Result<Vec<u8>, StoreError> {
        self.0.read_free_seg(seg)
    }
    fn free_leaf_hashes(&self) -> Result<Vec<[u8; 32]>, StoreError> {
        self.0.free_leaf_hashes()
    }
    fn page_edges(&self) -> Result<Vec<Vec<u32>>, StoreError> {
        self.0.page_edges()
    }
    fn commit(
        &mut self,
        batch: &ironhorse_snapshot::store::CheckpointBatch,
    ) -> Result<(), StoreError> {
        self.0.commit(batch)
    }
    // The lie: reports success, persists nothing.
    fn replace_manifest_for_migration(
        &mut self,
        _manifest: &ironhorse_snapshot::store::StoreManifest,
    ) -> Result<(), StoreError> {
        Ok(())
    }
}

#[test]
fn ladder_refuses_a_backend_that_does_not_advance() {
    // Review wave 4, F5: without the progress guard this spins forever
    // (read schema 5, "migrate", read schema 5, …). With it, the second
    // sighting of the same schema fails closed.
    let dir = TempDir::new("ih-migrate-noprogress");
    let path = dir.join("store.ihstore");
    write_matching_boot_v5_fixture(&path);

    // Run under an explicit deadline. AGENTS.md requires one on any test
    // guarding a deadlock or hang, and this is exactly that: WITHOUT the
    // guard the ladder spins forever, so the regression signal would be
    // an unattributed CI job timeout rather than a named failure (review
    // wave 5). With the deadline the bite-check reports the hang as this
    // test, by name, in seconds.
    let (tx, rx) = std::sync::mpsc::channel();
    let probe = std::thread::spawn(move || {
        let mut store = NoOpMigrationStore(FileStore::open(&path).expect("open v5 store"));
        let r = migrate_store(&mut store, &sig());
        // Render inside the thread: StoreError is not Send-friendly to
        // move across as-is, and the string is all the assertion needs.
        let _ = tx.send(match r {
            Err(StoreError::Snapshot(SnapshotError::Corrupt(msg))) => Ok(msg.to_string()),
            other => Err(format!("{other:?}")),
        });
    });
    match rx.recv_timeout(std::time::Duration::from_secs(20)) {
        Ok(Ok(msg)) => {
            assert!(msg.contains("advance"), "named failure: {msg}");
            probe.join().expect("probe thread");
        }
        Ok(Err(other)) => panic!("expected a no-progress refusal, got {other}"),
        Err(_) => panic!(
            "the ladder did not terminate within 20s — the progress guard \
             is gone and migrate_store is spinning"
        ),
    }
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

/// A store whose reported schema CYCLES rather than advancing — the
/// second shape of the same backend bug `NoOpMigrationStore` models.
/// Writes really happen; only the reported schema lies, alternating
/// 5, 6, 5, 6, ...
struct CyclingMigrationStore {
    inner: FileStore,
    reads: std::cell::Cell<u32>,
}

impl CyclingMigrationStore {
    fn cycled(&self) -> Result<ironhorse_snapshot::store::StoreManifest, StoreError> {
        let mut m = self.inner.manifest()?;
        let n = self.reads.get();
        self.reads.set(n + 1);
        m.store_schema = if n % 2 == 0 { 5 } else { 6 };
        Ok(m)
    }
}

impl HeapStore for CyclingMigrationStore {
    // Only the LADDER's read lies. The steps read `manifest()` and see
    // the truth, so each one migrates real content correctly and the
    // test isolates the guard rather than tripping a root check.
    fn manifest(&self) -> Result<ironhorse_snapshot::store::StoreManifest, StoreError> {
        self.inner.manifest()
    }
    fn reread_manifest(&self) -> Result<ironhorse_snapshot::store::StoreManifest, StoreError> {
        self.cycled()
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
    fn leaf_hashes(&self) -> Result<(Vec<[u8; 32]>, Vec<[u8; 32]>), StoreError> {
        self.inner.leaf_hashes()
    }
    fn read_free_seg(&self, seg: u32) -> Result<Vec<u8>, StoreError> {
        self.inner.read_free_seg(seg)
    }
    fn free_leaf_hashes(&self) -> Result<Vec<[u8; 32]>, StoreError> {
        self.inner.free_leaf_hashes()
    }
    fn page_edges(&self) -> Result<Vec<Vec<u32>>, StoreError> {
        self.inner.page_edges()
    }
    fn commit(
        &mut self,
        batch: &ironhorse_snapshot::store::CheckpointBatch,
    ) -> Result<(), StoreError> {
        self.inner.commit(batch)
    }
    fn replace_manifest_for_migration(
        &mut self,
        manifest: &ironhorse_snapshot::store::StoreManifest,
    ) -> Result<(), StoreError> {
        self.inner.replace_manifest_for_migration(manifest)
    }
    fn replace_manifest_and_small_for_migration(
        &mut self,
        manifest: &ironhorse_snapshot::store::StoreManifest,
        small: &[u8],
    ) -> Result<(), StoreError> {
        self.inner
            .replace_manifest_and_small_for_migration(manifest, small)
    }
}

#[test]
fn ladder_refuses_a_backend_whose_schema_cycles() {
    // Review wave 5: the wave-4 progress guard compared each schema
    // only against the IMMEDIATELY previous one, so a backend reporting
    // 5, 6, 5, 6, ... never repeated consecutively and spun forever.
    // Requiring a STRICT advance closes both shapes with one comparison
    // and bounds the loop by the schema range.
    //
    // Under a deadline for the same reason as the no-progress test: the
    // regression is a hang, and a hang must fail by name.
    let dir = TempDir::new("ih-migrate-cycle");
    let path = dir.join("store.ihstore");
    write_matching_boot_v5_fixture(&path);

    let (tx, rx) = std::sync::mpsc::channel();
    let probe = std::thread::spawn(move || {
        let mut store = CyclingMigrationStore {
            inner: FileStore::open(&path).expect("open v5 store"),
            reads: std::cell::Cell::new(0),
        };
        let r = migrate_store(&mut store, &sig());
        let _ = tx.send(match r {
            Err(StoreError::Snapshot(SnapshotError::Corrupt(msg))) => Ok(msg.to_string()),
            other => Err(format!("{other:?}")),
        });
    });
    match rx.recv_timeout(std::time::Duration::from_secs(20)) {
        Ok(Ok(msg)) => {
            assert!(msg.contains("advance"), "named failure: {msg}");
            probe.join().expect("probe thread");
        }
        Ok(Err(other)) => panic!("expected a no-advance refusal, got {other}"),
        Err(_) => panic!(
            "the ladder did not terminate within 20s — the progress guard \
             still only compares against the previous schema"
        ),
    }
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
