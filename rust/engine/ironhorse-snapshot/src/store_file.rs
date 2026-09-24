//! [`FileStore`]: the single-file, pure-Rust reference [`HeapStore`]
//! (design `designs/ironhorse-snapshot-store-seam.md` § The seam is
//! three layers). It proves the trait against a durable medium with
//! **lazy point reads** — a page read seeks straight to its blob — and
//! an **atomic commit**: the whole file is rewritten to a temp path
//! (dirty rows from the batch, clean rows streamed from the previous
//! file) and renamed into place, so a torn checkpoint leaves the prior
//! epoch intact.
//!
//! Commit I/O is therefore O(store), while commit *encoding* work is
//! O(dirty) — the honest reference trade-off. The store whose commit
//! I/O is also O(dirty) is the daemon-side SQLite backend, which
//! updates rows in place under WAL; this file format deliberately does
//! not chase that property, it exists to pin the semantics every
//! backend must match (epoch discipline, geometry drop, byte-exact
//! rows) in `forbid(unsafe_code)` std-only Rust.
//!
//! # Writer scope
//!
//! This reference backend requires a single writer: callers must serialize
//! simultaneous commits and migrations on one path. Reopening/reloading detects
//! stale sequential handles; it is not a cross-process writer lock. Production
//! multi-writer stores use SQLite's transaction isolation.
//!
//! # On-disk layout (`FILE_MAGIC`, all integers big-endian)
//!
//! ```text
//! [8]  magic (the current `FILE_MAGIC` — version-suffixed)
//! [4]  manifest length   [..] manifest (StoreManifest::encode)
//! [4]  small length      [..] small state (SmallState::encode)
//! [4]  slot-page count   [4] chunk-extent count
//! [page directory: count × (u64 offset, u32 length)]
//! [extent directory: count × (u64 offset, u32 length)]
//! [page edges: count × (u32 len, len × u32 targets)]
//! [free segments: u32 count, then count × (u32 len, len bytes)]
//! [blobs, in directory order]
//! ```
//!
//! The directories are read (with reservation clamps against the file
//! size — the malformed-count discipline) at open; reads then seek by
//! directory entry. A missing file is an [`StoreError::Empty`] store,
//! not an error, so `open` serves both the create and reopen paths.
//!
//! The layout before store schema 36, [`LEGACY_FILE_MAGIC`], also carried
//! the row-leaf hashes: 32 bytes per slot page and then per chunk extent
//! after the directories, and 32 per free segment after the segments.
//! `open` reads it, skipping the hashes, so that
//! [`crate::store::migrate_store`] can upgrade the file, which it rewrites
//! in the current layout. Nothing writes it.

#[cfg(test)]
use crate::store::HeapStoreCommit;
use std::cell::RefCell;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::PathBuf;

use crate::format::SnapshotError;
use crate::store::{
    check_migration_baseline, chunk_extent_count, slot_page_count, CommitVerifier, HeapStore,
    StoreError, StoreManifest,
};

/// The file-format discriminator — the LAYOUT version. A layout
/// change (sections, directories) is a new magic and a reader fails
/// closed on one it does not know. The STORE SCHEMA does not ride
/// the magic: it travels in the manifest's `store_schema` field, gated by
/// the supported range and migrated forward in place by
/// [`crate::store::migrate_store`], which the opener runs explicitly (it
/// gates the restamp on the callback-table signature `open` does not
/// know). "6" is the layout without row-leaf hashes (store schema 36).
pub const FILE_MAGIC: [u8; 8] = *b"IHSTORE6";

/// The layout of store schemas 5 through 35, with row-leaf hashes. Read
/// for migration only; see the module docs.
pub const LEGACY_FILE_MAGIC: [u8; 8] = *b"IHSTORE5";

/// Temp files are uniquely named per process and per commit
/// (`.tmp-{pid}-{n}`), so two writers can never interleave bytes in a
/// shared temp inode. Leftover temps from torn commits are inert
/// (`open` never reads them).
/// Cross-process last-rename-wins remains bounded by the documented
/// single-writer-per-path model plus the durable succession check —
/// a lost lineage is detected at its next commit by its commit token,
/// never silently merged.
static TMP_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct DirEntry {
    offset: u64,
    length: u32,
}

/// The decoded header the reads navigate by.
#[derive(Debug)]
struct Loaded {
    manifest: StoreManifest,
    small: Vec<u8>,
    pages: Vec<DirEntry>,
    extents: Vec<DirEntry>,
    edges: Vec<Vec<u32>>,
    free_segs: Vec<Vec<u8>>,
}

/// Where one slot page or chunk extent of a file being written comes
/// from: bytes in hand, or a row of the durable previous file.
enum Row<'a> {
    New(&'a [u8]),
    Prior(DirEntry),
}

impl Row<'_> {
    fn len(&self) -> u32 {
        match self {
            // The writers bound new rows with `row_len` first.
            Row::New(bytes) => bytes.len() as u32,
            Row::Prior(entry) => entry.length,
        }
    }
}

/// Everything one store file holds, in the current layout. Commit and
/// migration both write through this, so their layouts cannot drift.
struct Layout<'a> {
    manifest: Vec<u8>,
    small: &'a [u8],
    pages: Vec<Row<'a>>,
    extents: Vec<Row<'a>>,
    edges: &'a [Vec<u32>],
    free_segs: &'a [Vec<u8>],
}

