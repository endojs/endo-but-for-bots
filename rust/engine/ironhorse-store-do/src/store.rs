//! The store itself: six tables keyed by a store id, read and written through
//! the executor one statement at a time.
//!
//! ```sql
//! ih_meta        (store, key, value)             -- 'manifest', 'failure'; the 'IRON' stamp under store 0
//! ih_slot_pages  (store, page, bytes)
//! ih_chunk_exts  (store, ext, bytes)
//! ih_free_segs   (store, seg, bytes)
//! ih_page_edges  (store, page, targets)          -- big-endian u32s, as the SQLite backend stores them
//! ih_sections    (store, id, chunk, bytes, hash) -- small-state sections in chunks,
//!                                                -- the whole payload's digest on chunk 0
//! ```
//!
//! A section is stored as `len / chunk_bytes` full chunks followed by one
//! shorter final chunk, which is empty when the length is a multiple of the
//! chunk size (an empty payload is one empty chunk). Every chunk but the last
//! is therefore exactly the chunk size and the last is strictly shorter, so a
//! read detects a lost chunk wherever it was: a gap in the chunk numbers, a
//! chunk following a short one, or a section whose last chunk is full.

use ironhorse_snapshot::store::{
    check_migration_baseline, chunk_extent_count, free_seg_count, slot_page_count, CommitVerifier,
    HeapStore, StoreError, StoreManifest,
};
use ironhorse_snapshot::store_sections::{
    batch_updates, frame_small_state_at, merge_framed, section_count_at, section_hash,
    split_small_state, split_small_state_at, SmallSection, SECTIONED_SCHEMA, SMALL_SECTION_COUNT,
    WEAK_SECTIONS_SCHEMA,
};

use crate::{corrupt, SqlExecutor, Value};

/// The documented Durable Object per-value cap. Local workerd accepts
/// 4 MiB, so the store enforces the production figure itself.
pub const MAX_VALUE_BYTES: usize = 2_000_000;
/// The refusal for a value over [`MAX_VALUE_BYTES`]; the two are kept in
/// step by hand.
const CAP_REFUSAL: &str = "do sql: a value exceeds the 2,000,000-byte cap";
/// Small-state sections are stored in chunks of this size.
pub const SECTION_CHUNK_BYTES: usize = 1_000_000;

const META_MANIFEST: &str = "manifest";
const META_STAMP: &str = "stamp";
const META_FAILURE: &str = "failure";
const STAMP: &[u8] = b"IRON";
/// The database's own rows (the stamp) live under this id.
const DATABASE_ID: u32 = 0;

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

/// The marker a failure record ends with when its reason was cut to fit the
/// value cap.
pub(crate) const TRUNCATED: &str = " [truncated]";

/// Refuse a value over `limit` bytes, which the platform would not store.
/// Deterministic, so a refusal rather than a transient I/O error a
/// supervisor would retry.
fn cap(bytes: &[u8], limit: usize) -> Result<(), StoreError> {
    if bytes.len() > limit {
        return Err(StoreError::Unsupported(CAP_REFUSAL));
    }
    Ok(())
}

/// `reason` cut at a character boundary, with [`TRUNCATED`] after it, so the
/// whole is at most `limit` bytes; unchanged when it already fits.
pub(crate) fn fit_reason(reason: &str, limit: usize) -> std::borrow::Cow<'_, str> {
    if reason.len() <= limit {
        return reason.into();
    }
    let mut cut = limit.saturating_sub(TRUNCATED.len());
    while !reason.is_char_boundary(cut) {
        cut -= 1;
    }
    format!("{}{TRUNCATED}", &reason[..cut]).into()
}

/// A planned parameter: a small value of its own, or row bytes borrowed from
/// the batch or the small state they already live in, copied into a
/// [`Value::Blob`] only when its statement runs.
enum Param<'a> {
    Value(Value),
    Bytes(&'a [u8]),
}

