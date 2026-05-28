use std::collections::{HashMap, HashSet};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::RwLock;

use gix_object::Write as _;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

// ---------------------------------------------------------------------------
// Content types
// ---------------------------------------------------------------------------

/// Advisory content type stored in `.meta` sidecar.
#[derive(Clone, Debug, PartialEq)]
pub enum ContentType {
    Blob,
    Snapshot,
    Tree,
    Archive,
}

impl ContentType {
    pub fn as_str(&self) -> &'static str {
        match self {
            ContentType::Blob => "blob",
            ContentType::Snapshot => "snapshot",
            ContentType::Tree => "tree",
            ContentType::Archive => "archive",
        }
    }

    pub fn from_str(s: &str) -> Self {
        match s {
            "snapshot" => ContentType::Snapshot,
            "tree" => ContentType::Tree,
            "archive" => ContentType::Archive,
            _ => ContentType::Blob,
        }
    }
}

// ---------------------------------------------------------------------------
// Tree representation
// ---------------------------------------------------------------------------

/// A tree manifest in the CAS — maps names to child entries.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TreeManifest {
    pub entries: HashMap<String, TreeEntry>,
}

/// A single entry in a CAS tree.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TreeEntry {
    #[serde(rename = "type")]
    pub entry_type: String,
    pub hash: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
}

// ---------------------------------------------------------------------------
// ContentStore
// ---------------------------------------------------------------------------

/// SHA-256 content-addressed store backed by a git object database.
///
/// The Endo-facing content identity is the hex SHA-256 of the bytes, exactly
/// as before; the bytes themselves live as git (loose) objects under
/// `{dir}/objects/`, and a persistent `sha256 -> git-oid` index
/// (`{dir}/sha256-oid.idx`) bridges the Endo key to git's internal object id.
/// Git's object DB runs in its default (SHA-1) object format internally; the
/// experimental git SHA-256 object mode is deliberately not used (the
/// Endo-facing key stays SHA-256 regardless).
///
/// Optional `.meta` sidecars in `{dir}` carry advisory type and ref count, as
/// before. Retention (`retain`/`release`/`gc`) is unchanged in this pass; the
/// design's axis 4 replaces it with `refs/formulas/<id>` + `git gc`.
pub struct ContentStore {
    dir: PathBuf,
    /// Git loose-object database rooted at `{dir}/objects/`.
    odb: gix_odb::loose::Store,
    /// Persistent `sha256-hex -> git-oid` index, loaded on open and appended
    /// on every newly stored object. Endo references the SHA-256 key; this
    /// resolves it to the git object id used by the object DB.
    index: RwLock<HashMap<String, gix_hash::ObjectId>>,
    /// In-memory ref count cache (flushed to `.meta` on release/retain).
    refs: RwLock<HashMap<String, u32>>,
}

/// Basename of the persistent sha256 -> git-oid index inside the store dir.
const INDEX_FILE: &str = "sha256-oid.idx";
/// Subdirectory of the store dir holding the git loose-object database.
const OBJECTS_DIR: &str = "objects";

impl ContentStore {
    /// Open (or create) a content store at `dir`.
    pub fn open(dir: &Path) -> io::Result<Self> {
        fs::create_dir_all(dir)?;
        let objects_dir = dir.join(OBJECTS_DIR);
        fs::create_dir_all(&objects_dir)?;
        let odb = gix_odb::loose::Store::at(&objects_dir, gix_hash::Kind::Sha1, None);
        let index = RwLock::new(load_index(dir)?);
        Ok(ContentStore {
            dir: dir.to_path_buf(),
            odb,
            index,
            refs: RwLock::new(HashMap::new()),
        })
    }

    /// Store bytes in the CAS and return the hex SHA-256 hash.
    ///
    /// The bytes are written as a git blob; the returned identity is the hex
    /// SHA-256 of the bytes (unchanged contract). A `sha256 -> git-oid` entry
    /// is recorded so subsequent `fetch`/`has` resolve back to the object.
    pub fn store(&self, data: &[u8], content_type: &str) -> io::Result<String> {
        let hash = hex_sha256(data);
        // Only write the git object (and index entry) the first time we see a
        // given SHA-256 — preserves dedup. Git's own loose writer is
        // content-addressed and atomic (tempfile + rename) under the hood.
        if !self.index_contains(&hash) {
            let oid = self
                .odb
                .write_buf(gix_object::Kind::Blob, data)
                .map_err(|e| io::Error::new(io::ErrorKind::Other, format!("git write: {e}")))?;
            self.record_index(&hash, oid)?;
        }
        // Write .meta if content type is not blob (default).
        if content_type != "blob" {
            self.write_meta(&hash, content_type, 0)?;
        }
        Ok(hash)
    }

