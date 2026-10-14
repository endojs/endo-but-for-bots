//! `DoStore`: a [`HeapStore`] over the Durable Object's SQLite through the
//! host-import ABI, on the `MemoryStore` pattern the verification review
//! directs a first port to: the required reads, one upsert-style commit with
//! no transaction statements of its own, the dense reachability defaults,
//! the `IRON` stamp in a `meta` row, every value at most 2,000,000 bytes,
//! and the small-state sections chunked by `(id, chunk)` with the whole
//! payload's hash on chunk 0 so the seal inputs do not change.
//!
//! Several stores share one database: every row carries a store id, which
//! is what lets the acceptance suite, which creates a fresh store per case,
//! run inside one Durable Object.

use std::cell::Cell;

use ironhorse_snapshot::store::{
    chunk_extent_count, free_seg_count, slot_page_count, CommitVerifier, HeapStore, StoreError,
    StoreManifest,
};
use ironhorse_snapshot::store_sections::{
    batch_updates, frame_small_state, merge_framed, section_hash, split_small_state, SectionLeaves,
    SMALL_SECTION_COUNT,
};
use ironhorse_snapshot::SnapshotError;

use crate::host::{exec, Value};

/// The documented Durable Object per-value cap (local workerd allows 4 MiB,
/// so the backend asserts the production figure itself).
pub const MAX_VALUE_BYTES: usize = 2_000_000;
/// The refusal for a value over [`MAX_VALUE_BYTES`]; the two are kept in step by hand.
const CAP_REFUSAL: &str = "do sql: a value exceeds the 2,000,000-byte cap";
/// Small-state sections are stored in pieces of this size.
const SECTION_CHUNK_BYTES: usize = 1_000_000;
const META_MANIFEST: &str = "manifest";
const META_STAMP: &str = "stamp";
const STAMP: &[u8] = b"IRON";

const SCHEMA: &[&str] = &[
    "CREATE TABLE IF NOT EXISTS ih_meta (store INTEGER NOT NULL, key TEXT NOT NULL, value BLOB NOT NULL, PRIMARY KEY (store, key))",
    "CREATE TABLE IF NOT EXISTS ih_slot_pages (store INTEGER NOT NULL, page INTEGER NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY (store, page))",
    "CREATE TABLE IF NOT EXISTS ih_chunk_exts (store INTEGER NOT NULL, ext INTEGER NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY (store, ext))",
    "CREATE TABLE IF NOT EXISTS ih_free_segs (store INTEGER NOT NULL, seg INTEGER NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY (store, seg))",
    "CREATE TABLE IF NOT EXISTS ih_page_edges (store INTEGER NOT NULL, page INTEGER NOT NULL, targets BLOB NOT NULL, PRIMARY KEY (store, page))",
    "CREATE TABLE IF NOT EXISTS ih_sections (store INTEGER NOT NULL, id INTEGER NOT NULL, chunk INTEGER NOT NULL, bytes BLOB NOT NULL, hash BLOB NOT NULL, PRIMARY KEY (store, id, chunk))",
];
const TABLES: &[&str] = &[
    "ih_meta",
    "ih_slot_pages",
    "ih_chunk_exts",
    "ih_free_segs",
    "ih_page_edges",
    "ih_sections",
];

thread_local! {
    /// Fresh-store ids for the suite, above the ids a host hands out.
    static NEXT_FRESH: Cell<u32> = const { Cell::new(1_000) };
}

#[derive(Debug, Clone)]
pub struct DoStore {
    id: u32,
}

/// Refuse a value the platform would not store. Deterministic, so a refusal
/// (`Unsupported`) rather than a transient I/O error a supervisor would
/// retry; the sizes go to the host's log.
fn cap(what: &'static str, bytes: &[u8]) -> Result<(), StoreError> {
    if bytes.len() > MAX_VALUE_BYTES {
        crate::host::log(&format!(
            "do sql: {what} of {} bytes exceeds the {MAX_VALUE_BYTES}-byte value cap",
            bytes.len()
        ));
        return Err(StoreError::Unsupported(CAP_REFUSAL));
    }
    Ok(())
}

