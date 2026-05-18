//! CAS-backed archive ingestion and loading.
//!
//! Provides functions to ingest a compartment-map archive
//! (either a ZIP file or an unpacked directory) into the
//! content-addressed store and load it back by root hash.

use std::collections::{BTreeMap, HashMap};
use std::io::{self, Read, Seek};
use std::path::Path;

use crate::cas::{ContentStore, TreeEntry, TreeManifest};

/// Serialize a tree manifest with entries in sorted key order.
///
/// `TreeManifest` stores entries in a `HashMap`, whose iteration order
/// is randomized per process. Without sorting, `serde_json::to_vec`
/// emits the same logical manifest as different byte sequences across
/// runs, and the CAS hash drifts. Sorting at the serialization
/// boundary makes the on-disk tree (and therefore the root hash) a
/// pure function of the manifest's key/value pairs, so the same input
/// always yields the same hash. ZIP- and directory-ingested archives
/// of the same content converge on the same root.
fn encode_manifest_sorted(manifest: &TreeManifest) -> io::Result<Vec<u8>> {
    let sorted: BTreeMap<&String, &TreeEntry> = manifest.entries.iter().collect();
    #[derive(serde::Serialize)]
    struct SortedManifest<'a> {
        entries: &'a BTreeMap<&'a String, &'a TreeEntry>,
    }
    serde_json::to_vec(&SortedManifest { entries: &sorted })
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
}

/// Result of ingesting an archive into the CAS.
pub struct IngestedArchive {
    /// Root tree hash of the ingested archive.
    pub root_hash: String,
    /// The loaded archive (for immediate execution).
    pub archive: xsnap::archive::LoadedArchive,
}

/// Ingest a ZIP archive into the CAS and return the root hash.
///
/// Each file in the archive is stored as a CAS blob. A tree
/// manifest is built mapping compartment directory structures
/// to their blob hashes. The root tree references the
/// `compartment-map.json` and all compartment trees.
pub fn ingest_archive<R: Read + Seek>(
    cas: &ContentStore,
    reader: R,
) -> io::Result<IngestedArchive> {
    let mut zip = zip::ZipArchive::new(reader)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;

    let mut root_entries: HashMap<String, TreeEntry> = HashMap::new();
    // Compartment sub-trees: compartment_name → { filename → TreeEntry }
    let mut compartment_trees: HashMap<String, HashMap<String, TreeEntry>> = HashMap::new();

    // Read and store every file in the archive.
    for i in 0..zip.len() {
        let mut file = zip.by_index(i)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;

        if file.is_dir() {
            continue;
        }

        let name = file.name().to_string();
        let mut contents = Vec::new();
        file.read_to_end(&mut contents)?;

        let hash = cas.store(&contents, "blob")?;
        let size = contents.len() as u64;

        // Determine if this is a top-level file or inside a compartment dir.
        if let Some(slash_pos) = name.find('/') {
            let dir = &name[..slash_pos];
            let file_name = &name[slash_pos + 1..];
            if !file_name.is_empty() {
                compartment_trees
                    .entry(dir.to_string())
                    .or_default()
                    .insert(
                        file_name.to_string(),
                        TreeEntry {
                            entry_type: "blob".to_string(),
                            hash,
                            size: Some(size),
                        },
                    );
            }
        } else {
            // Top-level file (e.g., compartment-map.json).
            root_entries.insert(
                name,
                TreeEntry {
                    entry_type: "blob".to_string(),
                    hash,
                    size: Some(size),
                },
            );
        }
    }

    // Build sub-tree manifests for each compartment directory.
    for (dir_name, entries) in &compartment_trees {
        let sub_tree = TreeManifest {
            entries: entries.clone(),
        };
        let tree_json = encode_manifest_sorted(&sub_tree)?;
        let tree_hash = cas.store_tree(&tree_json)?;
        root_entries.insert(
            dir_name.clone(),
            TreeEntry {
                entry_type: "tree".to_string(),
                hash: tree_hash,
                size: None,
            },
        );
    }

    // Build root tree manifest.
    let root_tree = TreeManifest {
        entries: root_entries,
    };
    let root_json = encode_manifest_sorted(&root_tree)?;
    let root_hash = cas.store_tree(&root_json)?;

    // Also load the archive conventionally for immediate execution.
    // (In the future, this would be lazy CAS-backed loading.)
    let reader2 = {
        // Re-read the zip from the beginning. Since we already consumed
        // the reader, build a LoadedArchive from the CAS tree instead.
        load_archive_from_cas(cas, &root_hash)?
    };

    Ok(IngestedArchive {
        root_hash,
        archive: reader2,
    })
}

