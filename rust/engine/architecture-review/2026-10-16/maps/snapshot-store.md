# Map: Heap stores and checkpoints

Reviewed commit `61cd656cb`.

## Scope

| File | Lines |
|---|---|
| `rust/engine/ironhorse-snapshot/src/store.rs` | 5048 (1-2899 code, 2900-5048 unit tests) |
| `rust/engine/ironhorse-snapshot/src/store_file.rs` | 1465 (1-719 code, 720-1465 tests) |
| `rust/engine/ironhorse-snapshot/src/store_sections.rs` | 637 |
| `rust/engine/ironhorse-snapshot/src/stored_slots.rs` | 720 |
| `rust/engine/ironhorse-snapshot/src/store_suite.rs` | 1292 |
| `rust/engine/ironhorse-snapshot/src/machine.rs` | 3196 (1-1810 code, 1811-2985 tests, 2986-3196 shared sessions) |
| `rust/engine/ironhorse-snapshot/src/test_dir.rs` | 37 |
| `rust/endo/ironhorse-store-sqlite/src/lib.rs` | 2323 (1-1265 code, 1266-2323 tests) |
| `rust/endo/ironhorse-store-sqlite/tests/*.rs` | 3,630 across 10 files (store_suite 121, engine_lifecycle 1626, query_gc 504, row_corruption 417, migration_fixtures 307, store_bench 299, migration 186, writer_exclusion 80, semantic_migration 52, common 38) |
| `rust/endo/ironhorse-store-sqlite/examples/vat_surgery*` + `VAT_SURGERY.md` | 1,079 + 131 |
| `rust/engine/ironhorse-snapshot/tests/` (store/checkpoint subset skimmed) | e.g. store_checkpoint 1301, store_hardening 1008, migration 609, checkpoint_scaling_bench 73 |

## What was read