impl Layout<'_> {
    /// Write the file to `out`, streaming each prior row from `prior`.
    fn write(&self, out: &mut File, prior: Option<&RefCell<File>>) -> Result<(), StoreError> {
        let rows = || self.pages.iter().chain(&self.extents);
        let edges_bytes: u64 = self.edges.iter().map(|ts| 4 + 4 * ts.len() as u64).sum();
        let free_bytes: u64 = 4 + self
            .free_segs
            .iter()
            .map(|b| 4 + b.len() as u64)
            .sum::<u64>();
        // Directory offsets are absolute, so the header's length comes
        // first.
        let n_rows = (self.pages.len() + self.extents.len()) as u64;
        let header_len = 8
            + 4
            + self.manifest.len() as u64
            + 4
            + self.small.len() as u64
            + 4
            + 4
            + 12 * n_rows
            + edges_bytes
            + free_bytes;
        out.write_all(&FILE_MAGIC).map_err(io_err)?;
        out.write_all(&(self.manifest.len() as u32).to_be_bytes())
            .map_err(io_err)?;
        out.write_all(&self.manifest).map_err(io_err)?;
        out.write_all(&(self.small.len() as u32).to_be_bytes())
            .map_err(io_err)?;
        out.write_all(self.small).map_err(io_err)?;
        out.write_all(&(self.pages.len() as u32).to_be_bytes())
            .map_err(io_err)?;
        out.write_all(&(self.extents.len() as u32).to_be_bytes())
            .map_err(io_err)?;
        let mut cursor = header_len;
        for row in rows() {
            out.write_all(&cursor.to_be_bytes()).map_err(io_err)?;
            out.write_all(&row.len().to_be_bytes()).map_err(io_err)?;
            cursor += row.len() as u64;
        }
        for ts in self.edges {
            out.write_all(&(ts.len() as u32).to_be_bytes())
                .map_err(io_err)?;
            for t in ts {
                out.write_all(&t.to_be_bytes()).map_err(io_err)?;
            }
        }
        out.write_all(&(self.free_segs.len() as u32).to_be_bytes())
            .map_err(io_err)?;
        for b in self.free_segs {
            out.write_all(&(b.len() as u32).to_be_bytes())
                .map_err(io_err)?;
            out.write_all(b).map_err(io_err)?;
        }
        for row in rows() {
            match row {
                Row::New(bytes) => out.write_all(bytes).map_err(io_err)?,
                Row::Prior(entry) => {
                    // Stream the clean row from the durable previous file.
                    let file = prior.expect("a prior row implies a prior file");
                    let mut f = file.borrow_mut();
                    f.seek(SeekFrom::Start(entry.offset)).map_err(io_err)?;
                    let mut buf = vec![0u8; entry.length as usize];
                    f.read_exact(&mut buf).map_err(io_err)?;
                    drop(f);
                    out.write_all(&buf).map_err(io_err)?;
                }
            }
        }
        Ok(())
    }
}

/// The single-file reference store. See the module docs.
#[derive(Debug)]
pub struct FileStore {
    path: PathBuf,
    /// `None` until the first commit (an empty store). The open file
    /// handle rides along so point reads reuse it; it is replaced
    /// whenever a commit renames a fresh file into place.
    state: Option<(Loaded, RefCell<File>)>,
}

fn io_err(e: std::io::Error) -> StoreError {
    StoreError::Io(e.to_string())
}

// Keep wire-size conversion separate from row allocation so its full usize
// domain can be checked without constructing an oversized buffer.
fn row_len(len: usize, what: &'static str) -> Result<u32, StoreError> {
    u32::try_from(len).map_err(|_| file_corrupt(what))
}

fn file_corrupt(what: &'static str) -> StoreError {
    StoreError::Snapshot(SnapshotError::Corrupt(what))
}

impl FileStore {
    /// Write a whole store file through `layout` — unique temp, fsync,
    /// rename, directory sync — then reload the in-memory view from the
    /// renamed file. Commit and migration share this, so their atomicity
    /// cannot drift.
    fn replace_file(
        &mut self,
        layout: &Layout<'_>,
        prior: Option<&RefCell<File>>,
    ) -> Result<(), StoreError> {
        let tmp_path = {
            let mut os = self.path.clone().into_os_string();
            os.push(format!(
                ".tmp-{}-{}",
                std::process::id(),
                TMP_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            ));
            PathBuf::from(os)
        };
        // Stage the whole new file; on ANY failure remove the temp so
        // a flaky disk does not accumulate `.tmp-*` litter beside the
        // store. Leftovers are inert but can accumulate across retries.
        let write_tmp = || -> Result<(), StoreError> {
            let mut tmp = File::create(&tmp_path).map_err(io_err)?;
            layout.write(&mut tmp, prior)?;
            tmp.sync_all().map_err(io_err)?;
            Ok(())
        };
        if let Err(e) = write_tmp() {
            let _ = std::fs::remove_file(&tmp_path);
            return Err(e);
        }
        if let Err(e) = std::fs::rename(&tmp_path, &self.path) {
            // A failed RENAME must clean up like a failed write does:
            // the tmp file is inert litter (opens ignore it) but
            // unbounded across retries. See
            // `failed_rename_removes_the_temp_file`.
            let _ = std::fs::remove_file(&tmp_path);
            return Err(io_err(e));
        }
        // The rename is the commit point, and it is durable only once
        // the containing directory is synced: an acknowledged checkpoint
        // must not roll back on crash.
        // `Path::parent()` returns `Some("")` for a bare relative
        // filename, and opening "" fails ENOENT AFTER the rename — a
        // durable commit misreported as failed, wedging the session
        // one epoch behind its own file. An empty parent means the
        // current directory.
        let dir = match self.path.parent() {
            Some(p) if !p.as_os_str().is_empty() => p,
            _ => std::path::Path::new("."),
        };
        File::open(dir).and_then(|d| d.sync_all()).map_err(io_err)?;
        // Reopen and re-decode: the in-memory view always reflects the
        // durable file, never a shadow copy that could drift.
        let mut file = File::open(&self.path).map_err(io_err)?;
        let loaded = Self::load(&mut file)?;
        self.state = Some((loaded, RefCell::new(file)));
        Ok(())
    }

    /// The durable file, decoded afresh, or `None` when there is none.
    fn load_durable(&self) -> Result<Option<(Loaded, RefCell<File>)>, StoreError> {
        if !self.path.exists() {
            return Ok(None);
        }
        let mut f = File::open(&self.path).map_err(io_err)?;
        let l = Self::load(&mut f)?;
        Ok(Some((l, RefCell::new(f))))
    }

    /// Open the store at `path`. An absent file is a valid empty store
    /// (its first commit creates the file); a present file has its
    /// header and directories decoded and checked immediately, so a
    /// foreign or truncated file fails closed here rather than on a
    /// later fault.
    ///
    /// Open does NOT migrate: an older but decodable store opens as-is
    /// and the caller upgrades it with [`crate::store::migrate_store`],
    /// which gates the restamp on the callback-table signature.
    /// Resuming without migrating first fails closed with
    /// [`StoreError::NeedsMigration`].
    pub fn open(path: impl Into<PathBuf>) -> Result<FileStore, StoreError> {
        let path = path.into();
        if !path.exists() {
            return Ok(FileStore { path, state: None });
        }
        let mut file = File::open(&path).map_err(io_err)?;
        let loaded = Self::load(&mut file)?;
        Ok(FileStore {
            path,
            state: Some((loaded, RefCell::new(file))),
        })
    }

