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
/// Shared by the ZIP (`ingest_archive`) and directory (`ingest_directory`)
/// ingestion paths so the two produce identical trees.
fn ingest_files(
    cas: &ContentStore,
    files: Vec<(String, Vec<u8>)>,
) -> io::Result<String> {
    let mut builder = ArchiveTreeBuilder::new(cas);
    for (name, contents) in files {
        builder.add_file(&name, &contents)?;
    }
    builder.finish()
}

/// Incrementally stores archive files in the CAS and assembles the tree
/// manifests that mirror the archive's directory structure.
///
/// Each `/`-separated path component below the root becomes a nested
/// tree, so `app-v1.0.0/lib/util.js` is stored as root → `app-v1.0.0`
/// (tree) → `lib` (tree) → `util.js` (blob), the shape
/// `ContentStore::fetch_from_tree` walks.
pub struct ArchiveTreeBuilder<'a> {
    cas: &'a ContentStore,
    root: DirectoryNode,
}

#[derive(Default)]
struct DirectoryNode {
    files: BTreeMap<String, TreeEntry>,
    directories: BTreeMap<String, DirectoryNode>,
}

impl<'a> ArchiveTreeBuilder<'a> {
    pub fn new(cas: &'a ContentStore) -> Self {
        ArchiveTreeBuilder {
            cas,
            root: DirectoryNode::default(),
        }
    }

    /// Store `contents` as a blob and record it at the archive-relative
    /// `path`. Empty path components are ignored, so a trailing `/` (a ZIP
    /// directory entry) records nothing.
    pub fn add_file(&mut self, path: &str, contents: &[u8]) -> io::Result<()> {
        let components: Vec<&str> = path.split('/').filter(|c| !c.is_empty()).collect();
        let Some((file_name, directories)) = components.split_last() else {
            return Ok(());
        };
        if path.ends_with('/') {
            return Ok(());
        }

        let mut node = &mut self.root;
        for directory in directories {
            if node.files.contains_key(*directory) {
                return Err(conflict(path, directory));
            }
            node = node.directories.entry(directory.to_string()).or_default();
        }
        if node.directories.contains_key(*file_name) {
            return Err(conflict(path, file_name));
        }

        let hash = self.cas.store(contents, "blob")?;
        node.files.insert(
            file_name.to_string(),
            TreeEntry {
                entry_type: "blob".to_string(),
                hash,
                size: Some(contents.len() as u64),
            },
        );
        Ok(())
    }

    /// Store the tree manifests bottom-up and return the root tree hash.
    pub fn finish(self) -> io::Result<String> {
        store_directory(self.cas, self.root)
    }
}

fn conflict(path: &str, component: &str) -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        format!("archive path {path:?}: {component:?} is both a file and a directory"),
    )
}

fn store_directory(cas: &ContentStore, node: DirectoryNode) -> io::Result<String> {
    // BTreeMap keeps the manifests canonical (sorted keys → stable hash).
    let mut entries = node.files;
    for (name, child) in node.directories {
        let hash = store_directory(cas, child)?;
        entries.insert(
            name,
            TreeEntry {
                entry_type: "tree".to_string(),
                hash,
                size: None,
            },
        );
    }
    let tree_json = serde_json::to_vec(&TreeManifest { entries })
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    cas.store_tree(&tree_json)
}

/// Whether `path` names a ZIP archive: a `.zip` extension, or a file whose
/// first bytes are the ZIP local-file-header magic `PK\x03\x04`.
///
/// `endor run` treats a non-directory input that is not a ZIP archive as
/// an entry-point module.
pub fn is_zip_archive(path: &Path) -> bool {
    if path
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("zip"))
    {
        return true;
    }
    let mut magic = [0u8; 4];
    std::fs::File::open(path)
        .and_then(|mut file| file.read_exact(&mut magic))
        .is_ok_and(|()| magic == *b"PK\x03\x04")
}

