//! CAS-backed archive ingestion and loading.
//!
//! Provides functions to ingest a compartment-map ZIP archive
//! into the content-addressed store and load it back by root hash.

use std::collections::{BTreeMap, HashMap};
use std::io::{self, Read, Seek};
use std::path::Path;

use crate::cas::{ContentStore, TreeEntry, TreeManifest};

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

    // Read every file out of the archive as (archive-relative path, bytes),
    // then hand the same tree-building logic the directory path uses.
    let mut files: Vec<(String, Vec<u8>)> = Vec::new();
    for i in 0..zip.len() {
        let mut file = zip.by_index(i)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;

        if file.is_dir() {
            continue;
        }

        let name = file.name().to_string();
        let mut contents = Vec::new();
        file.read_to_end(&mut contents)?;
        files.push((name, contents));
    }

    let root_hash = ingest_files(cas, files)?;

    // Also load the archive conventionally for immediate execution.
    // (In the future, this would be lazy CAS-backed loading.)
    let archive = load_archive_from_cas(cas, &root_hash)?;

    Ok(IngestedArchive { root_hash, archive })
}

/// Ingest an unpacked archive **directory** into the CAS and return the
/// root hash.
///
/// The directory must have the same shape as a ZIP archive: a top-level
/// `compartment-map.json` alongside one directory per compartment. Each
/// file is walked, hashed, and stored as a CAS blob (deduplicated by the
/// store), and the same tree manifests the ZIP path builds are produced —
/// so a directory and its zipped equivalent ingest to the identical root
/// hash and load through the same `load_archive_from_cas` path.
pub fn ingest_directory(cas: &ContentStore, dir: &Path) -> io::Result<IngestedArchive> {
    if !dir.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("not a directory: {}", dir.display()),
        ));
    }

    let mut files: Vec<(String, Vec<u8>)> = Vec::new();
    collect_files(dir, dir, &mut files)?;

    let root_hash = ingest_files(cas, files)?;
    let archive = load_archive_from_cas(cas, &root_hash)?;

    Ok(IngestedArchive { root_hash, archive })
}

/// Recursively walk `dir`, appending each regular file as
/// `(path-relative-to-root, bytes)` with `/`-separated components — the
/// same naming a ZIP archive uses for its entries.
fn collect_files(
    root: &Path,
    dir: &Path,
    files: &mut Vec<(String, Vec<u8>)>,
) -> io::Result<()> {
    let mut entries: Vec<_> = std::fs::read_dir(dir)?.collect::<io::Result<Vec<_>>>()?;
    // Deterministic order so the walk is reproducible across platforms.
    entries.sort_by_key(|e| e.file_name());

    for entry in entries {
        let path = entry.path();
        let file_type = entry.file_type()?;
        if file_type.is_dir() {
            collect_files(root, &path, files)?;
        } else if file_type.is_file() {
            let rel = path
                .strip_prefix(root)
                .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
            // Normalize to forward slashes to match ZIP entry names.
            let name = rel
                .components()
                .map(|c| c.as_os_str().to_string_lossy())
                .collect::<Vec<_>>()
                .join("/");
            let contents = std::fs::read(&path)?;
            files.push((name, contents));
        }
        // Symlinks and other special files are skipped.
    }
    Ok(())
}