    /// Decode the header and directories of an existing store file.
    fn load(file: &mut File) -> Result<Loaded, StoreError> {
        let file_len = file.metadata().map_err(io_err)?.len();
        let mut header = [0u8; 8];
        file.seek(SeekFrom::Start(0)).map_err(io_err)?;
        file.read_exact(&mut header)
            .map_err(|_| file_corrupt("file store header truncated"))?;
        let legacy = header == LEGACY_FILE_MAGIC;
        if !legacy && header != FILE_MAGIC {
            return Err(file_corrupt("file store magic"));
        }

        let read_u32 = |file: &mut File| -> Result<u32, StoreError> {
            let mut b = [0u8; 4];
            file.read_exact(&mut b)
                .map_err(|_| file_corrupt("file store header truncated"))?;
            Ok(u32::from_be_bytes(b))
        };
        let read_block = |file: &mut File, what: &'static str| -> Result<Vec<u8>, StoreError> {
            let len = {
                let mut b = [0u8; 4];
                file.read_exact(&mut b).map_err(|_| file_corrupt(what))?;
                u32::from_be_bytes(b) as usize
            };
            // Clamp the reservation to what the file can hold before
            // trusting the length (malformed-count discipline).
            if (len as u64) > file_len {
                return Err(file_corrupt(what));
            }
            let mut buf = vec![0u8; len];
            file.read_exact(&mut buf).map_err(|_| file_corrupt(what))?;
            Ok(buf)
        };
        // The legacy layout's leaf hashes: skipped, but they must be
        // there, 32 bytes per row.
        let skip_leaves = |file: &mut File, n: u64, what: &'static str| -> Result<(), StoreError> {
            let len = n * 32;
            let at = file.stream_position().map_err(io_err)?;
            if at.checked_add(len).is_none_or(|end| end > file_len) {
                return Err(file_corrupt(what));
            }
            file.seek(SeekFrom::Current(len as i64)).map_err(io_err)?;
            Ok(())
        };

        let manifest_bytes = read_block(file, "file store manifest block")?;
        let manifest = StoreManifest::decode(&manifest_bytes)?;
        let small = read_block(file, "file store small-state block")?;

        let n_pages = read_u32(file)? as u64;
        let n_exts = read_u32(file)? as u64;
        // Each directory entry is 12 bytes; a count the file cannot
        // hold is corruption, refused before any reservation.
        if (n_pages + n_exts) * 12 > file_len {
            return Err(file_corrupt("file store directory truncated"));
        }
        let mut read_dir = |n: u64| -> Result<Vec<DirEntry>, StoreError> {
            let mut dir = Vec::with_capacity(n as usize);
            for _ in 0..n {
                let mut b = [0u8; 12];
                file.read_exact(&mut b)
                    .map_err(|_| file_corrupt("file store directory truncated"))?;
                let offset = u64::from_be_bytes(b[0..8].try_into().unwrap());
                let length = u32::from_be_bytes(b[8..12].try_into().unwrap());
                let end = offset
                    .checked_add(length as u64)
                    .ok_or_else(|| file_corrupt("file store directory entry overflows"))?;
                if end > file_len {
                    return Err(file_corrupt("file store directory entry out of range"));
                }
                dir.push(DirEntry { offset, length });
            }
            Ok(dir)
        };
        let pages = read_dir(n_pages)?;
        let extents = read_dir(n_exts)?;
        if legacy {
            skip_leaves(file, n_pages + n_exts, "file store leaf hashes truncated")?;
        }

        // Page-edge summaries: u32 length + targets per
        // page, with the same clamp discipline. The OUTER vector
        // grows against real reads — a `with_capacity(n)` here would
        // reserve 24 bytes per counted entry against a 4-byte-per-
        // entry clamp. Reservation amplification must be bounded by
        // the encoded bytes, as in the free-segment read below.
        let mut edges: Vec<Vec<u32>> = Vec::new();
        for _ in 0..n_pages {
            let len = read_u32(file)? as u64;
            if len * 4 > file_len {
                return Err(file_corrupt("file store page edges truncated"));
            }
            let mut ts = Vec::with_capacity(len as usize);
            for _ in 0..len {
                ts.push(read_u32(file)?);
            }
            edges.push(ts);
        }

        // Free-list segments, clamp-checked; the outer vector grows
        // against real reads (see the edges note).
        let n_frees = read_u32(file)? as u64;
        if n_frees * 4 > file_len {
            return Err(file_corrupt("file store free segments truncated"));
        }
        let mut free_segs: Vec<Vec<u8>> = Vec::new();
        for _ in 0..n_frees {
            let len = read_u32(file)? as u64;
            if len > file_len {
                return Err(file_corrupt("file store free segments truncated"));
            }
            let mut b = vec![0u8; len as usize];
            file.read_exact(&mut b)
                .map_err(|_| file_corrupt("file store free segments truncated"))?;
            free_segs.push(b);
        }
        if legacy {
            skip_leaves(file, n_frees, "file store free leaf hashes truncated")?;
        }

        // The directories must cover exactly the manifest's geometry —
        // the same promise the row inventory of `validate_store`
        // re-checks with lengths. Pages, extents, and free segments
        // all receive this check at open time; see
        // `file_metadata_has_exact_refusals`.
        if pages.len() != slot_page_count(manifest.slot_count) as usize {
            return Err(file_corrupt(
                "file store page directory disagrees with geometry",
            ));
        }
        if extents.len() != chunk_extent_count(manifest.chunk_len) as usize {
            return Err(file_corrupt(
                "file store extent directory disagrees with geometry",
            ));
        }
        if free_segs.len() != crate::store::free_seg_count(manifest.free_len) as usize {
            return Err(file_corrupt(
                "file store free segments disagree with geometry",
            ));
        }

        Ok(Loaded {
            manifest,
            small,
            pages,
            extents,
            edges,
            free_segs,
        })
    }

    fn read_entry(&self, is_page: bool, index: u32) -> Result<Vec<u8>, StoreError> {
        let (loaded, file) = self.state.as_ref().ok_or(StoreError::Empty)?;
        let (dir, kind) = if is_page {
            (&loaded.pages, "slot page")
        } else {
            (&loaded.extents, "chunk extent")
        };
        let entry = dir
            .get(index as usize)
            .copied()
            .ok_or(StoreError::MissingRow(kind, index))?;
        let mut f = file.borrow_mut();
        f.seek(SeekFrom::Start(entry.offset)).map_err(io_err)?;
        let mut buf = vec![0u8; entry.length as usize];
        f.read_exact(&mut buf).map_err(io_err)?;
        Ok(buf)
    }
}