/// Ingest an unpacked compartment-map directory into the CAS
/// and return the root hash.
///
/// The directory is expected to contain `compartment-map.json` at its
/// root and one subdirectory per compartment. The CAS layout produced
/// mirrors [`ingest_archive`] exactly: each compartment becomes a
/// sub-tree under the root, and every regular file under a compartment
/// becomes a blob entry in that sub-tree keyed by its forward-slash-
/// joined path relative to the compartment directory. The result is
/// the same root tree hash that `ingest_archive` would produce for a
/// ZIP containing the same files, so [`load_archive_from_cas`] reads
/// directory-ingested and ZIP-ingested archives interchangeably.
///
/// Symbolic links and non-regular files are skipped. A missing
/// `compartment-map.json` at the directory root is an
/// `InvalidData` error so the caller fails fast rather than producing
/// an unrunnable root hash.
pub fn ingest_directory(
    cas: &ContentStore,
    dir: &Path,
) -> io::Result<IngestedArchive> {
    if !dir.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            format!("not a directory: {}", dir.display()),
        ));
    }

    // Require compartment-map.json at the directory root before any
    // CAS writes, so a malformed input does not partially populate the
    // store with an unreachable root.
    let map_path = dir.join("compartment-map.json");
    if !map_path.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "compartment-map.json not found at {}",
                map_path.display()
            ),
        ));
    }

    let mut root_entries: HashMap<String, TreeEntry> = HashMap::new();
    let mut compartment_trees: HashMap<String, HashMap<String, TreeEntry>> =
        HashMap::new();

    for child in fs_read_dir_sorted(dir)? {
        let name = match child.file_name().to_str() {
            Some(s) => s.to_string(),
            None => continue,
        };
        let path = child.path();
        let ft = child.file_type()?;
        if ft.is_file() {
            let contents = std::fs::read(&path)?;
            let hash = cas.store(&contents, "blob")?;
            let size = contents.len() as u64;
            root_entries.insert(
                name,
                TreeEntry {
                    entry_type: "blob".to_string(),
                    hash,
                    size: Some(size),
                },
            );
        } else if ft.is_dir() {
            let entries = collect_compartment_blobs(cas, &path)?;
            compartment_trees.insert(name, entries);
        }
        // Symlinks and other non-regular files are intentionally skipped.
    }

    // Build sub-tree manifests for each compartment directory.
    for (dir_name, entries) in &compartment_trees {
        let sub_tree = TreeManifest {
            entries: entries.clone(),
        };
        let tree_json = encode_manifest_sorted(&sub_tree)?;
        let tree_hash = cas.store_tree(&tree_json)?;
        root_entries.insert(
            dir_name.clone(),
            TreeEntry {
                entry_type: "tree".to_string(),
                hash: tree_hash,
                size: None,
            },
        );
    }

    let root_tree = TreeManifest {
        entries: root_entries,
    };
    let root_json = encode_manifest_sorted(&root_tree)?;
    let root_hash = cas.store_tree(&root_json)?;

    let archive = load_archive_from_cas(cas, &root_hash)?;

    Ok(IngestedArchive {
        root_hash,
        archive,
    })
}

