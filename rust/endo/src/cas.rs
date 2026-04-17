use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::RwLock;

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
// ContentStore
// ---------------------------------------------------------------------------

/// SHA-256 content-addressed store backed by a flat directory.
///
/// Files are stored as `{dir}/{hex-sha256}`.
/// Optional `.meta` sidecars carry advisory type and ref count.
pub struct ContentStore {
    dir: PathBuf,
    /// In-memory ref count cache (flushed to `.meta` on release/retain).
    refs: RwLock<HashMap<String, u32>>,
}

impl ContentStore {
    /// Open (or create) a content store at `dir`.
    pub fn open(dir: &Path) -> io::Result<Self> {
        fs::create_dir_all(dir)?;
        Ok(ContentStore {
            dir: dir.to_path_buf(),
            refs: RwLock::new(HashMap::new()),
        })
    }

    /// Store bytes in the CAS and return the hex SHA-256 hash.
    pub fn store(&self, data: &[u8], content_type: &str) -> io::Result<String> {
        let hash = hex_sha256(data);
        let path = self.dir.join(&hash);
        if !path.exists() {
            // Write atomically: write to .tmp, then rename.
            let tmp = self.dir.join(format!("{hash}.tmp"));
            fs::write(&tmp, data)?;
            fs::rename(&tmp, &path)?;
        }
        // Write .meta if content type is not blob (default).
        if content_type != "blob" {
            self.write_meta(&hash, content_type, 0)?;
        }
        Ok(hash)
    }

    /// Fetch content by hex hash.
    pub fn fetch(&self, hash: &str) -> io::Result<Vec<u8>> {
        let path = self.dir.join(hash);
        fs::read(&path)
    }

    /// Check whether a hash exists in the store.
    pub fn has(&self, hash: &str) -> bool {
        self.dir.join(hash).exists()
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

    /// Return the directory path of the store.
    pub fn dir(&self) -> &Path {
        &self.dir
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
}