impl HeapStore for FileStore {
    fn manifest(&self) -> Result<StoreManifest, StoreError> {
        self.state
            .as_ref()
            .map(|(l, _)| l.manifest.clone())
            .ok_or(StoreError::Empty)
    }

    /// `open` reads the header once and `manifest()` serves that copy,
    /// so a handle opened before another
    /// process upgraded the file would otherwise decide a ladder step
    /// from a schema the file no longer has. Re-reads
    /// the header off disk.
    fn reread_manifest(&self) -> Result<StoreManifest, StoreError> {
        if !self.path.exists() {
            return Err(StoreError::Empty);
        }
        let mut file = File::open(&self.path).map_err(io_err)?;
        Ok(Self::load(&mut file)?.manifest)
    }

    /// Rewrites the whole file in the current layout: `to` and `small`,
    /// the durable file's rows, summaries and free segments, and no leaf
    /// hashes. The comparison with `from` runs against the file as it is
    /// on disk, under the single-writer discipline the module documents.
    fn replace_for_migration(
        &mut self,
        from: &StoreManifest,
        to: &StoreManifest,
        small: &[u8],
    ) -> Result<(), StoreError> {
        let (durable, file) = self.load_durable()?.ok_or(StoreError::Empty)?;
        check_migration_baseline(&durable.manifest, from)?;
        let layout = Layout {
            manifest: to.encode(),
            small,
            pages: durable.pages.iter().map(|e| Row::Prior(*e)).collect(),
            extents: durable.extents.iter().map(|e| Row::Prior(*e)).collect(),
            edges: &durable.edges,
            free_segs: &durable.free_segs,
        };
        self.replace_file(&layout, Some(&file))
    }

    fn read_small_state(&self) -> Result<Vec<u8>, StoreError> {
        self.state
            .as_ref()
            .map(|(l, _)| l.small.clone())
            .ok_or(StoreError::Empty)
    }

    fn read_slot_page(&self, page: u32) -> Result<Vec<u8>, StoreError> {
        self.read_entry(true, page)
    }

    fn read_chunk_extent(&self, ext: u32) -> Result<Vec<u8>, StoreError> {
        self.read_entry(false, ext)
    }

    fn inventory(&self) -> Result<(Vec<usize>, Vec<usize>), StoreError> {
        // Pure metadata: the directories were decoded at open.
        let (loaded, _) = self.state.as_ref().ok_or(StoreError::Empty)?;
        Ok((
            loaded.pages.iter().map(|e| e.length as usize).collect(),
            loaded.extents.iter().map(|e| e.length as usize).collect(),
        ))
    }

    fn page_edges(&self) -> Result<Vec<Vec<u32>>, StoreError> {
        self.state
            .as_ref()
            .map(|(l, _)| l.edges.clone())
            .ok_or(StoreError::Empty)
    }

    fn read_free_seg(&self, seg: u32) -> Result<Vec<u8>, StoreError> {
        self.state
            .as_ref()
            .ok_or(StoreError::Empty)?
            .0
            .free_segs
            .get(seg as usize)
            .cloned()
            .ok_or(StoreError::MissingRow("free segment", seg))
    }