impl DoStore {
    pub fn id(&self) -> u32 {
        self.id
    }

    /// Create the schema if needed, stamp the database, and return a handle
    /// on store `id`. With `reset`, any rows the id already holds are
    /// deleted first: the database outlives instances and workerd runs.
    /// Id 0 is the database's own row (the stamp) and is refused.
    pub fn open(id: u32, reset: bool) -> Result<DoStore, StoreError> {
        if id == 0 {
            return Err(StoreError::Unsupported(
                "do sql: store id 0 holds the stamp",
            ));
        }
        for statement in SCHEMA {
            exec(statement, &[])?;
        }
        let stamp = exec(
            "SELECT value FROM ih_meta WHERE store = ?1 AND key = ?2",
            &[Value::u32(0), Value::Text(META_STAMP.into())],
        )?;
        match stamp.into_iter().next() {
            None => {
                exec(
                    "INSERT INTO ih_meta (store, key, value) VALUES (?1, ?2, ?3)",
                    &[
                        Value::u32(0),
                        Value::Text(META_STAMP.into()),
                        Value::Blob(STAMP.to_vec()),
                    ],
                )?;
            }
            Some(row) if row.len() == 1 && row[0] == Value::Blob(STAMP.to_vec()) => {}
            Some(_) => {
                return Err(StoreError::Snapshot(SnapshotError::Corrupt(
                    "do sql: foreign database (stamp)",
                )))
            }
        }
        let store = DoStore { id };
        if reset {
            store.reset()?;
        }
        Ok(store)
    }

    /// A never-used store for the acceptance suite's `fresh` closures.
    pub fn fresh() -> DoStore {
        let id = NEXT_FRESH.with(|next| {
            let id = next.get();
            next.set(id + 1);
            id
        });
        DoStore::open(id, true).expect("a fresh store opens")
    }

    /// Delete every row of this store.
    pub fn reset(&self) -> Result<(), StoreError> {
        for table in TABLES {
            exec(
                &format!("DELETE FROM {table} WHERE store = ?1"),
                &[Value::u32(self.id)],
            )?;
        }
        Ok(())
    }

    fn stored_manifest(&self) -> Result<Option<StoreManifest>, StoreError> {
        let rows = exec(
            "SELECT value FROM ih_meta WHERE store = ?1 AND key = ?2",
            &[Value::u32(self.id), Value::Text(META_MANIFEST.into())],
        )?;
        match rows.into_iter().next() {
            None => Ok(None),
            Some(mut row) => {
                let bytes = row.remove(0).into_blob("manifest")?;
                Ok(Some(StoreManifest::decode(&bytes)?))
            }
        }
    }

    fn point_read(
        &self,
        table: &str,
        column: &str,
        index: u32,
        what: &'static str,
    ) -> Result<Vec<u8>, StoreError> {
        // Empty-store gate for point-read parity with the other backends:
        // an uncommitted store is `Empty`; `MissingRow` means a committed
        // store lacks the row.
        if self.stored_manifest()?.is_none() {
            return Err(StoreError::Empty);
        }
        let rows = exec(
            &format!("SELECT bytes FROM {table} WHERE store = ?1 AND {column} = ?2"),
            &[Value::u32(self.id), Value::u32(index)],
        )?;
        match rows.into_iter().next() {
            Some(mut row) => row.remove(0).into_blob(what),
            None => Err(StoreError::MissingRow(what, index)),
        }
    }