impl From<Value> for Param<'_> {
    fn from(value: Value) -> Self {
        Param::Value(value)
    }
}

impl From<u32> for Param<'_> {
    fn from(n: u32) -> Self {
        Param::Value(n.into())
    }
}

/// Write statements collected before the first of them runs, so that every
/// refusal the store raises itself (a value over the cap, a framing or a
/// count it cannot store) arrives before anything is written. Once a plan
/// runs, only the executor can fail. It borrows the row bytes rather than
/// copying them, so a commit's peak is the batch plus one row.
struct Plan<'a> {
    limit: usize,
    statements: Vec<(&'static str, Vec<Param<'a>>)>,
}

impl<'a> Plan<'a> {
    fn new(limit: usize) -> Plan<'a> {
        Plan {
            limit,
            statements: Vec::new(),
        }
    }

    /// Add a statement, refusing any blob or text over the value cap: the
    /// same bytes the statement will bind.
    fn push(&mut self, sql: &'static str, params: Vec<Param<'a>>) -> Result<(), StoreError> {
        for param in &params {
            match param {
                Param::Bytes(bytes) => cap(bytes, self.limit)?,
                Param::Value(Value::Blob(bytes)) => cap(bytes, self.limit)?,
                Param::Value(Value::Text(text)) => cap(text.as_bytes(), self.limit)?,
                Param::Value(Value::Null | Value::Integer(_)) => {}
            }
        }
        self.statements.push((sql, params));
        Ok(())
    }
}

/// A row table's upsert and its delete beyond the geometry: one text per
/// table, shared by all its rows.
struct RowTable {
    upsert: &'static str,
    truncate: &'static str,
}

const SLOT_PAGES: RowTable = RowTable {
    upsert: "INSERT INTO ih_slot_pages (store, page, bytes) VALUES (?1, ?2, ?3) \
             ON CONFLICT(store, page) DO UPDATE SET bytes = excluded.bytes",
    truncate: "DELETE FROM ih_slot_pages WHERE store = ?1 AND page >= ?2",
};
const CHUNK_EXTS: RowTable = RowTable {
    upsert: "INSERT INTO ih_chunk_exts (store, ext, bytes) VALUES (?1, ?2, ?3) \
             ON CONFLICT(store, ext) DO UPDATE SET bytes = excluded.bytes",
    truncate: "DELETE FROM ih_chunk_exts WHERE store = ?1 AND ext >= ?2",
};
const FREE_SEGS: RowTable = RowTable {
    upsert: "INSERT INTO ih_free_segs (store, seg, bytes) VALUES (?1, ?2, ?3) \
             ON CONFLICT(store, seg) DO UPDATE SET bytes = excluded.bytes",
    truncate: "DELETE FROM ih_free_segs WHERE store = ?1 AND seg >= ?2",
};
const PAGE_EDGES: RowTable = RowTable {
    upsert: "INSERT INTO ih_page_edges (store, page, targets) VALUES (?1, ?2, ?3) \
             ON CONFLICT(store, page) DO UPDATE SET targets = excluded.targets",
    truncate: "DELETE FROM ih_page_edges WHERE store = ?1 AND page >= ?2",
};

/// A row with exactly `N` columns, or a corrupt answer.
fn columns<const N: usize>(row: Vec<Value>) -> Result<[Value; N], StoreError> {
    row.try_into()
        .map_err(|_| corrupt("do sql: a row has the wrong number of columns"))
}

/// The one row a keyed lookup answers, if any. Two rows for one primary key
/// contradict the schema.
fn at_most_one<const N: usize>(rows: Vec<Vec<Value>>) -> Result<Option<[Value; N]>, StoreError> {
    let mut rows = rows.into_iter();
    let first = rows.next().map(columns).transpose()?;
    if rows.next().is_some() {
        return Err(corrupt("do sql: a keyed lookup answered several rows"));
    }
    Ok(first)
}