    /// Fetch content by hex hash.
    pub fn fetch(&self, hash: &str) -> io::Result<Vec<u8>> {
        let oid = self.oid_for(hash).ok_or_else(|| {
            io::Error::new(io::ErrorKind::NotFound, format!("no object for {hash}"))
        })?;
        let mut buf = Vec::new();
        match self
            .odb
            .try_find(&oid, &mut buf)
            .map_err(|e| io::Error::new(io::ErrorKind::Other, format!("git read: {e}")))?
        {
            Some(obj) => Ok(obj.data.to_vec()),
            None => Err(io::Error::new(
                io::ErrorKind::NotFound,
                format!("git object missing for {hash}"),
            )),
        }
    }

    /// Check whether a hash exists in the store.
    pub fn has(&self, hash: &str) -> bool {
        match self.oid_for(hash) {
            Some(oid) => self.odb.contains(&oid),
            None => false,
        }
    }

    /// Increment ref count for a hash.
    pub fn retain(&self, hash: &str) {
        let mut refs = self.refs.write().unwrap_or_else(|e| e.into_inner());
        let count = refs.entry(hash.to_string()).or_insert(0);
        *count += 1;
        // Best-effort flush to .meta.
        let _ = self.write_meta(hash, "blob", *count);
    }

    /// Decrement ref count for a hash.
    pub fn release(&self, hash: &str) {
        let mut refs = self.refs.write().unwrap_or_else(|e| e.into_inner());
        if let Some(count) = refs.get_mut(hash) {
            *count = count.saturating_sub(1);
            let _ = self.write_meta(hash, "blob", *count);
        }
    }

    /// Store a tree entry (JSON manifest) in the CAS.
    /// Returns the tree's own SHA-256 hash.
    pub fn store_tree(&self, tree_json: &[u8]) -> io::Result<String> {
        self.store(tree_json, "tree")
    }

    /// Read a tree entry and return its JSON bytes.
    pub fn fetch_tree(&self, hash: &str) -> io::Result<Vec<u8>> {
        self.fetch(hash)
    }

    /// Parse a tree manifest from the CAS.
    pub fn read_tree(&self, hash: &str) -> io::Result<TreeManifest> {
        let data = self.fetch(hash)?;
        serde_json::from_slice(&data).map_err(|e| {
            io::Error::new(io::ErrorKind::InvalidData, format!("invalid tree JSON: {e}"))
        })
    }

    /// List the names of entries in a tree.
    pub fn list_tree(&self, hash: &str) -> io::Result<Vec<String>> {
        let tree = self.read_tree(hash)?;
        let mut names: Vec<String> = tree.entries.keys().cloned().collect();
        names.sort();
        Ok(names)
    }

