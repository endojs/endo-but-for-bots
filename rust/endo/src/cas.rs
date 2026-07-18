use std::collections::{HashMap, HashSet};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::RwLock;

use git2::{Oid, Repository};
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
/// as before; the bytes themselves live as git (loose) objects inside a **bare
/// git repository** at `{dir}/cas.git`, and a persistent `sha256 -> git-oid`
/// index (`{dir}/sha256-oid.idx`) bridges the Endo key to git's internal
/// object id. Git's object DB runs in its default (SHA-1) object format
/// internally; the experimental git SHA-256 object mode is deliberately not
/// used (the Endo-facing key stays SHA-256 regardless).
///
/// Optional `.meta` sidecars in `{dir}` carry the advisory content type.
///
/// Retention is **reachability-driven and crash-safe** (axis 4): a retained
/// object is recorded as a git ref under `refs/cas/<sha256>` pointing at the
/// object's git oid, written through libgit2's own ref-lock discipline
/// (lock-file + atomic rename). `gc` computes the live set from those refs —
/// git reachability over the retained roots — rather than from an in-memory
/// refcount that was lost on every restart. This replaces the hand-rolled
/// `HashMap<String, u32>` refcount the store used to flush best-effort to
/// `.meta`; the maintainer's ruling is to lean on git's ref machinery instead
/// of rolling our own retention cache.
///
/// The store holds no live `git2::Repository` handle as a field:
/// `git2::Repository` is `Send` but not `Sync`, while `ContentStore` is shared
/// across threads via `Arc` (the daemon's control thread clones it). Opening a
/// bare repo is cheap, so each operation opens a fresh `Repository` against
/// `repo_dir`, which keeps `ContentStore` `Send + Sync` without an interior
/// mutex on the git handle. (libgit2 already serializes the on-disk
/// object/ref writes through its own locking.)
pub struct ContentStore {
    dir: PathBuf,
    /// Path to the bare git repository (`{dir}/cas.git`) that holds every CAS
    /// object and the `refs/cas/*` retention refs. A fresh `Repository` is
    /// opened against this per operation (see the type doc for why no handle
    /// is held).
    repo_dir: PathBuf,
    /// Persistent `sha256-hex -> git-oid` index, loaded on open and appended
    /// on every newly stored object. Endo references the SHA-256 key; this
    /// resolves it to the git object id used by the object DB.
    index: RwLock<HashMap<String, Oid>>,
}

/// Basename of the persistent sha256 -> git-oid index inside the store dir.
const INDEX_FILE: &str = "sha256-oid.idx";
/// Subdirectory of the store dir holding the bare git repository (object DB +
/// retention refs).
const REPO_DIR: &str = "cas.git";
/// Ref-namespace prefix for retained CAS objects. A ref
/// `refs/cas/<sha256>` -> git-oid is the liveness record for one retained
/// content hash.
const CAS_REF_PREFIX: &str = "refs/cas/";

