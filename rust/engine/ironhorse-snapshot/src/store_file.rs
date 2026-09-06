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
//! # On-disk layout (`FILE_MAGIC`, all integers big-endian)
//!
//! ```text
//! [8]  magic (the current `FILE_MAGIC` — version-suffixed)
//! [4]  manifest length   [..] manifest (StoreManifest::encode)
//! [4]  small length      [..] small state (SmallState::encode)
//! [4]  slot-page count   [4] chunk-extent count
//! [page directory: count × (u64 offset, u32 length)]
//! [extent directory: count × (u64 offset, u32 length)]
//! [page leaf hashes: count × 32]  [extent leaf hashes: count × 32]
//! [page edges: count × (u32 len, len × u32 targets)]
//! [free segments: u32 count, then count × (u32 len, len bytes)]
//! [free leaf hashes: count × 32]
//! [blobs, in directory order]
//! ```
//!
//! The directories are read (with reservation clamps against the file
//! size — the malformed-count discipline) at open; reads then seek by
//! directory entry. A missing file is an [`StoreError::Empty`] store,
//! not an error, so `open` serves both the create and reopen paths.

use std::cell::RefCell;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::PathBuf;

use crate::format::SnapshotError;
use crate::store::{
    check_succession, chunk_extent_count, slot_page_count, CheckpointBatch, HeapStore,
    StoreError, StoreManifest,
};

/// The file-format discriminator — the LAYOUT version. A layout
/// change (sections, directories) is a new magic and a reader fails
/// closed on one it does not know. The STORE SCHEMA no longer rides
/// the magic: since the v5→v6 root-formula bump it travels in the
/// manifest's `store_schema` field, gated by the supported range and
/// migrated forward in place by [`crate::store::migrate_store`], which
/// the opener runs explicitly (it gates the restamp on the
/// callback-table signature `open` does not know); the "5" suffix is
/// historical — the last time the LAYOUT changed.
pub const FILE_MAGIC: [u8; 8] = *b"IHSTORE5";

/// Temp files are uniquely named per process and per commit
/// (`.tmp-{pid}-{n}`), so two writers can never interleave bytes in a
/// shared temp inode (the PR-review concurrency finding); leftover
/// temps from torn commits are inert (`open` never reads them).
/// Cross-process last-rename-wins remains bounded by the documented
/// single-writer-per-path model plus the durable succession check —
/// a lost lineage is detected at its next commit or resume via the
/// seal chain, never silently merged.
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
    leaf_pages: Vec<[u8; 32]>,
    leaf_exts: Vec<[u8; 32]>,
    edges: Vec<Vec<u32>>,
    free_segs: Vec<Vec<u8>>,
    leaf_frees: Vec<[u8; 32]>,
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

fn corrupt(what: &'static str) -> StoreError {
    StoreError::Snapshot(SnapshotError::Corrupt(what))
}

impl FileStore {
    /// Write `bytes` as the store file through the commit path's
    /// exact durability discipline — unique temp, fsync, rename,
    /// directory sync — then reload the in-memory view from the
    /// renamed file. The migration writes share this so their
    /// atomicity can never drift from commit's.
    fn atomic_replace_and_reload(&mut self, bytes: &[u8]) -> Result<(), StoreError> {
        let tmp_path = {
            let mut os = self.path.clone().into_os_string();
            os.push(format!(
                ".tmp-{}-{}",
                std::process::id(),
                TMP_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            ));
            PathBuf::from(os)
        };
        let write_tmp = || -> Result<(), StoreError> {
            let mut tmp = File::create(&tmp_path).map_err(io_err)?;
            tmp.write_all(bytes).map_err(io_err)?;
            tmp.sync_all().map_err(io_err)?;
            Ok(())
        };
        if let Err(e) = write_tmp() {
            let _ = std::fs::remove_file(&tmp_path);
            return Err(e);
        }
        if let Err(e) = std::fs::rename(&tmp_path, &self.path) {
            let _ = std::fs::remove_file(&tmp_path);
            return Err(io_err(e));
        }
        let dir = match self.path.parent() {
            Some(p) if !p.as_os_str().is_empty() => p,
            _ => std::path::Path::new("."),
        };
        File::open(dir).and_then(|d| d.sync_all()).map_err(io_err)?;
        let mut file = File::open(&self.path).map_err(io_err)?;
        let loaded = Self::load(&mut file)?;
        self.state = Some((loaded, RefCell::new(file)));
        Ok(())
    }