    fn lengths(
        &self,
        table: &str,
        column: &str,
        what: &'static str,
    ) -> Result<Vec<usize>, StoreError> {
        // Metadata only: `length(bytes)` never materializes the blobs.
        let rows = exec(
            &format!(
                "SELECT {column}, length(bytes) FROM {table} WHERE store = ?1 ORDER BY {column}"
            ),
            &[Value::u32(self.id)],
        )?;
        let mut out = Vec::with_capacity(rows.len());
        for row in rows {
            let index = row[0].as_u32(what)?;
            if index as usize != out.len() {
                return Err(StoreError::MissingRow(what, out.len() as u32));
            }
            out.push(row[1].as_u32("length")? as usize);
        }
        Ok(out)
    }

    fn write_section(&self, id: u32, payload: &[u8], hash: &[u8; 32]) -> Result<(), StoreError> {
        exec(
            "DELETE FROM ih_sections WHERE store = ?1 AND id = ?2",
            &[Value::u32(self.id), Value::u32(id)],
        )?;
        let mut chunks: Vec<&[u8]> = payload.chunks(SECTION_CHUNK_BYTES).collect();
        if chunks.is_empty() {
            chunks.push(&[]);
        }
        for (n, chunk) in chunks.into_iter().enumerate() {
            let hash: &[u8] = if n == 0 { &hash[..] } else { &[] };
            exec(
                "INSERT INTO ih_sections (store, id, chunk, bytes, hash) VALUES (?1, ?2, ?3, ?4, ?5)",
                &[
                    Value::u32(self.id),
                    Value::u32(id),
                    Value::u32(n as u32),
                    Value::Blob(chunk.to_vec()),
                    Value::Blob(hash.to_vec()),
                ],
            )?;
        }
        Ok(())
    }

    fn upsert(
        &self,
        table: &str,
        column: &str,
        index: u32,
        what: &'static str,
        bytes: &[u8],
    ) -> Result<(), StoreError> {
        cap(what, bytes)?;
        exec(
            &format!(
                "INSERT INTO {table} (store, {column}, bytes) VALUES (?1, ?2, ?3) \
                 ON CONFLICT(store, {column}) DO UPDATE SET bytes = excluded.bytes"
            ),
            &[
                Value::u32(self.id),
                Value::u32(index),
                Value::Blob(bytes.to_vec()),
            ],
        )?;
        Ok(())
    }

    fn truncate(&self, table: &str, column: &str, from: u32) -> Result<(), StoreError> {
        exec(
            &format!("DELETE FROM {table} WHERE store = ?1 AND {column} >= ?2"),
            &[Value::u32(self.id), Value::u32(from)],
        )?;
        Ok(())
    }

    /// Rewrite one row at rest, for the suite's offline-edit lock. The
    /// section edit stores the digest beside the payload, as the design's
    /// offline-edit rule asks.
    pub fn edit_row(&self, kind: &str, index: u32, new: &[u8]) -> Result<(), StoreError> {
        match kind {
            "slot page" => self.upsert("ih_slot_pages", "page", index, "slot page", new),
            "chunk extent" => self.upsert("ih_chunk_exts", "ext", index, "chunk extent", new),
            "free segment" => self.upsert("ih_free_segs", "seg", index, "free segment", new),
            "small section" => {
                let section = ironhorse_snapshot::store_sections::SmallSection::from_id(index)?;
                self.write_section(index, new, &section_hash(section, new))
            }
            "manifest" => {
                exec(
                    "INSERT INTO ih_meta (store, key, value) VALUES (?1, ?2, ?3) \
                     ON CONFLICT(store, key) DO UPDATE SET value = excluded.value",
                    &[
                        Value::u32(self.id),
                        Value::Text(META_MANIFEST.into()),
                        Value::Blob(new.to_vec()),
                    ],
                )?;
                Ok(())
            }
            other => Err(StoreError::Io(format!(
                "edit_row: unknown row kind {other}"
            ))),
        }
    }
}

impl HeapStore for DoStore {
    fn manifest(&self) -> Result<StoreManifest, StoreError> {
        self.stored_manifest()?.ok_or(StoreError::Empty)
    }