fn text(s: &str) -> Value {
    Value::Text(s.to_owned())
}

/// Which of the store's tables the database already has, by name.
fn existing_tables<E: SqlExecutor>(executor: &E) -> Result<Vec<&'static str>, StoreError> {
    let rows = executor.exec(
        "SELECT name FROM sqlite_master WHERE type = 'table' \
         AND name IN (?1, ?2, ?3, ?4, ?5, ?6)",
        &TABLES.iter().map(|table| text(table)).collect::<Vec<_>>(),
    )?;
    let mut existing = Vec::with_capacity(rows.len());
    for row in rows {
        let [name] = columns(row)?;
        let table = match name {
            Value::Text(name) => TABLES.iter().find(|table| **table == name),
            _ => None,
        };
        existing.push(*table.ok_or_else(|| corrupt("do sql: an unexpected table name"))?);
    }
    Ok(existing)
}

/// A [`HeapStore`] over the SQL database an executor runs statements
/// against. See the crate documentation for the host contract.
///
/// Not `Clone`: the store has one writer, and a second handle on the same
/// store is a second, explicit [`DoStore::open`].
#[derive(Debug)]
pub struct DoStore<E: SqlExecutor> {
    executor: E,
    id: u32,
    chunk_bytes: usize,
    value_cap: usize,
}

impl<E: SqlExecutor> DoStore<E> {
    /// Check or write the database's stamp, create the schema if needed,
    /// and return a handle on store `id`, whose rows are left as they are: a
    /// populated store resumes, and a first checkpoint aimed at it refuses
    /// with [`StoreError::NotEmpty`]. The schema is not migrated here; the
    /// caller that knows the signature runs
    /// [`migrate_store`](ironhorse_snapshot::store::migrate_store).
    ///
    /// Id 0 holds the stamp and is refused. A database whose stamp is not
    /// `IRON` is foreign and refused as corrupt, and so is one with no stamp
    /// while any `ih_*` table holds a row (a lost stamp, or someone else's
    /// tables): only a database whose `ih_*` tables are absent or empty is
    /// stamped. Both refusals come before any write. Which `ih_*` tables
    /// exist is read from `sqlite_master` by name; the store never counts
    /// that table's rows, which on a Durable Object include the platform's
    /// own `_cf_*` tables.
    ///
    /// Known limit: a database with a table named `ih_meta` of another shape
    /// fails the stamp lookup itself, and that failure is the executor's own
    /// error, returned as it is (from rusqlite or the Durable Object host,
    /// [`StoreError::Io`]: classified transient, although a retry fails the
    /// same way). Telling a foreign shape from a failing medium would need
    /// the table's columns (`pragma_table_info`), which this crate does not
    /// read; a supervisor bounds its retries, as `StoreError::Io` asks.
    /// Nothing is written in that case either.
    pub fn open(executor: E, id: u32) -> Result<DoStore<E>, StoreError> {
        if id == DATABASE_ID {
            return Err(StoreError::Unsupported(
                "do sql: store id 0 holds the database's stamp",
            ));
        }
        let existing = existing_tables(&executor)?;
        let stamped = if existing.contains(&"ih_meta") {
            let stamp = executor.exec(
                "SELECT value FROM ih_meta WHERE store = ?1 AND key = ?2",
                &[DATABASE_ID.into(), text(META_STAMP)],
            )?;
            match at_most_one::<1>(stamp)? {
                None => false,
                Some([Value::Blob(found)]) if found == STAMP => true,
                Some(_) => return Err(corrupt("do sql: foreign database (stamp)")),
            }
        } else {
            false
        };
        if !stamped {
            for table in &existing {
                if !executor
                    .exec(&format!("SELECT 1 FROM {table} LIMIT 1"), &[])?
                    .is_empty()
                {
                    return Err(corrupt("do sql: foreign database (populated, unstamped)"));
                }
            }
        }
        for statement in SCHEMA {
            executor.exec(statement, &[])?;
        }
        if !stamped {
            executor.exec(
                "INSERT INTO ih_meta (store, key, value) VALUES (?1, ?2, ?3)",
                &[
                    DATABASE_ID.into(),
                    text(META_STAMP),
                    Value::Blob(STAMP.to_vec()),
                ],
            )?;
        }
        Ok(DoStore {
            executor,
            id,
            chunk_bytes: SECTION_CHUNK_BYTES,
            value_cap: MAX_VALUE_BYTES,
        })
    }

