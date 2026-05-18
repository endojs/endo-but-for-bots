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

    /// Build a ZIP archive in memory whose entries are exactly
    /// `(name, contents)` in the given order. Used to confirm that
    /// `ingest_archive` and `ingest_directory` agree on the same root
    /// hash for inputs richer than the single-file fixture.
    fn make_zip_from_entries(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut buf = io::Cursor::new(Vec::new());
        {
            let mut zip = zip::ZipWriter::new(&mut buf);
            let options = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Stored);
            for (name, contents) in entries {
                zip.start_file(*name, options).unwrap();
                zip.write_all(contents).unwrap();
            }
            zip.finish().unwrap();
        }
        buf.into_inner()
    }

    /// Compartment-map.json that names two compartments, each with one
    /// module. Used by both the multi-compartment and the nested-file
    /// directory-ingest tests.
    const TEST_TWO_COMPARTMENT_MAP: &str = r#"{
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
                    },
                    "lib-v1.0.0": {
                        "name": "lib",
                        "modules": {
                            "./util.js": {
                                "parser": "mjs",
                                "location": "util.js"
                            }
                        }
                    }
                }
            }"#;

    #[test]
    fn ingest_directory_handles_nested_subdirectories() {
        // `collect_compartment_blobs` walks a compartment recursively.
        // The contract this test locks is the *CAS layout* the walker
        // produces: each nested file becomes one blob entry in the
        // compartment sub-tree, keyed by its `/`-joined path relative
        // to the compartment root (matching `ingest_archive`'s ZIP
        // semantics, where ZIP entry names already carry the
        // `/`-joined path). Without the recursion or the
        // `{prefix}/{name}` join, a nested file is either missed
        // entirely or keyed by its leaf name (colliding with any
        // sibling at the compartment root).
        //
        // Note on `LoadedArchive.sources`: the loader currently fetches
        // module sources via `fetch_from_tree`, which splits on `/`
        // and walks a tree-of-trees, while the sub-tree stores nested
        // keys flat with embedded `/`. The two encodings do not meet,
        // so nested modules silently drop out of `sources`. That gap
        // is pre-existing (it affects ZIP-ingested archives the same
        // way) and out of scope for this Phase 3 PR; see the
        // `load_archive_from_cas_drops_nested_module_sources_today`
        // test below for the current contract there.
        let cas_tmp = tempfile::tempdir().unwrap();
        let dir_tmp = tempfile::tempdir().unwrap();
        let cas = ContentStore::open(cas_tmp.path()).unwrap();

        let map = r#"{
            "entry": {"compartment": "app-v1.0.0", "module": "./index.js"},
            "compartments": {
                "app-v1.0.0": {
                    "name": "app",
                    "modules": {
                        "./index.js": {"parser": "mjs", "location": "index.js"},
                        "./lib/util.js": {"parser": "mjs", "location": "lib/util.js"},
                        "./lib/deep/inner.js": {
                            "parser": "mjs",
                            "location": "lib/deep/inner.js"
                        }
                    }
                }
            }
        }"#;
        std::fs::write(dir_tmp.path().join("compartment-map.json"), map).unwrap();
        let compartment = dir_tmp.path().join("app-v1.0.0");
        std::fs::create_dir_all(compartment.join("lib").join("deep")).unwrap();
        std::fs::write(compartment.join("index.js"), b"export const a = 1;").unwrap();
        std::fs::write(
            compartment.join("lib").join("util.js"),
            b"export const b = 2;",
        )
        .unwrap();
        std::fs::write(
            compartment.join("lib").join("deep").join("inner.js"),
            b"export const c = 3;",
        )
        .unwrap();

        let ingested = ingest_directory(&cas, dir_tmp.path()).unwrap();

        // The compartment sub-tree carries every nested file as a
        // single flat entry keyed by its `/`-joined relative path,
        // exactly as `ingest_archive` would for a ZIP with the same
        // contents.
        let names = cas.list_tree(&ingested.root_hash).unwrap();
        assert!(names.contains(&"app-v1.0.0".to_string()));
        let app_entry = cas
            .read_tree(&ingested.root_hash)
            .unwrap()
            .entries
            .remove("app-v1.0.0")
            .unwrap();
        let sub_tree_names = cas.list_tree(&app_entry.hash).unwrap();
        for expected in ["index.js", "lib/util.js", "lib/deep/inner.js"] {
            assert!(
                sub_tree_names.contains(&expected.to_string()),
                "expected nested key {expected} in sub-tree, got {sub_tree_names:?}",
            );
        }

        // Each blob's bytes can still be retrieved by fetching its
        // hash directly out of the sub-tree manifest, which is what
        // a future `load_archive_from_cas` will rely on once it walks
        // flat keys instead of tree-of-trees.
        let sub_manifest = cas.read_tree(&app_entry.hash).unwrap();
        for (key, expected_bytes) in [
            ("index.js", &b"export const a = 1;"[..]),
            ("lib/util.js", &b"export const b = 2;"[..]),
            ("lib/deep/inner.js", &b"export const c = 3;"[..]),
        ] {
            let entry = sub_manifest
                .entries
                .get(key)
                .unwrap_or_else(|| panic!("missing sub-tree entry {key}"));
            let bytes = cas.fetch(&entry.hash).unwrap();
            assert_eq!(bytes, expected_bytes, "wrong bytes for {key}");
        }
    }

    #[test]
    fn load_archive_from_cas_drops_nested_module_sources_today() {
        // Document the loader's current behavior for nested module
        // files: `fetch_from_tree` splits the path on `/` and walks a
        // tree-of-trees, but `ingest_directory` / `ingest_archive`
        // store the compartment sub-tree as a single flat manifest
        // with `/`-joined keys. The two encodings do not meet, so a
        // module whose `location` contains a `/` is silently absent
        // from `LoadedArchive.sources`. Top-level modules in the
        // same archive load normally.
        //
        // This test exists to lock the contract until the loader
        // (or the sub-tree writer) is changed; once that lands, this
        // test flips to assert the source is present, which keeps the
        // fix from drifting back.
        let cas_tmp = tempfile::tempdir().unwrap();
        let dir_tmp = tempfile::tempdir().unwrap();
        let cas = ContentStore::open(cas_tmp.path()).unwrap();

        let map = r#"{
            "entry": {"compartment": "app-v1.0.0", "module": "./index.js"},
            "compartments": {
                "app-v1.0.0": {
                    "name": "app",
                    "modules": {
                        "./index.js": {"parser": "mjs", "location": "index.js"},
                        "./lib/util.js": {"parser": "mjs", "location": "lib/util.js"}
                    }
                }
            }
        }"#;
        std::fs::write(dir_tmp.path().join("compartment-map.json"), map).unwrap();
        let compartment = dir_tmp.path().join("app-v1.0.0");
        std::fs::create_dir_all(compartment.join("lib")).unwrap();
        std::fs::write(compartment.join("index.js"), b"export const a = 1;").unwrap();
        std::fs::write(
            compartment.join("lib").join("util.js"),
            b"export const b = 2;",
        )
        .unwrap();

        let ingested = ingest_directory(&cas, dir_tmp.path()).unwrap();

        // Top-level module loads.
        let key_index = ("app-v1.0.0".to_string(), "./index.js".to_string());
        assert_eq!(
            ingested.archive.sources.get(&key_index).map(|s| s.as_str()),
            Some("export const a = 1;"),
        );
        // Nested module does not (pre-existing flat-key/tree-walk
        // mismatch, see the test docstring).
        let key_util = ("app-v1.0.0".to_string(), "./lib/util.js".to_string());
        assert!(
            !ingested.archive.sources.contains_key(&key_util),
            "loader currently drops nested sources; if this asserts \
             becomes false, flip the assertion and remove the gap note",
        );
    }

    #[test]
    fn ingest_directory_matches_zip_root_hash_with_nested_files() {
        // The cross-form invariant (a directory ingests to the same
        // root hash as the equivalent ZIP) must hold for nested files
        // too, not just flat ones. This is what guarantees the
        // `--cas <hash>` re-run path is interchangeable across input
        // forms when the input has any structure at all.
        let cas_tmp = tempfile::tempdir().unwrap();
        let cas = ContentStore::open(cas_tmp.path()).unwrap();

        let map = r#"{
            "entry": {"compartment": "app-v1.0.0", "module": "./index.js"},
            "compartments": {
                "app-v1.0.0": {
                    "name": "app",
                    "modules": {
                        "./index.js": {"parser": "mjs", "location": "index.js"},
                        "./lib/util.js": {"parser": "mjs", "location": "lib/util.js"}
                    }
                }
            }
        }"#;
        let index_src = b"export const a = 1;";
        let util_src = b"export const b = 2;";

        // ZIP form: the directory entries in the archive are flat,
        // keyed by their `/`-joined path.
        let zip_bytes = make_zip_from_entries(&[
            ("compartment-map.json", map.as_bytes()),
            ("app-v1.0.0/index.js", index_src),
            ("app-v1.0.0/lib/util.js", util_src),
        ]);
        let zip_ingested = ingest_archive(&cas, io::Cursor::new(&zip_bytes)).unwrap();

        // Directory form: same files on disk.
        let dir_tmp = tempfile::tempdir().unwrap();
        std::fs::write(dir_tmp.path().join("compartment-map.json"), map).unwrap();
        let compartment = dir_tmp.path().join("app-v1.0.0");
        std::fs::create_dir_all(compartment.join("lib")).unwrap();
        std::fs::write(compartment.join("index.js"), index_src).unwrap();
        std::fs::write(compartment.join("lib").join("util.js"), util_src).unwrap();
        let dir_ingested = ingest_directory(&cas, dir_tmp.path()).unwrap();

        assert_eq!(dir_ingested.root_hash, zip_ingested.root_hash);
    }

    #[test]
    fn ingest_directory_handles_multiple_compartments() {
        // The `compartment_trees` loop in `ingest_directory` must
        // build one sub-tree per compartment. With a single-compartment
        // fixture the loop runs once and any "first entry wins" bug
        // (e.g., reading from a non-iterating accumulator) would be
        // invisible; two compartments forces both sub-tree manifests
        // into the root tree.
        let cas_tmp = tempfile::tempdir().unwrap();
        let dir_tmp = tempfile::tempdir().unwrap();
        let cas = ContentStore::open(cas_tmp.path()).unwrap();

        std::fs::write(
            dir_tmp.path().join("compartment-map.json"),
            TEST_TWO_COMPARTMENT_MAP,
        )
        .unwrap();
        let app = dir_tmp.path().join("app-v1.0.0");
        std::fs::create_dir_all(&app).unwrap();
        std::fs::write(app.join("index.js"), b"export const x = 1;").unwrap();
        let lib = dir_tmp.path().join("lib-v1.0.0");
        std::fs::create_dir_all(&lib).unwrap();
        std::fs::write(lib.join("util.js"), b"export const y = 2;").unwrap();

        let ingested = ingest_directory(&cas, dir_tmp.path()).unwrap();

        let names = cas.list_tree(&ingested.root_hash).unwrap();
        assert!(names.contains(&"compartment-map.json".to_string()));
        assert!(names.contains(&"app-v1.0.0".to_string()));
        assert!(names.contains(&"lib-v1.0.0".to_string()));

        // Both compartments' modules are loadable.
        let key_app = ("app-v1.0.0".to_string(), "./index.js".to_string());
        let key_lib = ("lib-v1.0.0".to_string(), "./util.js".to_string());
        assert_eq!(
            ingested.archive.sources.get(&key_app).map(|s| s.as_str()),
            Some("export const x = 1;"),
        );
        assert_eq!(
            ingested.archive.sources.get(&key_lib).map(|s| s.as_str()),
            Some("export const y = 2;"),
        );
    }

    #[test]
    fn ingest_directory_handles_multiple_files_per_compartment() {
        // Within `collect_compartment_blobs` the per-entry insert into
        // `out` must accumulate across multiple sibling files. A bug
        // that re-creates `out` per iteration (or accidentally returns
        // after the first file) would surface as only one of the
        // sibling files being reachable in the compartment sub-tree.
        let cas_tmp = tempfile::tempdir().unwrap();
        let dir_tmp = tempfile::tempdir().unwrap();
        let cas = ContentStore::open(cas_tmp.path()).unwrap();

        let map = r#"{
            "entry": {"compartment": "app-v1.0.0", "module": "./index.js"},
            "compartments": {
                "app-v1.0.0": {
                    "name": "app",
                    "modules": {
                        "./index.js": {"parser": "mjs", "location": "index.js"},
                        "./a.js": {"parser": "mjs", "location": "a.js"},
                        "./b.js": {"parser": "mjs", "location": "b.js"}
                    }
                }
            }
        }"#;
        std::fs::write(dir_tmp.path().join("compartment-map.json"), map).unwrap();
        let compartment = dir_tmp.path().join("app-v1.0.0");
        std::fs::create_dir_all(&compartment).unwrap();
        std::fs::write(compartment.join("index.js"), b"export const i = 0;").unwrap();
        std::fs::write(compartment.join("a.js"), b"export const a = 1;").unwrap();
        std::fs::write(compartment.join("b.js"), b"export const b = 2;").unwrap();

        let ingested = ingest_directory(&cas, dir_tmp.path()).unwrap();

        // All three sibling files end up in the compartment sub-tree.
        let app_entry = cas
            .read_tree(&ingested.root_hash)
            .unwrap()
            .entries
            .remove("app-v1.0.0")
            .unwrap();
        let sub_names = cas.list_tree(&app_entry.hash).unwrap();
        for expected in ["index.js", "a.js", "b.js"] {
            assert!(
                sub_names.contains(&expected.to_string()),
                "expected sub-tree to contain {expected}, got {sub_names:?}",
            );
        }

        // And each is loadable from the LoadedArchive.
        for (spec, body) in [
            ("./index.js", "export const i = 0;"),
            ("./a.js", "export const a = 1;"),
            ("./b.js", "export const b = 2;"),
        ] {
            let key = ("app-v1.0.0".to_string(), spec.to_string());
            assert_eq!(
                ingested.archive.sources.get(&key).map(|s| s.as_str()),
                Some(body),
                "missing source for {spec}",
            );
        }
    }

    /// Symlink-handling tests are Unix-only. On Windows the
    /// `symlink_file` / `symlink_dir` split and the
    /// developer-mode requirement make a portable assertion noisy;
    /// the underlying `ft.is_file()` / `ft.is_dir()` check is platform-
    /// neutral so Unix coverage is sufficient to lock the behavior.
    #[cfg(unix)]
    #[test]
    fn ingest_directory_skips_symlinks_at_root() {
        // The contract of `ingest_directory` is that only regular files
        // and directories at the root participate in the ingest; a
        // symlink at the root (even if pointing at a real file) is
        // skipped. Without this branch, a symlink would either follow
        // (silently ingesting the link target under the link's name,
        // surprising the caller) or surface a file_type() error and
        // abort an otherwise-valid ingest.
        let cas_tmp = tempfile::tempdir().unwrap();
        let dir_tmp = tempfile::tempdir().unwrap();
        let cas = ContentStore::open(cas_tmp.path()).unwrap();
        make_test_directory(dir_tmp.path());

        // Hard-to-misread name so the assertion is concrete.
        let outside = dir_tmp.path().join("dangling-target.txt");
        std::fs::write(&outside, b"should not be ingested").unwrap();
        let link = dir_tmp.path().join("link.txt");
        std::os::unix::fs::symlink(&outside, &link).unwrap();

        let ingested = ingest_directory(&cas, dir_tmp.path()).unwrap();

        // The symlink entry is absent from the root tree. The actual
        // target file (`dangling-target.txt`) is still a regular file
        // at the root and *is* ingested; the symlink itself is not.
        let names = cas.list_tree(&ingested.root_hash).unwrap();
        assert!(
            !names.contains(&"link.txt".to_string()),
            "symlink should be skipped, got {names:?}",
        );
    }

    #[cfg(unix)]
    #[test]
    fn ingest_directory_skips_symlinks_inside_compartment() {
        // Same contract inside `collect_compartment_blobs`: a symlink
        // within a compartment directory is skipped, so the sub-tree
        // manifest mirrors a literal walk of regular files only.
        let cas_tmp = tempfile::tempdir().unwrap();
        let dir_tmp = tempfile::tempdir().unwrap();
        let cas = ContentStore::open(cas_tmp.path()).unwrap();
        make_test_directory(dir_tmp.path());

        let compartment = dir_tmp.path().join("app-v1.0.0");
        let target = compartment.join("real.js");
        std::fs::write(&target, b"export const r = 1;").unwrap();
        let link = compartment.join("link.js");
        std::os::unix::fs::symlink(&target, &link).unwrap();

        let ingested = ingest_directory(&cas, dir_tmp.path()).unwrap();

        let app_entry = cas
            .read_tree(&ingested.root_hash)
            .unwrap()
            .entries
            .remove("app-v1.0.0")
            .unwrap();
        let sub_names = cas.list_tree(&app_entry.hash).unwrap();
        assert!(
            sub_names.contains(&"real.js".to_string()),
            "regular file alongside symlink should be ingested, got {sub_names:?}",
        );
        assert!(
            !sub_names.contains(&"link.js".to_string()),
            "symlink in compartment should be skipped, got {sub_names:?}",
        );
    }

    // -----------------------------------------------------------------------
    // load_archive_from_cas error and edge-case paths
    // -----------------------------------------------------------------------

    #[test]
    fn load_archive_from_cas_errors_when_compartment_map_missing() {
        // If the root tree references no `compartment-map.json` blob,
        // `load_archive_from_cas` must surface NotFound rather than
        // panicking or silently returning an empty LoadedArchive.
        // The CLI's `--cas <hash>` path relies on this error to tell
        // the user the supplied hash is not a runnable archive root.
        let cas_tmp = tempfile::tempdir().unwrap();
        let cas = ContentStore::open(cas_tmp.path()).unwrap();

        // Build a minimal root tree with one unrelated blob, no
        // compartment-map.json entry.
        let mut entries: HashMap<String, TreeEntry> = HashMap::new();
        let blob_hash = cas.store(b"unrelated", "blob").unwrap();
        entries.insert(
            "other.bin".to_string(),
            TreeEntry {
                entry_type: "blob".to_string(),
                hash: blob_hash,
                size: Some(9),
            },
        );
        let root_tree = TreeManifest { entries };
        let root_json = encode_manifest_sorted(&root_tree).unwrap();
        let root_hash = cas.store_tree(&root_json).unwrap();

        let err = match load_archive_from_cas(&cas, &root_hash) {
            Ok(_) => panic!("expected NotFound, got Ok"),
            Err(e) => e,
        };
        assert_eq!(err.kind(), io::ErrorKind::NotFound);
        // The error message names what was missing, so a caller's
        // diagnostic does not become a guessing game over which hash
        // / blob / tree entry is at fault.
        let msg = err.to_string();
        assert!(
            msg.contains("compartment-map.json"),
            "error should mention compartment-map.json, got: {msg}",
        );
    }

    #[test]
    fn load_archive_from_cas_skips_non_script_parsers() {
        // The loader only fetches sources for parsers it knows how to
        // hand to the engine (`mjs`, `cjs`, `json`). A `wasm` (or
        // other future) parser must be skipped silently here so the
        // engine, not this loader, decides how to surface it.
        let cas_tmp = tempfile::tempdir().unwrap();
        let dir_tmp = tempfile::tempdir().unwrap();
        let cas = ContentStore::open(cas_tmp.path()).unwrap();

        let map = r#"{
            "entry": {"compartment": "app-v1.0.0", "module": "./index.js"},
            "compartments": {
                "app-v1.0.0": {
                    "name": "app",
                    "modules": {
                        "./index.js": {"parser": "mjs", "location": "index.js"},
                        "./blob.wasm": {"parser": "wasm", "location": "blob.wasm"}
                    }
                }
            }
        }"#;
        std::fs::write(dir_tmp.path().join("compartment-map.json"), map).unwrap();
        let compartment = dir_tmp.path().join("app-v1.0.0");
        std::fs::create_dir_all(&compartment).unwrap();
        std::fs::write(compartment.join("index.js"), b"export const i = 0;").unwrap();
        std::fs::write(compartment.join("blob.wasm"), [0x00, 0x61, 0x73, 0x6d]).unwrap();

        let ingested = ingest_directory(&cas, dir_tmp.path()).unwrap();

        // The mjs module is present, but the wasm module is not loaded
        // into `sources` — the loader skipped it at parser dispatch.
        let key_index = ("app-v1.0.0".to_string(), "./index.js".to_string());
        let key_wasm = ("app-v1.0.0".to_string(), "./blob.wasm".to_string());
        assert!(ingested.archive.sources.contains_key(&key_index));
        assert!(
            !ingested.archive.sources.contains_key(&key_wasm),
            "wasm module must be skipped by load_archive_from_cas",
        );
    }

    #[test]
    fn load_archive_from_cas_falls_back_to_specifier_when_location_missing() {
        // When a module descriptor omits the `location` field, the
        // loader strips a leading `./` from the specifier and uses
        // that as the path under the compartment sub-tree. This is
        // what the @endo/compartment-mapper contract guarantees when
        // location and specifier coincide; a regression here would
        // leave the source absent from the LoadedArchive even though
        // the file is present in the CAS.
        let cas_tmp = tempfile::tempdir().unwrap();
        let dir_tmp = tempfile::tempdir().unwrap();
        let cas = ContentStore::open(cas_tmp.path()).unwrap();

        let map = r#"{
            "entry": {"compartment": "app-v1.0.0", "module": "./index.js"},
            "compartments": {
                "app-v1.0.0": {
                    "name": "app",
                    "modules": {
                        "./index.js": {"parser": "mjs"}
                    }
                }
            }
        }"#;
        std::fs::write(dir_tmp.path().join("compartment-map.json"), map).unwrap();
        let compartment = dir_tmp.path().join("app-v1.0.0");
        std::fs::create_dir_all(&compartment).unwrap();
        std::fs::write(compartment.join("index.js"), b"export default 99;").unwrap();

        let ingested = ingest_directory(&cas, dir_tmp.path()).unwrap();

        let key = ("app-v1.0.0".to_string(), "./index.js".to_string());
        assert_eq!(
            ingested.archive.sources.get(&key).map(|s| s.as_str()),
            Some("export default 99;"),
        );
    }

    #[test]
    fn load_archive_from_cas_tolerates_missing_module_file() {
        // A module the manifest names but whose file is not present in
        // the CAS tree is intentionally swallowed (`Err(_) => {}`) on
        // the loader side. The contract is that any subsequent
        // engine-side import of that specifier surfaces the missing-
        // module condition; loading itself does not fail. Without this
        // arm, a typo in the manifest would block every other source
        // in the archive from loading.
        let cas_tmp = tempfile::tempdir().unwrap();
        let cas = ContentStore::open(cas_tmp.path()).unwrap();

        // Build the CAS layout by hand: a compartment sub-tree that
        // is empty, and a root tree referencing it plus a compartment
        // map that names one module.
        let map_json = r#"{
            "entry": {"compartment": "app-v1.0.0", "module": "./index.js"},
            "compartments": {
                "app-v1.0.0": {
                    "name": "app",
                    "modules": {
                        "./missing.js": {
                            "parser": "mjs",
                            "location": "missing.js"
                        }
                    }
                }
            }
        }"#;
        let map_hash = cas.store(map_json.as_bytes(), "blob").unwrap();

        let empty_sub_json = encode_manifest_sorted(&TreeManifest {
            entries: HashMap::new(),
        })
        .unwrap();
        let sub_hash = cas.store_tree(&empty_sub_json).unwrap();

        let mut root_entries: HashMap<String, TreeEntry> = HashMap::new();
        root_entries.insert(
            "compartment-map.json".to_string(),
            TreeEntry {
                entry_type: "blob".to_string(),
                hash: map_hash,
                size: Some(map_json.len() as u64),
            },
        );
        root_entries.insert(
            "app-v1.0.0".to_string(),
            TreeEntry {
                entry_type: "tree".to_string(),
                hash: sub_hash,
                size: None,
            },
        );
        let root_json = encode_manifest_sorted(&TreeManifest {
            entries: root_entries,
        })
        .unwrap();
        let root_hash = cas.store_tree(&root_json).unwrap();

        // Loader succeeds and returns an empty `sources` map.
        let loaded = load_archive_from_cas(&cas, &root_hash).unwrap();
        let key = ("app-v1.0.0".to_string(), "./missing.js".to_string());
        assert!(
            !loaded.sources.contains_key(&key),
            "missing module file must not surface in sources",
        );
        // The compartment map itself was still parsed and is intact.
        assert_eq!(loaded.map.entry.compartment, "app-v1.0.0");
    }
}