    fn read_small_state(&self) -> Result<Vec<u8>, StoreError> {
        if self.stored_manifest()?.is_none() {
            return Err(StoreError::Empty);
        }
        let rows = exec(
            "SELECT id, chunk, bytes FROM ih_sections WHERE store = ?1 ORDER BY id, chunk",
            &[Value::u32(self.id)],
        )?;
        let mut payloads: [Vec<u8>; SMALL_SECTION_COUNT] = std::array::from_fn(|_| Vec::new());
        let mut seen = [false; SMALL_SECTION_COUNT];
        let mut next_chunk = [0u32; SMALL_SECTION_COUNT];
        for mut row in rows {
            let id = row[0].as_u32("small section id")? as usize;
            if id >= SMALL_SECTION_COUNT {
                return Err(StoreError::Io("do sql: extra small sections".into()));
            }
            // The chunks of a section are 0, 1, 2, … by `(id, chunk)`; a gap
            // is a lost chunk, caught here rather than by the section codec.
            let chunk = row[1].as_u32("small section chunk")?;
            if chunk != next_chunk[id] {
                return Err(StoreError::Snapshot(SnapshotError::Corrupt(
                    "do sql: small section chunks are not contiguous",
                )));
            }
            next_chunk[id] += 1;
            seen[id] = true;
            payloads[id].extend_from_slice(&row.remove(2).into_blob("small section")?);
        }
        if let Some(id) = seen.iter().position(|present| !present) {
            return Err(StoreError::MissingRow("small section", id as u32));
        }
        frame_small_state(&std::array::from_fn(|id| payloads[id].as_slice()))
    }

    fn small_section_hashes(&self) -> Result<[[u8; 32]; SMALL_SECTION_COUNT], StoreError> {
        if self.stored_manifest()?.is_none() {
            return Err(StoreError::Empty);
        }
        let rows = exec(
            "SELECT id, hash FROM ih_sections WHERE store = ?1 AND chunk = 0 ORDER BY id",
            &[Value::u32(self.id)],
        )?;
        let mut hashes = [[0u8; 32]; SMALL_SECTION_COUNT];
        let mut rows = rows.into_iter();
        for (id, hash) in hashes.iter_mut().enumerate() {
            let mut row = rows
                .next()
                .ok_or(StoreError::MissingRow("small section hash", id as u32))?;
            if row[0].as_u32("small section id")? as usize != id {
                return Err(StoreError::MissingRow("small section hash", id as u32));
            }
            let bytes = row.remove(1).into_blob("small section hash")?;
            *hash = bytes
                .try_into()
                .map_err(|_| StoreError::Io("do sql: small section hash length".into()))?;
        }
        if rows.next().is_some() {
            return Err(StoreError::Io("do sql: extra small section hashes".into()));
        }
        Ok(hashes)
    }

    fn read_slot_page(&self, page: u32) -> Result<Vec<u8>, StoreError> {
        self.point_read("ih_slot_pages", "page", page, "slot page")
    }

    fn read_chunk_extent(&self, ext: u32) -> Result<Vec<u8>, StoreError> {
        self.point_read("ih_chunk_exts", "ext", ext, "chunk extent")
    }

    fn inventory(&self) -> Result<(Vec<usize>, Vec<usize>), StoreError> {
        let _ = self.manifest()?;
        Ok((
            self.lengths("ih_slot_pages", "page", "slot page")?,
            self.lengths("ih_chunk_exts", "ext", "chunk extent")?,
        ))
    }