impl ContentStore {
    /// Open (or create) a content store at `dir`.
    pub fn open(dir: &Path) -> io::Result<Self> {
        fs::create_dir_all(dir)?;
        let repo_dir = dir.join(REPO_DIR);
        // Initialize the bare repository if it is not already present.
        // `Repository::open` is the fast path on an existing store; we only
        // pay `init_bare` on first creation.
        if Repository::open_bare(&repo_dir).is_err() {
            Repository::init_bare(&repo_dir).map_err(git_err("init bare repo"))?;
        }
        let index = RwLock::new(load_index(dir)?);
        Ok(ContentStore {
            dir: dir.to_path_buf(),
            repo_dir,
            index,
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
            let repo = self.open_repo()?;
            let oid = repo.blob(data).map_err(git_err("git write"))?;
            self.record_index(&hash, oid)?;
        }
        // Write .meta if content type is not blob (default).
        if content_type != "blob" {
            self.write_meta(&hash, content_type)?;
        }
        Ok(hash)
    }

    /// Fetch content by hex hash.
    pub fn fetch(&self, hash: &str) -> io::Result<Vec<u8>> {
        let oid = self.oid_for(hash).ok_or_else(|| {
            io::Error::new(io::ErrorKind::NotFound, format!("no object for {hash}"))
        })?;
        let repo = self.open_repo()?;
        let blob = repo.find_blob(oid).map_err(|e| {
            io::Error::new(
                io::ErrorKind::NotFound,
                format!("git object missing for {hash}: {e}"),
            )
        })?;
        Ok(blob.content().to_vec())
    }

    /// Check whether a hash exists in the store.
    pub fn has(&self, hash: &str) -> bool {
        let Some(oid) = self.oid_for(hash) else {
            return false;
        };
        let Ok(repo) = self.open_repo() else {
            return false;
        };
        repo.odb().map(|odb| odb.exists(oid)).unwrap_or(false)
    }

    /// Retain a hash: record it as a live root via `refs/cas/<sha256>`.
    ///
    /// The ref points at the object's git oid and is written through libgit2's
    /// ref-lock discipline (lock-file + atomic rename), so it survives a daemon
    /// restart and a crash mid-write. A retained object is reachable from a
    /// ref, which is what keeps it out of `gc`'s sweep. Best-effort: an unknown
    /// hash (never stored) has no oid to point at and is silently ignored, and
    /// a write failure leaves retention as it was rather than panicking on the
    /// CapTP control path.
    pub fn retain(&self, hash: &str) {
        let Some(oid) = self.oid_for(hash) else {
            return;
        };
        let _ = self.set_cas_ref(hash, oid);
    }

    /// Release a hash: drop its `refs/cas/<sha256>` retention ref.
    ///
    /// After release the object is collectable on the next `gc` unless some
    /// other live root (a tree, an explicit `gc` root, another retain) keeps it
    /// reachable. Deleting a ref that does not exist is a no-op.
    pub fn release(&self, hash: &str) {
        let _ = self.delete_cas_ref(hash);
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

    /// Run garbage collection. Deletes entries that are not reachable from a
    /// live root, where the live roots are:
    /// - the explicit `live_roots` argument (caller-supplied, e.g. the formula
    ///   graph the supervisor knows is live this session), and
    /// - every retained object recorded as a durable `refs/cas/<sha256>` ref.
    ///
    /// The ref-derived roots are the crash-safe replacement for the old
    /// in-memory refcount: because they live on disk through libgit2's ref-lock
    /// discipline, retention survives a daemon restart, and a `gc` after a
    /// restart no longer collects everything that was retained in a prior
    /// session. The transitive tree walk below expands those roots over their
    /// children, which is git reachability over the retained ref set.
    ///
    /// libgit2 (unlike the `git` porcelain) ships no `git gc` / loose-object
    /// prune; the sweep here is the same in-process manual reachability sweep
    /// the store has always done — compute the live set, then delete the
    /// unreachable loose objects directly. This keeps GC in-process with no
    /// runtime dependency on a `git` binary.
    ///
    /// Returns a report of what was collected.
    pub fn gc(&self, live_roots: &HashSet<String>) -> io::Result<GcReport> {
        // Build the full live set, seeded by the caller's explicit roots.
        let mut live = live_roots.clone();

        // Add every object retained via a `refs/cas/<sha256>` ref. These are
        // durable across restart — the load-bearing reachability source.
        for hash in self.retained_hashes()? {
            live.insert(hash);
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
        let to_collect: Vec<(String, Oid)> = {
            let index = self.index.read().unwrap_or_else(|e| e.into_inner());
            index
                .iter()
                .filter(|(hash, _)| !live.contains(hash.as_str()))
                .map(|(hash, oid)| (hash.clone(), *oid))
                .collect()
        };

        for (hash, oid) in to_collect {
            // The loose-object file for this oid. libgit2 has no loose-object
            // delete API, so we reconstruct git's standard loose path
            // (`objects/<oid[0:2]>/<oid[2:]>`) and remove it directly — the
            // same filesystem-side deletion the manual sweep has always done.
            let object_path = self.loose_object_path(&oid);
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
            // Drop the index entry.
            {
                let mut index = self.index.write().unwrap_or_else(|e| e.into_inner());
                index.remove(&hash);
            }
            // A collected object is unreachable, so it carries no retention ref
            // (refs seed the live set). Drop any stale ref defensively anyway.
            let _ = self.delete_cas_ref(&hash);
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

    /// Open the bare git repository for one operation. `git2::Repository` is
    /// `Send` but not `Sync`, so it cannot be held as a shared field on the
    /// `Arc`-shared `ContentStore`; opening it per call sidesteps that. The
    /// open is cheap (a path probe + handle), and libgit2 serializes the
    /// on-disk object/ref writes through its own locking.
    fn open_repo(&self) -> io::Result<Repository> {
        Repository::open_bare(&self.repo_dir).map_err(git_err("open bare repo"))
    }

    /// The on-disk path of the loose object for `oid` inside the bare repo:
    /// `{dir}/cas.git/objects/<oid[0:2]>/<oid[2:]>`. This is git's standard
    /// loose-object layout (libgit2 exposes no path/delete API for loose
    /// objects, so we compute it for the GC sweep).
    fn loose_object_path(&self, oid: &Oid) -> PathBuf {
        let hex = oid.to_string();
        let (prefix, rest) = hex.split_at(2);
        self.repo_dir
            .join("objects")
            .join(prefix)
            .join(rest)
    }

    /// Write the advisory `.meta` sidecar carrying the content type.
    ///
    /// The old `refs` field is gone: retention is now a git ref under
    /// `refs/cas/<sha256>`, not a count flushed into `.meta`.
    fn write_meta(&self, hash: &str, content_type: &str) -> io::Result<()> {
        let meta_path = self.dir.join(format!("{hash}.meta"));
        let json = format!("{{\"type\":\"{content_type}\"}}");
        fs::write(&meta_path, json.as_bytes())
    }

    /// The full ref name of the retention ref for a content hash.
    fn cas_ref_name(hash: &str) -> String {
        format!("{CAS_REF_PREFIX}{hash}")
    }

    /// Create or update `refs/cas/<hash>` -> `oid` through libgit2's ref-lock
    /// discipline. Crash-safe: libgit2 writes the ref via a `.lock` file and an
    /// atomic rename, so a crash either leaves the old ref state or the new one,
    /// never a torn write — git's `update-ref` guarantee. These refs are pure
    /// liveness markers, so no reflog is requested (`reference` with an empty
    /// log message and `force = true`).
    fn set_cas_ref(&self, hash: &str, oid: Oid) -> io::Result<()> {
        let repo = self.open_repo()?;
        repo.reference(&Self::cas_ref_name(hash), oid, true, "")
            .map_err(git_err("ref update"))?;
        Ok(())
    }

    /// Delete `refs/cas/<hash>` if present. Deleting an absent ref is a no-op.
    fn delete_cas_ref(&self, hash: &str) -> io::Result<()> {
        let repo = self.open_repo()?;
        let found = repo.find_reference(&Self::cas_ref_name(hash));
        match found {
            Ok(mut reference) => {
                reference.delete().map_err(git_err("ref delete"))?;
                Ok(())
            }
            // Not found — nothing to delete.
            Err(e) if e.code() == git2::ErrorCode::NotFound => Ok(()),
            Err(e) => Err(git_err("ref find")(e)),
        }
    }

    /// The set of content hashes currently retained via a `refs/cas/<sha256>`
    /// ref. This is the durable, crash-safe live-root set read straight off
    /// disk — the heart of axis 4: it survives a daemon restart, so a `gc`
    /// after a restart no longer treats every previously-retained object as
    /// collectable.
    fn retained_hashes(&self) -> io::Result<Vec<String>> {
        let repo = self.open_repo()?;
        // `references_glob` over the CAS namespace; the glob is rooted at the
        // ref prefix so unrelated refs (none, in this bare store) are skipped.
        let glob = format!("{CAS_REF_PREFIX}*");
        let refs = repo
            .references_glob(&glob)
            .map_err(git_err("ref iter"))?;
        let mut out = Vec::new();
        for reference in refs {
            let reference = reference.map_err(git_err("ref"))?;
            // `name()` is `Err` when the ref name is not valid UTF-8; CAS refs
            // are always valid UTF-8 (`refs/cas/<hex>`), so a non-UTF-8 name is
            // simply skipped.
            if let Ok(name) = reference.name() {
                if let Some(rest) = name.strip_prefix(CAS_REF_PREFIX) {
                    out.push(rest.to_string());
                }
            }
        }
        Ok(out)
    }

    /// Resolve an Endo SHA-256 key to its git object id, if indexed.
    fn oid_for(&self, hash: &str) -> Option<Oid> {
        let index = self.index.read().unwrap_or_else(|e| e.into_inner());
        index.get(hash).copied()
    }

    /// Whether the SHA-256 key already has an index entry.
    fn index_contains(&self, hash: &str) -> bool {
        let index = self.index.read().unwrap_or_else(|e| e.into_inner());
        index.contains_key(hash)
    }

    /// Record a `sha256 -> git-oid` mapping in memory and persist it.
    fn record_index(&self, hash: &str, oid: Oid) -> io::Result<()> {
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
            body.push_str(&oid.to_string());
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
fn load_index(dir: &Path) -> io::Result<HashMap<String, Oid>> {
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
        if let Ok(oid) = Oid::from_str(oid_hex) {
            map.insert(hash.to_string(), oid);
        }
    }
    Ok(map)
}

/// Build an `io::Error`-producing closure that frames a `git2::Error` with a
/// short operation label. Keeps the call sites terse.
fn git_err(op: &'static str) -> impl Fn(git2::Error) -> io::Error {
    move |e| io::Error::new(io::ErrorKind::Other, format!("{op}: {e}"))
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

    /// Axis 4: retain records a durable git ref under `refs/cas/<sha256>`, and
    /// release deletes it. The ref's presence — not an in-memory count — is the
    /// liveness record, so a retained object survives a `gc` and a released one
    /// is collectable. (The old counted-`.meta` contract is replaced by
    /// reachability over refs per the maintainer's ruling.)
    #[test]
    fn retain_release_manage_cas_refs() {
        let tmp = tempfile::tempdir().unwrap();
        let cas = ContentStore::open(tmp.path()).unwrap();

        let hash = cas.store(b"ref retained", "blob").unwrap();

        // No ref yet — the object is collectable.
        assert!(cas.retained_hashes().unwrap().is_empty());

        cas.retain(&hash);
        // The retention ref lives inside the bare repo at
        // `{dir}/cas.git/refs/cas/<sha256>`.
        let ref_path = tmp
            .path()
            .join(REPO_DIR)
            .join(format!("{CAS_REF_PREFIX}{hash}"));
        assert!(ref_path.exists(), "retain must write refs/cas/<sha256>");
        assert!(cas.retained_hashes().unwrap().contains(&hash));

        // Retained content survives GC with an empty caller root set.
        let report = cas.gc(&HashSet::new()).unwrap();
        assert_eq!(report.freed_count, 0);
        assert!(cas.has(&hash));

        cas.release(&hash);
        assert!(!ref_path.exists(), "release must delete the ref");
        assert!(cas.retained_hashes().unwrap().is_empty());

        // Now collectable.
        let report = cas.gc(&HashSet::new()).unwrap();
        assert_eq!(report.freed_count, 1);
        assert!(!cas.has(&hash));
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

    /// The bytes are stored as git objects inside the bare repo at
    /// `{dir}/cas.git`, and a persistent `sha256 -> git-oid` index file is
    /// written. This asserts the substrate is the git object DB (not the old
    /// flat `{dir}/{hex-sha256}`).
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
        // The bare repo's object DB directory holds the object.
        let objects_dir = tmp.path().join(REPO_DIR).join("objects");
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
        let repo = cas.open_repo().unwrap();
        assert!(repo.odb().unwrap().exists(oid));
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
        let drop_object_path = cas.loose_object_path(&drop_oid);
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

    // -- Axis 4: reachability-driven, crash-safe retention ----------------

    /// The crash-safety fix. Today's bug: `retain` kept an in-memory refcount
    /// that was rebuilt empty on `ContentStore::open`, so a `gc` after a daemon
    /// restart collected everything that had been retained in a prior session
    /// (the live system calls `cas.gc(&HashSet::new())`). With retention stored
    /// as a durable `refs/cas/<sha256>` ref, the retained object survives the
    /// reopen and the subsequent empty-root-set GC; the unretained one is
    /// collected. This asserts the durable-liveness contract, not a mechanism.
    #[test]
    fn retention_survives_reopen_and_empty_root_gc() {
        let tmp = tempfile::tempdir().unwrap();

        let (retained, unretained);
        {
            let cas = ContentStore::open(tmp.path()).unwrap();
            retained = cas.store(b"retained across restart", "blob").unwrap();
            unretained = cas.store(b"only this session", "blob").unwrap();
            cas.retain(&retained);
        } // Drop the store — the in-memory state is gone, only disk survives.

        // A fresh daemon process reopens the store and runs GC the way the live
        // system does: with an empty caller-supplied root set.
        let reopened = ContentStore::open(tmp.path()).unwrap();
        let report = reopened.gc(&HashSet::new()).unwrap();

        // The retained object is preserved purely because its ref persisted.
        assert!(
            reopened.has(&retained),
            "retained content must survive restart + empty-root GC"
        );
        // The unretained object is collected.
        assert_eq!(report.freed_count, 1);
        assert!(!reopened.has(&unretained));
    }

    /// Retention refs act as GC roots that reach transitively into tree
    /// children: retaining only a tree root keeps the tree's blobs alive even
    /// though those blobs were never themselves retained. This is git
    /// reachability over the retained ref set.
    #[test]
    fn retained_tree_root_keeps_children_alive() {
        let tmp = tempfile::tempdir().unwrap();
        let cas = ContentStore::open(tmp.path()).unwrap();

        let child = cas.store(b"reachable child", "blob").unwrap();
        let tree = TreeManifest {
            entries: {
                let mut m = HashMap::new();
                m.insert(
                    "child.js".to_string(),
                    TreeEntry {
                        entry_type: "blob".to_string(),
                        hash: child.clone(),
                        size: Some(15),
                    },
                );
                m
            },
        };
        let tree_hash = cas.store_tree(&serde_json::to_vec(&tree).unwrap()).unwrap();
        let orphan = cas.store(b"unreachable orphan", "blob").unwrap();

        // Retain only the tree root — via a ref, not a caller root set.
        cas.retain(&tree_hash);

        let report = cas.gc(&HashSet::new()).unwrap();
        assert_eq!(report.freed_count, 1, "only the orphan is collected");
        assert!(cas.has(&tree_hash), "retained tree root preserved");
        assert!(cas.has(&child), "child reachable from the retained tree");
        assert!(!cas.has(&orphan), "orphan collected");
    }
}
