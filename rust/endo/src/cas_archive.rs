//! CAS-backed archive ingestion and loading.
//!
//! Provides functions to ingest a compartment-map ZIP archive
//! into the content-addressed store and load it back by root hash.
//!
//! Three input forms are supported:
//!
//! - [`ingest_archive`] takes a ZIP reader (Form 1 of
//!   `designs/endor-run-expanded.md`).
//! - [`ingest_entry_point`] takes a single source file path and
//!   synthesises a one-compartment, one-module archive around it
//!   (Form 3 § Phase 4, no-dependency case).
//! - The directory form (Form 2 / Phase 3) ships separately on PR
//!   #278 and is not present on this branch.

use std::collections::{BTreeMap, HashMap};
use std::ffi::OsStr;
use std::io::{self, Read, Seek};
use std::path::Path;

use crate::cas::{ContentStore, TreeEntry, TreeManifest};

/// Compartment id used by [`ingest_entry_point`] for the synthetic
/// one-compartment archive it wraps around a single entry-point
/// source file. The `v1.0.0` suffix is a placeholder version, not a
/// reference to any real package: the `<name>-v<version>` shape
/// mirrors `@endo/compartment-mapper`'s output for ZIP-shaped
/// archives so the same downstream loader handles both shapes
/// uniformly. Phase 5's mapper-driven path is expected to re-use
/// the same id for the no-dependency fast path; collecting the
/// literal in one named constant keeps the symbol grep-discoverable
/// at every call site (helper + tests).
pub const SYNTHETIC_COMPARTMENT_ID: &str = "entry-v1.0.0";

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
    let mut zip =
        zip::ZipArchive::new(reader).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;

    let mut root_entries: BTreeMap<String, TreeEntry> = BTreeMap::new();
    // Compartment sub-trees: compartment_name -> { filename -> TreeEntry }
    let mut compartment_trees: HashMap<String, BTreeMap<String, TreeEntry>> = HashMap::new();

    // Read and store every file in the archive.
    for i in 0..zip.len() {
        let mut file = zip
            .by_index(i)
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

/// Ingest a single entry-point source file into the CAS as a
/// synthetic one-compartment, one-module archive.
///
/// This is the Phase 4 (no-dependencies) implementation of Form 3
/// from `designs/endor-run-expanded.md`. The design's chosen
/// long-term approach is an XS-hosted compartment mapper that
/// walks `package.json` and the dependency graph (see Phase 5);
/// for a single source file with no imports, the mapper would
/// produce exactly the one-compartment, one-module shape this
/// helper produces directly. Doing it in Rust here keeps the
/// no-dependency case self-contained while leaving the
/// XS-hosted mapper for Phase 5 where dependency walking
/// becomes load-bearing.
///
/// Naming: the synthetic compartment is named `entry-v1.0.0` and
/// its single module specifier is `./<filename>` (the entry file's
/// basename). The file itself is stored at
/// `entry-v1.0.0/<filename>` in the CAS tree, mirroring the layout
/// `ingest_archive` produces for ZIP-shaped inputs so the same
/// [`load_archive_from_cas`] reader handles all three forms
/// identically.
///
/// Parser selection follows the source file's extension:
/// `.mjs` and `.js` map to `mjs` (ESM); `.cjs` maps to `cjs`
/// (CommonJS); `.json` maps to `json`. Other extensions are
/// rejected with `InvalidData` so a misnamed input fails fast
/// instead of producing an archive XS will refuse to import.
///
/// Errors:
/// - `NotFound` if the path does not exist or is not a regular
///   file.
/// - `InvalidData` if the file extension is not one of `.js`,
///   `.mjs`, `.cjs`, `.json`.
/// - I/O errors propagate from the underlying file read and CAS
///   writes.
pub fn ingest_entry_point(cas: &ContentStore, entry_path: &Path) -> io::Result<IngestedArchive> {
    // Validation-before-storage is a deliberate ordering invariant
    // of this function: every check that can reject the input
    // (the `is_file()` precheck, the `parser_for_extension`
    // extension check, the `file_name()` extraction) runs before
    // the first `cas.store` call. A refactor that inserts a CAS
    // write above the parser check would leave orphan blobs in the
    // store on the rejection path; the
    // `cas_is_unchanged_after_rejected_ingest` test below pins this invariant
    // by asserting the
    // CAS layout is byte-identical before and after a rejected
    // ingest.
    if !entry_path.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            format!("not a regular file: {}", entry_path.display()),
        ));
    }

    let parser = parser_for_extension(entry_path.extension()).ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "unsupported entry-point extension: {} (expected .js, .mjs, .cjs, .json)",
                entry_path.display()
            ),
        )
    })?;

    // Read the entry source.
    let source_bytes = std::fs::read(entry_path)?;

    // The file name within the synthetic compartment is the
    // path's basename; the module specifier is its `./`-prefixed
    // form. Both are derived from the same string so they stay in
    // lock-step.
    let file_name = entry_path
        .file_name()
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("entry path has no file name: {}", entry_path.display()),
            )
        })?
        .to_string_lossy()
        .into_owned();
    let specifier = format!("./{file_name}");

    // The compartment naming convention matches `ingest_archive`'s
    // test fixtures and the @endo/compartment-mapper output:
    // `<name>-v<version>` is the canonical compartment id even for
    // synthetic single-entry archives where the version is a
    // placeholder. The literal lives in [`SYNTHETIC_COMPARTMENT_ID`]
    // at module scope so the helper and its tests share one source
    // of truth.
    let compartment_id = SYNTHETIC_COMPARTMENT_ID.to_string();

    // Build the compartment-map.json describing one compartment
    // with one module. The `parser` field is derived once at the
    // top of the function from the entry path's extension; the
    // map-builder accepts it as an argument so both the
    // pre-flight validation and the on-disk serialisation read
    // from the same source of truth.
    let map_json =
        build_entry_compartment_map_json(&compartment_id, &specifier, &file_name, parser);

    // Store the entry source as a blob.
    let source_hash = cas.store(&source_bytes, "blob")?;
    let source_size = source_bytes.len() as u64;

    // Store the synthesised compartment-map.json as a blob.
    let map_hash = cas.store(map_json.as_bytes(), "blob")?;
    let map_size = map_json.len() as u64;

    // Build the compartment sub-tree: { <file_name>: <source blob> }.
    let mut compartment_entries: BTreeMap<String, TreeEntry> = BTreeMap::new();
    compartment_entries.insert(
        file_name.clone(),
        TreeEntry {
            entry_type: "blob".to_string(),
            hash: source_hash,
            size: Some(source_size),
        },
    );
    let compartment_tree = TreeManifest {
        entries: compartment_entries,
    };
    let compartment_tree_json = serde_json::to_vec(&compartment_tree)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    let compartment_tree_hash = cas.store_tree(&compartment_tree_json)?;

    // Build the root tree: {
    //   "compartment-map.json": <map blob>,
    //   "<compartment_id>": <compartment subtree>,
    // }
    let mut root_entries: BTreeMap<String, TreeEntry> = BTreeMap::new();
    root_entries.insert(
        "compartment-map.json".to_string(),
        TreeEntry {
            entry_type: "blob".to_string(),
            hash: map_hash,
            size: Some(map_size),
        },
    );
    root_entries.insert(
        compartment_id.clone(),
        TreeEntry {
            entry_type: "tree".to_string(),
            hash: compartment_tree_hash,
            size: None,
        },
    );
    let root_tree = TreeManifest {
        entries: root_entries,
    };
    let root_json = serde_json::to_vec(&root_tree)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    let root_hash = cas.store_tree(&root_json)?;

    // Load via the shared CAS reader so the synthetic archive is
    // observably identical to a ZIP- or directory-ingested one
    // from `run_xs_archive_loaded`'s perspective. Reusing the same
    // reader keeps Form 1, Form 2, and Form 3 (Phase 4) on a
    // single execution path.
    let archive = load_archive_from_cas(cas, &root_hash)?;

    Ok(IngestedArchive { root_hash, archive })
}