/// Walk a compartment directory recursively and return a flat map of
/// forward-slash-joined relative paths to their CAS blob entries.
///
/// Mirrors how `ingest_archive` populates `compartment_trees`: every
/// regular file under `compartment_dir` is stored as one blob, keyed
/// by its path relative to `compartment_dir` with `/` as the
/// separator on every platform (matching ZIP semantics).
fn collect_compartment_blobs(
    cas: &ContentStore,
    compartment_dir: &Path,
) -> io::Result<HashMap<String, TreeEntry>> {
    let mut out: HashMap<String, TreeEntry> = HashMap::new();
    let mut stack: Vec<(std::path::PathBuf, String)> =
        vec![(compartment_dir.to_path_buf(), String::new())];

    while let Some((dir, prefix)) = stack.pop() {
        for child in fs_read_dir_sorted(&dir)? {
            let name = match child.file_name().to_str() {
                Some(s) => s.to_string(),
                None => continue,
            };
            let path = child.path();
            let ft = child.file_type()?;
            let rel = if prefix.is_empty() {
                name.clone()
            } else {
                format!("{prefix}/{name}")
            };
            if ft.is_file() {
                let contents = std::fs::read(&path)?;
                let hash = cas.store(&contents, "blob")?;
                let size = contents.len() as u64;
                out.insert(
                    rel,
                    TreeEntry {
                        entry_type: "blob".to_string(),
                        hash,
                        size: Some(size),
                    },
                );
            } else if ft.is_dir() {
                stack.push((path, rel));
            }
            // Symlinks and other non-regular files are skipped.
        }
    }

    Ok(out)
}

/// Read a directory's entries and return them sorted by file name.
/// Sorting makes the CAS layout (and therefore the root hash) a
/// deterministic function of the directory contents, independent of
/// the underlying filesystem's iteration order.
fn fs_read_dir_sorted(dir: &Path) -> io::Result<Vec<std::fs::DirEntry>> {
    let mut entries: Vec<std::fs::DirEntry> =
        std::fs::read_dir(dir)?.collect::<io::Result<Vec<_>>>()?;
    entries.sort_by_key(|e| e.file_name());
    Ok(entries)
}