- `store.rs` 1-2899: full read (error taxonomy and `classify`, `StoreManifest` encode/decode, `CommitToken`/`RandomTokens`/`mint_token`, geometry helpers, `derive_page_edges`, `bfs_pages`, free segments, `check_batch`, `SmallState` macros, `CheckpointBatch`, `HeapStoreCommit`/`HeapStore` trait with all default bodies, `migrate_store`/`migrate_step`/`LADDER`/`names_to_cesu8`, `check_succession`/`check_epoch`, image↔batch encoders, `check_open_gates`, `open_store`/`open_state`, `store_to_image_at`, `validate_store`/`validate_state`/`validate_store_content`, import/export/`root_hash`, `MemoryStore`). Unit tests 2900-5048: targeted (name-migration and legacy-section tests at 4440-4552).
- `store_file.rs`: full read, code and tests.
- `store_sections.rs`: full read.
- `stored_slots.rs`: full read.
- `machine.rs` 1-1810 (blob/CAS verbs, `LazyPin`, `StoreFault`, `StoreSession`/`StoreTracking`, `begin_store_core`, `checkpoint_to_store_core`, `changed_free_segs`, eager and lazy resume, `StorePageSource`, the three collectors) and 2986-3196 (`SharedStoreSession` and shared resume): full read.
- `store_suite.rs`: 1-330 and 800-980 read; function inventory and backend-instantiation matrix grep-driven.
- `test_dir.rs`: full read.
- SQLite `lib.rs` 1-1500: full read; 1500-2323 test names only.
- SQLite `tests/store_suite.rs`, `tests/writer_exclusion.rs`: full read; `tests/row_corruption.rs` 60-190 read; `tests/store_bench.rs` header read; `VAT_SURGERY.md` read.
- Neighbours read to answer region questions: `ironhorse-vm/src/value.rs` (lazy arena: 300-372, 880-1120, 1540-1700, 1790-1800, 2160-2182), `ironhorse-vm/src/snapshot_dirty.rs` 1-140, `ironhorse-vm/src/interp/persist.rs` 540-830 and 4530-4643, `ironhorse-vm/src/interp/gc.rs` (whole file), `rust/endo/src/ironhorse_engine.rs` 900-930 and 1060-1820 (the daemon's `PersistentMachine` open/eval/collect/flush), `rust/thixotrope-ironhorse-worker/src/main.rs` 240-340.
- For the ontology lens: `ironhorse-snapshot/src/format.rs` (`Version::decode`, 299-345) and `tests/store_failure_classes.rs` 90-190 (the class rules), plus a grep of every `StoreError::Io(` construction site in the SQLite backend.
- Engine tests skimmed: `tests/migration.rs` (30-140, 500-609), `tests/checkpoint_scaling_bench.rs`, `tests/store_checkpoint.rs` head, `tests/shared_machine.rs` 1-80 and 340-407, function lists of `store_hardening.rs`.

## What was not read

- `store.rs` unit tests 2900-4440 and 4553-5048 beyond grep hits.
- `machine.rs` tests 1811-2985.
- `store_suite.rs` 330-800 and 980-1292 (metamorphic body, boundary-collection twins, `commit_contract` body, `consistent_edits_resume`, `sparse_section_acceptance`) only skimmed by name.
- SQLite `lib.rs` tests 1500-2323; `tests/engine_lifecycle.rs`, `tests/query_gc.rs`, `tests/migration_fixtures.rs`, `tests/semantic_migration.rs` bodies; the `vat_surgery` example code.
- `snapshot_roster.rs` (the payload roster macro that generates section codecs), `image.rs` codecs, `sidetable.rs`: outside the region, so the per-section encoders and the `canonical_payload` used by commit validation were taken as black boxes.
- Whether every VM mutation of a snapshot-tracked side table goes through `Tracked::deref_mut` (interior mutability could bypass section dirt on the standalone path): not verified; the metamorphic suite is the only guard.
- No SQLite-side probe was run (the outer workspace was not built); SQLite cost claims are static.

## Architecture as built

**Logical image, two containers.**
A store holds the same logical machine as an `XS_M` container, split into rows: slot pages of `SLOTS_PER_PAGE = 256` records × 20 bytes = 5,120 bytes (`ironhorse-vm/src/value.rs:168`), chunk extents of `CHUNK_EXTENT_BYTES = 64 KiB` (`value.rs:172`), free-list segments of 4,096 big-endian u32s (`store.rs:998`), one page-edge summary per slot page (`store.rs:941`), 34 small-state sections (stack, meter, names, and every side table; `store_sections.rs:17-46`), and a manifest (`store.rs:437-495`) carrying version, schema 38, signature, creation params, geometry (`slot_count`, `slot_live`, `chunk_len`, `free_len`), epoch, durable crank and collection counters, cadence and a 16-byte random `CommitToken`.
`export_to_container`/`import_from_container` (`store.rs:2597-2643`) hold the two containers byte-identical.

**Trait.**
`HeapStore` (`store.rs:1449-1616`) is point reads by index (`read_slot_page`, `read_chunk_extent`, `read_free_seg`), metadata reads (`manifest`, `inventory`, `page_edges`, `small_section_hashes`), plus `commit_verified(verify)`.
`HeapStoreCommit::commit` (`store.rs:1422-1437`) is a blanket impl: the backend supplies its current manifest under its own isolation and receives the batch only through `VerifiedCommit`, after `check_succession` (epoch +1, `prev_token` equality, non-zero fresh token, schema, counter monotonicity, canonical section payloads via `store_sections::validate_batch`) and `check_batch` (row indices inside geometry, grown rows present, boundary rows present when a tail length changes, exact row lengths, summaries travel exactly with page rows, debug-only summary re-derivation).
The trust model (`store.rs:31-46`) is explicit: content is trusted; validators (`validate_store`, `validate_store_content`) are on-request only; open runs compatibility gates (`check_open_gates`, `store.rs:2117-2159`), accounting and tail-row checks.

**Backends.**
- `MemoryStore` (`store.rs:2700-2898`): `HashMap<u32, Vec<u8>>` per row class, `Vec<Vec<u32>>` edges, 34 section `Vec<u8>`s plus 34×32-byte digests. Reference semantics.
- `FileStore` (`store_file.rs`): one file, layout magic `IHSTORE6`. Open decodes header, directories (12 bytes/row, held as 16-byte `DirEntry`), all edge summaries and all free segments into a resident `Loaded` (`store_file.rs:107-114`) and keeps the `File` for seek-and-read point reads. Commit (`store_file.rs:625-718`) reloads the durable header, merges dirty rows over `Row::Prior` directory entries, writes a complete new file to an exclusively created temp, `sync_all`, `rename`, directory `sync_all`, then reloads (`store_file.rs:258-326`). Commit I/O is O(store) by design. Single writer is documented, not enforced (`store_file.rs:18-23`).
- `SqliteHeapStore` (`rust/endo/ironhorse-store-sqlite/src/lib.rs`): tables `meta`, `slot_pages`, `chunk_exts`, `small_state` (pre-28 only), `small_sections(id, bytes, hash)`, `page_edges`, `free_segs`, `edge_pairs(target, page)` WITHOUT ROWID plus index on `page`, and an unused `side_tables` (`lib.rs:402-461`). Open: read-only refusal, `application_id = 'IRON'` foreign-database gate, `busy_timeout 5s`, `locking_mode=EXCLUSIVE` (verified by read-back), `journal_mode=WAL`, an empty `BEGIN IMMEDIATE; COMMIT` to take the exclusive lock at open, `wal_autocheckpoint=1000`, `synchronous=FULL` (verified), DDL, then rebuild of `edge_pairs` only when `meta.edge_pairs_epoch` is stale (`lib.rs:287-496`). Commit is one IMMEDIATE transaction: upsert dirty rows, delete rows past the new geometry, upsert summaries and re-derive their `edge_pairs`, write the epoch marker, write changed sections with a fresh digest, write the manifest (`lib.rs:1106-1264`). Each point read first re-reads and decodes the manifest for the empty-store gate (`lib.rs:972-1004`).

**Crash consistency.**
SQLite: WAL + `synchronous=FULL` + one transaction per commit and per migration; the manifest and the rows commit together. FileStore: whole-file temp + fsync + rename + directory fsync. Neither backend checksums row content (trust model). Torn files are caught structurally at open (directory ranges, magic, geometry/directory agreement, `store_file.rs:364-508`); SQLite page damage surfaces as `DatabaseCorrupt`, mapped to `Corrupt` (`lib.rs:53-63`).

**Session and checkpoint.**
A `StoreSession` owns an `Interp` plus `StoreTracking` (`machine.rs:705-766`): epoch, token, token source, optional `LazyPin`, `BackingCommitAuthority`, `gen_dirty: BTreeSet<u32>`, 34 section digests, the free-list acknowledgement, durable crank and collection counters.
`begin_store_core` (`machine.rs:933-1026`) builds a gated full `MachineImage` and a full batch.
`checkpoint_to_store_core` (`machine.rs:1046-1243`): quiescence, the checkpoint persist gate (`Interp::stored_unpersistable_row_at_checkpoint`), epoch/token pairing against the stored manifest, then: dirty slot pages (copied, encoded, edge summary derived per page), dirty chunk extents, small-state sections selected by `Interp::snapshot_dirty_sections` and then filtered by digest change, free segments from the low-water mark (`changed_free_segs`, `machine.rs:1251-1275`). After a successful commit the dirty bits, snapshot baseline and free-list acknowledgement advance; a commit that landed in the pinned lazy backing advances the backing geometry so the rows become evictable.
`SharedStoreSession` (`machine.rs:2990-3067`) wraps an `ironhorse_vm::Machine` and calls the same core through `with_persistence`. This is the path the daemon's `PersistentMachine` uses (`rust/endo/src/ironhorse_engine.rs:1124-1339`), with `checkpoint_every: 1` by default (`ironhorse_engine.rs:922-929`).

**Lazy restore.**
`resume_from_store_lazy` (`machine.rs:1434-1532`) reads manifest, small state and free list (`store::open_store`), builds lazy arenas over `StorePageSource` (`machine.rs:1345-1412`) and restores side tables eagerly. A fault calls `HeapStore::read_slot_page`; a read error unwinds as `StoreFault` via `resume_unwind`, caught by `catch_store_fault`. Row-content problems (decode failure, wrong length, out-of-arena or free-slot references) are plain `panic!`/`assert!` in `StorePageSource::slot_page` and in the VM's `SlotBacking::validate_records` (`value.rs:313-372`). Residency is grow-only in production; `evict_page`/`evict_extent` are called only by the store suite.

**Collectors.**
`full_collect` delegates to the VM's mark-sweep (`collect_garbage`), the only collector production uses.
`partial_collect` and `generational_collect` (`machine.rs:1625-1809`) decide reachability from the stored page-edge summaries (`each_ref_slot` edges: `next` + `Payload::Reference`) with every side-table value as a page root, so they are page-granular over-approximations of the full collector, not a second copy of it. Both are reached only from tests and benches; the generational one is documented as not resume-invariant (`machine.rs:1719-1734`).

**Migration.**
`migrate_store` (`store.rs:1679-1741`) reads the durable manifest, gates on boot fingerprint, signature compatibility and cost-table version, walks `migrate_step` in memory over manifest and framed small state (rows never change), validates the result with `validate_state`, and writes once through `replace_for_migration` (compare-and-swap on the durable manifest). The ladder: 5→6 no-op, 6→7..24→25 append empty frames (`LADDER`, `store.rs:1811-1830`), 7→8 crank counter, 25→26 UTF-8→CESU-8 names, 26→27 one canonicalization through the current decoders, 27..35 identity, 35→36 drops root/seal/leaves, 36→37 appends two canonical empty weak sections, 37→38 identity.

**Store suite.**
`store_suite.rs` is compiled under the `store-suite` feature and instantiated for Memory, File and SQLite (in-memory and on-disk) stores and the wasm `DoStore`; every function drives a standalone `Interp`, never the shared `Machine`.

## Candidate findings

### SNS-1. On the daemon's shared-Machine path every checkpoint extracts, encodes and SHA-256-hashes the entire small state

- **Lens(es):** 4.
- **Proposed severity:** medium.
- **Location:** `rust/engine/ironhorse-vm/src/interp/persist.rs:4545-4551`; consumed at `rust/engine/ironhorse-snapshot/src/machine.rs:1161-1176` via `SharedStoreSession::checkpoint`, `machine.rs:3038-3048`.
- **Excerpt:**
  ```rust
  pub fn snapshot_dirty_sections(&self, baseline: &crate::SnapshotBaseline) -> crate::SnapshotDirty {
      if self.shared_compartments {
          return crate::SnapshotDirty::all();
      }
  ```
  ```rust
  let dirty = interp.snapshot_dirty_sections(&tracking.snapshot_baseline);
  let small = small_state_of(interp, dirty);
  ... .filter(|section| dirty.contains(section.vm_section()))
      .filter_map(|section| { let bytes = small.encode_section(section);
          let digest = crate::store_sections::section_hash(section, &bytes); ...
  ```
- **Mechanism:** every `ironhorse_vm::Machine` sets `shared_compartments = true`: `Machine::new`/`with_start_global_names` (`ironhorse-vm/src/compartment.rs:893-923`) build through `new_shared_realm_machine_configured`, which sets it at `interp/realm.rs:854`, and a shared restore sets it again at `interp/shared_persist.rs:512`. For such machines the section dirt tracker is bypassed and all 34 sections count as dirty. `small_state_of` then copies every side table out of the VM, `encode_section` serializes each, and `section_hash` SHA-256s each, only to discover by digest comparison that nothing changed. Sparse writes still avoid I/O, so the waste is pure CPU proportional to the whole small state (array items, Map entries, function records, promises), paid on every checkpoint.
- **Scenario:** a daemon worker (`PersistentMachine`, default `checkpoint_every: 1`) holding a 100k-element array runs a `1+1` crank. The checkpoint writes zero sections yet re-encodes and hashes 2.4 MB of small state. The standalone `Interp` path does the same no-op in 0.29 ms (release).
- **Evidence:** probe `zz_audit_snapshot-store_2.rs` (source below), shared `Machine` + `begin_shared_store_session` + `MemoryStore`, median of three `1+1` checkpoints, debug build:
  ```
  SHARED ARRAY n=1000   noop checkpoint median=0.013611s sections_written=0 small_bytes_written=0 small_state_total=41385
  SHARED ARRAY n=10000  noop checkpoint median=0.038479s sections_written=0 small_bytes_written=0 small_state_total=257385
  SHARED ARRAY n=100000 noop checkpoint median=0.310390s sections_written=0 small_bytes_written=0 small_state_total=2417385
  SHARED FUNCS n=1000   noop checkpoint median=0.029705s sections_written=0 small_state_total=81506
  SHARED FUNCS n=10000  noop checkpoint median=0.224349s sections_written=0 small_state_total=657506
  ```
  The same 100k-array heap on the standalone path (probe 1, `ARRAYS n=100000 noop`) checkpoints in 0.0066 s, 47× less. In release (block under SNS-2) the shared no-op is 18.1 ms against 0.29 ms standalone (62×), linear in the small-state size, on every crank.
  None of `store_suite.rs` uses `Machine`/`SharedStoreSession` (`grep -n "begin_shared_store_session\|Machine::new" store_suite.rs` finds nothing), so the backend suite and `checkpoint_scaling_bench.rs` (standalone `Interp`, `MemoryStore`) cannot see this.
- **Recommendation:** track dirt for the shared state that motivated the bypass (environments, realm roots, jobs live in the `Functions` and `Promises` sections) and mark only those sections dirty on shared machines instead of `all()`. Add a shared-Machine arm to `store_suite::checkpoint_acceptance` and to `checkpoint_scaling_bench.rs` so the no-op cost is locked on the production path.
- **Confidence:** confirmed by probe.

### SNS-2. Bulk side tables are one section each, so a one-element change rewrites the whole table (O(section) per checkpoint, not O(dirty))

- **Lens(es):** 4.
- **Proposed severity:** medium.
- **Location:** section-granular dirt `rust/engine/ironhorse-vm/src/snapshot_dirty.rs:67-146` (`Tracked::deref_mut` at `:141-146` and `update` mark one bit per table); selection `rust/engine/ironhorse-snapshot/src/machine.rs:1161-1176`; commit-time canonical re-decode `rust/engine/ironhorse-snapshot/src/store_sections.rs:206-233`; second digest in the SQLite backend `rust/endo/ironhorse-store-sqlite/src/lib.rs:207-225`.
- **Excerpt:**
  ```rust
  impl<T> DerefMut for Tracked<T> {
      fn deref_mut(&mut self) -> &mut T {
          self.dirt.mark(self.mask);   // one bit for the whole table
          &mut self.value
      }
  }
  ```
  ```rust
  fn validate_payload(section: SmallSection, bytes: &[u8]) -> Result<(), StoreError> {
      let decoded = crate::snapshot_roster::canonical_payload(section, bytes);
      if decoded.map_err(StoreError::Snapshot)? != bytes { ... }
  ```
- **Mechanism:** slot pages and chunk extents are dirty-tracked per row, but the side tables that hold most JS data (all arrays' items, all Map/Set entries, all function records, index properties) are each a single small-state section with a single dirty bit. Touching any one array re-extracts and re-encodes every array; the session hashes it, the commit gate decodes and re-encodes it for the canonicality check (`validate_batch`), the SQLite backend hashes it again (`write_section_updates`), and the whole payload is written. The design comment already concedes "the 32 small-state sections include BULK side tables, so they need not be small" (`store.rs:26-28`); the SQLite schema even reserves a per-row `side_tables(name, key, bytes)` table that nothing writes (SNS-10).
- **Scenario:** a heap with one 100k-element array and one 1-element array; a crank does `small[0]++`. The checkpoint writes 2.4 MB. A heap with 100k closures; a crank creates one throwaway closure: 5.6 MB written. Under `checkpoint_every: 1` this is per crank.
- **Evidence:** probe `zz_audit_snapshot-store_1.rs` (standalone `Interp`, `MemoryStore`, `CommitStats`), debug build:
  ```
  ARRAYS n=1000   small[0]++: 0.009946s sections=2 small_bytes=24129   pages=0 exts=0
  ARRAYS n=10000  small[0]++: 0.030276s sections=2 small_bytes=240129  pages=0 exts=0
  ARRAYS n=100000 small[0]++: 0.372529s sections=2 small_bytes=2400129 pages=0 exts=0
  FUNCS  n=1000   new closure: 0.017907s sections=2 small_bytes=61883   pages=1
  FUNCS  n=10000  new closure: 0.214372s sections=2 small_bytes=565883  pages=1
  FUNCS  n=100000 new closure: 1.428759s sections=2 small_bytes=5605885 pages=1
  MAPS   n=1000   sm.set: 0.007156s sections=2 small_bytes=40147
  MAPS   n=10000  sm.set: 0.096676s sections=2 small_bytes=400147
  MAPS   n=100000 sm.set: 0.633419s sections=2 small_bytes=4000147
  ```
  That is 24 bytes per array item, 56 bytes per function record and 40 bytes per Map entry rewritten for an O(1) change; the touched slot pages (0 or 1) are negligible beside it. `checkpoint_scaling_bench.rs` only measures unchanged arrays after `1 + 1`, which is the case that does not regress.
  Release build (`cargo test --release`, same probes), which gives the magnitudes cited in SNS-1 to SNS-3:
  ```
  ARRAYS n=1000   noop: 0.000393s | small[0]++: 0.000808s small_bytes=24129
  ARRAYS n=10000  noop: 0.000259s | small[0]++: 0.007219s small_bytes=240129
  ARRAYS n=100000 noop: 0.000288s | small[0]++: 0.049079s small_bytes=2400129
  FUNCS  n=1000   noop: 0.000567s | new closure: 0.010409s small_bytes=61883
  FUNCS  n=10000  noop: 0.004994s | new closure: 0.038148s small_bytes=565883
  FUNCS  n=100000 noop: 0.005998s | new closure: 0.288771s small_bytes=5605885
  MAPS   n=100000 sm.set: 0.067523s small_bytes=4000147
  SHARED ARRAY n=1000   noop checkpoint median=0.000458s sections_written=0 small_state_total=41385
  SHARED ARRAY n=10000  noop checkpoint median=0.001584s sections_written=0 small_state_total=257385
  SHARED ARRAY n=100000 noop checkpoint median=0.018100s sections_written=0 small_state_total=2417385
  SHARED FUNCS n=1000   noop checkpoint median=0.001047s sections_written=0 small_state_total=81506
  SHARED FUNCS n=10000  noop checkpoint median=0.009872s sections_written=0 small_state_total=657506
  GATE n=1000   stored_unpersistable_row_at_checkpoint median=0.000073s
  GATE n=10000  stored_unpersistable_row_at_checkpoint median=0.000373s
  GATE n=100000 stored_unpersistable_row_at_checkpoint median=0.006605s
  ```
  In release, one `small[0]++` against a 100k-item array costs 49 ms against a 0.29 ms no-op (170×). One throwaway closure in a 100k-closure heap costs 289 ms.
- **Recommendation:** dirty-track bulk tables per owner (a dirty-owner set beside the section bit, as the slot arena already does per page) and store them as owner-keyed rows or fixed-size segments, the way free-list segments already work (`store.rs:994-1031`); the unused SQLite `side_tables` table is the obvious home. Until then, skip the commit-time `canonical_payload` re-decode for batches built by `checkpoint_to_store_core` (the producer is the engine), and pass the digest the session already computed to the backend instead of re-hashing.
- **Confidence:** confirmed by probe.

### SNS-3. The checkpoint persist gate is O(functions + promise reactions) on every checkpoint, whatever changed

- **Lens(es):** 4, 6 (the doc premise that justifies it is stale; see Ontology notes).
- **Proposed severity:** medium.
- **Location:** `rust/engine/ironhorse-vm/src/interp/persist.rs:688-723` and `:810-816`, called from `rust/engine/ironhorse-snapshot/src/machine.rs:1084`.
- **Excerpt:**
  ```rust
  let async_reaction = self.promises.values().flat_map(|p| p.reactions.iter()) ... .any(...);
  ...
  let doomed = self.non_persisting_functions();   // self.functions.keys().filter(|f| !self.function_persists(**f))
  ```
- **Mechanism:** the doc comment says the checkpoint form keeps "the per-crank cost O(dirty)" (`persist.rs:561-576`), and the heap walk is dirty-pages-only, but before it the gate scans every promise reaction and classifies every entry of `functions` (up to six SipHash lookups per function in `function_persists`, `persist.rs:773-805`), building a `BTreeSet`. That term is paid by every checkpoint.
- **Scenario:** a worker holding 100k closures pays this scan on every crank even when the crank touched nothing.
- **Evidence:** probe `zz_audit_snapshot-store_3.rs` timing `Interp::stored_unpersistable_row_at_checkpoint()` directly, debug build:
  ```
  GATE n=1000   median=0.000766s
  GATE n=10000  median=0.009639s
  GATE n=100000 median=0.074859s
  ```
  It accounts for the scaling of the standalone no-op checkpoint in probe 1 (`FUNCS n=… noop`: 0.0032 s, 0.0141 s, 0.0626 s). In release the gate takes 6.6 ms at 100k closures, essentially the whole 6.0 ms no-op checkpoint for that heap (block under SNS-2), so on function-heavy heaps it is the per-crank floor.
- **Recommendation:** maintain the doomed set incrementally (functions become non-persisting only at creation), so the gate is O(1) when the set is empty; track "has a non-carried reaction kind" as a counter at reaction creation.
- **Confidence:** confirmed by probe.

### SNS-4. Corrupt row content under a lazy fault is an untyped panic, which the daemon's typed fault channel re-raises

- **Lens(es):** 1, 6 (the same damage is a typed `StoreError` on the eager path and an untyped panic on the lazy one).
- **Proposed severity:** medium.
- **Location:** `rust/engine/ironhorse-snapshot/src/machine.rs:1396-1404`; `rust/engine/ironhorse-vm/src/value.rs:313-372` and `:2169-2176`; daemon catch `rust/endo/src/ironhorse_engine.rs:1071-1081` and its use at `:1482-1521`.
- **Excerpt:**
  ```rust
  fn slot_page(&self, page: u32) -> Vec<ironhorse_vm::Slot> {
      let bytes = match self.store().read_slot_page(page) { Ok(b) => b, Err(error) => raise_store_fault(error) };
      crate::slot_codec::decode_slots(&bytes)
          .unwrap_or_else(|e| panic!("lazy heap fault: slot page {page} decode: {e:?}"))
  }
  ```
  ```rust
  assert!(records.len() == expected, "page source returned {} records for page {page}, expected {expected} (corrupt or torn store row)", ...);
  ```
  ```rust
  Err(payload) => match ironhorse_snapshot::machine::store_fault_of(payload) {
      Ok(error) => Err(store_err(error)),
      Err(payload) => std::panic::resume_unwind(payload),
  },
  ```
- **Mechanism:** a failed read is a typed `StoreFault(StoreError)` that `classify()` can call `Poisoned`/`Transient`, but a row that reads fine and then fails to decode, has the wrong length, or holds an out-of-arena or free-slot reference is a `String` panic. Every catch site re-raises non-`StoreFault` payloads, and `Interp::run` re-raises non-resource panics (`ironhorse-vm/src/interp.rs:2983-2992`). In the daemon, `PersistentMachine::eval` therefore never reaches its rewind branch: the panic leaves `eval` with the machine mid-crank and no `MachineError::Store` for the supervisor to classify. The eager path and the validators report the same damage as `StoreError::RowLength`/`Corrupt`.
- **Scenario:** a SQLite heap whose slot-page BLOB is truncated (disk damage, an offline edit, or an engine bug in an earlier build) is resumed lazily by the daemon (`resume_shared_from_store_lazy_with`, `ironhorse_engine.rs:1281`). The first crank to touch the page panics out of `PersistentMachine::eval` instead of returning a `Poisoned` store error.
- **Evidence:** static, plus the backend test `rust/endo/ironhorse-store-sqlite/tests/row_corruption.rs:101-130`, which truncates `slot_pages.bytes` and accepts a `String` panic containing "lazy heap fault"/"corrupt" as the lazy path's refusal. The eager probe in the same test gets a structured error.
- **Recommendation:** check length and decode in `StorePageSource` and raise `StoreFault(StoreError::RowLength{..}/Snapshot(Corrupt))`; have `validate_records` and the extent check return a typed refusal (or call a page-source hook that raises the store's fault) instead of `assert!`. Then `catch_store_fault` turns all store-content failures into `Poisoned` and the daemon's rewind path runs.
- **Confidence:** high.

### SNS-5. Page-edge summaries, the SQLite `edge_pairs` index and `gen_dirty` are maintained on every production commit for collectors only tests call

- **Lens(es):** 4, 3.
- **Proposed severity:** low.
- **Location:** derivation `rust/engine/ironhorse-snapshot/src/machine.rs:1129-1147`; `gen_dirty` growth `machine.rs:1195-1197` and full-page seeding at begin `machine.rs:1006-1007`; SQLite maintenance `rust/endo/ironhorse-store-sqlite/src/lib.rs:1191-1245`; consumers `machine.rs:1625-1809` (`partial_collect`, `generational_collect`), `lib.rs:599-890`.
- **Excerpt:**
  ```rust
  page_edges.push((page, derive_page_edges(page, &records)));
  ```
  ```rust
  clear_pairs.execute(params![*page as i64])?;
  for t in targets { insert_pair.execute(params![*t as i64, *page as i64])?; }
  ```
- **Mechanism:** each dirty page's summary is derived through a `BTreeSet`, stored, and in SQLite mirrored into a two-B-tree reverse index with a delete-then-insert per page, inside every commit. The only production collector is `full_collect` (`ironhorse_engine.rs:1657`; grep finds no non-test caller of `partial_collect`, `generational_collect`, `reachable_page_set`, `externally_referenced`, `reachable_within` or `pages_referencing`). `gen_dirty` accumulates every page any checkpoint ships and is cleared only by a collection, and the default daemon cadence is `collect_every: 0` (`ironhorse_engine.rs:926`), so it grows toward the page count for the worker's lifetime. The generational collector is documented as not resume-invariant and must not be scheduled (`machine.rs:1719-1734`), and the partial collector treats every side-table value as a root, so a heap whose references live mostly in arrays and Maps (the common JS case) frees little through it.
- **Scenario:** steady-state daemon commits pay summary derivation plus SQLite index churn for an index nobody queries.
- **Evidence:** static, and probe 2's edge census: the array-heavy fixture has 71 stored edges over 13 pages regardless of n (array element references are not arena edges); the closure chain has 1,245 edges over 404 pages (~3 per page). Per-commit cost is O(dirty pages × out-degree); small per page, but non-zero and unused.
- **Recommendation:** either wire a production consumer (and make the generational candidate set durable), or gate summary derivation, `edge_pairs` maintenance and `gen_dirty` behind a store option and drop them from the default daemon path. Clear or bound `gen_dirty` when no collector that reads it is configured.
- **Confidence:** high.

### SNS-6. Every SQLite point read re-reads and decodes the manifest and compiles two statements

- **Lens(es):** 4.
- **Proposed severity:** low.
- **Location:** `rust/endo/ironhorse-store-sqlite/src/lib.rs:972-1004` (also `:1091-1104`), `stored_manifest` at `:570-583`.
- **Excerpt:**
  ```rust
  fn read_slot_page(&self, page: u32) -> Result<Vec<u8>, StoreError> {
      if Self::stored_manifest(&self.conn)?.is_none() { return Err(StoreError::Empty); }
      self.conn.query_row("SELECT bytes FROM slot_pages WHERE page = ?1", ...)
  ```
- **Mechanism:** the empty-store parity gate runs `SELECT value FROM meta`, decodes the whole `StoreManifest` (signature string allocation included), and `Connection::query_row` prepares (not `prepare_cached`) both statements on every call. A lazy fault therefore costs two SQL compilations and a manifest decode in addition to the row read. The store holds an exclusive lock for its lifetime, so the manifest cannot change except through this handle.
- **Scenario:** a lazy wake that faults 1,000 pages compiles 2,000 statements and decodes the manifest 1,000 times.
- **Evidence:** static (rusqlite `Connection::query_row` is `self.prepare(sql)?.query_row(..)`); not measured, as the outer workspace was not built.
- **Recommendation:** cache the manifest (or a committed flag) in the handle, refreshed by `commit_verified`/`replace_for_migration` (the exclusive lock makes this sound), and use `prepare_cached` for all point reads.
- **Confidence:** medium.

### SNS-7. Migration ladder steps are tested only on stores synthesized from current encodings; both real-bytes fixtures stop at the boot gate

- **Lens(es):** 1 (test coverage of a persistent-state path), 3.
- **Proposed severity:** low.
- **Location:** `rust/engine/ironhorse-snapshot/src/store.rs:1745-1830`; tests `rust/engine/ironhorse-snapshot/tests/migration.rs:47-77`, `:80-103`, `:504-597`.
- **Excerpt:**
  ```rust
  /// A schema-5 store of the current boot's fixture machine, in what an older
  /// build left that migration reads: the rows as this build writes them, the
  /// small state cut back to schema 5's six sections ...
  ```
  ```rust
  // 27 → 28 split ... and 28 through 35 are identity restamps (payloads
  // that an older schema could not carry are simply absent).
  27..=35 => {}
  ```
- **Mechanism:** every completing migration test builds a current-build store and restamps its manifest (and trims trailing sections) to an older schema. The steps that rely on older payload bytes decoding canonically under current decoders (26→27 and the identity restamps 27..35 for FUNC, GENR, ASYN and PRMS trailers) never see bytes an older build actually wrote. The two committed real fixtures (`store-v5.ihstore`, `store-v35-stage1.ihstore`) are refused with `BootLayoutMismatch` before the ladder runs. Failure is fail-closed (`validate_state` and `SmallState::decode`'s canonical check run before the single write), so the risk is a refused upgrade, not corruption. Separately, any boot-layout or cost-table change strands every persisted heap: the ladder can only bridge builds that share both.
- **Scenario:** a schema-33 store written by a build whose FUNC encoder emitted an optional trailer differently is refused at migration even though the ladder claims 33→38 is an identity restamp.
- **Evidence:** static, from reading the tests named above and `tests/migration.rs:512-541` (the v35 fixture's own comment: "no build since ... has that layout").
- **Recommendation:** freeze real per-schema fixtures whenever a payload codec changes, generated under a stable boot layout (or a test-only boot-fingerprint override), and run each through `migrate_store` plus `validate_store_content`. Document in the store design that cross-boot-layout upgrades go through container export and vat surgery, not the ladder.
- **Confidence:** high.

### SNS-8. `check_succession` classifies several batch-side defects as a poisoned store

- **Lens(es):** 1, 6.
- **Proposed severity:** low.
- **Location:** `rust/engine/ironhorse-snapshot/src/store.rs:1897-1923` and `:1938`.
- **Excerpt:**
  ```rust
  if previous.collect_every != batch.manifest.collect_every {
      return Err(SnapshotError::Corrupt("collection cadence mismatch").into());
  }
  ...
  if batch.manifest.store_schema != STORE_SCHEMA_VERSION {
      return Err(StoreError::Snapshot(SnapshotError::Corrupt("checkpoint requires current store schema")));
  }
  ...
  crate::store_sections::validate_batch(batch, stored.is_none())?;
  ```
- **Mechanism:** `BatchRejected` exists so that a malformed request is `Refused` rather than `Poisoned` (`store.rs:182-190`, `:1033-1046`), and `HeapStoreCommit::commit` wraps every `check_batch` error that way (`store.rs:1431`), but inside `check_succession` only the two token checks go through `reject_batch`. A batch with the wrong cadence, a counter regression, a non-current schema stamp, or a non-canonical section payload comes back as bare `Snapshot(Corrupt)`, which `classify` maps to `Poisoned` (`store.rs:322-326`): "tear the session down", although the stored state is fine.
- **Scenario:** a caller that sets `set_cranks` below the stored count (a bookkeeping bug after a rewind) gets `Poisoned` and discards a healthy store session.
- **Evidence:** static.
- **Recommendation:** wrap the batch-side checks (schema stamp, counters, cadence, `validate_batch`) in `reject_batch`.
- **Confidence:** high.

### SNS-9. FileStore: single writer documented but not enforced; commit reloads the durable header twice with unbuffered 4-byte reads

- **Lens(es):** 1, 4.
- **Proposed severity:** low (FileStore is the in-crate reference backend; production uses SQLite).
- **Location:** `rust/engine/ironhorse-snapshot/src/store_file.rs:18-23`, `:625-633`, `:258-326`; reads `:374-378`, `:446-457`, `:417-433`.
- **Excerpt:**
  ```rust
  //! This reference backend requires a single writer: callers must serialize
  //! simultaneous commits and migrations on one path. ... it is not a cross-process writer lock.
  ```
  ```rust
  for _ in 0..len { ts.push(read_u32(file)?); }   // one read(2) per edge target, File is unbuffered
  ```
- **Mechanism:** two handles that commit concurrently both verify against the same durable manifest inside `commit_verified`, both write temps and both `rename`; the second rename silently replaces the first, so an acknowledged epoch is lost (detected only at the loser's next commit). Separately, `load` reads directories 12 bytes per syscall and edge summaries 4 bytes per syscall straight from `File`, and every commit calls it twice (`load_durable` before, reload after the rename), plus O(store) row copying by design.
- **Scenario:** two tests or tools sharing one `.ihstore` path; or a large FileStore where each commit issues O(pages + edges) syscalls twice.
- **Evidence:** static.
- **Recommendation:** take an advisory lock (`flock`/`File::lock` on a sibling lock file) for the handle's lifetime, as the SQLite backend does with `locking_mode=EXCLUSIVE`; read the header through a `BufReader`.
- **Confidence:** high.

### SNS-10. The SQLite schema creates a `side_tables` table on every open that nothing reads or writes

- **Lens(es):** 2 (maintainability), 3 (planned feature never built).
- **Proposed severity:** low.
- **Location:** `rust/endo/ironhorse-store-sqlite/src/lib.rs:432-440`.
- **Excerpt:**
  ```sql
  -- One row set per side-table ledger row, populated as the
  -- Pending atoms land paired with their store rows (design
  -- § Side tables: the ledger governs the schema).
  CREATE TABLE IF NOT EXISTS side_tables ( name TEXT NOT NULL, key BLOB NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY (name, key) );
  ```
- **Mechanism:** side tables went into the small-state sections instead; the table and its comment survived. `grep -rn side_tables rust/endo/ironhorse-store-sqlite` finds only this DDL and an unrelated test name.
- **Scenario:** a reader trusts the comment and believes side tables are row-keyed in SQLite.
- **Evidence:** static.
- **Recommendation:** drop the DDL and comment, or use the table for per-owner bulk rows as SNS-2 recommends.
- **Confidence:** confirmed (grep).

### SNS-11. The daemon's open decodes, and canonically re-encodes, the whole small state twice before the first crank

- **Lens(es):** 4.
- **Proposed severity:** low.
- **Location:** `rust/endo/src/ironhorse_engine.rs:1157-1166`; second decode `rust/engine/ironhorse-snapshot/src/store.rs:2182-2215` (via `resume_from_store_lazy`, `machine.rs:1438-1439`); decode cost `store.rs:1349-1355`.
- **Excerpt:**
  ```rust
  if ironhorse_snapshot::store::SmallState::decode(&store.read_small_state().map_err(store_err)?)
      .map_err(store_err)?.function_state.shared.is_none() { ... }
  ```
  ```rust
  pub fn decode(p: &[u8]) -> Result<SmallState, StoreError> {
      let small = Self::decode_legacy(p)?;
      if small.encode() != p { return Err(... "non-canonical small state") }
  ```
- **Mechanism:** the open path decodes the full small state (bulk arrays, Maps, functions) only to test whether `function_state.shared` is present, discards it, and the lazy resume reads and decodes it again. Each decode also re-encodes to check canonicality, so wake does two reads, two decodes and two encodes of the largest part of a lazily resumed heap.
- **Scenario:** wake latency of a worker with a multi-megabyte small state roughly doubles in its small-state term.
- **Evidence:** static; magnitude bounded by probe 2's encode+hash cost for a 2.4 MB small state (0.31 s debug per pass).
- **Recommendation:** decide the shared-profile check from the Functions section alone (`read_small_state` then `split_small_state` and decode one section), or have `resume_shared_from_store_lazy_with` report the absence of shared state itself.
- **Confidence:** high.

### SNS-12. A store written by a newer build classifies as `Poisoned`, while a container written by a newer build classifies as `Refused`

- **Lens(es):** 6, 1.
- **Proposed severity:** low.
- **Location:** `rust/engine/ironhorse-snapshot/src/store.rs:804-809` (manifest decode), repeated at `:1695-1699`, `:1913-1917`, `:2141-2145`, `:2315-2319`; classifier `store.rs:311-340`; the daemon's stated policy `rust/endo/src/ironhorse_engine.rs:1100-1104`; the stated rule `rust/engine/ironhorse-snapshot/tests/store_failure_classes.rs:160-164`.
- **Excerpt:**
  ```rust
  if !(STORE_SCHEMA_MIN_SUPPORTED..=STORE_SCHEMA_VERSION).contains(&store_schema) {
      return Err(StoreError::Snapshot(SnapshotError::Corrupt("unsupported store schema version")));
  }
  ```
  ```rust
  SnapshotError::Atom(_) | SnapshotError::Signature(_) | SnapshotError::MissingAtom(_)
  | SnapshotError::Corrupt(_) => StoreFailure::Poisoned,
  SnapshotError::Version(v) => { ... V::UnsupportedVersion(_) | ... => StoreFailure::Refused, ... }
  ```
  ```rust
  /// ... stop using a store that answers [`StoreFailure::Poisoned`].
  ```
- **Mechanism:** the taxonomy's own rule is "structural damage means the stored bytes cannot be trusted; a compatibility answer is a refusal from an intact store" (`store_failure_classes.rs:160-164`). A container format version this build cannot read follows it (`VersionError::UnsupportedVersion` → `Refused`). The same answer for the store schema is spelled `Corrupt` at five sites and lands in `Poisoned`, which `StoreFailure` defines as "the stored state contradicts itself" (`store.rs:277-282`). The class is also stretched over conditions that say nothing about the store: `StoreError::EngineInvariant` (a VM halt `EngineInvariant`/`Panic` through `shared_access_error`, `machine.rs:3003-3005`, or a lazy fault during a commit borrow, `machine.rs:1368-1372`) and `Corrupt("commit authority does not match the machine's backing")` (`machine.rs:1054-1058`, `:1236-1239`) both classify `Poisoned` while the stored state is intact.
- **Scenario:** an operator rolls a daemon back one release after it has checkpointed a worker at schema 39. The older binary opens the heap, gets `Corrupt("unsupported store schema version")`, and a supervisor that follows `MachineError::store_failure`'s documented contract stops using a store that the newer binary would resume. The same holds for a healthy store after an engine-invariant halt.
- **Evidence:** static; the classification is pinned by `store_failure_classes.rs` (`SnapshotError::Corrupt("slot record")` under "poisoned", `VersionError::UnsupportedVersion(99)` under "refused") and no test covers a newer store schema.
- **Recommendation:** give "store schema newer than this build" its own refusal variant (a `StoreError::UnsupportedSchema { found }`, or `NeedsMigration`'s forward twin) classified `Refused`, and use it at all five sites. Split `StoreFailure::Poisoned` from an engine-side class (the machine must be discarded, the store is fine), or document that `Poisoned` means "discard the session", not "distrust the store".
- **Confidence:** high.

### SNS-13. The SQLite backend reports stored-content damage and permanent configuration refusals as `Io`, so they classify `Transient`

- **Lens(es):** 6, 1.
- **Proposed severity:** low.
- **Location:** `rust/endo/ironhorse-store-sqlite/src/lib.rs:70`, `:199`, `:202`, `:250`, `:541`, `:757`, `:955`, `:1070` (content); `:355`, `:367`, `:398` (pragma refusals); `sql_err` fallback `:53-63`. Contrast `row_key` at `:78-80` and `MissingRow("small section", ..)` at `:242-246`.
- **Excerpt:**
  ```rust
  fn page_col(v: i64) -> Result<u32, StoreError> {
      u32::try_from(v).map_err(|_| StoreError::Io(format!("sqlite: page column out of range ({v})")))
  }
  ...
  fn row_key(key: i64, what: &'static str) -> Result<u32, StoreError> {
      u32::try_from(key).map_err(|_| StoreError::Snapshot(SnapshotError::Corrupt(what)))
  }
  ```
  ```rust
  .ok_or(StoreError::MissingRow("small section", id as u32))?;   // a missing section: Poisoned
  ...
  return Err(StoreError::Io("sqlite: extra small sections".into()));   // an extra section: Transient
  ```
- **Mechanism:** the classifier's rule is "the medium, and only the medium" is `Transient`, and "a capability the backend does not have is `Unsupported`, not this" (`store.rs:289-291`; test `only_the_medium_is_transient`). The variant-level test cannot see construction sites, and these sites spell damage as `Io`: a malformed `page_edges` blob, a non-contiguous summary table, an out-of-range page column, an extra or wrong-length section row, a committed store without its small-state row. A `rusqlite` type mismatch from `row.get` (for example a `TEXT` where a `BLOB` belongs) carries no SQLite error code and also falls through `sql_err` to `Io`. The open-time refusals of `locking_mode=EXCLUSIVE`, `journal_mode=WAL` and `synchronous=FULL` are permanent properties of the database, yet `Io`, while the analogous read-only refusal was deliberately moved to `Unsupported` (`lib.rs:288-303`). The same damage is `Poisoned` or `Transient` depending on which helper noticed it (`row_key` against `page_col`, missing section against extra section).
- **Scenario:** a heap whose `page_edges` row was truncated by an offline edit fails `partial_collect` or `validate_store_content` with `Io`; a supervisor following the classifier retries a permanently damaged store until its retry bound.
- **Evidence:** static (each site cited above).
- **Recommendation:** route every content check in the backend through one `corrupt(what)` helper returning `Snapshot(Corrupt)`; map `rusqlite::Error::InvalidColumnType`/`FromSqlConversionFailure` to `Corrupt`; return `Unsupported` for the three pragma refusals; add a construction-site test that damages each table and asserts `classify() == Poisoned`.
- **Confidence:** high.

### Probe sources (evidence for SNS-1, SNS-2, SNS-3)

All three probes lived at `rust/engine/ironhorse-snapshot/tests/zz_audit_snapshot-store_{1,2,3}.rs`, ran with `CARGO_TARGET_DIR=$SCRATCH/audit-target RUST_MIN_STACK=33554432 cargo test -p ironhorse-snapshot --test <name> -- --nocapture` from `rust/engine`, and have been deleted.

#### Probe 1 (standalone `Interp`, small change against large sections)

```rust
//! AUDIT PROBE (temporary): checkpoint cost of a small change against a
//! large section-resident heap. Measures small-state bytes written per
//! checkpoint (profile-independent) and wall time (debug build: relative).
use ironhorse_snapshot::machine::{begin_store_session, checkpoint_to_store, StoreSession};
use ironhorse_snapshot::store::MemoryStore;
use ironhorse_snapshot::Signature;
use ironhorse_vm::{parse_symbols, Interp, SymbolName};
use std::time::Instant;

fn sig() -> Signature {
    Signature::new("ironhorse-worker-v1")
}

fn compile(src: &str) -> (Vec<u8>, Vec<SymbolName>) {
    let (code, names) = ironhorse_compile::compile_atoms(src).expect("compiles");
    (code, parse_symbols(&names))
}

fn start(setup: &str) -> (StoreSession, MemoryStore) {
    let (code, names) = compile(setup);
    let mut m = Interp::new();
    m.link_intrinsics(&names);
    let o = m.run(&code);
    assert!(o.completed, "{:?}", o.halt);
    let mut store = MemoryStore::new();
    let session = begin_store_session(m, &sig(), &mut store)
        .map_err(|(_, e)| e)
        .unwrap();
    (session, store)
}

fn crank_and_checkpoint(
    session: &mut StoreSession,
    store: &mut MemoryStore,
    src: &str,
) -> (f64, ironhorse_snapshot::store::CommitStats) {
    let (code, names) = compile(src);
    let code = session.machine_mut().relink_crank(&code, &names).unwrap();
    let o = session.machine_mut().run(&code);
    assert!(o.completed, "{:?}", o.halt);
    let t = Instant::now();
    checkpoint_to_store(session, &sig(), store).unwrap();
    (t.elapsed().as_secs_f64(), store.last_commit_stats())
}

#[test]
fn small_change_checkpoint_cost() {
    for n in [1_000u32, 10_000, 100_000] {
        // A: one big array, one tiny array; touch only the tiny one.
        let (mut s, mut st) = start(&format!(
            "var big=[]; for(var i=0;i<{n};i++) big[i]=i; var small=[0]; 0"
        ));
        // warm: first checkpoint after begin
        crank_and_checkpoint(&mut s, &mut st, "1+1");
        let (t0, c0) = crank_and_checkpoint(&mut s, &mut st, "1+1");
        let (t1, c1) = crank_and_checkpoint(&mut s, &mut st, "small[0] = small[0] + 1; 0");
        println!(
            "ARRAYS n={n} noop: {:.6}s sections={} small_bytes={} pages={} | small[0]++: {:.6}s sections={} small_bytes={} pages={} exts={}",
            t0, c0.small_sections_written, c0.small_bytes_written, c0.slot_pages_written,
            t1, c1.small_sections_written, c1.small_bytes_written, c1.slot_pages_written, c1.chunk_extents_written
        );

        // B: n live closures held through heap objects; mint one garbage closure.
        let (mut s, mut st) = start(&format!(
            "var head=null; for(var i=0;i<{n};i++) head={{f:function(){{return 1}}, next:head}}; 0"
        ));
        crank_and_checkpoint(&mut s, &mut st, "1+1");
        let (t0, c0) = crank_and_checkpoint(&mut s, &mut st, "1+1");
        let (t1, c1) =
            crank_and_checkpoint(&mut s, &mut st, "(function(){ return 2 }); 0");
        println!(
            "FUNCS  n={n} noop: {:.6}s sections={} small_bytes={} | new closure: {:.6}s sections={} small_bytes={} pages={}",
            t0, c0.small_sections_written, c0.small_bytes_written,
            t1, c1.small_sections_written, c1.small_bytes_written, c1.slot_pages_written
        );

        // C: one big Map, one tiny Map; touch only the tiny one.
        let (mut s, mut st) = start(&format!(
            "var bm=new Map(); for(var i=0;i<{n};i++) bm.set(i,i); var sm=new Map(); 0"
        ));
        crank_and_checkpoint(&mut s, &mut st, "1+1");
        let (t1, c1) = crank_and_checkpoint(&mut s, &mut st, "sm.set(1, 2); 0");
        println!(
            "MAPS   n={n} sm.set: {:.6}s sections={} small_bytes={} pages={}",
            t1, c1.small_sections_written, c1.small_bytes_written, c1.slot_pages_written
        );
    }
}
```

#### Probe 2 (shared `Machine` path, no-op checkpoint and edge census)

```rust
//! AUDIT PROBE (temporary): checkpoint cost on the SHARED Machine path (the
//! daemon's PersistentMachine path), where snapshot_dirty_sections returns
//! all(); plus page-edge summary volume for an object-graph heap.
use ironhorse_snapshot::machine::begin_shared_store_session;
use ironhorse_snapshot::store::{HeapStore, MemoryStore};
use ironhorse_snapshot::Signature;
use ironhorse_vm::{Compartment, Machine};
use std::time::Instant;

fn sig() -> Signature {
    Signature::new("ironhorse-worker-v1")
}

fn eval(c: &Compartment, source: &str) {
    let (code, symbols) = ironhorse_compile::compile_atoms(source).unwrap();
    let outcome = c.evaluate_with_symbols(&code, &symbols);
    assert!(outcome.completed, "{source}: {:?}", outcome.halt);
}

#[test]
fn shared_noop_checkpoint_cost() {
    for n in [1_000u32, 10_000, 100_000] {
        for (label, setup) in [
            ("ARRAY", format!("var big=[]; for(var i=0;i<{n};i++) big[i]=i; 0")),
            (
                "FUNCS",
                format!("var head=null; for(var i=0;i<{n};i++) head={{f:function(){{return 1}}, next:head}}; 0"),
            ),
        ] {
            let m = Machine::new();
            let a = m.new_compartment();
            eval(&a, &setup);
            let mut store = MemoryStore::new();
            let mut session = begin_shared_store_session(m, &sig(), &mut store, 0)
                .ok()
                .unwrap();
            eval(&a, "1+1");
            session.checkpoint(&sig(), &mut store).unwrap();
            let mut times = Vec::new();
            for _ in 0..3 {
                eval(&a, "1+1");
                let t = Instant::now();
                session.checkpoint(&sig(), &mut store).unwrap();
                times.push(t.elapsed().as_secs_f64());
            }
            times.sort_by(f64::total_cmp);
            let stats = store.last_commit_stats();
            let edges = store.page_edges().unwrap();
            let total_edges: usize = edges.iter().map(Vec::len).sum();
            let max_deg = edges.iter().map(Vec::len).max().unwrap_or(0);
            let small_total = store.read_small_state().unwrap().len();
            println!(
                "SHARED {label} n={n} noop checkpoint median={:.6}s sections_written={} small_bytes_written={} small_state_total={} | pages={} edges={} max_out_degree={}",
                times[1],
                stats.small_sections_written,
                stats.small_bytes_written,
                small_total,
                edges.len(),
                total_edges,
                max_deg
            );
        }
    }
}
```

Output note: the shared `FUNCS n=100000` setup itself halts with `HeapExhausted` under `Machine::new()`'s default ceiling, so the probe stops after `ARRAY n=100000`.

#### Probe 3 (persist-gate attribution)

```rust
//! AUDIT PROBE (temporary): attribute the per-checkpoint O(functions) term to
//! the checkpoint persist gate (`stored_unpersistable_row_at_checkpoint`).
use ironhorse_vm::{parse_symbols, Interp};
use std::time::Instant;

#[test]
fn persist_gate_cost_scales_with_function_count() {
    for n in [1_000u32, 10_000, 100_000] {
        let (code, names) = ironhorse_compile::compile_atoms(&format!(
            "var head=null; for(var i=0;i<{n};i++) head={{f:function(){{return 1}}, next:head}}; 0"
        ))
        .unwrap();
        let mut m = Interp::new();
        m.link_intrinsics(&parse_symbols(&names));
        assert!(m.run(&code).completed);
        let mut times = Vec::new();
        for _ in 0..5 {
            let t = Instant::now();
            let row = m.stored_unpersistable_row_at_checkpoint();
            times.push(t.elapsed().as_secs_f64());
            assert!(row.is_none());
        }
        times.sort_by(f64::total_cmp);
        println!("GATE n={n} stored_unpersistable_row_at_checkpoint median={:.6}s", times[2]);
    }
}
```

## Duplication inventory

| Family | Copies (path:line) | Size | Note |
|---|---|---|---|
| Scratch `TempDir` guard | `ironhorse-snapshot/src/test_dir.rs:6-37`; `ironhorse-snapshot/tests/common/mod.rs:6-42`; `ironhorse-store-sqlite/tests/common/mod.rs:6-38`; `ironhorse-store-sqlite/src/lib.rs:1655-1693` | 4 × ~35 lines | the first comment admits "the small duplicate" |
| Schema-range gate (older → `NeedsMigration`, newer → `Corrupt("unsupported store schema version")`) | `store.rs:805-809`, `:1695-1699`, `:1907-1918`, `:2132-2145`, `:2310-2319` | 5 × 5-12 lines | one helper `check_schema(m) -> Result` |
| Row length vs geometry (`expected = slot_page_len*20` / `chunk_extent_len` / `free_seg_len*4`, then `RowLength`) | `store.rs:1203-1235` (×3), `:2230-2256` (×2), `:2266-2275`, `:2332-2363` (×2), `:2469-2497` (×2) | 10 sites, ~10 lines each | one `expected_row_len(kind, manifest, index)` |
| Restore sequence (arenas, name floor, symbol-key table, side tables, `finish_restore`) | `machine.rs:494-528` (eager) and `:1469-1502` (lazy) | 2 × ~35 lines | differ in error wrapping only |
| `StoreTracking` construction | `machine.rs:1009-1025`, `:1309-1327`, `:1513-1531` | 3 × ~18 lines | resume variants differ in `pin`/`backing_authority` only |
| Collector preamble (quiescence, clean-boundary assert, manifest pairing, summary count) | `machine.rs:1567-1575`, `:1637-1659`, `:1747-1763` | 3 × 10-25 lines | |
| Page BFS over summaries | `store.rs:973-992` (`bfs_pages`), `:1570-1585` (dense `externally_referenced`), `:1593-1615` (dense `reachable_within`); SQLite CTEs `lib.rs:623-664`, `:831-890` | 5 implementations | deliberate (dense vs CTE) and parity-tested in `tests/query_gc.rs` |
| Empty-store gate on each read | `MemoryStore` `store.rs:2766`, `:2791`, `:2801`, `:2834`, `:2841`; SQLite `lib.rs:736`, `:770`, `:788`, `:838`, `:977`, `:992`, `:1092` | 12 sites | the SQLite copies are what SNS-6 costs |
| Per-backend commit merge (geometry drop, free-segment truncation, edge-vector resize) | `store.rs:2850-2897`, `store_file.rs:625-718`, `lib.rs:1106-1264` | 3 × 50-160 lines | inherent per backend, but the drop/truncate rules are hand-mirrored |
| `catch_store_fault` | `machine.rs:677-685`; `rust/endo/src/ironhorse_engine.rs:1071-1081` | 2 × 10 lines | the daemon copy only re-wraps the error type |
| Section digest computed twice per changed section | session `machine.rs:1169`; SQLite `lib.rs:215`; `MemoryStore` via `SectionLeaves::apply` `store_sections.rs:309-316` | 2 SHA-256 passes per changed section | pass the session's digest through `SectionUpdate` |

## Skipped features and refusals inventory

| Site | What is refused or skipped | Spec/design status | Should support? | Effort |
|---|---|---|---|---|
| `persist.rs:4549-4551` | section dirt tracking on shared (`Machine`) heaps; all sections re-extracted (SNS-1) | design promises O(dirty) checkpoints | yes | medium: track dirt for shared environment/job state |
| `machine.rs:1719-1734` | `generational_collect` not resume-invariant; must not be scheduled | documented latent hazard | yes, or delete | medium: durable candidate set |
| `machine.rs:1625-1809`, SQLite `lib.rs:585-890` | partial and generational collectors and the CTE/reverse-index queries have no production caller (SNS-5) | design phases 6-10 | decide: wire or retire | small to retire, medium to wire |
| `value.rs:1064`, `:2189` | eviction implemented but never called outside the suite; lazy residency is grow-only in production | design phase 8 | yes for memory-bounded wakes | small: an eviction policy at checkpoint |
| `store.rs:1553-1561` | `replace_for_migration` default `Unsupported` | by design for read-only backends | n/a | n/a |
| `store_file.rs:565-571` | migration to another geometry `Unsupported` | ladder never changes geometry | n/a | n/a |
| `store.rs:619-626` | `RandomTokens` refuses on `wasm32-unknown-unknown` | embedder supplies a source | n/a | n/a |
| `store.rs:161-168` | `StoreError::Io` loses `io::ErrorKind`, so permanent medium failures classify `Transient` | documented limitation | yes | small, crosses the SQLite crate |
| `store.rs:1690-1731` | migration refuses a different boot layout or cost table; no upgrade path for such stores (SNS-7) | by design (fingerprint gate) | design question | large: export, transform, import |
| `lib.rs:296-303` | read-only SQLite databases refused at open | by design (open takes the write lock) | a read-only inspection open would help tooling | small |
| `lib.rs:432-440` | `side_tables` table never populated (SNS-10) | planned per-row side tables | yes (see SNS-2) | medium |
| `ironhorse_engine.rs:1152-1166` | daemon refuses stores below schema 32 and stores without shared function state | profile incompatibility | n/a | n/a |

## Memory and performance opportunities

| Site | Waste | Magnitude | Fix |
|---|---|---|---|
| `persist.rs:4549-4551` (SNS-1) | full small-state extract + encode + SHA-256 on every daemon checkpoint | release 18.1 ms per `1+1` crank at 2.4 MB small state (standalone: 0.29 ms), linear in it | shared-state dirt tracking |
| bulk sections (SNS-2) | O(table) rewrite per O(1) change; plus a canonical decode/re-encode and a second SHA in the backend | 24 B/array item, 56 B/function, 40 B/Map entry written per touched table; release 49 ms (100k-item arrays), 289 ms (100k closures) per such checkpoint | per-owner rows or segments |
| `persist.rs:688-723` (SNS-3) | O(functions + reactions) gate per checkpoint | release 6.6 ms at 100k closures, per crank | incremental doomed set |
| `machine.rs:1129-1147`, `lib.rs:1191-1245` (SNS-5) | summary derivation + `edge_pairs` churn per dirty page, unused in production | O(dirty pages × out-degree) per commit; edge_pairs stores each edge in two B-trees | gate behind an option |
| `machine.rs:740`, `:1195-1197` | `gen_dirty: BTreeSet<u32>` grows until a collection; daemon default `collect_every: 0` | ~40 B per page dirtied in the session's lifetime | clear when unused |
| `lib.rs:972-1004` (SNS-6) | manifest decode + 2 statement compilations per lazy fault | estimated tens of µs per fault | cache manifest, `prepare_cached` |
| `ironhorse_engine.rs:1157` (SNS-11) | small state decoded and re-encoded twice at open | 2 × O(small state) on every wake | check one section |
| `machine.rs:966-994`, `store.rs:2062-2108` | `begin_store_session` and `import_from_container` hold live heap + `MachineImage` + full encoded batch at once | about 3× heap peak at genesis/import | stream pages into the batch (the container writer already streams, `machine.rs:1-10`) |
| `store_file.rs:107-114`, `:329-336`, `:632` | FileStore keeps the whole small state, all edges and the whole free list resident; reloads them twice per commit with unbuffered reads (SNS-9) | O(store metadata) per commit | `BufReader`; reuse the in-memory view under a lock |
| `store.rs:2857` | `MemoryStore::commit_verified` clones the whole edge vector each commit | O(pages + edges) per commit (reference store only) | mutate in place after verification |
| `stored_slots.rs:508` | `visit_image_slots` builds a `BTreeSet` of the whole free list per call | ~tens of bytes per free slot, transient (import, publish, validate) | use the arena's free marks or a bitmap |
| `value.rs:931`, `:1002` (VM, region neighbour) | a lazily resumed arena allocates `free_marks` and `marks` as `Vec<bool>` per slot up front | 2 bytes per slot before any fault | bitsets; allocate `marks` at collection time |
| production residency | no eviction; the first scheduled `full_collect` faults the entire heap (`machine.rs:1547-1553`) | lazy-wake memory benefit lasts until the first collection | eviction policy after checkpoint |

## Ontology notes

Region-local results for lens 6. Items with a persistence consequence are promoted to SNS-8, SNS-12 and SNS-13 (and SNS-3's stale premise); the rest are recorded here.

**(a) Synonyms and homonyms.**
- *Baseline* has five meanings in and around the region: the commit-token lineage (`StoreError::BaselineMismatch` at succession, `store.rs:1928-1933`), the whole-manifest compare-and-swap of a migration (`check_migration_baseline`, `store.rs:2678-2695`, whose message is "schema N epoch E token T"), the VM's dirty-section acknowledgement (`ironhorse_vm::SnapshotBaseline`, `machine.rs:724`), the free-list acknowledgement (`free_list_baseline`, `machine.rs:1308`), and the uninterrupted reference run in the suite (`store_suite::Baseline`, `store_suite.rs:74`). The error's two meanings also show up in `Display`, which the code comments have to defend as "deliberately neutral about which side is which" (`store.rs:385-393`).
- *Small state* names the sections, but the bulk side tables (all array items, Map entries, function records) live there: 2.4 MB for one 100k-item array in probe 2. The module table still describes it as "stack, free list, keys/names/symbols, meter" (`store.rs:22`).
- *Free list* has four representations under three names: `SmallState.slot_free` (decoded, filled from segments at open), the always-empty `SmallSection::RetiredFreeList` frame, the `free_segs` rows, and `MachineImage.slot_free`, with `free_len` in the manifest. `SmallSection::Keys` is likewise a retired, always-empty frame. Two of the 34 persisted sections carry no data.
- *Generation* means the checkpoint epoch in the manifest docs ("The checkpoint generation", `store.rs:459-461`) and the dirtied-pages candidate set in "generational collection" (`machine.rs:1699-1717`).
- *Corrupt* (`SnapshotError::Corrupt`) covers stored damage, caller batch defects (SNS-8), a newer schema (SNS-12), and an engine/caller authority mismatch (`machine.rs:1054-1058`); its class is fixed at `Poisoned` whatever it describes.
- The persistence refusal for live unsupported state has two user-facing texts: "that side table does not travel" (`store.rs:353`) and "that side table does not travel yet" (`machine.rs:80`).
- Row kinds are strings, and one row class has two names: the page-edge summary is `"page-edge summary"` in `check_batch` (`store.rs:1107`) and `"page edges"` in the SQLite inventory (`lib.rs:1067`); sections are `"small section"`/`"small section hash"` (`lib.rs:191-246`).

**(b) Taxonomies.**
- `StoreFailure` is documented as "what a caller should do about a store failure", but three of its inputs are machine conditions (`MachineNotQuiescent`, `MachineOperation`, `EngineInvariant`, `store.rs:145-196`), and `EngineInvariant` lands in `Poisoned`, whose definition is about the stored state (SNS-12).
- The same pairing failure gets different variants at different sites: a store at another epoch is `EpochMismatch` at checkpoint (`machine.rs:1088-1093`) and in the unbound-fault check (`machine.rs:1384-1387`), but `BaselineMismatch` showing only tokens in the collectors' `check_pairing` (`machine.rs:1537-1545`). Both classify `Refused`, so only diagnostics differ.
- Compatibility answers split between `Snapshot(Version(UnsupportedVersion))` (`Refused`) and `Snapshot(Corrupt("unsupported store schema version"))` (`Poisoned`) (SNS-12); damage splits between `Corrupt`/`MissingRow` (`Poisoned`) and `Io` (`Transient`) by construction site (SNS-13).

**(c) Types missing a distinction.**
- Page indices, chunk-extent indices, free-segment indices and section ids are all bare `u32`; `MissingRow(&'static str, u32)` and `RowLength { kind: &'static str, .. }` carry the row class as a string, which is how the two spellings in (a) arose. A `RowKind` enum would make backend parity checkable.
- `LazyPin.backed`/`UnboundPairing` are `(u64, CommitToken)` tuples (`machine.rs:610`, `:648`) for what the manifest already models as (epoch, token).
- Epochs are bare `u64` across `StoreManifest`, `StoreTracking` and errors; `CommitToken` is the one identity in the region with a newtype.

**(d) ECMA-262 model.**
No guest-observable divergence originates in this region; the store carries the VM's Realm, environment and job rows opaquely inside the Functions and Promises sections.

**(e) Docs against code.**
- Section count: "The 32 small-state sections" (`store.rs:26`), "Encode the 32 payloads separately" (`store.rs:1300`) and "The 32 section digests" (`store_sections.rs:292`) describe current code; `SMALL_SECTION_COUNT` is 34 since schema 37 (`store_sections.rs:362-363`).
- Whole-versus-sparse small state: `SmallState`'s own doc calls it "the whole-on-every-commit remainder of the machine state" (`store.rs:1271`); `checkpoint_to_store`'s doc says it commits "the whole (small) manifest and small state" (`machine.rs:1028-1030`); the persist gate justifies its full side-table walk with "they are small state, re-serialized on every checkpoint anyway" (`persist.rs:572-573`). Since schema 28 only changed sections are sent, and on the standalone path only dirty sections are even encoded, so the premise behind SNS-3's full walk no longer holds.
- `SqliteHeapStore`'s `side_tables` DDL comment says the table is "populated as the Pending atoms land" (`lib.rs:432-434`); nothing populates it (SNS-10).
- `stored_unpersistable_row_at_checkpoint` says it keeps "the per-crank cost O(dirty)" (`persist.rs:561-563`); its function and reaction scans are O(heap) (SNS-3).
- `HeapStore`'s doc lists three implementations (`store.rs:1439-1444`); the wasm spike's `DoStore` is a fourth that also runs the suite (`rust/engine/wasm-worker-spike/src/lib.rs:147-160`).

## Leads that did not survive

- Crash between page writes and manifest write: SQLite commits rows, summaries, sections and manifest in one IMMEDIATE transaction under WAL + `synchronous=FULL` (`lib.rs:1106-1264`); FileStore swaps a complete fsynced file by rename and syncs the directory (`store_file.rs:258-326`). No torn epoch is reachable.
- SQLite single writer: enforced, not just documented (`locking_mode=EXCLUSIVE` read back, plus an empty `BEGIN IMMEDIATE` at open, `lib.rs:351-382`), and tested by `tests/writer_exclusion.rs`.
- Sequential stale FileStore handles: `commit_verified` reloads the durable file first, so a stale handle gets `EpochMismatch`/`BaselineMismatch` (`store_file.rs:625-633`); only truly concurrent commits race (SNS-9).
- Migration atomicity: the ladder runs in memory, `validate_state` checks the result, and one compare-and-swap write lands it on every backend; SQLite rolls back DDL with it (verified by the backend's trigger-abort tests at `lib.rs:1374-1500`).
- Free-segment diffing: the arena's free list mutates only by `push`/`pop` (`value.rs:1244-1286`, `:1428`) and `free_low` tracks every `pop`, so shipping segments from the low-water mark is exact.
- Dirty-pages-only heap walk in the persist gate: a function's persistability is fixed for the life of its slot (`promise_functions`, `proxy_revokers` and the Intl maps lose entries only when GC frees the key slot), so the induction in `persist.rs:561-576` holds.
- Partial collector unsoundness versus the full collector: summaries use the same `each_ref_slot` edges the full tracer uses (`gc.rs:187`), and every side-table value is a root, so page reachability over-approximates the full mark set; stale edges from free records only retain more.
- Store suite coverage across backends: `metamorphic_suite`, `lazy_working_set_bound`, `boundary_collection_twins`, `checkpoint_acceptance`, `resume_equals_uninterrupted`, `commit_contract` and `consistent_edits_resume` run on Memory, File and SQLite (in-memory and on-disk); `sparse_section_acceptance` runs on SQLite in-memory only. The gap is the shared-`Machine` path (SNS-1), not a backend.
- Manifest decode bounds: every length is checked before slicing, `chunk_len` is capped at `u32::MAX` before any `usize` narrowing, and trailing bytes are refused (`store.rs:775-931`).
- FileStore directory clamps: counts are checked against the file length before reservation (`store_file.rs:385-475`).