    fn commit_verified(&mut self, verify: &mut CommitVerifier<'_>) -> Result<(), StoreError> {
        // Reload the durable file: the cached view can be stale if
        // another handle on this path committed. Both the succession
        // check and the clean-row merge below must run against what is actually on
        // disk, so a forked handle fails closed with
        // EpochMismatch/BaselineMismatch instead of resurrecting its
        // stale baseline over the other's commit.
        let durable = self.load_durable()?;
        let batch = verify(durable.as_ref().map(|(l, _)| &l.manifest))?.batch();
        let small = crate::store_sections::merge_framed(
            durable.as_ref().map(|(l, _)| l.small.as_slice()),
            batch,
        )?;
        let n_pages = slot_page_count(batch.manifest.slot_count);
        let n_exts = chunk_extent_count(batch.manifest.chunk_len);
        let mut edges = durable
            .as_ref()
            .map(|(l, _)| l.edges.clone())
            .unwrap_or_default();
        edges.resize(n_pages as usize, Vec::new());
        for (page, targets) in &batch.page_edges {
            edges[*page as usize] = targets.clone();
        }

        // Resolve every row of the NEW geometry: a batch row wins;
        // otherwise the previous file must hold it (a grown row that is
        // not in the batch is a caller bug, refused as MissingRow).
        use std::collections::HashMap;
        let dirty_pages: HashMap<u32, &[u8]> = batch
            .slot_pages
            .iter()
            .map(|(p, b)| (*p, b.as_slice()))
            .collect();
        let dirty_exts: HashMap<u32, &[u8]> = batch
            .chunk_extents
            .iter()
            .map(|(e, b)| (*e, b.as_slice()))
            .collect();
        let mut pages = Vec::with_capacity(n_pages as usize);
        for page in 0..n_pages {
            pages.push(match dirty_pages.get(&page) {
                Some(bytes) => {
                    row_len(bytes.len(), "file store slot page row exceeds u32")?;
                    Row::New(bytes)
                }
                None => Row::Prior(
                    durable
                        .as_ref()
                        .and_then(|(l, _)| l.pages.get(page as usize))
                        .copied()
                        .ok_or(StoreError::MissingRow("slot page", page))?,
                ),
            });
        }
        let mut extents = Vec::with_capacity(n_exts as usize);
        for ext in 0..n_exts {
            extents.push(match dirty_exts.get(&ext) {
                Some(bytes) => {
                    row_len(bytes.len(), "file store chunk extent row exceeds u32")?;
                    Row::New(bytes)
                }
                None => Row::Prior(
                    durable
                        .as_ref()
                        .and_then(|(l, _)| l.extents.get(ext as usize))
                        .copied()
                        .ok_or(StoreError::MissingRow("chunk extent", ext))?,
                ),
            });
        }

        let n_free_segs = crate::store::free_seg_count(batch.manifest.free_len) as usize;
        let mut free_segs = durable
            .as_ref()
            .map(|(l, _)| l.free_segs.clone())
            .unwrap_or_default();
        free_segs.resize(n_free_segs, Vec::new());
        for (seg, bytes) in &batch.free_segs {
            if let Some(slot) = free_segs.get_mut(*seg as usize) {
                *slot = bytes.clone();
            }
        }
        free_segs.truncate(n_free_segs);

        let layout = Layout {
            manifest: batch.manifest.encode(),
            small: &small,
            pages,
            extents,
            edges: &edges,
            free_segs: &free_segs,
        };
        self.replace_file(&layout, durable.as_ref().map(|(_, f)| f))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::format::Signature;
    use crate::image::write_machine_unchecked;
    use crate::machine::MachineSnapshot;
    use crate::store::CheckpointBatch;
    use crate::store::{
        export_to_container, image_to_batch_unchecked, import_from_container, store_to_image,
        validate_store, CommitToken,
    };
    use ironhorse_vm::Interp;

    fn sig() -> Signature {
        Signature::new("ironhorse-store-test-v1")
    }

    const PROG_A: [u8; 44] = [
        0x0b, 0x00, 0x4b, 0xe0, 0x38, 0x00, 0x00, 0x2e, 0x13, 0x0b, 0x01, 0x9e, 0x01, 0x86, 0x01,
        0x00, 0x02, 0x00, 0xe6, 0x01, 0x92, 0x5c, 0x01, 0x72, 0x01, 0x01, 0xbb, 0x44, 0x58, 0x92,
        0x42, 0xe0, 0x89, 0x02, 0x00, 0x72, 0x04, 0x28, 0x72, 0x05, 0xab, 0x01, 0xbb, 0xa9,
    ];

    fn ran_image() -> crate::image::MachineImage {
        let mut m = Interp::new();
        assert!(m.run(&PROG_A).completed);
        m.snapshot_image_for_testing(&sig()).expect("gated image")
    }

    fn tmp_dir(name: &str) -> crate::test_dir::TempDir {
        crate::test_dir::TempDir::new(&format!("ironhorse-file-store-{name}"))
    }

    #[test]
    #[cfg(target_pointer_width = "64")]
    fn row_lengths_refuse_values_outside_the_wire_domain() {
        // This tests the writer's production arithmetic, independently of
        // the earlier geometry gate and without multi-gigabyte allocation.
        for length in [0, 1, u32::MAX as usize] {
            assert_eq!(
                row_len(length, "file store slot page row exceeds u32"),
                Ok(length as u32)
            );
            assert_eq!(
                row_len(length, "file store chunk extent row exceeds u32"),
                Ok(length as u32)
            );
        }
        for length in [u32::MAX as usize + 1, usize::MAX] {
            assert_eq!(
                row_len(length, "file store slot page row exceeds u32"),
                Err(StoreError::Snapshot(SnapshotError::Corrupt(
                    "file store slot page row exceeds u32"
                )))
            );
            assert_eq!(
                row_len(length, "file store chunk extent row exceeds u32"),
                Err(StoreError::Snapshot(SnapshotError::Corrupt(
                    "file store chunk extent row exceeds u32"
                )))
            );
        }
    }

    #[test]
    fn failed_rename_removes_the_temp_file() {
        // A failed rename must remove its .tmp file: opens ignore it,
        // but leaked files can accumulate across retries. Parking a
        // non-empty directory at the store path makes the rename fail
        // deterministically (EISDIR/ENOTEMPTY), which works under
        // root too, where permission-bit tricks do not.
        let dir = tmp_dir("failed-rename-cleanup");
        let target = dir.join("heap.ihstore");
        let mut store = FileStore::open(&target).unwrap();
        std::fs::create_dir_all(target.join("occupier")).unwrap();
        let image = ran_image();
        assert!(
            store
                .commit(&image_to_batch_unchecked(&image, 1, CommitToken::ZERO))
                .is_err(),
            "renaming a file onto a non-empty directory fails"
        );
        let leftovers: Vec<String> = std::fs::read_dir(&*dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.contains(".tmp-"))
            .collect();
        assert!(
            leftovers.is_empty(),
            "no temp litter after a failed rename: {leftovers:?}"
        );
    }

    #[test]
    fn absent_file_is_an_empty_store() {
        let dir = tmp_dir("empty");
        let store = FileStore::open(dir.join("heap.ihstore")).unwrap();
        assert_eq!(store.manifest().unwrap_err(), StoreError::Empty);
    }

    /// The same identity locks as the memory store, through the durable
    /// medium and a fresh reopen.
    #[test]
    fn round_trips_and_persists_across_reopen() {
        let dir = tmp_dir("roundtrip");
        let path = dir.join("heap.ihstore");
        let image = ran_image();
        let bytes = write_machine_unchecked(&image);

        let mut store = FileStore::open(&path).unwrap();
        import_from_container(&bytes, &sig(), &mut store).expect("imports");
        assert_eq!(export_to_container(&store).unwrap(), bytes);
        drop(store);

        // Reopen from disk alone: everything must survive.
        let store = FileStore::open(&path).unwrap();
        validate_store(&store, &sig()).expect("validates after reopen");
        assert_eq!(store_to_image(&store).unwrap(), image);
        assert_eq!(export_to_container(&store).unwrap(), bytes);
    }

    /// An incremental commit merges dirty rows over clean ones: the
    /// dirty page is replaced, every other row is preserved byte-exact.
    #[test]
    fn incremental_commit_merges_dirty_over_clean() {
        let dir = tmp_dir("incremental");
        let path = dir.join("heap.ihstore");
        let image = ran_image();
        let mut store = FileStore::open(&path).unwrap();
        store
            .commit(&image_to_batch_unchecked(&image, 1, CommitToken::ZERO))
            .unwrap();

        // Mutate one record on page 0 and commit only that page.
        let mut changed = image.clone();
        changed.slots[0] = ironhorse_vm::Slot::integer(424242);
        let prev = store.manifest().unwrap().token;
        let full = image_to_batch_unchecked(&changed, 2, prev);
        let one_page = CheckpointBatch {
            prev_token: prev,
            manifest: full.manifest.clone(),
            small: full.small.clone(),
            small_updates: None,
            slot_pages: full
                .slot_pages
                .iter()
                .filter(|(p, _)| *p == 0)
                .cloned()
                .collect(),
            chunk_extents: Vec::new(),
            free_segs: full.free_segs.clone(),
            page_edges: full
                .page_edges
                .iter()
                .filter(|(p, _)| *p == 0)
                .cloned()
                .collect(),
        };
        store.commit(&one_page).unwrap();

        // The merged store now equals the changed image exactly.
        assert_eq!(store_to_image(&store).unwrap(), changed);

        // And after a reopen, still.
        drop(store);
        let store = FileStore::open(&path).unwrap();
        assert_eq!(store_to_image(&store).unwrap(), changed);
    }

    #[test]
    fn epoch_discipline_holds_across_reopen() {
        let dir = tmp_dir("epoch");
        let path = dir.join("heap.ihstore");
        let image = ran_image();
        let mut store = FileStore::open(&path).unwrap();
        store
            .commit(&image_to_batch_unchecked(&image, 1, CommitToken::ZERO))
            .unwrap();
        drop(store);

        let mut store = FileStore::open(&path).unwrap();
        // Replaying epoch 1 into a store already at epoch 1 is refused.
        assert_eq!(
            store
                .commit(&image_to_batch_unchecked(&image, 1, CommitToken::ZERO))
                .unwrap_err(),
            StoreError::EpochMismatch {
                expected: 2,
                found: 1
            }
        );
        let prev = store.manifest().unwrap().token;
        store
            .commit(&image_to_batch_unchecked(&image, 2, prev))
            .unwrap();
    }

    #[test]
    fn file_framing_has_exact_refusals() {
        let dir = tmp_dir("framing-refusals");
        let path = dir.join("heap.ihstore");
        let mut store = FileStore::open(&path).unwrap();
        store
            .commit(&image_to_batch_unchecked(
                &ran_image(),
                1,
                CommitToken::ZERO,
            ))
            .unwrap();
        drop(store);
        let bytes = std::fs::read(&path).unwrap();
        FileStore::open(&path).unwrap();
        let open = |contents: &[u8]| {
            std::fs::write(&path, contents).unwrap();
            FileStore::open(&path).unwrap_err()
        };
        for length in 0..8 {
            assert_eq!(
                open(&bytes[..length]),
                StoreError::Snapshot(SnapshotError::Corrupt("file store header truncated"))
            );
        }
        let mut invalid = bytes.clone();
        invalid[0] ^= 1;
        assert_eq!(
            open(&invalid),
            StoreError::Snapshot(SnapshotError::Corrupt("file store magic"))
        );
        let manifest_len = u32::from_be_bytes(bytes[8..12].try_into().unwrap()) as usize;
        let small_header = 12 + manifest_len;
        for length in [8, 11, small_header - 1] {
            assert_eq!(
                open(&bytes[..length]),
                StoreError::Snapshot(SnapshotError::Corrupt("file store manifest block"))
            );
        }
        let small_len =
            u32::from_be_bytes(bytes[small_header..small_header + 4].try_into().unwrap()) as usize;
        let counts = small_header + 4 + small_len;
        for length in [small_header, small_header + 3, counts - 1] {
            assert_eq!(
                open(&bytes[..length]),
                StoreError::Snapshot(SnapshotError::Corrupt("file store small-state block"))
            );
        }
        for length in counts..counts + 8 {
            assert_eq!(
                open(&bytes[..length]),
                StoreError::Snapshot(SnapshotError::Corrupt("file store header truncated"))
            );
        }
        invalid = bytes.clone();
        invalid[counts..counts + 4].copy_from_slice(&u32::MAX.to_be_bytes());
        assert_eq!(
            open(&invalid),
            StoreError::Snapshot(SnapshotError::Corrupt("file store directory truncated"))
        );
        let entry = counts + 8;
        assert!(u32::from_be_bytes(bytes[counts..counts + 4].try_into().unwrap()) > 0);
        assert!(u32::from_be_bytes(bytes[entry + 8..entry + 12].try_into().unwrap()) > 0);
        invalid = bytes.clone();
        invalid[entry..entry + 8].copy_from_slice(&u64::MAX.to_be_bytes());
        assert_eq!(
            open(&invalid),
            StoreError::Snapshot(SnapshotError::Corrupt(
                "file store directory entry overflows"
            ))
        );
        invalid = bytes.clone();
        invalid[entry..entry + 8].copy_from_slice(&(bytes.len() as u64).to_be_bytes());
        assert_eq!(
            open(&invalid),
            StoreError::Snapshot(SnapshotError::Corrupt(
                "file store directory entry out of range"
            ))
        );
        std::fs::write(&path, &bytes).unwrap();
        FileStore::open(&path).unwrap();
    }

    #[test]
    fn file_metadata_has_exact_refusals() {
        let dir = tmp_dir("metadata-refusals");
        let path = dir.join("heap.ihstore");
        let mut manifest = image_to_batch_unchecked(&ran_image(), 1, CommitToken::ZERO).manifest;
        manifest.slot_count = 1;
        manifest.chunk_len = 1;
        manifest.free_len = 1;
        // This fixture tests open-time framing, not row validity. Zero-length
        // directory entries keep later truncations from first failing the
        // independent directory-range guard. The legacy layout adds the leaf
        // hashes.
        let encode = |manifest: &StoreManifest, legacy: bool| {
            let encoded = manifest.encode();
            let mut bytes = if legacy {
                LEGACY_FILE_MAGIC
            } else {
                FILE_MAGIC
            }
            .to_vec();
            bytes.extend_from_slice(&(encoded.len() as u32).to_be_bytes());
            bytes.extend_from_slice(&encoded);
            bytes.extend_from_slice(&0u32.to_be_bytes()); // small state
            bytes.extend_from_slice(&1u32.to_be_bytes()); // pages
            bytes.extend_from_slice(&1u32.to_be_bytes()); // extents
            bytes.extend_from_slice(&[0; 24]); // directories
            if legacy {
                bytes.extend_from_slice(&[0; 64]); // row leaves
            }
            bytes.extend_from_slice(&0u32.to_be_bytes()); // page edges
            bytes.extend_from_slice(&1u32.to_be_bytes()); // free segments
            bytes.extend_from_slice(&4u32.to_be_bytes()); // segment length
            bytes.extend_from_slice(&0u32.to_be_bytes()); // free index
            if legacy {
                bytes.extend_from_slice(&[0; 32]); // free leaf
            }
            bytes
        };
        let open = |contents: &[u8]| {
            std::fs::write(&path, contents).unwrap();
            FileStore::open(&path).unwrap_err()
        };
        for legacy in [false, true] {
            let bytes = encode(&manifest, legacy);
            std::fs::write(&path, &bytes).unwrap();
            FileStore::open(&path).unwrap();
            let free_leaf = bytes.len() - if legacy { 32 } else { 0 };
            let free_body = free_leaf - 4;
            let free_length = free_body - 4;
            let free_count = free_length - 4;
            let edges = free_count - 4;
            if legacy {
                for end in edges - 64..edges {
                    assert_eq!(
                        open(&bytes[..end]),
                        StoreError::Snapshot(SnapshotError::Corrupt(
                            "file store leaf hashes truncated"
                        ))
                    );
                }
                for end in free_leaf..bytes.len() {
                    assert_eq!(
                        open(&bytes[..end]),
                        StoreError::Snapshot(SnapshotError::Corrupt(
                            "file store free leaf hashes truncated"
                        ))
                    );
                }
            }
            let mut invalid = bytes.clone();
            invalid[edges..edges + 4].copy_from_slice(&u32::MAX.to_be_bytes());
            assert_eq!(
                open(&invalid),
                StoreError::Snapshot(SnapshotError::Corrupt("file store page edges truncated"))
            );
            for offset in [free_count, free_length] {
                invalid = bytes.clone();
                invalid[offset..offset + 4].copy_from_slice(&u32::MAX.to_be_bytes());
                assert_eq!(
                    open(&invalid),
                    StoreError::Snapshot(SnapshotError::Corrupt(
                        "file store free segments truncated"
                    ))
                );
            }
            for end in free_body..free_leaf {
                assert_eq!(
                    open(&bytes[..end]),
                    StoreError::Snapshot(SnapshotError::Corrupt(
                        "file store free segments truncated"
                    ))
                );
            }
            let mut wrong = manifest.clone();
            wrong.slot_count = 0;
            assert_eq!(
                open(&encode(&wrong, legacy)),
                StoreError::Snapshot(SnapshotError::Corrupt(
                    "file store page directory disagrees with geometry"
                ))
            );
            wrong = manifest.clone();
            wrong.chunk_len = 0;
            assert_eq!(
                open(&encode(&wrong, legacy)),
                StoreError::Snapshot(SnapshotError::Corrupt(
                    "file store extent directory disagrees with geometry"
                ))
            );
            wrong = manifest.clone();
            wrong.free_len = 0;
            assert_eq!(
                open(&encode(&wrong, legacy)),
                StoreError::Snapshot(SnapshotError::Corrupt(
                    "file store free segments disagree with geometry"
                ))
            );
            std::fs::write(&path, &bytes).unwrap();
            FileStore::open(&path).unwrap();
        }
    }

    /// The same file in the legacy layout: zero leaf hashes after the
    /// directories and after the free segments, every directory offset
    /// shifted past them.
    fn to_legacy_layout(bytes: &[u8]) -> Vec<u8> {
        let at = |i: usize| u32::from_be_bytes(bytes[i..i + 4].try_into().unwrap()) as usize;
        let small_header = 12 + at(8);
        let counts = small_header + 4 + at(small_header);
        let (n_pages, n_exts) = (at(counts), at(counts + 4));
        let dirs = counts + 8;
        let dirs_end = dirs + 12 * (n_pages + n_exts);
        let mut edges_end = dirs_end;
        for _ in 0..n_pages {
            edges_end += 4 + 4 * at(edges_end);
        }
        let n_frees = at(edges_end);
        let mut frees_end = edges_end + 4;
        for _ in 0..n_frees {
            frees_end += 4 + at(frees_end);
        }
        let shift = (32 * (n_pages + n_exts + n_frees)) as u64;
        let mut out = LEGACY_FILE_MAGIC.to_vec();
        out.extend_from_slice(&bytes[8..dirs]);
        for row in bytes[dirs..dirs_end].chunks_exact(12) {
            let offset = u64::from_be_bytes(row[..8].try_into().unwrap());
            out.extend_from_slice(&(offset + shift).to_be_bytes());
            out.extend_from_slice(&row[8..]);
        }
        out.extend(std::iter::repeat_n(0u8, 32 * (n_pages + n_exts)));
        out.extend_from_slice(&bytes[dirs_end..frees_end]);
        out.extend(std::iter::repeat_n(0u8, 32 * n_frees));
        out.extend_from_slice(&bytes[frees_end..]);
        out
    }

    /// A file in the legacy layout reads as the same store, and the
    /// migration write rewrites it in the current layout: byte for byte
    /// the file this build would have written.
    #[test]
    fn legacy_layout_reads_and_the_migration_write_upgrades_it() {
        let dir = tmp_dir("legacy-layout");
        let path = dir.join("heap.ihstore");
        let image = ran_image();
        let mut store = FileStore::open(&path).unwrap();
        store
            .commit(&image_to_batch_unchecked(&image, 1, CommitToken::ZERO))
            .unwrap();
        let manifest = store.manifest().unwrap();
        let small = store.read_small_state().unwrap();
        drop(store);
        let current = std::fs::read(&path).unwrap();
        let legacy = to_legacy_layout(&current);
        assert_ne!(legacy, current);
        std::fs::write(&path, &legacy).unwrap();
        let mut store = FileStore::open(&path).unwrap();
        assert_eq!(store_to_image(&store).unwrap(), image);
        validate_store(&store, &sig()).unwrap();
        store
            .replace_for_migration(&manifest, &manifest, &small)
            .unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), current);
        assert_eq!(store_to_image(&store).unwrap(), image);
    }

    /// The migration write compares the durable manifest with the one the
    /// migration read, and refuses without writing when they differ or
    /// the file does not decode.
    #[test]
    fn migration_write_refuses_a_moved_or_damaged_file() {
        let dir = tmp_dir("migration-write-refusals");
        let path = dir.join("heap.ihstore");
        let mut store = FileStore::open(&path).unwrap();
        assert_eq!(
            store.replace_for_migration(
                &image_to_batch_unchecked(&ran_image(), 1, CommitToken::ZERO).manifest,
                &image_to_batch_unchecked(&ran_image(), 1, CommitToken::ZERO).manifest,
                &[],
            ),
            Err(StoreError::Empty)
        );
        store
            .commit(&image_to_batch_unchecked(
                &ran_image(),
                1,
                CommitToken::ZERO,
            ))
            .unwrap();
        let manifest = store.manifest().unwrap();
        let small = store.read_small_state().unwrap();
        let bytes = std::fs::read(&path).unwrap();
        let mut moved = manifest.clone();
        moved.epoch += 1;
        assert!(matches!(
            store.replace_for_migration(&moved, &manifest, &small),
            Err(StoreError::BaselineMismatch { .. })
        ));
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        for cut in [0, 8, 11] {
            std::fs::write(&path, &bytes[..cut]).unwrap();
            assert!(store
                .replace_for_migration(&manifest, &manifest, &small)
                .is_err());
            assert_eq!(std::fs::read(&path).unwrap(), bytes[..cut]);
        }
        std::fs::write(&path, &bytes).unwrap();
        store
            .replace_for_migration(&manifest, &manifest, &small)
            .unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        validate_store(&FileStore::open(&path).unwrap(), &sig()).unwrap();
    }

    /// The shared consistent-edit suite on the file store, editing the row's
    /// bytes in the file itself.
    #[test]
    fn consistent_edits_resume_on_the_file_store() {
        let dir = tmp_dir("consistent-edits");
        let path = dir.join("heap.ihstore");
        crate::store_suite::consistent_edits_resume(
            FileStore::open(&path).unwrap(),
            |store, _kind, _index, old, new| {
                drop(store);
                let mut bytes = std::fs::read(&path).unwrap();
                let at: Vec<usize> = (0..=bytes.len() - old.len())
                    .filter(|&at| bytes[at..at + old.len()] == *old)
                    .collect();
                assert_eq!(at.len(), 1, "the row is stored once");
                bytes[at[0]..at[0] + old.len()].copy_from_slice(new);
                std::fs::write(&path, &bytes).unwrap();
                FileStore::open(&path).unwrap()
            },
        );
    }

    /// A handle serves the small state and rows it loaded, so its view falls
    /// behind the file when another handle writes. The migration reads them
    /// through the handle and refuses one that is behind, rather than write
    /// the durable rows beside a stale small state; a handle that reloads
    /// migrates.
    #[test]
    fn migration_refuses_a_handle_behind_the_file() {
        use crate::store::migrate_store;
        let dir = tmp_dir("migration-stale-handle");
        let path = dir.join("heap.ihstore");
        let mut writer = FileStore::open(&path).unwrap();
        writer
            .commit(&image_to_batch_unchecked(
                &ran_image(),
                1,
                CommitToken::ZERO,
            ))
            .unwrap();
        let current = writer.manifest().unwrap();
        let small = writer.read_small_state().unwrap();
        let older = StoreManifest {
            store_schema: 35,
            ..current.clone()
        };
        writer
            .replace_for_migration(&current, &older, &small)
            .unwrap();
        let mut stale = FileStore::open(&path).unwrap();
        let moved = StoreManifest {
            epoch: older.epoch + 1,
            ..older.clone()
        };
        writer
            .replace_for_migration(&older, &moved, &small)
            .unwrap();
        let bytes = std::fs::read(&path).unwrap();
        assert_eq!(
            migrate_store(&mut stale, &sig()),
            Err(StoreError::BaselineMismatch {
                expected: format!("schema 35 epoch 2 token {}", moved.token),
                found: format!("schema 35 epoch 1 token {}", older.token),
            })
        );
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        assert_eq!(
            migrate_store(&mut FileStore::open(&path).unwrap(), &sig()),
            Ok(true)
        );
    }

    #[test]
    fn foreign_magic_fails_closed() {
        let dir = tmp_dir("magic");
        let path = dir.join("heap.ihstore");
        std::fs::write(&path, b"NOTASTORE-at-all").unwrap();
        match FileStore::open(&path) {
            Err(StoreError::Snapshot(SnapshotError::Corrupt("file store magic"))) => {}
            other => panic!("expected magic failure, got {other:?}"),
        }
    }

    #[test]
    fn truncated_file_fails_closed() {
        let dir = tmp_dir("truncated");
        let path = dir.join("heap.ihstore");
        let image = ran_image();
        let mut store = FileStore::open(&path).unwrap();
        store
            .commit(&image_to_batch_unchecked(&image, 1, CommitToken::ZERO))
            .unwrap();
        drop(store);

        // Cut the file mid-directory: open must refuse, not misread.
        let bytes = std::fs::read(&path).unwrap();
        std::fs::write(&path, &bytes[..bytes.len() / 2]).unwrap();
        assert!(FileStore::open(&path).is_err());
    }

    /// A leftover temp file from a torn commit is inert: open ignores
    /// it and the next commit overwrites it.
    #[test]
    fn leftover_tmp_from_torn_commit_is_ignored() {
        let dir = tmp_dir("torn");
        let path = dir.join("heap.ihstore");
        let image = ran_image();
        let mut store = FileStore::open(&path).unwrap();
        store
            .commit(&image_to_batch_unchecked(&image, 1, CommitToken::ZERO))
            .unwrap();
        drop(store);

        std::fs::write(dir.join("heap.ihstore.tmp"), b"half a checkpoint").unwrap();
        let mut store = FileStore::open(&path).unwrap();
        assert_eq!(store_to_image(&store).unwrap(), image);
        let prev = store.manifest().unwrap().token;
        store
            .commit(&image_to_batch_unchecked(&image, 2, prev))
            .unwrap();
        assert_eq!(store.manifest().unwrap().epoch, 2);
    }

    /// A grown geometry whose new rows are missing from the batch is a
    /// refused caller bug, not a silent gap.
    #[test]
    fn grown_row_missing_from_batch_is_refused() {
        let dir = tmp_dir("grow");
        let path = dir.join("heap.ihstore");
        let image = ran_image();
        let mut store = FileStore::open(&path).unwrap();
        store
            .commit(&image_to_batch_unchecked(&image, 1, CommitToken::ZERO))
            .unwrap();

        let mut grown = image.clone();
        grown.chunks.extend(std::iter::repeat_n(
            7u8,
            crate::store::CHUNK_EXTENT_BYTES as usize,
        ));
        let prev = store.manifest().unwrap().token;
        let mut batch = image_to_batch_unchecked(&grown, 2, prev);
        batch.chunk_extents.pop(); // drop the newest extent's row
        match store.commit(&batch) {
            // Wrapped: a row missing from the caller's batch is a rejected
            // request, not a poisoned store.
            Err(StoreError::BatchRejected(inner))
                if matches!(*inner, StoreError::MissingRow("chunk extent", _)) => {}
            other => panic!("expected missing grown row, got {other:?}"),
        }
    }
}