    /// The same store with its sections read and written in chunks of
    /// `bytes`, for tests that want many chunks without megabytes of state.
    /// A store written with one chunk size and read with another fails
    /// closed as corrupt (its full chunks are the wrong length).
    #[cfg(feature = "test-support")]
    pub fn with_section_chunk_bytes(mut self, bytes: usize) -> Result<DoStore<E>, StoreError> {
        if bytes == 0 || bytes > MAX_VALUE_BYTES {
            return Err(StoreError::Unsupported(
                "do sql: a section chunk size outside 1..=2,000,000 bytes",
            ));
        }
        self.chunk_bytes = bytes;
        Ok(self)
    }

    /// The same store with a value cap of `bytes` instead of
    /// [`MAX_VALUE_BYTES`], so tests reach the cap's refusals with small
    /// heaps. A cap below the chunk size refuses any section chunk over it.
    #[cfg(feature = "test-support")]
    pub fn with_value_cap(mut self, bytes: usize) -> Result<DoStore<E>, StoreError> {
        if bytes == 0 || bytes > MAX_VALUE_BYTES {
            return Err(StoreError::Unsupported(
                "do sql: a value cap outside 1..=2,000,000 bytes",
            ));
        }
        self.value_cap = bytes;
        Ok(self)
    }

    /// The store id this handle reads and writes.
    pub fn id(&self) -> u32 {
        self.id
    }

    /// Delete every row of this store, the failure record included, leaving
    /// a never-used store and every other store in the database untouched.
    /// For harnesses (the acceptance suite's fresh stores, a test host that
    /// reuses a database across runs); a production open never resets.
    pub fn reset_for_harness(&mut self) -> Result<(), StoreError> {
        for table in TABLES {
            self.exec(
                &format!("DELETE FROM {table} WHERE store = ?1"),
                &[self.id.into()],
            )?;
        }
        Ok(())
    }

    /// Record why this store's machine failed, for quarantine (Addendum A
    /// § 6.4; the review's "failure row committed outside the halted
    /// crank"). The host writes it in its own transaction after the failed
    /// crank's has rolled back, so it outlives that rollback.
    ///
    /// The first record wins: answers `true` when this call's reason is the
    /// one now stored, and `false` when a record was already there, which is
    /// left as it is, so the cause of a quarantine is not overwritten by what
    /// failed after it. A reason over [`MAX_VALUE_BYTES`] is cut at a
    /// character boundary and ends with `" [truncated]"`, so the cap never
    /// costs a record.
    ///
    /// The record lives beside the store and is no part of the heap: a
    /// commit and [`HeapStore::replace_for_migration`] leave it as it is,
    /// and only [`DoStore::reset_for_harness`] removes it; there is no other
    /// way to clear it. The store does not refuse anything because a record
    /// is present; that policy is the worker's.
    pub fn record_failure(&mut self, reason: &str) -> Result<bool, StoreError> {
        if self.failure()?.is_some() {
            return Ok(false);
        }
        let reason = fit_reason(reason, self.value_cap);
        let mut plan = Plan::new(self.value_cap);
        // A plain insert: the read above is the first-wins check, and a row
        // appearing in between (which the single writer rules out) fails
        // rather than reporting a record that was not stored.
        plan.push(
            "INSERT INTO ih_meta (store, key, value) VALUES (?1, ?2, ?3)",
            vec![
                self.id.into(),
                text(META_FAILURE).into(),
                Param::Bytes(reason.as_bytes()),
            ],
        )?;
        self.run(plan)?;
        Ok(true)
    }