    /// Open the store at `path`. An absent file is a valid empty store
    /// (its first commit creates the file); a present file has its
    /// header and directories decoded and checked immediately, so a
    /// foreign or truncated file fails closed here rather than on a
    /// later fault.
    ///
    /// Open does NOT migrate: an older but decodable store opens as-is
    /// and the caller upgrades it with [`crate::store::migrate_store`],
    /// which gates the restamp on the callback-table signature (review
    /// wave 4, F2). Resuming without migrating first fails closed with
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
            .map_err(|_| corrupt("file store header truncated"))?;
        if header != FILE_MAGIC {
            return Err(corrupt("file store magic"));
        }

        let read_u32 = |file: &mut File| -> Result<u32, StoreError> {
            let mut b = [0u8; 4];
            file.read_exact(&mut b)
                .map_err(|_| corrupt("file store header truncated"))?;
            Ok(u32::from_be_bytes(b))
        };
        let read_block = |file: &mut File, what: &'static str| -> Result<Vec<u8>, StoreError> {
            let len = {
                let mut b = [0u8; 4];
                file.read_exact(&mut b).map_err(|_| corrupt(what))?;
                u32::from_be_bytes(b) as usize
            };
            // Clamp the reservation to what the file can hold before
            // trusting the length (malformed-count discipline).
            if (len as u64) > file_len {
                return Err(corrupt(what));
            }
            let mut buf = vec![0u8; len];
            file.read_exact(&mut buf).map_err(|_| corrupt(what))?;
            Ok(buf)
        };

        let manifest_bytes = read_block(file, "file store manifest block")?;
        let manifest = StoreManifest::decode(&manifest_bytes)?;
        let small = read_block(file, "file store small-state block")?;

        let n_pages = read_u32(file)? as u64;
        let n_exts = read_u32(file)? as u64;
        // Each directory entry is 12 bytes; a count the file cannot
        // hold is corruption, refused before any reservation.
        if (n_pages + n_exts) * 12 > file_len {
            return Err(corrupt("file store directory truncated"));
        }
        let mut read_dir = |n: u64| -> Result<Vec<DirEntry>, StoreError> {
            let mut dir = Vec::with_capacity(n as usize);
            for _ in 0..n {
                let mut b = [0u8; 12];
                file.read_exact(&mut b)
                    .map_err(|_| corrupt("file store directory truncated"))?;
                let offset = u64::from_be_bytes(b[0..8].try_into().unwrap());
                let length = u32::from_be_bytes(b[8..12].try_into().unwrap());
                let end = offset
                    .checked_add(length as u64)
                    .ok_or_else(|| corrupt("file store directory entry overflows"))?;
                if end > file_len {
                    return Err(corrupt("file store directory entry out of range"));
                }
                dir.push(DirEntry { offset, length });
            }
            Ok(dir)
        };
        let pages = read_dir(n_pages)?;
        let extents = read_dir(n_exts)?;

        // The row-leaf hashes (phase 5), 32 bytes per row; the same
        // reservation clamp discipline as the directories.
        if (n_pages + n_exts) * 32 > file_len {
            return Err(corrupt("file store leaf hashes truncated"));
        }
        let mut read_leaves = |n: u64| -> Result<Vec<[u8; 32]>, StoreError> {
            let mut out = Vec::with_capacity(n as usize);
            for _ in 0..n {
                let mut b = [0u8; 32];
                file.read_exact(&mut b)
                    .map_err(|_| corrupt("file store leaf hashes truncated"))?;
                out.push(b);
            }
            Ok(out)
        };
        let leaf_pages = read_leaves(n_pages)?;
        let leaf_exts = read_leaves(n_exts)?;

        // Page-edge summaries (phase 6): u32 length + targets per
        // page, with the same clamp discipline. The OUTER vector
        // grows against real reads — a `with_capacity(n)` here would
        // reserve 24 bytes per counted entry against a 4-byte-per-
        // entry clamp, the ~6x amplification the review flagged in
        // the free-segment read below (the over-allocation trophy
        // class applies to reservation RATIOS, not just totals).
        let mut edges: Vec<Vec<u32>> = Vec::new();
        for _ in 0..n_pages {
            let len = read_u32(file)? as u64;
            if len * 4 > file_len {
                return Err(corrupt("file store page edges truncated"));
            }
            let mut ts = Vec::with_capacity(len as usize);
            for _ in 0..len {
                ts.push(read_u32(file)?);
            }
            edges.push(ts);
        }

        // Free-list segments + their leaves (phase 9), clamp-checked;
        // outer vectors grow against real reads (see the edges note).
        let n_frees = read_u32(file)? as u64;
        if n_frees * 4 > file_len {
            return Err(corrupt("file store free segments truncated"));
        }
        let mut free_segs: Vec<Vec<u8>> = Vec::new();
        for _ in 0..n_frees {
            let len = read_u32(file)? as u64;
            if len > file_len {
                return Err(corrupt("file store free segments truncated"));
            }
            let mut b = vec![0u8; len as usize];
            file.read_exact(&mut b)
                .map_err(|_| corrupt("file store free segments truncated"))?;
            free_segs.push(b);
        }
        if n_frees * 32 > file_len {
            return Err(corrupt("file store free leaf hashes truncated"));
        }
        let mut leaf_frees: Vec<[u8; 32]> = Vec::with_capacity(n_frees as usize);
        for _ in 0..n_frees {
            let mut b = [0u8; 32];
            file.read_exact(&mut b)
                .map_err(|_| corrupt("file store free leaf hashes truncated"))?;
            leaf_frees.push(b);
        }

        // The directories must cover exactly the manifest's geometry —
        // the same promise the row inventory of `validate_store`
        // re-checks with lengths. The free-segment count gets the same
        // open-time symmetry (the review found it deferred to
        // validation while pages/extents were checked here).
        if pages.len() != slot_page_count(manifest.slot_count) as usize {
            return Err(corrupt("file store page directory disagrees with geometry"));
        }
        if extents.len() != chunk_extent_count(manifest.chunk_len) as usize {
            return Err(corrupt(
                "file store extent directory disagrees with geometry",
            ));
        }
        if free_segs.len() != crate::store::free_seg_count(manifest.free_len) as usize {
            return Err(corrupt(
                "file store free segments disagree with geometry",
            ));
        }

        Ok(Loaded {
            manifest,
            small,
            pages,
            extents,
            leaf_pages,
            leaf_exts,
            edges,
            free_segs,
            leaf_frees,
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

    /// The one backend that caches: `open` reads the header once and
    /// `manifest()` serves that copy, so a handle opened before another
    /// process upgraded the file would otherwise decide a ladder step
    /// from a schema the file no longer has (review wave 5). Re-reads
    /// the header off disk.
    fn reread_manifest(&self) -> Result<StoreManifest, StoreError> {
        if !self.path.exists() {
            return Err(StoreError::Empty);
        }
        let mut file = File::open(&self.path).map_err(io_err)?;
        Ok(Self::load(&mut file)?.manifest)
    }

    fn replace_manifest_for_migration(
        &mut self,
        manifest: &StoreManifest,
    ) -> Result<(), StoreError> {
        // The manifest is length-prefixed at the file's front and
        // every directory offset is absolute, so this write is only
        // sound when the replacement encodes to the SAME length. It
        // does for v5 → v6 (the schema stamp is a fixed-width u32 and
        // the root a fixed 64-hex string); a future step that changes
        // the length must rewrite the layout instead, and the guard
        // makes that unmissable.
        //
        // The caller verified the OLD root against the cached view
        // (`self.state`, loaded at open) while this re-reads the durable
        // file. Those agree under the store's single-writer discipline —
        // no other process rewrites the file between open and migrate —
        // which is the same assumption the whole in-place migration
        // rests on (review wave 4, F7). A multi-writer backend would have
        // to reload-then-verify instead.
        if self.state.is_none() {
            return Err(StoreError::Empty);
        }
        let mut bytes = std::fs::read(&self.path).map_err(io_err)?;
        let old_len = u32::from_be_bytes(
            bytes
                .get(8..12)
                .and_then(|b| b.try_into().ok())
                .ok_or(StoreError::Snapshot(SnapshotError::Corrupt(
                    "store file header truncated",
                )))?,
        ) as usize;
        let new_manifest = manifest.encode();
        if new_manifest.len() != old_len {
            return Err(StoreError::Io(
                "migration manifest length changed; full rewrite required".to_string(),
            ));
        }
        // The header's manifest length is trusted only after the file
        // is proven long enough to hold it: an externally truncated
        // file (header intact, body cut) must fail closed here, not
        // panic on the splice (review wave 4, F6). The 6→7 step below
        // already bounds every offset the same way.
        let man_end = 12usize
            .checked_add(old_len)
            .filter(|&end| end <= bytes.len())
            .ok_or(StoreError::Snapshot(SnapshotError::Corrupt(
                "store file manifest region truncated",
            )))?;
        bytes[12..man_end].copy_from_slice(&new_manifest);
        self.atomic_replace_and_reload(&bytes)
    }

    fn replace_manifest_and_small_for_migration(
        &mut self,
        manifest: &StoreManifest,
        small: &[u8],
    ) -> Result<(), StoreError> {
        // The length-changing ladder write (6→7 grows the small state,
        // 7→8 grows the manifest): unlike the manifest-only splice
        // above this rebuilds the header region and shifts every
        // directory offset by the COMBINED length delta — the
        // directories' offsets are absolute and every blob sits after
        // both sections. Leaf hashes, edges, free segments, and blob
        // bytes copy verbatim.
        if self.state.is_none() {
            return Err(StoreError::Empty);
        }
        let old = std::fs::read(&self.path).map_err(io_err)?;
        let truncated = || StoreError::Snapshot(SnapshotError::Corrupt("store file header truncated"));
        let read_u32 = |at: usize| -> Result<usize, StoreError> {
            Ok(u32::from_be_bytes(
                old.get(at..at + 4)
                    .and_then(|b| b.try_into().ok())
                    .ok_or_else(truncated)?,
            ) as usize)
        };
        let man_len = read_u32(8)?;
        let new_manifest = manifest.encode();
        // Unlike the manifest-only splice above, this write rebuilds the
        // header region, so BOTH sections may change length — the 6→7
        // step grows the small state, the 7→8 step grows the manifest.
        // Every directory offset is absolute and every blob sits after
        // both sections, so the shift below is their COMBINED delta.
        let man_end = 12usize.checked_add(man_len).ok_or_else(truncated)?;
        let old_small_len = read_u32(man_end)?;
        let small_end = man_end
            .checked_add(4)
            .and_then(|x| x.checked_add(old_small_len))
            .ok_or_else(truncated)?;
        let n_pages = read_u32(small_end)?;
        let n_exts = read_u32(small_end + 4)?;
        let dirs_start = small_end + 8;
        let dirs_len = n_pages
            .checked_add(n_exts)
            .and_then(|n| n.checked_mul(12))
            .ok_or_else(truncated)?;
        let dirs_end = dirs_start.checked_add(dirs_len).ok_or_else(truncated)?;
        if dirs_end > old.len() {
            return Err(truncated());
        }
        let delta = (new_manifest.len() as i64 - man_len as i64)
            + (small.len() as i64 - old_small_len as i64);

        let mut out = Vec::with_capacity(old.len().saturating_add_signed(delta as isize));
        out.extend_from_slice(&old[0..8]);
        out.extend_from_slice(&(new_manifest.len() as u32).to_be_bytes());
        out.extend_from_slice(&new_manifest);
        out.extend_from_slice(&(small.len() as u32).to_be_bytes());
        out.extend_from_slice(small);
        out.extend_from_slice(&old[small_end..dirs_start]);
        for row in old[dirs_start..dirs_end].chunks_exact(12) {
            let offset = u64::from_be_bytes(row[0..8].try_into().unwrap());
            let shifted = offset
                .checked_add_signed(delta)
                .ok_or(StoreError::Snapshot(SnapshotError::Corrupt(
                    "store file directory offset overflow",
                )))?;
            out.extend_from_slice(&shifted.to_be_bytes());
            out.extend_from_slice(&row[8..12]);
        }
        out.extend_from_slice(&old[dirs_end..]);
        self.atomic_replace_and_reload(&out)
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

    fn leaf_hashes(&self) -> Result<(Vec<[u8; 32]>, Vec<[u8; 32]>), StoreError> {
        self.state
            .as_ref()
            .map(|(l, _)| (l.leaf_pages.clone(), l.leaf_exts.clone()))
            .ok_or(StoreError::Empty)
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

    fn free_leaf_hashes(&self) -> Result<Vec<[u8; 32]>, StoreError> {
        self.state
            .as_ref()
            .map(|(l, _)| l.leaf_frees.clone())
            .ok_or(StoreError::Empty)
    }

    fn commit(&mut self, batch: &CheckpointBatch) -> Result<(), StoreError> {
        // Reload the durable file: the cached view can be stale if
        // another handle on this path committed (the review's silent
        // ping-pong finding). Both the succession check and the
        // clean-row merge below must run against what is actually on
        // disk, so a forked handle fails closed with
        // EpochMismatch/BaselineMismatch instead of resurrecting its
        // stale baseline over the other's commit.
        let durable: Option<(Loaded, RefCell<File>)> = if self.path.exists() {
            let mut f = File::open(&self.path).map_err(io_err)?;
            let l = Self::load(&mut f)?;
            Some((l, RefCell::new(f)))
        } else {
            None
        };
        check_succession(durable.as_ref().map(|(l, _)| &l.manifest), batch)?;

        let n_pages = slot_page_count(batch.manifest.slot_count);
        let n_exts = chunk_extent_count(batch.manifest.chunk_len);

        // Resolve every row of the NEW geometry: a batch row wins;
        // otherwise the previous file must hold it (a grown row that is
        // not in the batch is a caller bug, refused as MissingRow).
        // Dirty sources are indices into the batch's own vectors so no
        // borrow outlives this frame.
        use std::collections::HashMap;
        let dirty_pages: HashMap<u32, usize> = batch
            .slot_pages
            .iter()
            .enumerate()
            .map(|(i, (p, _))| (*p, i))
            .collect();
        let dirty_exts: HashMap<u32, usize> = batch
            .chunk_extents
            .iter()
            .enumerate()
            .map(|(i, (e, _))| (*e, i))
            .collect();

        enum Source {
            DirtyPage(usize),
            DirtyExtent(usize),
            Prior(DirEntry),
        }

        let row_len = |len: usize, what: &'static str| -> Result<u32, StoreError> {
            u32::try_from(len).map_err(|_| corrupt(what))
        };
        let mut sources: Vec<Source> = Vec::with_capacity((n_pages + n_exts) as usize);
        let mut lengths: Vec<u32> = Vec::with_capacity((n_pages + n_exts) as usize);
        for page in 0..n_pages {
            if let Some(&i) = dirty_pages.get(&page) {
                sources.push(Source::DirtyPage(i));
                lengths.push(row_len(
                    batch.slot_pages[i].1.len(),
                    "file store slot page row exceeds u32",
                )?);
            } else {
                let entry = durable
                    .as_ref()
                    .and_then(|(l, _)| l.pages.get(page as usize))
                    .copied()
                    .ok_or(StoreError::MissingRow("slot page", page))?;
                sources.push(Source::Prior(entry));
                lengths.push(entry.length);
            }
        }
        for ext in 0..n_exts {
            if let Some(&i) = dirty_exts.get(&ext) {
                sources.push(Source::DirtyExtent(i));
                lengths.push(row_len(
                    batch.chunk_extents[i].1.len(),
                    "file store chunk extent row exceeds u32",
                )?);
            } else {
                let entry = durable
                    .as_ref()
                    .and_then(|(l, _)| l.extents.get(ext as usize))
                    .copied()
                    .ok_or(StoreError::MissingRow("chunk extent", ext))?;
                sources.push(Source::Prior(entry));
                lengths.push(entry.length);
            }
        }

        // The shared per-commit verification and leaf/summary
        // maintenance (grown-region presence, row lengths, summary
        // coupling, root recombination) against the DURABLE prior
        // state — after source resolution, so a missing grown row
        // reports its precise MissingRow error rather than a root
        // mismatch.
        let mut leaf_pages = durable
            .as_ref()
            .map(|(l, _)| l.leaf_pages.clone())
            .unwrap_or_default();
        let mut leaf_exts = durable
            .as_ref()
            .map(|(l, _)| l.leaf_exts.clone())
            .unwrap_or_default();
        let mut leaf_frees = durable
            .as_ref()
            .map(|(l, _)| l.leaf_frees.clone())
            .unwrap_or_default();
        let mut edges = durable
            .as_ref()
            .map(|(l, _)| l.edges.clone())
            .unwrap_or_default();
        crate::store::apply_batch(
            &mut leaf_pages,
            &mut leaf_exts,
            &mut leaf_frees,
            &mut edges,
            durable.as_ref().map(|(l, _)| &l.manifest),
            batch,
        )?;
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
        let free_bytes: u64 = 4 + free_segs.iter().map(|b| 4 + b.len() as u64).sum::<u64>()
            + 32 * n_free_segs as u64;
        let edges_bytes: u64 = edges.iter().map(|ts| 4 + 4 * ts.len() as u64).sum();

        // Lay the file out: header, manifest, small, counts, dirs,
        // blobs. Directory offsets are computable before writing.
        let manifest_bytes = batch.manifest.encode();
        let header_len = 8
            + 4
            + manifest_bytes.len() as u64
            + 4
            + batch.small.len() as u64
            + 4
            + 4
            + 12 * (n_pages as u64 + n_exts as u64)
            + 32 * (n_pages as u64 + n_exts as u64)
            + edges_bytes
            + free_bytes;
        let mut offsets: Vec<u64> = Vec::with_capacity(lengths.len());
        let mut cursor = header_len;
        for len in &lengths {
            offsets.push(cursor);
            cursor += *len as u64;
        }

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
        // store (leftovers are inert but unbounded — review nit).
        let write_tmp = || -> Result<(), StoreError> {
            let mut tmp = File::create(&tmp_path).map_err(io_err)?;
            tmp.write_all(&FILE_MAGIC).map_err(io_err)?;
            tmp.write_all(&(manifest_bytes.len() as u32).to_be_bytes())
                .map_err(io_err)?;
            tmp.write_all(&manifest_bytes).map_err(io_err)?;
            tmp.write_all(&(batch.small.len() as u32).to_be_bytes())
                .map_err(io_err)?;
            tmp.write_all(&batch.small).map_err(io_err)?;
            tmp.write_all(&n_pages.to_be_bytes()).map_err(io_err)?;
            tmp.write_all(&n_exts.to_be_bytes()).map_err(io_err)?;
            for (offset, length) in offsets.iter().zip(&lengths) {
                tmp.write_all(&offset.to_be_bytes()).map_err(io_err)?;
                tmp.write_all(&length.to_be_bytes()).map_err(io_err)?;
            }
            for l in &leaf_pages {
                tmp.write_all(l).map_err(io_err)?;
            }
            for l in &leaf_exts {
                tmp.write_all(l).map_err(io_err)?;
            }
            for ts in &edges {
                tmp.write_all(&(ts.len() as u32).to_be_bytes()).map_err(io_err)?;
                for t in ts {
                    tmp.write_all(&t.to_be_bytes()).map_err(io_err)?;
                }
            }
            tmp.write_all(&(free_segs.len() as u32).to_be_bytes())
                .map_err(io_err)?;
            for b in &free_segs {
                tmp.write_all(&(b.len() as u32).to_be_bytes()).map_err(io_err)?;
                tmp.write_all(b).map_err(io_err)?;
            }
            for l in &leaf_frees {
                tmp.write_all(l).map_err(io_err)?;
            }
            for source in &sources {
                match source {
                    Source::DirtyPage(i) => {
                        tmp.write_all(&batch.slot_pages[*i].1).map_err(io_err)?
                    }
                    Source::DirtyExtent(i) => {
                        tmp.write_all(&batch.chunk_extents[*i].1).map_err(io_err)?
                    }
                    Source::Prior(entry) => {
                        // Stream the clean row from the durable previous file.
                        let (_, file) = durable.as_ref().expect("prior row implies prior file");
                        let mut f = file.borrow_mut();
                        f.seek(SeekFrom::Start(entry.offset)).map_err(io_err)?;
                        let mut buf = vec![0u8; entry.length as usize];
                        f.read_exact(&mut buf).map_err(io_err)?;
                        drop(f);
                        tmp.write_all(&buf).map_err(io_err)?;
                    }
                }
            }
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
            // unbounded across retries (wave-3 finding — the cleanup
            // wrapped only the write stage while the comment above it
            // promised "any failure").
            let _ = std::fs::remove_file(&tmp_path);
            return Err(io_err(e));
        }
        // The rename is the commit point, and it is durable only once
        // the containing directory is synced (the review's power-loss
        // finding: an acked checkpoint must not roll back on crash).
        // `Path::parent()` returns `Some("")` for a bare relative
        // filename, and opening "" fails ENOENT AFTER the rename — a
        // durable commit misreported as failed, wedging the session
        // one epoch behind its own file (the review's bare-filename
        // finding). An empty parent means the current directory.
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
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::format::Signature;
    use crate::image::write_machine;
    use crate::machine::MachineSnapshot;
    use crate::store::{
        export_to_container, image_to_batch, import_from_container, store_to_image,
        validate_store,
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
        m.snapshot_image(&sig()).expect("gated image")
    }

    fn tmp_dir(name: &str) -> crate::test_dir::TempDir {
        crate::test_dir::TempDir::new(&format!("ironhorse-file-store-{name}"))
    }

    #[test]
    fn failed_rename_removes_the_temp_file() {
        // wave-3: the cleanup used to wrap only the WRITE stage, so a
        // failed rename leaked its .tmp file — inert litter (opens
        // ignore it) but unbounded across retries. Parking a
        // non-empty directory at the store path makes the rename fail
        // deterministically (EISDIR/ENOTEMPTY), which works under
        // root too, where permission-bit tricks do not.
        let dir = tmp_dir("failed-rename-cleanup");
        let target = dir.join("heap.ihstore");
        let mut store = FileStore::open(&target).unwrap();
        std::fs::create_dir_all(target.join("occupier")).unwrap();
        let image = ran_image();
        assert!(
            store.commit(&image_to_batch(&image, 1, "")).is_err(),
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
        let bytes = write_machine(&image);

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
        store.commit(&image_to_batch(&image, 1, "")).unwrap();

        // Mutate one record on page 0 and commit only that page.
        let mut changed = image.clone();
        changed.slots[0] = ironhorse_vm::Slot::integer(424242);
        let prev = store.manifest().unwrap().seal;
        let full = image_to_batch(&changed, 2, &prev);
        let mut one_page = CheckpointBatch {
            prev_seal: prev.clone(),
            manifest: full.manifest.clone(),
            small: full.small.clone(),
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
        // The dirty-only batch seals over exactly its own rows (the
        // legitimate producer's shape); the full batch's seal covered
        // every page and must not be reused.
        crate::store::reseal_batch(&mut one_page);
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
        store.commit(&image_to_batch(&image, 1, "")).unwrap();
        drop(store);

        let mut store = FileStore::open(&path).unwrap();
        // Replaying epoch 1 into a store already at epoch 1 is refused.
        assert_eq!(
            store.commit(&image_to_batch(&image, 1, "")).unwrap_err(),
            StoreError::EpochMismatch {
                expected: 2,
                found: 1
            }
        );
        let prev = store.manifest().unwrap().seal;
        store.commit(&image_to_batch(&image, 2, &prev)).unwrap();
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
        store.commit(&image_to_batch(&image, 1, "")).unwrap();
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
        store.commit(&image_to_batch(&image, 1, "")).unwrap();
        drop(store);

        std::fs::write(dir.join("heap.ihstore.tmp"), b"half a checkpoint").unwrap();
        let mut store = FileStore::open(&path).unwrap();
        assert_eq!(store_to_image(&store).unwrap(), image);
        let prev = store.manifest().unwrap().seal;
        store.commit(&image_to_batch(&image, 2, &prev)).unwrap();
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
        store.commit(&image_to_batch(&image, 1, "")).unwrap();

        let mut grown = image.clone();
        grown
            .chunks
            .extend(std::iter::repeat_n(7u8, crate::store::CHUNK_EXTENT_BYTES as usize));
        let prev = store.manifest().unwrap().seal;
        let mut batch = image_to_batch(&grown, 2, &prev);
        batch.chunk_extents.pop(); // drop the newest extent's row
        crate::store::reseal_batch(&mut batch);
        match store.commit(&batch) {
            Err(StoreError::MissingRow("chunk extent", _)) => {}
            other => panic!("expected missing grown row, got {other:?}"),
        }
    }
}