/// Load a `LoadedArchive` from the CAS given a root tree hash.
///
/// Reads the compartment-map.json from the root tree, then fetches
/// each module source from the CAS tree structure.
pub fn load_archive_from_cas(
    cas: &ContentStore,
    root_hash: &str,
) -> io::Result<xsnap::archive::LoadedArchive> {
    let root_tree = cas.read_tree(root_hash)?;

    // Read compartment-map.json.
    let map_entry = root_tree.entries.get("compartment-map.json").ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::NotFound,
            "compartment-map.json not found in CAS tree",
        )
    })?;
    let map_bytes = cas.fetch(&map_entry.hash)?;
    let map: xsnap::archive::CompartmentMap = serde_json::from_slice(&map_bytes)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, format!("invalid map: {e}")))?;

    // Read module sources.
    let mut sources: HashMap<(String, String), String> = HashMap::new();

    for (compartment_name, compartment) in &map.compartments {
        for (specifier, descriptor) in &compartment.modules {
            if let xsnap::archive::ModuleDescriptor::File {
                parser, location, ..
            } = descriptor
            {
                match parser.as_str() {
                    "mjs" | "cjs" | "json" => {}
                    _ => continue,
                }

                let file_location = match location {
                    Some(loc) => loc.clone(),
                    None => {
                        let s = specifier.strip_prefix("./").unwrap_or(specifier);
                        s.to_string()
                    }
                };

                // Fetch from the compartment's sub-tree in the CAS.
                let path = format!("{compartment_name}/{file_location}");
                match cas.fetch_from_tree(root_hash, &path) {
                    Ok(bytes) => {
                        let source = String::from_utf8_lossy(&bytes).into_owned();
                        sources.insert(
                            (compartment_name.clone(), specifier.clone()),
                            source,
                        );
                    }
                    Err(_) => {
                        // Module file missing — will be a runtime error
                        // if actually imported.
                    }
                }
            }
        }
    }

    Ok(xsnap::archive::LoadedArchive { map, sources })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// Create a minimal zip archive in memory with compartment-map.json
    /// and one module file.
    fn make_test_archive() -> Vec<u8> {
        let mut buf = io::Cursor::new(Vec::new());
        {
            let mut zip = zip::ZipWriter::new(&mut buf);
            let options = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Stored);

            // compartment-map.json
            let map = r#"{
                "entry": {"compartment": "app-v1.0.0", "module": "./index.js"},
                "compartments": {
                    "app-v1.0.0": {
                        "name": "app",
                        "modules": {
                            "./index.js": {
                                "parser": "mjs",
                                "location": "index.js"
                            }
                        }
                    }
                }
            }"#;
            zip.start_file("compartment-map.json", options).unwrap();
            zip.write_all(map.as_bytes()).unwrap();

            // app-v1.0.0/index.js
            zip.start_file("app-v1.0.0/index.js", options).unwrap();
            zip.write_all(b"export default 42;").unwrap();

            zip.finish().unwrap();
        }
        buf.into_inner()
    }

    #[test]
    fn ingest_and_load_from_cas() {
        let tmp = tempfile::tempdir().unwrap();
        let cas = ContentStore::open(tmp.path()).unwrap();

        let archive_bytes = make_test_archive();
        let cursor = io::Cursor::new(&archive_bytes);

        let ingested = ingest_archive(&cas, cursor).unwrap();

        // Root hash should be non-empty.
        assert!(!ingested.root_hash.is_empty());
        assert!(cas.has(&ingested.root_hash));

        // Archive should have the entry compartment.
        assert_eq!(ingested.archive.map.entry.compartment, "app-v1.0.0");
        assert_eq!(ingested.archive.map.entry.module, "./index.js");

        // Module source should be present.
        let key = ("app-v1.0.0".to_string(), "./index.js".to_string());
        assert_eq!(
            ingested.archive.sources.get(&key).unwrap(),
            "export default 42;"
        );
    }

    #[test]
    fn load_from_cas_by_hash() {
        let tmp = tempfile::tempdir().unwrap();
        let cas = ContentStore::open(tmp.path()).unwrap();

        let archive_bytes = make_test_archive();
        let cursor = io::Cursor::new(&archive_bytes);

        let ingested = ingest_archive(&cas, cursor).unwrap();
        let root_hash = ingested.root_hash;

        // Load from CAS by hash (simulating a second run).
        let loaded = load_archive_from_cas(&cas, &root_hash).unwrap();
        assert_eq!(loaded.map.entry.compartment, "app-v1.0.0");

        let key = ("app-v1.0.0".to_string(), "./index.js".to_string());
        assert_eq!(loaded.sources.get(&key).unwrap(), "export default 42;");
    }

    #[test]
    fn root_tree_structure() {
        let tmp = tempfile::tempdir().unwrap();
        let cas = ContentStore::open(tmp.path()).unwrap();

        let archive_bytes = make_test_archive();
        let cursor = io::Cursor::new(&archive_bytes);

        let ingested = ingest_archive(&cas, cursor).unwrap();

        // Root tree should have compartment-map.json and app-v1.0.0.
        let names = cas.list_tree(&ingested.root_hash).unwrap();
        assert!(names.contains(&"compartment-map.json".to_string()));
        assert!(names.contains(&"app-v1.0.0".to_string()));
    }

    // -----------------------------------------------------------------------
    // ingest_directory tests (Phase 3)
    // -----------------------------------------------------------------------

    /// JSON literal for the minimal compartment-map.json shared by the
    /// ZIP fixture and the directory fixtures, so both forms produce
    /// the same blob hash for that file.
    const TEST_COMPARTMENT_MAP: &str = r#"{
                "entry": {"compartment": "app-v1.0.0", "module": "./index.js"},
                "compartments": {
                    "app-v1.0.0": {
                        "name": "app",
                        "modules": {
                            "./index.js": {
                                "parser": "mjs",
                                "location": "index.js"
                            }
                        }
                    }
                }
            }"#;
    const TEST_INDEX_JS: &[u8] = b"export default 42;";

    #[test]
    fn encode_manifest_sorted_is_deterministic_across_insertion_orders() {
        // Two manifests built with the same logical entries but
        // different HashMap insertion orders must serialise to the
        // same bytes; otherwise the CAS root hash drifts run-to-run
        // and the `--cas <hash>` re-run path is broken.
        let make = |insert_a_first: bool| {
            let mut entries: HashMap<String, TreeEntry> = HashMap::new();
            let a = (
                "alpha".to_string(),
                TreeEntry {
                    entry_type: "blob".to_string(),
                    hash: "aaaa".to_string(),
                    size: Some(1),
                },
            );
            let b = (
                "beta".to_string(),
                TreeEntry {
                    entry_type: "tree".to_string(),
                    hash: "bbbb".to_string(),
                    size: None,
                },
            );
            let c = (
                "gamma".to_string(),
                TreeEntry {
                    entry_type: "blob".to_string(),
                    hash: "cccc".to_string(),
                    size: Some(3),
                },
            );
            if insert_a_first {
                entries.insert(a.0.clone(), a.1.clone());
                entries.insert(b.0.clone(), b.1.clone());
                entries.insert(c.0.clone(), c.1.clone());
            } else {
                entries.insert(c.0.clone(), c.1.clone());
                entries.insert(b.0.clone(), b.1.clone());
                entries.insert(a.0.clone(), a.1.clone());
            }
            TreeManifest { entries }
        };
        let lhs = encode_manifest_sorted(&make(true)).unwrap();
        let rhs = encode_manifest_sorted(&make(false)).unwrap();
        assert_eq!(lhs, rhs);
        // And the bytes are actually sorted, not just stable.
        let lhs_str = String::from_utf8(lhs).unwrap();
        let alpha_pos = lhs_str.find("alpha").unwrap();
        let beta_pos = lhs_str.find("beta").unwrap();
        let gamma_pos = lhs_str.find("gamma").unwrap();
        assert!(alpha_pos < beta_pos, "alpha must precede beta");
        assert!(beta_pos < gamma_pos, "beta must precede gamma");
    }

    /// Build an unpacked compartment-map directory at `root` whose
    /// contents are byte-for-byte identical to `make_test_archive()`'s
    /// ZIP contents, so the CAS root hash is comparable across forms.
    fn make_test_directory(root: &Path) {
        std::fs::write(
            root.join("compartment-map.json"),
            TEST_COMPARTMENT_MAP,
        )
        .unwrap();
        let compartment = root.join("app-v1.0.0");
        std::fs::create_dir_all(&compartment).unwrap();
        std::fs::write(compartment.join("index.js"), TEST_INDEX_JS).unwrap();
    }

    #[test]
    fn ingest_directory_round_trip() {
        let cas_tmp = tempfile::tempdir().unwrap();
        let dir_tmp = tempfile::tempdir().unwrap();
        let cas = ContentStore::open(cas_tmp.path()).unwrap();
        make_test_directory(dir_tmp.path());

        let ingested = ingest_directory(&cas, dir_tmp.path()).unwrap();

        // Root hash is real, present, and references both top-level entries.
        assert!(!ingested.root_hash.is_empty());
        assert!(cas.has(&ingested.root_hash));
        let names = cas.list_tree(&ingested.root_hash).unwrap();
        assert!(names.contains(&"compartment-map.json".to_string()));
        assert!(names.contains(&"app-v1.0.0".to_string()));

        // The returned LoadedArchive matches the manifest exactly.
        assert_eq!(ingested.archive.map.entry.compartment, "app-v1.0.0");
        assert_eq!(ingested.archive.map.entry.module, "./index.js");
        let key = ("app-v1.0.0".to_string(), "./index.js".to_string());
        assert_eq!(
            ingested.archive.sources.get(&key).unwrap(),
            "export default 42;"
        );
    }

    #[test]
    fn ingest_directory_matches_zip_root_hash() {
        // Equivalent input via two ingestion paths must produce the
        // same root tree hash, otherwise `--cas <hash>` re-runs are
        // not interchangeable across input forms (which the design's
        // "Form 2 is equivalent to zipping the directory and running
        // Form 1" property requires).
        let cas_tmp = tempfile::tempdir().unwrap();
        let cas = ContentStore::open(cas_tmp.path()).unwrap();

        let archive_bytes = make_test_archive();
        let cursor = io::Cursor::new(&archive_bytes);
        let zip_ingested = ingest_archive(&cas, cursor).unwrap();

        let dir_tmp = tempfile::tempdir().unwrap();
        make_test_directory(dir_tmp.path());
        let dir_ingested = ingest_directory(&cas, dir_tmp.path()).unwrap();

        assert_eq!(dir_ingested.root_hash, zip_ingested.root_hash);
    }

    #[test]
    fn ingest_directory_reload_via_load_archive_from_cas() {
        // The CAS layout produced by ingest_directory must satisfy
        // load_archive_from_cas (which the CLI's `--cas <hash>`
        // path uses), so a directory-ingested run is re-runnable
        // by hash without distinguishing its origin.
        let cas_tmp = tempfile::tempdir().unwrap();
        let dir_tmp = tempfile::tempdir().unwrap();
        let cas = ContentStore::open(cas_tmp.path()).unwrap();
        make_test_directory(dir_tmp.path());

        let ingested = ingest_directory(&cas, dir_tmp.path()).unwrap();
        let loaded = load_archive_from_cas(&cas, &ingested.root_hash).unwrap();

        assert_eq!(loaded.map.entry.compartment, "app-v1.0.0");
        let key = ("app-v1.0.0".to_string(), "./index.js".to_string());
        assert_eq!(loaded.sources.get(&key).unwrap(), "export default 42;");
    }

    #[test]
    fn ingest_directory_requires_compartment_map() {
        // Without compartment-map.json at the root the function must
        // refuse fast and not write any CAS entries (otherwise the
        // user is left with a half-populated store and a root hash
        // that does not resolve).
        let cas_tmp = tempfile::tempdir().unwrap();
        let dir_tmp = tempfile::tempdir().unwrap();
        let cas = ContentStore::open(cas_tmp.path()).unwrap();

        // Populate a compartment dir but omit compartment-map.json.
        let compartment = dir_tmp.path().join("app-v1.0.0");
        std::fs::create_dir_all(&compartment).unwrap();
        std::fs::write(compartment.join("index.js"), TEST_INDEX_JS).unwrap();

        let err = match ingest_directory(&cas, dir_tmp.path()) {
            Ok(_) => panic!("expected InvalidData error, got Ok"),
            Err(e) => e,
        };
        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
        // Pre-flight refusal: no blobs land in the CAS.
        let entries: Vec<_> = std::fs::read_dir(cas_tmp.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| !e.file_name().to_string_lossy().ends_with(".meta"))
            .collect();
        assert!(
            entries.is_empty(),
            "expected an empty CAS, found {} entries",
            entries.len()
        );
    }

    #[test]
    fn ingest_directory_rejects_non_directory() {
        // A file path (not a directory) must be a clear NotFound rather
        // than silently coerced into a single-file archive.
        let cas_tmp = tempfile::tempdir().unwrap();
        let file_tmp = tempfile::NamedTempFile::new().unwrap();
        let cas = ContentStore::open(cas_tmp.path()).unwrap();

        let err = match ingest_directory(&cas, file_tmp.path()) {
            Ok(_) => panic!("expected NotFound error, got Ok"),
            Err(e) => e,
        };
        assert_eq!(err.kind(), io::ErrorKind::NotFound);
    }

    #[test]
    fn ingest_directory_root_hash_is_deterministic() {
        // The directory walker sorts each level by name, so the root
        // hash is the same on every run regardless of the underlying
        // filesystem's iteration order. Two independent ingestions of
        // the same input must agree.
        let cas_tmp = tempfile::tempdir().unwrap();
        let dir_tmp_a = tempfile::tempdir().unwrap();
        let dir_tmp_b = tempfile::tempdir().unwrap();
        let cas = ContentStore::open(cas_tmp.path()).unwrap();
        make_test_directory(dir_tmp_a.path());
        make_test_directory(dir_tmp_b.path());

        let a = ingest_directory(&cas, dir_tmp_a.path()).unwrap();
        let b = ingest_directory(&cas, dir_tmp_b.path()).unwrap();
        assert_eq!(a.root_hash, b.root_hash);
    }
}