    /// The failure recorded for this store, if any.
    pub fn failure(&self) -> Result<Option<String>, StoreError> {
        let rows = self.exec(
            "SELECT value FROM ih_meta WHERE store = ?1 AND key = ?2",
            &[self.id.into(), text(META_FAILURE)],
        )?;
        match at_most_one::<1>(rows)? {
            None => Ok(None),
            Some([value]) => String::from_utf8(value.into_blob()?)
                .map(Some)
                .map_err(|_| corrupt("do sql: the failure record is not UTF-8")),
        }
    }

    fn exec(&self, sql: &str, params: &[Value]) -> Result<Vec<Vec<Value>>, StoreError> {
        self.executor.exec(sql, params)
    }

    /// Run a plan's statements in order, each borrowed row copied into its
    /// statement's parameters only as that statement runs.
    fn run(&self, plan: Plan<'_>) -> Result<(), StoreError> {
        for (sql, params) in plan.statements {
            let params: Vec<Value> = params
                .into_iter()
                .map(|param| match param {
                    Param::Value(value) => value,
                    Param::Bytes(bytes) => Value::Blob(bytes.to_vec()),
                })
                .collect();
            self.exec(sql, &params)?;
        }
        Ok(())
    }

    fn stored_manifest(&self) -> Result<Option<StoreManifest>, StoreError> {
        let rows = self.exec(
            "SELECT value FROM ih_meta WHERE store = ?1 AND key = ?2",
            &[self.id.into(), text(META_MANIFEST)],
        )?;
        match at_most_one::<1>(rows)? {
            None => Ok(None),
            Some([value]) => Ok(Some(StoreManifest::decode(&value.into_blob()?)?)),
        }
    }

    fn plan_manifest(
        &self,
        plan: &mut Plan<'_>,
        manifest: &StoreManifest,
    ) -> Result<(), StoreError> {
        plan.push(
            "INSERT INTO ih_meta (store, key, value) VALUES (?1, ?2, ?3) \
             ON CONFLICT(store, key) DO UPDATE SET value = excluded.value",
            vec![
                self.id.into(),
                text(META_MANIFEST).into(),
                Value::Blob(manifest.encode()).into(),
            ],
        )
    }

    fn point_read(
        &self,
        table: &str,
        column: &str,
        index: u32,
        what: &'static str,
    ) -> Result<Vec<u8>, StoreError> {
        // Empty-store gate for point-read parity with the other backends: an
        // uncommitted store is `Empty`; `MissingRow` means a committed store
        // lacks the row.
        if self.stored_manifest()?.is_none() {
            return Err(StoreError::Empty);
        }
        let rows = self.exec(
            &format!("SELECT bytes FROM {table} WHERE store = ?1 AND {column} = ?2"),
            &[self.id.into(), index.into()],
        )?;
        match at_most_one::<1>(rows)? {
            Some([bytes]) => bytes.into_blob(),
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
        let rows = self.exec(
            &format!(
                "SELECT {column}, length(bytes) FROM {table} WHERE store = ?1 ORDER BY {column}"
            ),
            &[self.id.into()],
        )?;
        let mut out = Vec::with_capacity(rows.len());
        for row in rows {
            let [index, length] = columns(row)?;
            let index = index.into_u32()?;
            // Ordered and unique, so the first index that is not the next
            // one names a row the table lacks.
            let next = u32::try_from(out.len())
                .map_err(|_| corrupt("do sql: more rows than u32 indexes"))?;
            if index != next {
                return Err(StoreError::MissingRow(what, next));
            }
            out.push(length.into_u32()? as usize);
        }
        Ok(out)
    }

    /// Replace section `id` with `payload` in chunks, the whole payload's
    /// digest on chunk 0 (see the module documentation for the layout).
    fn plan_section<'a>(
        &self,
        plan: &mut Plan<'a>,
        id: u32,
        payload: &'a [u8],
        hash: &[u8; 32],
    ) -> Result<(), StoreError> {
        plan.push(
            "DELETE FROM ih_sections WHERE store = ?1 AND id = ?2",
            vec![self.id.into(), id.into()],
        )?;
        let full = payload.len() / self.chunk_bytes;
        for n in 0..=full {
            let start = n * self.chunk_bytes;
            let end = payload.len().min(start + self.chunk_bytes);
            let chunk = u32::try_from(n)
                .map_err(|_| StoreError::Unsupported("do sql: a section of over u32 chunks"))?;
            let hash = if n == 0 { hash.to_vec() } else { Vec::new() };
            plan.push(
                "INSERT INTO ih_sections (store, id, chunk, bytes, hash) VALUES (?1, ?2, ?3, ?4, ?5)",
                vec![
                    self.id.into(),
                    id.into(),
                    chunk.into(),
                    Param::Bytes(&payload[start..end]),
                    Value::Blob(hash).into(),
                ],
            )?;
        }
        Ok(())
    }

