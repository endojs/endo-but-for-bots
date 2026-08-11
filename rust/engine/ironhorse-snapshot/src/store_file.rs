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
//! [8]  magic "IHSTORE1"
//! [4]  manifest length   [..] manifest (StoreManifest::encode)
//! [4]  small length      [..] small state (SmallState::encode)
//! [4]  slot-page count   [4] chunk-extent count
//! [page directory: count × (u64 offset, u32 length)]
//! [extent directory: count × (u64 offset, u32 length)]
//! [page leaf hashes: count × 32]  [extent leaf hashes: count × 32]
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

/// The file-format discriminator. Version-suffixed: a layout change is
/// a new magic, and a reader fails closed on a magic it does not know.
pub const FILE_MAGIC: [u8; 8] = *b"IHSTORE2";

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
    /// Open the store at `path`. An absent file is a valid empty store
    /// (its first commit creates the file); a present file has its
    /// header and directories decoded and checked immediately, so a
    /// foreign or truncated file fails closed here rather than on a
    /// later fault.
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

        // The directories must cover exactly the manifest's geometry —
        // the same promise the row inventory of `validate_store`
        // re-checks with lengths.
        if pages.len() != slot_page_count(manifest.slot_count) as usize {
            return Err(corrupt("file store page directory disagrees with geometry"));
        }
        if extents.len() != chunk_extent_count(manifest.chunk_len) as usize {
            return Err(corrupt(
                "file store extent directory disagrees with geometry",
            ));
        }

        Ok(Loaded {
            manifest,
            small,
            pages,
            extents,
            leaf_pages,
            leaf_exts,
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

        let mut sources: Vec<Source> = Vec::with_capacity((n_pages + n_exts) as usize);
        let mut lengths: Vec<u32> = Vec::with_capacity((n_pages + n_exts) as usize);
        for page in 0..n_pages {
            if let Some(&i) = dirty_pages.get(&page) {
                sources.push(Source::DirtyPage(i));
                lengths.push(batch.slot_pages[i].1.len() as u32);
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
                lengths.push(batch.chunk_extents[i].1.len() as u32);
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

        // Leaf maintenance + root verification (phase 5) against the
        // DURABLE prior leaves — after source resolution, so a missing
        // grown row reports its precise MissingRow error rather than a
        // root mismatch.
        let mut leaf_pages = durable
            .as_ref()
            .map(|(l, _)| l.leaf_pages.clone())
            .unwrap_or_default();
        let mut leaf_exts = durable
            .as_ref()
            .map(|(l, _)| l.leaf_exts.clone())
            .unwrap_or_default();
        crate::store::apply_batch_leaves(&mut leaf_pages, &mut leaf_exts, batch)?;

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
            + 32 * (n_pages as u64 + n_exts as u64);
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
        for source in &sources {
            match source {
                Source::DirtyPage(i) => tmp.write_all(&batch.slot_pages[*i].1).map_err(io_err)?,
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
        drop(tmp);
        std::fs::rename(&tmp_path, &self.path).map_err(io_err)?;
        // The rename is the commit point, and it is durable only once
        // the containing directory is synced (the review's power-loss
        // finding: an acked checkpoint must not roll back on crash).
        if let Some(dir) = self.path.parent() {
            File::open(dir).and_then(|d| d.sync_all()).map_err(io_err)?;
        }

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
        m.snapshot_image(&sig())
    }

    fn tmp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ironhorse-file-store-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn absent_file_is_an_empty_store() {
        let dir = tmp_dir("empty");
        let store = FileStore::open(dir.join("heap.ihstore")).unwrap();
        assert_eq!(store.manifest().unwrap_err(), StoreError::Empty);
        let _ = std::fs::remove_dir_all(&dir);
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
        let _ = std::fs::remove_dir_all(&dir);
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
        let _ = std::fs::remove_dir_all(&dir);
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
        let _ = std::fs::remove_dir_all(&dir);
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
        let _ = std::fs::remove_dir_all(&dir);
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
        let _ = std::fs::remove_dir_all(&dir);
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
        let _ = std::fs::remove_dir_all(&dir);
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
        let _ = std::fs::remove_dir_all(&dir);
    }
}