/// Map a path extension to the compartment-map `parser` field.
///
/// `.mjs` and `.js` both yield `mjs` (modern ESM is the default
/// for plain `.js` entry points consistent with
/// `@endo/compartment-mapper`'s default when no `package.json`
/// `type` is present). `.cjs` yields `cjs`. `.json` yields
/// `json`. Anything else returns `None`.
///
/// The extension is matched case-insensitively to mirror
/// [`crate::run_input::classify_run_input`]: a path like
/// `Hello.JS` classifies as an entry point in the CLI and must
/// also be acceptable to the ingest helper. Without the
/// `to_ascii_lowercase()` step the two halves of the
/// extension-to-form contract would silently diverge (the CLI
/// would accept the input, then `ingest_entry_point` would reject
/// it as `InvalidData`).
pub(crate) fn parser_for_extension(extension: Option<&OsStr>) -> Option<&'static str> {
    let extension = extension?.to_str()?.to_ascii_lowercase();
    match extension.as_str() {
        "js" | "mjs" => Some("mjs"),
        "cjs" => Some("cjs"),
        "json" => Some("json"),
        _ => None,
    }
}

/// Build the JSON text of a one-compartment, one-module
/// compartment-map.json describing an entry point.
///
/// The output matches the shape `ingest_archive`'s test fixture
/// uses, with `entry.compartment` / `entry.module` pointing into
/// the synthesised compartment. The `parser` argument is
/// authoritative: it is produced upstream by
/// `parser_for_extension` so the on-disk JSON and the
/// pre-flight validation cannot disagree.
///
/// Each interpolated string is passed through
/// `serde_json::to_string` so a file name containing `"`, `\`, a
/// control byte, or a non-BMP code point produces well-formed
/// JSON (a regular file named `foo"bar.js` is legal on every
/// POSIX filesystem and must not break the synthesised map). The
/// `compartment_id` and `parser` strings come from compile-time
/// constants or a fixed match arm and therefore cannot
/// realistically contain a JSON-significant character, but they
/// are escaped uniformly so the function has no implicit
/// "trusted" arguments.
fn build_entry_compartment_map_json(
    compartment_id: &str,
    specifier: &str,
    file_name: &str,
    parser: &str,
) -> String {
    // We hand-build the JSON rather than going through
    // `serde_json::to_string(&CompartmentMap)` because:
    // 1. The schema lives in `xsnap::archive` and using its
    //    `CompartmentMap` type here pulls a relatively heavy
    //    dependency into Rust-side serialisation for what is
    //    essentially a fixed two-pair template.
    // 2. The output is short and review-readable inline; a
    //    structural change to the schema would update this
    //    string alongside the new test fixtures.
    // The map intentionally omits optional fields (label,
    // sha512, etc.) so the on-disk JSON is a pure function of
    // the inputs. The `escape` helper below threads every
    // interpolation through `serde_json::to_string` so the
    // hand-built template still produces valid JSON for any
    // string the caller can pass.
    let escaped_compartment_id = escape(compartment_id);
    let escaped_specifier = escape(specifier);
    let escaped_file_name = escape(file_name);
    let parser_json = escape(parser);
    format!(
        r#"{{"entry":{{"compartment":{escaped_compartment_id},"module":{escaped_specifier}}},"compartments":{{{escaped_compartment_id}:{{"name":"entry","modules":{{{escaped_specifier}:{{"parser":{parser_json},"location":{escaped_file_name}}}}}}}}}}}"#,
    )
}