    /// Replace every section with those of a framed small state, and drop
    /// any section row beyond the ones it carries.
    fn plan_sections<'a>(
        &self,
        plan: &mut Plan<'a>,
        sections: &[&'a [u8]],
    ) -> Result<(), StoreError> {
        for (id, payload) in sections.iter().enumerate() {
            let section = SmallSection::from_id(id as u32)?;
            self.plan_section(plan, section.id(), payload, &section_hash(section, payload))?;
        }
        plan.push(
            "DELETE FROM ih_sections WHERE store = ?1 AND id >= ?2",
            vec![self.id.into(), Value::Integer(sections.len() as i64).into()],
        )
    }

    /// The `count` section payloads, reassembled from their chunks and
    /// checked against the layout: contiguous ids from 0, contiguous chunks
    /// from 0, every chunk but the last full and the last short.
    fn read_sections(&self, count: usize) -> Result<Vec<Vec<u8>>, StoreError> {
        const LOST: &str = "do sql: a small section lost a chunk";
        let rows = self.exec(
            "SELECT id, chunk, bytes FROM ih_sections WHERE store = ?1 ORDER BY id, chunk",
            &[self.id.into()],
        )?;
        let mut payloads: Vec<Vec<u8>> = Vec::with_capacity(count);
        // The chunk number the current section expects next, and whether
        // its last chunk was full (so that another must follow).
        let mut next_chunk = 0u32;
        let mut open = false;
        for row in rows {
            let [id, chunk, bytes] = columns(row)?;
            let (id, chunk, bytes) = (
                id.into_u32()? as usize,
                chunk.into_u32()?,
                bytes.into_blob()?,
            );
            if id >= count {
                return Err(corrupt("do sql: extra small sections"));
            }
            if bytes.len() > self.chunk_bytes {
                return Err(corrupt(
                    "do sql: a small section chunk exceeds the chunk size",
                ));
            }
            if chunk == 0 {
                if open {
                    return Err(corrupt(LOST));
                }
                if id != payloads.len() {
                    // Ordered by id, so a skipped id is a section with no
                    // chunk 0 at all.
                    return Err(StoreError::MissingRow(
                        "small section",
                        payloads.len() as u32,
                    ));
                }
                payloads.push(Vec::new());
            } else if !open || Some(id) != payloads.len().checked_sub(1) || chunk != next_chunk {
                return Err(corrupt(LOST));
            }
            next_chunk = chunk
                .checked_add(1)
                .ok_or_else(|| corrupt("do sql: a small section chunk number overflows"))?;
            open = bytes.len() == self.chunk_bytes;
            if let Some(payload) = payloads.last_mut() {
                payload.extend_from_slice(&bytes);
            }
        }
        if open {
            return Err(corrupt(LOST));
        }
        if payloads.len() < count {
            return Err(StoreError::MissingRow(
                "small section",
                payloads.len() as u32,
            ));
        }
        Ok(payloads)
    }
}