    fn page_edges(&self) -> Result<Vec<Vec<u32>>, StoreError> {
        let Some(m) = self.stored_manifest()? else {
            return Err(StoreError::Empty);
        };
        let rows = exec(
            "SELECT page, targets FROM ih_page_edges WHERE store = ?1 ORDER BY page",
            &[Value::u32(self.id)],
        )?;
        let mut out: Vec<Vec<u32>> = Vec::with_capacity(rows.len());
        for mut row in rows {
            let page = row[0].as_u32("page edges")?;
            if page as usize != out.len() {
                return Err(StoreError::MissingRow("page edges", out.len() as u32));
            }
            let blob = row.remove(1).into_blob("page edges")?;
            if blob.len() % 4 != 0 {
                return Err(StoreError::Io("do sql: malformed page edges".into()));
            }
            out.push(
                blob.chunks_exact(4)
                    .map(|c| u32::from_be_bytes(c.try_into().unwrap()))
                    .collect(),
            );
        }
        let expected = slot_page_count(m.slot_count);
        if out.len() != expected as usize {
            return Err(StoreError::SummaryCount {
                expected,
                found: out.len() as u32,
            });
        }
        Ok(out)
    }

    fn read_free_seg(&self, seg: u32) -> Result<Vec<u8>, StoreError> {
        self.point_read("ih_free_segs", "seg", seg, "free segment")
    }

    /// Reads, then the shared verifier, then plain writes. No transaction
    /// statement is issued here: the host runs every export that commits
    /// (begin, import, a crank with its checkpoint) inside one
    /// `transactionSync`, and a failed status makes it throw so the callback
    /// rolls back. The acceptance suite's refusals all come from `verify`,
    /// before the first write; atomicity of a partial batch is the host's.
    fn commit_verified(&mut self, verify: &mut CommitVerifier<'_>) -> Result<(), StoreError> {
        let stored = self.stored_manifest()?;
        let batch = verify(stored.as_ref())?.batch();
        let pages = slot_page_count(batch.manifest.slot_count);
        let exts = chunk_extent_count(batch.manifest.chunk_len);
        let n_frees = free_seg_count(batch.manifest.free_len);

        for (page, bytes) in &batch.slot_pages {
            self.upsert("ih_slot_pages", "page", *page, "slot page", bytes)?;
        }
        for (ext, bytes) in &batch.chunk_extents {
            self.upsert("ih_chunk_exts", "ext", *ext, "chunk extent", bytes)?;
        }
        // Drop rows beyond the new geometry (the commit contract: a shrink
        // across a collection must not leave stale extents for a later,
        // larger geometry to resurrect).
        self.truncate("ih_slot_pages", "page", pages)?;
        self.truncate("ih_chunk_exts", "ext", exts)?;
        for (seg, bytes) in &batch.free_segs {
            self.upsert("ih_free_segs", "seg", *seg, "free segment", bytes)?;
        }
        self.truncate("ih_free_segs", "seg", n_frees)?;
        for (page, targets) in &batch.page_edges {
            let mut blob = Vec::with_capacity(targets.len() * 4);
            for t in targets {
                blob.extend_from_slice(&t.to_be_bytes());
            }
            cap("page edges", &blob)?;
            exec(
                "INSERT INTO ih_page_edges (store, page, targets) VALUES (?1, ?2, ?3) \
                 ON CONFLICT(store, page) DO UPDATE SET targets = excluded.targets",
                &[Value::u32(self.id), Value::u32(*page), Value::Blob(blob)],
            )?;
        }
        self.truncate("ih_page_edges", "page", pages)?;

        if stored.is_none() {
            // The first commit carries every section.
            let small = merge_framed(None, batch)?;
            let sections = split_small_state(&small)?;
            let leaves = SectionLeaves::from_payloads(&sections);
            for (id, payload) in sections.iter().enumerate() {
                self.write_section(id as u32, payload, &leaves.hashes()[id])?;
            }
        } else {
            for update in batch_updates(batch)? {
                let hash = section_hash(update.section, &update.bytes);
                self.write_section(update.section.id(), &update.bytes, &hash)?;
            }
        }
        exec(
            "INSERT INTO ih_meta (store, key, value) VALUES (?1, ?2, ?3) \
             ON CONFLICT(store, key) DO UPDATE SET value = excluded.value",
            &[
                Value::u32(self.id),
                Value::Text(META_MANIFEST.into()),
                Value::Blob(batch.manifest.encode()),
            ],
        )?;
        Ok(())
    }
}