/// Ingest the application rooted at an entry-point module into the CAS
/// and return the root hash (Form 3 of `endor run`).
///
/// The XS-hosted compartment mapper (`xsnap::mapper`) walks the module
/// graph from `entry` and writes each archive file straight into the CAS
/// through an [`ArchiveTreeBuilder`], so the result has the same layout,
/// and loads through the same `load_archive_from_cas` path, as an ingested
/// ZIP archive of the same application.
pub fn ingest_entry_point(cas: &ContentStore, entry: &Path) -> io::Result<IngestedArchive> {
    let entry = std::fs::canonicalize(entry)
        .map_err(|e| io::Error::new(e.kind(), format!("{}: {e}", entry.display())))?;
    if !entry.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("not a file: {}", entry.display()),
        ));
    }

    let mut builder = ArchiveTreeBuilder::new(cas);
    xsnap::mapper::map_entry_point(&entry, &mut |path, bytes| builder.add_file(path, bytes))
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e.to_string()))?;
    let root_hash = builder.finish()?;
    let archive = load_archive_from_cas(cas, &root_hash)?;

    Ok(IngestedArchive { root_hash, archive })
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

    /// A compartment-map directory whose entry module lives two levels deep
    /// inside its compartment (`app-v1.0.0/lib/util.js`).
    fn write_nested_directory(dir: &std::path::Path) {
        const MAP: &str = r#"{
            "entry": {"compartment": "app-v1.0.0", "module": "./lib/util.js"},
            "compartments": {
                "app-v1.0.0": {
                    "name": "app",
                    "modules": {
                        "./lib/util.js": {"parser": "mjs", "location": "lib/util.js"}
                    }
                }
            }
        }"#;
        std::fs::write(dir.join("compartment-map.json"), MAP).unwrap();
        let nested = dir.join("app-v1.0.0").join("lib");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(nested.join("util.js"), b"export const x = 1;").unwrap();
    }

    #[test]
    fn nested_module_loads_from_cas() {
        let cas_tmp = tempfile::tempdir().unwrap();
        let cas = ContentStore::open(cas_tmp.path()).unwrap();
        let src_tmp = tempfile::tempdir().unwrap();
        write_nested_directory(src_tmp.path());

        let ingested = ingest_directory(&cas, src_tmp.path()).unwrap();

        let key = ("app-v1.0.0".to_string(), "./lib/util.js".to_string());
        assert_eq!(
            ingested.archive.sources.get(&key).map(String::as_str),
            Some("export const x = 1;")
        );
    }

    #[test]
    fn nested_files_become_nested_trees() {
        let cas_tmp = tempfile::tempdir().unwrap();
        let cas = ContentStore::open(cas_tmp.path()).unwrap();
        let src_tmp = tempfile::tempdir().unwrap();
        write_nested_directory(src_tmp.path());

        let root = ingest_directory(&cas, src_tmp.path()).unwrap().root_hash;

        let root_tree = cas.read_tree(&root).unwrap();
        let compartment = cas.read_tree(&root_tree.entries["app-v1.0.0"].hash).unwrap();
        let names: Vec<&String> = compartment.entries.keys().collect();
        assert_eq!(names, vec!["lib"]);
        assert_eq!(compartment.entries["lib"].entry_type, "tree");
        let lib = cas.read_tree(&compartment.entries["lib"].hash).unwrap();
        assert_eq!(lib.entries["util.js"].entry_type, "blob");
        assert_eq!(
            cas.fetch_from_tree(&root, "app-v1.0.0/lib/util.js").unwrap(),
            b"export const x = 1;"
        );
    }

    #[test]
    fn tree_builder_rejects_file_directory_conflict() {
        let cas_tmp = tempfile::tempdir().unwrap();
        let cas = ContentStore::open(cas_tmp.path()).unwrap();

        let mut builder = ArchiveTreeBuilder::new(&cas);
        builder.add_file("app/lib", b"a file").unwrap();
        let error = builder.add_file("app/lib/util.js", b"x").unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);

        let mut builder = ArchiveTreeBuilder::new(&cas);
        builder.add_file("app/lib/util.js", b"x").unwrap();
        let error = builder.add_file("app/lib", b"a file").unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    }

    #[test]
    fn zip_detection_by_extension_and_magic() {
        let tmp = tempfile::tempdir().unwrap();

        let named = tmp.path().join("app.ZIP");
        std::fs::write(&named, b"not really a zip").unwrap();
        assert!(is_zip_archive(&named));

        let unnamed = tmp.path().join("app");
        std::fs::write(&unnamed, make_test_archive()).unwrap();
        assert!(is_zip_archive(&unnamed));

        let module = tmp.path().join("hello.js");
        std::fs::write(&module, b"print('hi');").unwrap();
        assert!(!is_zip_archive(&module));

        let short = tmp.path().join("x");
        std::fs::write(&short, b"PK").unwrap();
        assert!(!is_zip_archive(&short));
    }

    /// Serializes the tests that run the XS mapper. XS's quiesce loop reads
    /// a process-global pending-jobs flag (`fxHasPendingJobs` in
    /// `xsnap-platform.c`), so a machine on another test thread can consume
    /// the flag and end this machine's drain early.
    static XS_MACHINE: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn lock_xs_machine() -> std::sync::MutexGuard<'static, ()> {
        XS_MACHINE.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Lay out an ESM application: `hello.js` imports `./lib/greet.js`.
    fn write_entry_point_application(dir: &std::path::Path, package_json: bool) {
        if package_json {
            std::fs::write(
                dir.join("package.json"),
                br#"{"name":"hello","version":"1.2.3","type":"module"}"#,
            )
            .unwrap();
        }
        std::fs::write(
            dir.join("hello.js"),
            b"import { greet } from './lib/greet.js';\nprint(greet());\n",
        )
        .unwrap();
        std::fs::create_dir_all(dir.join("lib")).unwrap();
        std::fs::write(
            dir.join("lib").join("greet.js"),
            b"export const greet = () => 'hello';\n",
        )
        .unwrap();
    }

    #[test]
    fn entry_point_maps_module_graph_into_cas() {
        let _xs = lock_xs_machine();
        let cas_tmp = tempfile::tempdir().unwrap();
        let cas = ContentStore::open(cas_tmp.path()).unwrap();
        let src_tmp = tempfile::tempdir().unwrap();
        write_entry_point_application(src_tmp.path(), true);

        let ingested = ingest_entry_point(&cas, &src_tmp.path().join("hello.js")).unwrap();

        let map = &ingested.archive.map;
        let compartment = map.entry.compartment.clone();
        assert_eq!(map.entry.module, "./hello.js");
        let greet = (compartment.clone(), "./lib/greet.js".to_string());
        assert_eq!(
            ingested.archive.sources.get(&greet).map(String::as_str),
            Some("export const greet = () => 'hello';\n")
        );
        assert_eq!(
            cas.fetch_from_tree(&ingested.root_hash, &format!("{compartment}/lib/greet.js"))
                .unwrap(),
            b"export const greet = () => 'hello';\n"
        );

        // Re-running from the root hash reproduces the same archive.
        let reloaded = load_archive_from_cas(&cas, &ingested.root_hash).unwrap();
        assert_eq!(reloaded.sources, ingested.archive.sources);
    }

    #[test]
    fn entry_point_without_package_json_is_esm() {
        let _xs = lock_xs_machine();
        let cas_tmp = tempfile::tempdir().unwrap();
        let cas = ContentStore::open(cas_tmp.path()).unwrap();
        let src_tmp = tempfile::tempdir().unwrap();
        write_entry_point_application(src_tmp.path(), false);
        // A package.json above the temporary directory would be found first.
        if !no_package_json_above(src_tmp.path()) {
            return;
        }

        let ingested = ingest_entry_point(&cas, &src_tmp.path().join("hello.js")).unwrap();

        let compartment = &ingested.archive.map.compartments[&ingested.archive.map.entry.compartment];
        assert!(matches!(
            compartment.modules.get("./lib/greet.js"),
            Some(xsnap::archive::ModuleDescriptor::File { parser, .. }) if parser == "mjs"
        ));
        // The synthetic package.json is not stored.
        let names = cas.list_tree(&ingested.root_hash).unwrap();
        assert_eq!(names.len(), 2, "{names:?}");
    }

    fn no_package_json_above(dir: &std::path::Path) -> bool {
        dir.ancestors().all(|d| !d.join("package.json").exists())
    }

    #[test]
    fn entry_point_is_deterministic() {
        let _xs = lock_xs_machine();
        let src_tmp = tempfile::tempdir().unwrap();
        write_entry_point_application(src_tmp.path(), true);
        let entry = src_tmp.path().join("hello.js");

        let a_tmp = tempfile::tempdir().unwrap();
        let a = ContentStore::open(a_tmp.path()).unwrap();
        let b_tmp = tempfile::tempdir().unwrap();
        let b = ContentStore::open(b_tmp.path()).unwrap();

        assert_eq!(
            ingest_entry_point(&a, &entry).unwrap().root_hash,
            ingest_entry_point(&b, &entry).unwrap().root_hash
        );
    }

    #[test]
    fn entry_point_reports_unresolvable_import() {
        let _xs = lock_xs_machine();
        let cas_tmp = tempfile::tempdir().unwrap();
        let cas = ContentStore::open(cas_tmp.path()).unwrap();
        let src_tmp = tempfile::tempdir().unwrap();
        std::fs::write(
            src_tmp.path().join("package.json"),
            br#"{"name":"broken","version":"1.0.0","type":"module"}"#,
        )
        .unwrap();
        std::fs::write(src_tmp.path().join("main.js"), b"import './missing.js';\n").unwrap();

        let error = match ingest_entry_point(&cas, &src_tmp.path().join("main.js")) {
            Ok(_) => panic!("mapping an unresolvable import succeeded"),
            Err(error) => error,
        };
        assert!(error.to_string().contains("missing.js"), "{error}");
    }
}