impl<E: SqlExecutor> HeapStore for DoStore<E> {
    fn manifest(&self) -> Result<StoreManifest, StoreError> {
        self.stored_manifest()?.ok_or(StoreError::Empty)
    }

    /// The sections the stored schema frames, reassembled and framed. The
    /// stored digests are not re-derived: under the store-seam design's trust
    /// model they are change detection only (`validate_store_content`
    /// re-derives them).
    fn read_small_state(&self) -> Result<Vec<u8>, StoreError> {
        let manifest = self.stored_manifest()?.ok_or(StoreError::Empty)?;
        if manifest.store_schema < SECTIONED_SCHEMA {
            return Err(corrupt(
                "do sql: a store schema before 28, which this backend never writes",
            ));
        }
        let payloads = self.read_sections(section_count_at(manifest.store_schema))?;
        let refs: Vec<&[u8]> = payloads.iter().map(Vec::as_slice).collect();
        frame_small_state_at(&refs, manifest.store_schema)
    }

    /// The digests from chunk 0 of each section, without the payloads.
    fn small_section_hashes(&self) -> Result<[[u8; 32]; SMALL_SECTION_COUNT], StoreError> {
        let manifest = self.stored_manifest()?.ok_or(StoreError::Empty)?;
        // The inventory is this build's roster; a store at an older schema
        // frames fewer sections, and only the migration ladder reads it.
        if manifest.store_schema < WEAK_SECTIONS_SCHEMA {
            return Err(StoreError::NeedsMigration {
                found: manifest.store_schema,
            });
        }
        let rows = self.exec(
            "SELECT id, hash FROM ih_sections WHERE store = ?1 AND chunk = 0 ORDER BY id",
            &[self.id.into()],
        )?;
        let mut hashes = [[0u8; 32]; SMALL_SECTION_COUNT];
        let mut rows = rows.into_iter();
        for (id, hash) in hashes.iter_mut().enumerate() {
            let row = rows
                .next()
                .ok_or(StoreError::MissingRow("small section hash", id as u32))?;
            let [found, bytes] = columns(row)?;
            if found.into_u32()? as usize != id {
                return Err(StoreError::MissingRow("small section hash", id as u32));
            }
            *hash = bytes
                .into_blob()?
                .try_into()
                .map_err(|_| corrupt("do sql: a small section digest is not 32 bytes"))?;
        }
        if rows.next().is_some() {
            return Err(corrupt("do sql: extra small section digests"));
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
        let manifest = self.manifest()?;
        let rows = self.exec(
            "SELECT page, targets FROM ih_page_edges WHERE store = ?1 ORDER BY page",
            &[self.id.into()],
        )?;
        let mut out: Vec<Vec<u32>> = Vec::with_capacity(rows.len());
        for row in rows {
            let [page, targets] = columns(row)?;
            let next = u32::try_from(out.len())
                .map_err(|_| corrupt("do sql: more rows than u32 indexes"))?;
            if page.into_u32()? != next {
                return Err(StoreError::MissingRow("page edges", next));
            }
            let blob = targets.into_blob()?;
            if blob.len() % 4 != 0 {
                return Err(corrupt("do sql: malformed page edges"));
            }
            out.push(
                blob.chunks_exact(4)
                    .map(|c| u32::from_be_bytes([c[0], c[1], c[2], c[3]]))
                    .collect(),
            );
        }
        let expected = slot_page_count(manifest.slot_count);
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

    /// Reads, then the shared verifier, then every statement planned, then
    /// plain writes. Every refusal the store raises itself (the value cap,
    /// the section framing) comes from the plan, before the first write, so
    /// once writing starts only the executor can fail. No transaction
    /// statement is issued: the host runs each commit inside one transaction
    /// of its own and rolls it back when this fails, and that transaction is
    /// the commit's atomicity (see the crate's host contract).
    fn commit_verified(&mut self, verify: &mut CommitVerifier<'_>) -> Result<(), StoreError> {
        let stored = self.stored_manifest()?;
        let batch = verify(stored.as_ref())?.batch();
        let pages = slot_page_count(batch.manifest.slot_count);
        let exts = chunk_extent_count(batch.manifest.chunk_len);
        let frees = free_seg_count(batch.manifest.free_len);
        // What the plan borrows from, bound before it: the first commit's
        // framed small state, or a later commit's section updates.
        let first = match stored {
            None => Some(merge_framed(None, batch)?),
            Some(_) => None,
        };
        let updates = match stored {
            None => Vec::new(),
            Some(_) => batch_updates(batch)?,
        };
        let mut plan = Plan::new(self.value_cap);

        for (table, rows) in [
            (SLOT_PAGES, &batch.slot_pages),
            (CHUNK_EXTS, &batch.chunk_extents),
            (FREE_SEGS, &batch.free_segs),
        ] {
            for (index, bytes) in rows {
                plan.push(
                    table.upsert,
                    vec![self.id.into(), (*index).into(), Param::Bytes(bytes)],
                )?;
            }
        }
        for (page, targets) in &batch.page_edges {
            let mut blob = Vec::with_capacity(targets.len() * 4);
            for target in targets {
                blob.extend_from_slice(&target.to_be_bytes());
            }
            plan.push(
                PAGE_EDGES.upsert,
                vec![self.id.into(), (*page).into(), Value::Blob(blob).into()],
            )?;
        }
        // Drop rows beyond the new geometry: a shrink across a collection
        // must not leave stale rows for a later, larger geometry to
        // resurrect (the commit contract).
        for (table, from) in [
            (SLOT_PAGES, pages),
            (CHUNK_EXTS, exts),
            (FREE_SEGS, frees),
            (PAGE_EDGES, pages),
        ] {
            plan.push(table.truncate, vec![self.id.into(), from.into()])?;
        }

        if let Some(small) = &first {
            // The first commit carries every section.
            self.plan_sections(&mut plan, &split_small_state(small)?)?;
        } else {
            for update in &updates {
                let hash = section_hash(update.section, &update.bytes);
                self.plan_section(&mut plan, update.section.id(), &update.bytes, &hash)?;
            }
        }
        self.plan_manifest(&mut plan, &batch.manifest)?;
        self.run(plan)
    }

    /// The durable manifest must still be `from`; then `to` and the small
    /// state, framed at `to`'s schema, replace it with plain statements,
    /// planned in full after the comparison and before the first write,
    /// inside the host's transaction like a commit.
    /// This backend never kept row-leaf hashes, so there are none to drop,
    /// and the failure record is left as it is.
    ///
    /// A `to` before schema 28 is refused with [`StoreError::Unsupported`]
    /// before anything is written: such a schema frames the small state
    /// whole, a layout this backend has never held. `migrate_store` always
    /// writes the current schema; only a fixture restamping a store
    /// backwards asks for an older one, and a sectioned one (28 on) is
    /// stored at its own section count.
    fn replace_for_migration(
        &mut self,
        from: &StoreManifest,
        to: &StoreManifest,
        small: &[u8],
    ) -> Result<(), StoreError> {
        let durable = self.stored_manifest()?.ok_or(StoreError::Empty)?;
        check_migration_baseline(&durable, from)?;
        if to.store_schema < SECTIONED_SCHEMA {
            return Err(StoreError::Unsupported(
                "do sql: a small state framed whole (a store schema before 28)",
            ));
        }
        let sections = split_small_state_at(small, to.store_schema)?;
        let mut plan = Plan::new(self.value_cap);
        self.plan_sections(&mut plan, &sections)?;
        self.plan_manifest(&mut plan, to)?;
        self.run(plan)
    }
}

#[cfg(test)]
mod tests;