/// Build the CAS tree for a set of `(archive-relative path, bytes)` files
/// and return the root tree hash.
///
/// Mirrors the archive layout: top-level files become root-tree entries;
/// files under a top-level directory become entries in that directory's
/// sub-tree. Shared by both the ZIP (`ingest_archive`) and directory
/// (`ingest_directory`) ingestion paths so the two produce identical
/// trees.
fn ingest_files(
    cas: &ContentStore,
    files: Vec<(String, Vec<u8>)>,
) -> io::Result<String> {
    // BTreeMap keeps the manifests canonical (sorted keys → stable hash).
    let mut root_entries: BTreeMap<String, TreeEntry> = BTreeMap::new();
    // Compartment sub-trees: compartment_name → { filename → TreeEntry }
    let mut compartment_trees: HashMap<String, BTreeMap<String, TreeEntry>> = HashMap::new();

    for (name, contents) in files {
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
        let tree_json = serde_json::to_vec(&sub_tree)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
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
    let root_json = serde_json::to_vec(&root_tree)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    cas.store_tree(&root_json)
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

    /// The `compartment-map.json` manifest shared by the ZIP and directory
    /// test fixtures. Kept as a single constant so the two ingestion paths
    /// hash byte-identical content.
    const TEST_MAP_JSON: &str = r#"{
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

    /// The single module source shared by the ZIP and directory fixtures.
    const TEST_INDEX_JS: &[u8] = b"export default 42;";

    /// Create a minimal zip archive in memory with compartment-map.json
    /// and one module file.
    fn make_test_archive() -> Vec<u8> {
        let mut buf = io::Cursor::new(Vec::new());
        {
            let mut zip = zip::ZipWriter::new(&mut buf);
            let options = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Stored);

            zip.start_file("compartment-map.json", options).unwrap();
            zip.write_all(TEST_MAP_JSON.as_bytes()).unwrap();

            // app-v1.0.0/index.js
            zip.start_file("app-v1.0.0/index.js", options).unwrap();
            zip.write_all(TEST_INDEX_JS).unwrap();

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

    /// Materialize the same shape as `make_test_archive` on disk under
    /// `dir`, as an unpacked directory.
    fn write_test_directory(dir: &std::path::Path) {
        std::fs::write(dir.join("compartment-map.json"), TEST_MAP_JSON).unwrap();
        let compartment = dir.join("app-v1.0.0");
        std::fs::create_dir_all(&compartment).unwrap();
        std::fs::write(compartment.join("index.js"), TEST_INDEX_JS).unwrap();
    }

    #[test]
    fn ingest_directory_and_load() {
        let cas_tmp = tempfile::tempdir().unwrap();
        let cas = ContentStore::open(cas_tmp.path()).unwrap();

        let src_tmp = tempfile::tempdir().unwrap();
        write_test_directory(src_tmp.path());

        let ingested = ingest_directory(&cas, src_tmp.path()).unwrap();

        // Root hash should be non-empty and stored.
        assert!(!ingested.root_hash.is_empty());
        assert!(cas.has(&ingested.root_hash));

        // Archive should have the entry compartment and module source.
        assert_eq!(ingested.archive.map.entry.compartment, "app-v1.0.0");
        assert_eq!(ingested.archive.map.entry.module, "./index.js");
        let key = ("app-v1.0.0".to_string(), "./index.js".to_string());
        assert_eq!(
            ingested.archive.sources.get(&key).unwrap(),
            "export default 42;"
        );

        // Root tree should carry the manifest and the compartment tree.
        let names = cas.list_tree(&ingested.root_hash).unwrap();
        assert!(names.contains(&"compartment-map.json".to_string()));
        assert!(names.contains(&"app-v1.0.0".to_string()));
    }

    #[test]
    fn directory_and_zip_produce_identical_root_hash() {
        // A directory and its zipped equivalent must ingest to the same
        // root hash — they share the tree-building path.
        let src_tmp = tempfile::tempdir().unwrap();
        write_test_directory(src_tmp.path());

        let dir_cas_tmp = tempfile::tempdir().unwrap();
        let dir_cas = ContentStore::open(dir_cas_tmp.path()).unwrap();
        let dir_root = ingest_directory(&dir_cas, src_tmp.path()).unwrap().root_hash;

        let zip_cas_tmp = tempfile::tempdir().unwrap();
        let zip_cas = ContentStore::open(zip_cas_tmp.path()).unwrap();
        let archive_bytes = make_test_archive();
        let zip_root = ingest_archive(&zip_cas, io::Cursor::new(&archive_bytes))
            .unwrap()
            .root_hash;

        assert_eq!(dir_root, zip_root);
    }

    #[test]
    fn directory_and_zip_identical_with_nested_file() {
        // A compartment sub-directory with a nested file must walk into the
        // same tree the ZIP path builds — so the directory and its zipped
        // equivalent still ingest to an identical root hash.
        const MAP: &[u8] =
            br#"{"entry":{"compartment":"app-v1.0.0","module":"./lib/util.js"},"compartments":{}}"#;
        const UTIL: &[u8] = b"export const x = 1;";

        // Directory form.
        let src_tmp = tempfile::tempdir().unwrap();
        let root = src_tmp.path();
        std::fs::write(root.join("compartment-map.json"), MAP).unwrap();
        let nested = root.join("app-v1.0.0").join("lib");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(nested.join("util.js"), UTIL).unwrap();

        let dir_cas_tmp = tempfile::tempdir().unwrap();
        let dir_cas = ContentStore::open(dir_cas_tmp.path()).unwrap();
        let dir_root = ingest_directory(&dir_cas, root).unwrap().root_hash;

        // ZIP form with the same entry names.
        let mut buf = io::Cursor::new(Vec::new());
        {
            let mut zip = zip::ZipWriter::new(&mut buf);
            let options = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Stored);
            zip.start_file("compartment-map.json", options).unwrap();
            zip.write_all(MAP).unwrap();
            zip.start_file("app-v1.0.0/lib/util.js", options).unwrap();
            zip.write_all(UTIL).unwrap();
            zip.finish().unwrap();
        }
        let archive_bytes = buf.into_inner();

        let zip_cas_tmp = tempfile::tempdir().unwrap();
        let zip_cas = ContentStore::open(zip_cas_tmp.path()).unwrap();
        let zip_root = ingest_archive(&zip_cas, io::Cursor::new(&archive_bytes))
            .unwrap()
            .root_hash;

        assert_eq!(dir_root, zip_root);
    }

    #[test]
    fn root_hash_is_deterministic_across_ingests() {
        // The same directory ingested twice (into distinct stores) must
        // yield the same root hash — content-addressing depends on canonical
        // manifest serialization, so this must not vary run to run.
        let src_tmp = tempfile::tempdir().unwrap();
        write_test_directory(src_tmp.path());

        let a_tmp = tempfile::tempdir().unwrap();
        let a = ContentStore::open(a_tmp.path()).unwrap();
        let b_tmp = tempfile::tempdir().unwrap();
        let b = ContentStore::open(b_tmp.path()).unwrap();

        let ra = ingest_directory(&a, src_tmp.path()).unwrap().root_hash;
        let rb = ingest_directory(&b, src_tmp.path()).unwrap().root_hash;
        assert_eq!(ra, rb);
    }

    #[test]
    fn ingest_directory_rejects_non_directory() {
        let cas_tmp = tempfile::tempdir().unwrap();
        let cas = ContentStore::open(cas_tmp.path()).unwrap();

        let file_tmp = tempfile::tempdir().unwrap();
        let file_path = file_tmp.path().join("not-a-dir.txt");
        std::fs::write(&file_path, b"hello").unwrap();

        assert!(ingest_directory(&cas, &file_path).is_err());
    }
}