    /// Fetch a blob by traversing a tree path (e.g., `"lib/index.js"`).
    /// Returns the raw blob bytes.
    pub fn fetch_from_tree(&self, root_hash: &str, path: &str) -> io::Result<Vec<u8>> {
        let parts: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
        let mut current_hash = root_hash.to_string();
        for (i, part) in parts.iter().enumerate() {
            let tree = self.read_tree(&current_hash)?;
            let entry = tree.entries.get(*part).ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::NotFound,
                    format!("entry not found: {part}"),
                )
            })?;
            if i < parts.len() - 1 {
                // Intermediate path component — must be a tree.
                if entry.entry_type != "tree" {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        format!("{part} is not a tree"),
                    ));
                }
                current_hash = entry.hash.clone();
            } else {
                // Final component — fetch it (blob or tree).
                return self.fetch(&entry.hash);
            }
        }
        // Empty path — return the tree itself.
        self.fetch(&current_hash)
    }

    /// Return the directory path of the store.
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// Run garbage collection. Deletes entries that:
    /// - Have zero ref count in the in-memory cache.
    /// - Are not in `live_roots`.
    /// - Are not transitively referenced by a live tree.
    ///
    /// Returns a report of what was collected.
    pub fn gc(&self, live_roots: &HashSet<String>) -> io::Result<GcReport> {
        // Build the full live set by walking trees from live_roots.
        let mut live = live_roots.clone();

        // Also include anything with refs > 0.
        {
            let refs = self.refs.read().unwrap_or_else(|e| e.into_inner());
            for (hash, count) in refs.iter() {
                if *count > 0 {
                    live.insert(hash.clone());
                }
            }
        }

        // Expand tree references: walk all live trees and mark children.
        let mut to_walk: Vec<String> = live.iter().cloned().collect();
        while let Some(hash) = to_walk.pop() {
            if let Ok(tree) = self.read_tree(&hash) {
                for entry in tree.entries.values() {
                    if live.insert(entry.hash.clone()) {
                        // Newly seen — walk if it might be a tree.
                        if entry.entry_type == "tree" {
                            to_walk.push(entry.hash.clone());
                        }
                    }
                }
            }
            // If read_tree fails, it's a blob — no children to walk.
        }

        // Sweep: walk the sha256 -> oid index, collecting unreferenced
        // objects. The set of CAS objects is exactly the index keyset (every
        // stored object recorded an entry); the git object DB may hold extra
        // intermediate objects, but the CAS only owns those it indexed.
        let mut freed_count = 0u64;
        let mut freed_bytes = 0u64;

        // Snapshot the hashes to collect so we don't hold the index read lock
        // while mutating it.
        let to_collect: Vec<(String, gix_hash::ObjectId)> = {
            let index = self.index.read().unwrap_or_else(|e| e.into_inner());
            index
                .iter()
                .filter(|(hash, _)| !live.contains(hash.as_str()))
                .map(|(hash, oid)| (hash.clone(), *oid))
                .collect()
        };

        for (hash, oid) in to_collect {
            // Size of the on-disk git object (compressed), best-effort.
            let object_path = self.odb.object_path(&oid);
            let size = fs::metadata(&object_path).map(|m| m.len()).unwrap_or(0);
            // Delete the git object file. It is shared by oid, so only remove
            // it if no other indexed hash maps to the same oid.
            let still_referenced = {
                let index = self.index.read().unwrap_or_else(|e| e.into_inner());
                index
                    .iter()
                    .any(|(other_hash, other_oid)| other_hash != &hash && *other_oid == oid)
            };
            if !still_referenced {
                let _ = fs::remove_file(&object_path);
                freed_bytes += size;
            }
            // Drop the meta sidecar.
            let meta_path = self.dir.join(format!("{hash}.meta"));
            let _ = fs::remove_file(&meta_path);
            // Drop the index entry and any in-memory ref count.
            {
                let mut index = self.index.write().unwrap_or_else(|e| e.into_inner());
                index.remove(&hash);
            }
            {
                let mut refs = self.refs.write().unwrap_or_else(|e| e.into_inner());
                refs.remove(&hash);
            }
            freed_count += 1;
        }

        // Persist the pruned index.
        self.persist_index()?;

        Ok(GcReport {
            freed_count,
            freed_bytes,
        })
    }

    // -----------------------------------------------------------------------
    // Internal helpers
    // -----------------------------------------------------------------------

    fn write_meta(&self, hash: &str, content_type: &str, ref_count: u32) -> io::Result<()> {
        let meta_path = self.dir.join(format!("{hash}.meta"));
        let json = format!(
            "{{\"type\":\"{content_type}\",\"refs\":{ref_count}}}"
        );
        fs::write(&meta_path, json.as_bytes())
    }

    /// Resolve an Endo SHA-256 key to its git object id, if indexed.
    fn oid_for(&self, hash: &str) -> Option<gix_hash::ObjectId> {
        let index = self.index.read().unwrap_or_else(|e| e.into_inner());
        index.get(hash).copied()
    }

    /// Whether the SHA-256 key already has an index entry.
    fn index_contains(&self, hash: &str) -> bool {
        let index = self.index.read().unwrap_or_else(|e| e.into_inner());
        index.contains_key(hash)
    }

    /// Record a `sha256 -> git-oid` mapping in memory and persist it.
    fn record_index(&self, hash: &str, oid: gix_hash::ObjectId) -> io::Result<()> {
        {
            let mut index = self.index.write().unwrap_or_else(|e| e.into_inner());
            index.insert(hash.to_string(), oid);
        }
        self.persist_index()
    }

    /// Rewrite the persistent index file atomically (`.tmp` then rename).
    fn persist_index(&self) -> io::Result<()> {
        let index = self.index.read().unwrap_or_else(|e| e.into_inner());
        let mut body = String::with_capacity(index.len() * 110);
        for (hash, oid) in index.iter() {
            body.push_str(hash);
            body.push(' ');
            body.push_str(&oid.to_hex().to_string());
            body.push('\n');
        }
        let path = self.dir.join(INDEX_FILE);
        let tmp = self.dir.join(format!("{INDEX_FILE}.tmp"));
        fs::write(&tmp, body.as_bytes())?;
        fs::rename(&tmp, &path)
    }
}