/// Encode a string as a JSON string literal (including the
/// surrounding double quotes). Falls back to the empty JSON
/// string only if `serde_json` cannot serialise the input, which
/// in practice does not happen for `&str` because
/// `serde_json::to_string` of any `&str` is infallible; the
/// fallback is defensive belt-and-braces against a future API
/// signature change.
fn escape(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"\"".to_string())
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
    let map_entry = root_tree
        .entries
        .get("compartment-map.json")
        .ok_or_else(|| {
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
                        sources.insert((compartment_name.clone(), specifier.clone()), source);
                    }
                    Err(_) => {
                        // Module file missing — will be a runtime error
                        // if actually imported.
                    }
                }
            }
        }
    }

    Ok(xsnap::archive::LoadedArchive {
        map,
        sources,
        cjs_sources: HashMap::new(),
    })
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

    // ---- Phase 4 (entry-point form, no dependencies) tests ----

    /// Write a single source file inside a fresh temporary
    /// directory and return both. The directory is returned so
    /// the caller can keep it alive for the duration of the
    /// test; dropping it removes the file.
    fn write_temp_source(
        file_name: &str,
        contents: &[u8],
    ) -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(file_name);
        std::fs::write(&path, contents).unwrap();
        (dir, path)
    }

    #[test]
    fn ingest_entry_point_synthesises_one_compartment_archive() {
        let tmp = tempfile::tempdir().unwrap();
        let cas = ContentStore::open(tmp.path()).unwrap();

        let (_src_dir, src_path) = write_temp_source("hello.js", b"export default 'hello';");

        let ingested = ingest_entry_point(&cas, &src_path).unwrap();

        // Root hash must be non-empty and present in the CAS.
        assert!(!ingested.root_hash.is_empty());
        assert!(cas.has(&ingested.root_hash));

        // The synthesised archive is a one-compartment, one-module
        // archive whose entry points at the source file.
        assert_eq!(
            ingested.archive.map.entry.compartment,
            SYNTHETIC_COMPARTMENT_ID
        );
        assert_eq!(ingested.archive.map.entry.module, "./hello.js");

        // The module source was stored faithfully.
        let key = (
            SYNTHETIC_COMPARTMENT_ID.to_string(),
            "./hello.js".to_string(),
        );
        assert_eq!(
            ingested.archive.sources.get(&key).unwrap(),
            "export default 'hello';"
        );
    }

    #[test]
    fn ingest_entry_point_root_tree_layout() {
        // The on-disk root tree should mirror `ingest_archive`'s
        // layout: a `compartment-map.json` blob and one
        // compartment-named subtree. This keeps the existing
        // `load_archive_from_cas` reader and the `endor run
        // --cas <hash>` re-entry point reading entry-point-
        // ingested and ZIP-ingested archives interchangeably.
        let tmp = tempfile::tempdir().unwrap();
        let cas = ContentStore::open(tmp.path()).unwrap();
        let (_src_dir, src_path) = write_temp_source("entry.mjs", b"export const x = 1;");

        let ingested = ingest_entry_point(&cas, &src_path).unwrap();

        let names = cas.list_tree(&ingested.root_hash).unwrap();
        assert!(names.contains(&"compartment-map.json".to_string()));
        assert!(names.contains(&SYNTHETIC_COMPARTMENT_ID.to_string()));

        // The compartment subtree contains exactly the entry
        // file at its on-disk name.
        let entries: std::collections::HashMap<String, Vec<u8>> = cas
            .read_tree(&ingested.root_hash)
            .unwrap()
            .entries
            .iter()
            .filter(|(_, e)| e.entry_type == "tree")
            .map(|(_, e)| (e.hash.clone(), cas.fetch_tree(&e.hash).unwrap()))
            .map(|(_, bytes)| {
                let m: TreeManifest = serde_json::from_slice(&bytes).unwrap();
                m.entries
                    .into_iter()
                    .map(|(k, v)| (k, v.hash.into_bytes()))
                    .collect::<std::collections::HashMap<_, _>>()
            })
            .next()
            .unwrap();
        assert!(entries.contains_key("entry.mjs"));
    }

    #[test]
    fn ingest_entry_point_reload_via_load_archive_from_cas() {
        // The root hash is sufficient to re-read the archive
        // later: `load_archive_from_cas` should reproduce the
        // same compartment, module, and source bytes.
        let tmp = tempfile::tempdir().unwrap();
        let cas = ContentStore::open(tmp.path()).unwrap();
        let (_src_dir, src_path) = write_temp_source("main.js", b"globalThis.x = 42;");

        let ingested = ingest_entry_point(&cas, &src_path).unwrap();
        let root_hash = ingested.root_hash.clone();

        let reloaded = load_archive_from_cas(&cas, &root_hash).unwrap();
        assert_eq!(reloaded.map.entry.compartment, SYNTHETIC_COMPARTMENT_ID);
        assert_eq!(reloaded.map.entry.module, "./main.js");

        let key = (
            SYNTHETIC_COMPARTMENT_ID.to_string(),
            "./main.js".to_string(),
        );
        assert_eq!(reloaded.sources.get(&key).unwrap(), "globalThis.x = 42;");
    }

    #[test]
    fn ingest_entry_point_rejects_unsupported_extension() {
        // An entry path with no parser-mappable extension fails
        // fast with `InvalidData` and writes nothing to the CAS.
        // Without this check the synthesised compartment-map
        // would carry an empty or guessed `parser` field that
        // XS would reject at import time.
        let tmp = tempfile::tempdir().unwrap();
        let cas = ContentStore::open(tmp.path()).unwrap();
        let (_src_dir, src_path) = write_temp_source("hello.txt", b"not javascript");

        let err = match ingest_entry_point(&cas, &src_path) {
            Ok(_) => panic!("expected error for unsupported extension"),
            Err(e) => e,
        };
        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
        assert!(
            err.to_string()
                .contains("unsupported entry-point extension"),
            "unexpected error message: {err}"
        );
    }

    #[test]
    fn ingest_entry_point_rejects_missing_path() {
        // A non-existent entry path returns `NotFound` before
        // any CAS write.
        let tmp = tempfile::tempdir().unwrap();
        let cas = ContentStore::open(tmp.path()).unwrap();
        let missing = tmp.path().join("does-not-exist.js");

        let err = match ingest_entry_point(&cas, &missing) {
            Ok(_) => panic!("expected NotFound for missing path"),
            Err(e) => e,
        };
        assert_eq!(err.kind(), io::ErrorKind::NotFound);
    }

    #[test]
    fn ingest_entry_point_rejects_directory_input() {
        // A directory is not a valid entry-point file. Phase 3
        // (directory form) lives on PR #278 and follows its own
        // CLI dispatch path; the entry-point helper refuses
        // directory inputs at the helper boundary so a CLI bug
        // that mis-routes a directory here still surfaces a
        // clear error rather than producing a malformed archive.
        let tmp = tempfile::tempdir().unwrap();
        let cas = ContentStore::open(tmp.path()).unwrap();
        let dir = tempfile::tempdir().unwrap();

        let err = match ingest_entry_point(&cas, dir.path()) {
            Ok(_) => panic!("expected NotFound for directory input"),
            Err(e) => e,
        };
        assert_eq!(err.kind(), io::ErrorKind::NotFound);
    }

    #[test]
    fn ingest_entry_point_parser_selection_by_extension() {
        // The compartment-map.json the helper synthesises must
        // carry the parser that matches the source file's
        // extension. The check reads the blob back from the CAS
        // and inspects the serialised JSON so a parser-selection
        // regression is observed at the on-disk boundary, not
        // just in the Rust-side struct.
        for (file_name, expected_parser) in [
            ("a.js", "mjs"),
            ("b.mjs", "mjs"),
            ("c.cjs", "cjs"),
            ("d.json", "json"),
        ] {
            let tmp = tempfile::tempdir().unwrap();
            let cas = ContentStore::open(tmp.path()).unwrap();
            let (_src_dir, src_path) = write_temp_source(file_name, b"x");

            let ingested = ingest_entry_point(&cas, &src_path).unwrap();
            let map_bytes = cas
                .fetch_from_tree(&ingested.root_hash, "compartment-map.json")
                .unwrap();
            let map_text = String::from_utf8(map_bytes).unwrap();
            assert!(
                map_text.contains(&format!(r#""parser":"{expected_parser}""#)),
                "{file_name}: expected parser {expected_parser} in {map_text}",
            );
        }
    }

    #[test]
    fn ingest_entry_point_rejects_extensionless_file() {
        // A regular file with no extension at all is rejected with
        // `InvalidData` for the same reason `.txt` is: the
        // synthesised compartment-map needs a parser, and the
        // classifier has no way to guess one from a bare name.
        // The `parser_for_extension(None)` branch is the second
        // half of the parser-selection contract (the other being
        // an unrecognised extension); without this test the
        // `ext?` short-circuit in `parser_for_extension` is
        // exercised only at the bin layer.
        let tmp = tempfile::tempdir().unwrap();
        let cas = ContentStore::open(tmp.path()).unwrap();
        let (_src_dir, src_path) = write_temp_source("entry", b"export default 1;");

        let err = match ingest_entry_point(&cas, &src_path) {
            Ok(_) => panic!("expected error for extensionless file"),
            Err(e) => e,
        };
        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
        assert!(
            err.to_string()
                .contains("unsupported entry-point extension"),
            "unexpected error message: {err}"
        );
    }

    #[test]
    fn load_archive_from_cas_errors_when_compartment_map_missing() {
        // A synthetic root tree with no `compartment-map.json`
        // entry must surface `NotFound` from
        // `load_archive_from_cas`. The branch is reachable in
        // production from a malformed re-ingest or a partial GC
        // race; pinning it keeps the error path from regressing
        // into a panic or a silent empty-archive return.
        let tmp = tempfile::tempdir().unwrap();
        let cas = ContentStore::open(tmp.path()).unwrap();

        // Build a root tree whose only entry is an unrelated
        // blob: no `compartment-map.json` reference at all.
        let blob_hash = cas.store(b"not a map", "blob").unwrap();
        let mut entries: BTreeMap<String, TreeEntry> = BTreeMap::new();
        entries.insert(
            "filler.bin".to_string(),
            TreeEntry {
                entry_type: "blob".to_string(),
                hash: blob_hash,
                size: Some(9),
            },
        );
        let root = TreeManifest { entries };
        let root_json = serde_json::to_vec(&root).unwrap();
        let root_hash = cas.store_tree(&root_json).unwrap();

        let err = match load_archive_from_cas(&cas, &root_hash) {
            Ok(_) => panic!("expected NotFound when compartment-map.json missing"),
            Err(e) => e,
        };
        assert_eq!(err.kind(), io::ErrorKind::NotFound);
        assert!(
            err.to_string().contains("compartment-map.json"),
            "error message should name the missing entry: {err}",
        );
    }

    #[test]
    fn load_archive_from_cas_errors_on_invalid_map_json() {
        // A root tree whose `compartment-map.json` blob is not
        // parseable JSON surfaces `InvalidData` with a message
        // that names the failure as a map-parse problem. This
        // covers the `map_err` closure on the `serde_json::from_
        // slice` call (otherwise dead unless the CAS is corrupt
        // or a different writer produced the blob).
        let tmp = tempfile::tempdir().unwrap();
        let cas = ContentStore::open(tmp.path()).unwrap();

        // Store a deliberately-malformed blob and reference it as
        // `compartment-map.json` from a fresh root tree.
        let bad_map_hash = cas.store(b"{ not valid json", "blob").unwrap();
        let mut entries: BTreeMap<String, TreeEntry> = BTreeMap::new();
        entries.insert(
            "compartment-map.json".to_string(),
            TreeEntry {
                entry_type: "blob".to_string(),
                hash: bad_map_hash,
                size: Some(16),
            },
        );
        let root = TreeManifest { entries };
        let root_json = serde_json::to_vec(&root).unwrap();
        let root_hash = cas.store_tree(&root_json).unwrap();

        let err = match load_archive_from_cas(&cas, &root_hash) {
            Ok(_) => panic!("expected InvalidData on malformed compartment-map.json"),
            Err(e) => e,
        };
        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
        assert!(
            err.to_string().contains("invalid map"),
            "error message should name the parse failure: {err}",
        );
    }

    #[test]
    fn ingest_entry_point_run_path_matches_zip_run_path() {
        // The whole point of synthesising a one-compartment
        // archive in CAS is that the downstream `LoadedArchive`
        // is shape-compatible with the ZIP path's output. This
        // test asserts the shape compatibility directly: a ZIP
        // archive with the same single module and an entry-
        // point ingest of the same source should produce
        // `LoadedArchive` values that agree on entry compartment
        // structure and source contents (the compartment ids
        // differ because the ZIP uses `app-v1.0.0` and the
        // synthesised archive uses `entry-v1.0.0`; the test
        // pins both to the same source text and module specifier
        // so any divergence beyond the compartment label flags
        // a shape mismatch).
        let tmp = tempfile::tempdir().unwrap();
        let cas = ContentStore::open(tmp.path()).unwrap();

        // ZIP form.
        let zip_ingested = ingest_archive(&cas, io::Cursor::new(make_test_archive())).unwrap();

        // Entry-point form.
        let (_src_dir, src_path) = write_temp_source("index.js", b"export default 42;");
        let entry_point_ingested = ingest_entry_point(&cas, &src_path).unwrap();

        // Both archives have one compartment with one module.
        assert_eq!(zip_ingested.archive.map.compartments.len(), 1);
        assert_eq!(entry_point_ingested.archive.map.compartments.len(), 1);
        assert_eq!(zip_ingested.archive.sources.len(), 1);
        assert_eq!(entry_point_ingested.archive.sources.len(), 1);

        // Both archives carry the same module source text.
        let zip_source = zip_ingested
            .archive
            .sources
            .values()
            .next()
            .unwrap()
            .clone();
        let entry_point_source = entry_point_ingested
            .archive
            .sources
            .values()
            .next()
            .unwrap()
            .clone();
        assert_eq!(zip_source, entry_point_source);
    }

    #[test]
    fn ingest_entry_point_uppercase_extension_routes_to_parser() {
        // `parser_for_extension` matches case-insensitively so the
        // CLI's `classify_run_input` (which lowercases the
        // extension before matching) and this helper agree on what
        // counts as a valid entry-point source. Without the
        // `to_ascii_lowercase()` step in `parser_for_extension`,
        // `Hello.JS` would route to `RunInput::EntryPoint` at the
        // CLI and then fail with `InvalidData ("unsupported
        // entry-point extension: Hello.JS")` at ingest time, a
        // classify/ingest divergence the user observes as a
        // confusing error. The assertion reads the on-disk JSON
        // blob from the CAS so a parser-selection regression is
        // observed at the on-disk boundary.
        let tmp = tempfile::tempdir().unwrap();
        let cas = ContentStore::open(tmp.path()).unwrap();
        let (_src_dir, src_path) = write_temp_source("Hello.JS", b"export default 1;");

        let ingested = ingest_entry_point(&cas, &src_path).unwrap();

        let map_bytes = cas
            .fetch_from_tree(&ingested.root_hash, "compartment-map.json")
            .unwrap();
        let map_text = String::from_utf8(map_bytes).unwrap();
        assert!(
            map_text.contains(r#""parser":"mjs""#),
            "uppercase .JS extension should route to mjs parser; got {map_text}",
        );
    }

    #[test]
    fn ingest_entry_point_escapes_quote_in_file_name() {
        // A file whose name contains a literal `"` is legal on
        // every POSIX filesystem. Without JSON-escaping in
        // `build_entry_compartment_map_json`, the interpolation
        // would produce a `compartment-map.json` blob that is not
        // parseable JSON, and the immediate
        // `load_archive_from_cas` round-trip inside
        // `ingest_entry_point` would surface as
        // `InvalidData ("invalid map: ...")` rather than the
        // upstream input being accepted cleanly. The assertion
        // exercises both the JSON-validity invariant (the
        // synthesised blob parses) and the round-trip invariant
        // (the reloaded archive's specifier and source match what
        // the helper recorded).
        let tmp = tempfile::tempdir().unwrap();
        let cas = ContentStore::open(tmp.path()).unwrap();
        let (_src_dir, src_path) = write_temp_source(r#"foo"bar.js"#, b"export default 1;");

        let ingested = ingest_entry_point(&cas, &src_path).unwrap();

        // The synthesised compartment-map.json must be valid JSON
        // and parse against the upstream `CompartmentMap` schema.
        let map_bytes = cas
            .fetch_from_tree(&ingested.root_hash, "compartment-map.json")
            .unwrap();
        let parsed: xsnap::archive::CompartmentMap = serde_json::from_slice(&map_bytes)
            .expect("synthesised map must be valid JSON for an awkward file name");

        // The specifier preserves the original (unescaped) file
        // name; the escaping is a wire-format concern, not a
        // user-visible one.
        let expected_specifier = r#"./foo"bar.js"#;
        assert_eq!(parsed.entry.module, expected_specifier);

        // The round-trip through `load_archive_from_cas` (which
        // `ingest_entry_point` already performs internally) found
        // the source by the awkward specifier.
        let key = (
            SYNTHETIC_COMPARTMENT_ID.to_string(),
            expected_specifier.to_string(),
        );
        assert_eq!(
            ingested.archive.sources.get(&key).map(String::as_str),
            Some("export default 1;"),
            "the source bytes must survive the synthesise/store/load round trip for an \
             awkwardly-named file",
        );
    }

    #[test]
    fn cas_is_unchanged_after_rejected_ingest() {
        // Validation-before-storage is a deliberate ordering
        // invariant of `ingest_entry_point`: every check that can
        // reject the input runs before any `cas.store` call, so a
        // rejected ingest leaves the CAS byte-identical to its
        // pre-call state. A refactor that inserts a CAS write
        // above the parser check would leak orphan blobs on the
        // rejection path; this test catches that regression by
        // taking a snapshot of the CAS directory before the
        // rejected call and asserting the snapshot is preserved
        // after the call returns.
        //
        // We sample two rejection paths to cover both validation
        // gates: an unsupported extension (`InvalidData` after the
        // `is_file()` precheck succeeds) and a non-existent path
        // (`NotFound` from the precheck itself).
        let tmp = tempfile::tempdir().unwrap();
        let cas = ContentStore::open(tmp.path()).unwrap();

        let snapshot_before = list_cas_directory(tmp.path());
        // Sanity: a fresh CAS contains no stored entries (the
        // directory exists but holds no blob/tree files).
        assert!(
            snapshot_before.is_empty(),
            "fresh CAS should have no stored entries; got {snapshot_before:?}",
        );

        // Rejection path 1: unsupported extension.
        let (_src_dir, bad_ext_path) = write_temp_source("hello.txt", b"not javascript");
        let err = match ingest_entry_point(&cas, &bad_ext_path) {
            Ok(_) => panic!("expected InvalidData for unsupported extension"),
            Err(e) => e,
        };
        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
        let snapshot_after_ext = list_cas_directory(tmp.path());
        assert_eq!(
            snapshot_after_ext, snapshot_before,
            "unsupported-extension rejection must not write to the CAS; before={snapshot_before:?} after={snapshot_after_ext:?}",
        );

        // Rejection path 2: non-existent path.
        let missing = tmp.path().join("does-not-exist.js");
        let err = match ingest_entry_point(&cas, &missing) {
            Ok(_) => panic!("expected NotFound for missing path"),
            Err(e) => e,
        };
        assert_eq!(err.kind(), io::ErrorKind::NotFound);
        let snapshot_after_missing = list_cas_directory(tmp.path());
        assert_eq!(
            snapshot_after_missing, snapshot_before,
            "missing-path rejection must not write to the CAS; before={snapshot_before:?} after={snapshot_after_missing:?}",
        );
    }

    /// List the file names directly under `dir` (the CAS root),
    /// excluding `.tmp` artifacts from racing writers (there are
    /// none in this test, but the helper stays robust against
    /// them) and returning a sorted Vec so equality comparisons
    /// are deterministic. CAS entries are stored as
    /// `{dir}/{hex-sha256}` per `cas.rs`, so any committed write
    /// shows up as a new entry here.
    fn list_cas_directory(directory: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(directory)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| !n.ends_with(".tmp"))
            .collect();
        names.sort();
        names
    }

    #[test]
    fn synthesised_map_round_trips_through_compartment_map_schema() {
        // The synthesised `compartment-map.json` must remain
        // structurally compatible with `xsnap::archive::
        // CompartmentMap`: the immediate `load_archive_from_cas`
        // round-trip inside `ingest_entry_point` only asserts that
        // the parse succeeds, but a schema drift that, say, made
        // `parser` required-as-enum or renamed `location` would
        // surface here at compile-or-test time rather than
        // silently at the next upstream Endo bump. The shape
        // asserted here is the load-bearing one: one entry
        // descriptor, one compartment whose `modules` map carries
        // a single `File` descriptor with the expected `parser`
        // and `location` strings.
        let tmp = tempfile::tempdir().unwrap();
        let cas = ContentStore::open(tmp.path()).unwrap();
        let (_src_dir, src_path) = write_temp_source("greet.mjs", b"export default 1;");

        let ingested = ingest_entry_point(&cas, &src_path).unwrap();

        // Parse the synthesised JSON directly through the upstream
        // `CompartmentMap` type.
        let map_bytes = cas
            .fetch_from_tree(&ingested.root_hash, "compartment-map.json")
            .unwrap();
        let parsed: xsnap::archive::CompartmentMap =
            serde_json::from_slice(&map_bytes).expect("synthesised map must parse");

        // Entry descriptor.
        assert_eq!(parsed.entry.compartment, SYNTHETIC_COMPARTMENT_ID);
        assert_eq!(parsed.entry.module, "./greet.mjs");

        // One compartment with the synthetic id, named "entry".
        assert_eq!(parsed.compartments.len(), 1);
        let compartment = parsed
            .compartments
            .get(SYNTHETIC_COMPARTMENT_ID)
            .expect("compartment-map.json must carry the synthetic compartment id");
        assert_eq!(compartment.name, "entry");
        assert!(
            compartment.label.is_none(),
            "the synthesised map intentionally omits the optional label field",
        );

        // One module: `./greet.mjs` -> File { parser: mjs, location: greet.mjs }.
        assert_eq!(compartment.modules.len(), 1);
        let module = compartment
            .modules
            .get("./greet.mjs")
            .expect("module specifier should be `./greet.mjs`");
        match module {
            xsnap::archive::ModuleDescriptor::File {
                parser,
                location,
                sha512,
            } => {
                assert_eq!(parser, "mjs");
                assert_eq!(location.as_deref(), Some("greet.mjs"));
                assert!(
                    sha512.is_none(),
                    "the synthesised map intentionally omits the optional sha512 field",
                );
            }
            other => {
                panic!("expected File descriptor; got {other:?} (schema drift would land here)",)
            }
        }
    }
}