/// Load the persistent `sha256 -> git-oid` index from `{dir}/sha256-oid.idx`.
///
/// Each line is `<sha256-hex> <git-oid-hex>`. A missing file yields an empty
/// index (a fresh store). Malformed lines are skipped rather than failing the
/// whole open.
fn load_index(dir: &Path) -> io::Result<HashMap<String, gix_hash::ObjectId>> {
    let path = dir.join(INDEX_FILE);
    let mut map = HashMap::new();
    let body = match fs::read_to_string(&path) {
        Ok(b) => b,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(map),
        Err(e) => return Err(e),
    };
    for line in body.lines() {
        let mut parts = line.split_whitespace();
        let (Some(hash), Some(oid_hex)) = (parts.next(), parts.next()) else {
            continue;
        };
        if let Ok(oid) = gix_hash::ObjectId::from_hex(oid_hex.as_bytes()) {
            map.insert(hash.to_string(), oid);
        }
    }
    Ok(map)
}

/// Report from a GC run.
#[derive(Debug)]
pub struct GcReport {
    pub freed_count: u64,
    pub freed_bytes: u64,
}

/// Compute hex-encoded SHA-256 of `data`.
fn hex_sha256(data: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    let result = hasher.finalize();
    hex::encode(result)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn store_fetch_roundtrip() {
        let tmp = tempfile::tempdir().unwrap();
        let cas = ContentStore::open(tmp.path()).unwrap();

        let data = b"hello, CAS";
        let hash = cas.store(data, "blob").unwrap();

        assert!(cas.has(&hash));
        assert_eq!(cas.fetch(&hash).unwrap(), data);
    }

    #[test]
    fn store_deduplicates() {
        let tmp = tempfile::tempdir().unwrap();
        let cas = ContentStore::open(tmp.path()).unwrap();

        let data = b"duplicate content";
        let h1 = cas.store(data, "blob").unwrap();
        let h2 = cas.store(data, "blob").unwrap();
        assert_eq!(h1, h2);
    }

    #[test]
    fn has_returns_false_for_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let cas = ContentStore::open(tmp.path()).unwrap();
        assert!(!cas.has("0000000000000000000000000000000000000000000000000000000000000000"));
    }

    #[test]
    fn fetch_missing_returns_error() {
        let tmp = tempfile::tempdir().unwrap();
        let cas = ContentStore::open(tmp.path()).unwrap();
        assert!(cas.fetch("nonexistent").is_err());
    }

    #[test]
    fn store_with_content_type_writes_meta() {
        let tmp = tempfile::tempdir().unwrap();
        let cas = ContentStore::open(tmp.path()).unwrap();

        let data = b"snapshot data";
        let hash = cas.store(data, "snapshot").unwrap();

        let meta_path = tmp.path().join(format!("{hash}.meta"));
        assert!(meta_path.exists());
        let meta = fs::read_to_string(&meta_path).unwrap();
        assert!(meta.contains("\"type\":\"snapshot\""));
    }

    #[test]
    fn retain_release_updates_refs() {
        let tmp = tempfile::tempdir().unwrap();
        let cas = ContentStore::open(tmp.path()).unwrap();

        let hash = cas.store(b"ref counted", "blob").unwrap();
        cas.retain(&hash);
        cas.retain(&hash);

        let meta_path = tmp.path().join(format!("{hash}.meta"));
        let meta = fs::read_to_string(&meta_path).unwrap();
        assert!(meta.contains("\"refs\":2"));

        cas.release(&hash);
        let meta = fs::read_to_string(&meta_path).unwrap();
        assert!(meta.contains("\"refs\":1"));
    }

    #[test]
    fn store_tree_and_fetch() {
        let tmp = tempfile::tempdir().unwrap();
        let cas = ContentStore::open(tmp.path()).unwrap();

        // Store child blobs first.
        let blob_hash = cas.store(b"console.log('hello');", "blob").unwrap();

        let tree_json = format!(
            r#"{{"entries":{{"index.js":{{"type":"blob","hash":"{}","size":21}}}}}}"#,
            blob_hash
        );
        let tree_hash = cas.store_tree(tree_json.as_bytes()).unwrap();

        assert!(cas.has(&tree_hash));
        let fetched = cas.fetch_tree(&tree_hash).unwrap();
        assert_eq!(fetched, tree_json.as_bytes());

        // Verify meta says "tree".
        let meta_path = tmp.path().join(format!("{tree_hash}.meta"));
        let meta = fs::read_to_string(&meta_path).unwrap();
        assert!(meta.contains("\"type\":\"tree\""));
    }

    #[test]
    fn list_tree_entries() {
        let tmp = tempfile::tempdir().unwrap();
        let cas = ContentStore::open(tmp.path()).unwrap();

        let blob_hash = cas.store(b"content", "blob").unwrap();
        let tree = TreeManifest {
            entries: {
                let mut m = HashMap::new();
                m.insert("b.js".to_string(), TreeEntry {
                    entry_type: "blob".to_string(),
                    hash: blob_hash.clone(),
                    size: Some(7),
                });
                m.insert("a.js".to_string(), TreeEntry {
                    entry_type: "blob".to_string(),
                    hash: blob_hash,
                    size: Some(7),
                });
                m
            },
        };
        let tree_json = serde_json::to_vec(&tree).unwrap();
        let tree_hash = cas.store_tree(&tree_json).unwrap();

        let names = cas.list_tree(&tree_hash).unwrap();
        assert_eq!(names, vec!["a.js", "b.js"]);
    }

    #[test]
    fn fetch_from_tree_flat() {
        let tmp = tempfile::tempdir().unwrap();
        let cas = ContentStore::open(tmp.path()).unwrap();

        let src = b"export default 42;";
        let blob_hash = cas.store(src, "blob").unwrap();
        let tree = TreeManifest {
            entries: {
                let mut m = HashMap::new();
                m.insert("index.js".to_string(), TreeEntry {
                    entry_type: "blob".to_string(),
                    hash: blob_hash,
                    size: Some(src.len() as u64),
                });
                m
            },
        };
        let tree_json = serde_json::to_vec(&tree).unwrap();
        let root_hash = cas.store_tree(&tree_json).unwrap();

        let fetched = cas.fetch_from_tree(&root_hash, "index.js").unwrap();
        assert_eq!(fetched, src);
    }

    #[test]
    fn fetch_from_tree_nested() {
        let tmp = tempfile::tempdir().unwrap();
        let cas = ContentStore::open(tmp.path()).unwrap();

        // Create nested tree: root -> lib (tree) -> util.js (blob)
        let util_src = b"export const add = (a, b) => a + b;";
        let util_hash = cas.store(util_src, "blob").unwrap();

        let lib_tree = TreeManifest {
            entries: {
                let mut m = HashMap::new();
                m.insert("util.js".to_string(), TreeEntry {
                    entry_type: "blob".to_string(),
                    hash: util_hash,
                    size: Some(util_src.len() as u64),
                });
                m
            },
        };
        let lib_json = serde_json::to_vec(&lib_tree).unwrap();
        let lib_hash = cas.store_tree(&lib_json).unwrap();

        let root_tree = TreeManifest {
            entries: {
                let mut m = HashMap::new();
                m.insert("lib".to_string(), TreeEntry {
                    entry_type: "tree".to_string(),
                    hash: lib_hash,
                    size: None,
                });
                m
            },
        };
        let root_json = serde_json::to_vec(&root_tree).unwrap();
        let root_hash = cas.store_tree(&root_json).unwrap();

        let fetched = cas.fetch_from_tree(&root_hash, "lib/util.js").unwrap();
        assert_eq!(fetched, util_src);
    }

    #[test]
    fn fetch_from_tree_missing_entry() {
        let tmp = tempfile::tempdir().unwrap();
        let cas = ContentStore::open(tmp.path()).unwrap();

        let tree = TreeManifest {
            entries: HashMap::new(),
        };
        let tree_json = serde_json::to_vec(&tree).unwrap();
        let root_hash = cas.store_tree(&tree_json).unwrap();

        let result = cas.fetch_from_tree(&root_hash, "nonexistent.js");
        assert!(result.is_err());
    }

    #[test]
    fn gc_removes_unreferenced() {
        let tmp = tempfile::tempdir().unwrap();
        let cas = ContentStore::open(tmp.path()).unwrap();

        let keep_hash = cas.store(b"keep me", "blob").unwrap();
        let remove_hash = cas.store(b"remove me", "blob").unwrap();

        cas.retain(&keep_hash);

        let report = cas.gc(&HashSet::new()).unwrap();
        assert_eq!(report.freed_count, 1);
        assert!(cas.has(&keep_hash));
        assert!(!cas.has(&remove_hash));
    }

    #[test]
    fn gc_preserves_live_roots() {
        let tmp = tempfile::tempdir().unwrap();
        let cas = ContentStore::open(tmp.path()).unwrap();

        let h1 = cas.store(b"root 1", "blob").unwrap();
        let h2 = cas.store(b"root 2", "blob").unwrap();

        let mut live = HashSet::new();
        live.insert(h1.clone());
        live.insert(h2.clone());

        let report = cas.gc(&live).unwrap();
        assert_eq!(report.freed_count, 0);
        assert!(cas.has(&h1));
        assert!(cas.has(&h2));
    }

    #[test]
    fn gc_preserves_tree_children() {
        let tmp = tempfile::tempdir().unwrap();
        let cas = ContentStore::open(tmp.path()).unwrap();

        let blob_hash = cas.store(b"tree child", "blob").unwrap();
        let tree = TreeManifest {
            entries: {
                let mut m = HashMap::new();
                m.insert("child.js".to_string(), TreeEntry {
                    entry_type: "blob".to_string(),
                    hash: blob_hash.clone(),
                    size: Some(10),
                });
                m
            },
        };
        let tree_json = serde_json::to_vec(&tree).unwrap();
        let tree_hash = cas.store_tree(&tree_json).unwrap();
        let orphan = cas.store(b"orphan", "blob").unwrap();

        // Only the tree is a live root — its child should be preserved.
        let mut live = HashSet::new();
        live.insert(tree_hash.clone());

        let report = cas.gc(&live).unwrap();
        assert_eq!(report.freed_count, 1); // orphan removed
        assert!(cas.has(&tree_hash));
        assert!(cas.has(&blob_hash)); // child preserved
        assert!(!cas.has(&orphan));
    }

    #[test]
    fn structural_sharing() {
        let tmp = tempfile::tempdir().unwrap();
        let cas = ContentStore::open(tmp.path()).unwrap();

        // Two trees sharing the same blob.
        let shared_blob = cas.store(b"shared content", "blob").unwrap();

        let tree1 = TreeManifest {
            entries: {
                let mut m = HashMap::new();
                m.insert("shared.js".to_string(), TreeEntry {
                    entry_type: "blob".to_string(),
                    hash: shared_blob.clone(),
                    size: Some(14),
                });
                m
            },
        };
        let tree2 = TreeManifest {
            entries: {
                let mut m = HashMap::new();
                m.insert("also-shared.js".to_string(), TreeEntry {
                    entry_type: "blob".to_string(),
                    hash: shared_blob.clone(),
                    size: Some(14),
                });
                m
            },
        };

        let h1 = cas.store_tree(&serde_json::to_vec(&tree1).unwrap()).unwrap();
        let h2 = cas.store_tree(&serde_json::to_vec(&tree2).unwrap()).unwrap();

        // Trees have different hashes.
        assert_ne!(h1, h2);
        // But both reference the same blob.
        let b1 = cas.read_tree(&h1).unwrap().entries["shared.js"].hash.clone();
        let b2 = cas.read_tree(&h2).unwrap().entries["also-shared.js"].hash.clone();
        assert_eq!(b1, b2);
        assert_eq!(b1, shared_blob);
    }

    // -- Axis 1: git object-DB substrate ----------------------------------

    /// The bytes are stored as git objects under `{dir}/objects/`, and a
    /// persistent `sha256 -> git-oid` index file is written. This asserts the
    /// substrate is the git object DB (not the old flat `{dir}/{hex-sha256}`).
    #[test]
    fn store_uses_git_object_db_and_index() {
        let tmp = tempfile::tempdir().unwrap();
        let cas = ContentStore::open(tmp.path()).unwrap();

        let hash = cas.store(b"git substrate", "blob").unwrap();

        // The Endo key never appears as a raw flat-dir file.
        assert!(
            !tmp.path().join(&hash).exists(),
            "blob must not be stored as a flat {{dir}}/{{hex-sha256}} file"
        );
        // The git object DB directory holds the object.
        let objects_dir = tmp.path().join(OBJECTS_DIR);
        assert!(objects_dir.is_dir(), "git objects/ dir must exist");
        // The persistent index records the mapping.
        let index_path = tmp.path().join(INDEX_FILE);
        assert!(index_path.exists(), "sha256 -> oid index must be persisted");
        let index_body = fs::read_to_string(&index_path).unwrap();
        assert!(
            index_body.starts_with(&hash),
            "index must record the sha256 key"
        );
    }

    /// The git oid the index maps to is a real, resolvable git blob whose
    /// bytes equal the stored bytes. This proves the `sha256 -> git-oid`
    /// bridge actually resolves through the git object DB.
    #[test]
    fn index_oid_resolves_to_git_blob() {
        let tmp = tempfile::tempdir().unwrap();
        let cas = ContentStore::open(tmp.path()).unwrap();

        let data = b"resolvable via oid";
        let hash = cas.store(data, "blob").unwrap();

        let oid = cas.oid_for(&hash).expect("hash must be indexed");
        // The git object DB contains an object at that oid.
        assert!(cas.odb.contains(&oid));
        // Reading via the public API returns the exact bytes.
        assert_eq!(cas.fetch(&hash).unwrap(), data);
    }

    /// The persistent index makes the store survive a reopen: a second
    /// `ContentStore::open` on the same dir resolves content stored by the
    /// first. (The in-memory refcount cache never survived restart; the index
    /// is what gives the substrate durable lookups — see axis-4 framing.)
    #[test]
    fn index_survives_reopen() {
        let tmp = tempfile::tempdir().unwrap();

        let (hash, snapshot_hash);
        {
            let cas = ContentStore::open(tmp.path()).unwrap();
            hash = cas.store(b"persisted blob", "blob").unwrap();
            snapshot_hash = cas.store(b"persisted snapshot", "snapshot").unwrap();
        } // drop the first store — in-memory index is gone.

        let reopened = ContentStore::open(tmp.path()).unwrap();
        assert!(reopened.has(&hash), "blob must resolve after reopen");
        assert_eq!(reopened.fetch(&hash).unwrap(), b"persisted blob");
        assert!(reopened.has(&snapshot_hash));
        assert_eq!(
            reopened.fetch(&snapshot_hash).unwrap(),
            b"persisted snapshot"
        );
    }

    /// Two distinct SHA-256 keys never collide in the index, and fetching one
    /// does not return the other's bytes.
    #[test]
    fn distinct_keys_distinct_objects() {
        let tmp = tempfile::tempdir().unwrap();
        let cas = ContentStore::open(tmp.path()).unwrap();

        let a = cas.store(b"alpha", "blob").unwrap();
        let b = cas.store(b"beta", "blob").unwrap();
        assert_ne!(a, b);
        assert_eq!(cas.fetch(&a).unwrap(), b"alpha");
        assert_eq!(cas.fetch(&b).unwrap(), b"beta");
        assert_ne!(cas.oid_for(&a), cas.oid_for(&b));
    }

    /// GC removes the underlying git object (not a flat-dir file) and prunes
    /// the index entry; the index is re-persisted so the collection survives a
    /// reopen.
    #[test]
    fn gc_prunes_git_object_and_index() {
        let tmp = tempfile::tempdir().unwrap();
        let cas = ContentStore::open(tmp.path()).unwrap();

        let keep = cas.store(b"keep via retain", "blob").unwrap();
        let drop = cas.store(b"drop via gc", "blob").unwrap();
        cas.retain(&keep);

        let drop_oid = cas.oid_for(&drop).expect("indexed before gc");
        let drop_object_path = cas.odb.object_path(&drop_oid);
        assert!(drop_object_path.exists(), "git object present before gc");

        let report = cas.gc(&HashSet::new()).unwrap();
        assert_eq!(report.freed_count, 1);

        // The git object file is gone, and the index no longer maps it.
        assert!(!drop_object_path.exists(), "git object removed by gc");
        assert!(cas.oid_for(&drop).is_none(), "index entry pruned by gc");
        assert!(!cas.has(&drop));
        assert!(cas.has(&keep));

        // The pruned index is durable across reopen.
        let reopened = ContentStore::open(tmp.path()).unwrap();
        assert!(!reopened.has(&drop));
        assert!(reopened.has(&keep));
    }
}
