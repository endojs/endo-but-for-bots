//! Materialise an assembled entry-point run into a runnable archive.
//!
//! [`crate::assemble::assemble_entry`] leaves everything in the CAS:
//! one tree per package compartment, one tree for the entry package,
//! and a compartment-map blob binding them with `cas:sha256:` tree
//! locations and `"."` dependency edges. This module is the join to
//! the XS execution half of Phase 4 of
//! `designs/endor-npm-registry-proxy.md`: it loads that map, walks
//! each compartment's CAS tree, and produces the
//! [`xsnap::archive::LoadedArchive`] the in-process XS archive
//! runner executes — no zip, no `node_modules`, no filesystem
//! layout.
//!
//! Parser classification follows Node.js semantics: `.mjs` is a
//! module, `.cjs` is commonjs, `.js` follows the package's
//! `package.json` `"type"` field (commonjs when absent), `.json` is
//! json. Known gaps, deliberately deferred: the `"module"` /
//! `"browser"` manifest fields, conditional `"exports"` maps beyond
//! a plain string or a `"."`/`default`/`import`/`require` string,
//! and cyclic `require`.

use std::collections::HashMap;
use std::io;

use crate::cas::ContentStore;
use xsnap::archive::{CompartmentMap, LoadedArchive, ModuleDescriptor};

/// File extensions loaded into the source registry. Everything else
/// in a package tree (docs, licenses, type declarations) is inert at
/// run time and stays behind in the CAS.
fn parser_for(path: &str, type_module: bool) -> Option<&'static str> {
    if path.ends_with(".mjs") {
        Some("mjs")
    } else if path.ends_with(".cjs") {
        Some("cjs")
    } else if path.ends_with(".js") {
        Some(if type_module { "mjs" } else { "cjs" })
    } else if path.ends_with(".json") {
        Some("json")
    } else {
        None
    }
}

fn invalid<E: std::fmt::Display>(what: &str, e: E) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, format!("{what}: {e}"))
}

/// Recursively collect `(relative path, blob hash)` pairs for every
/// file under a CAS tree.
fn collect_tree_files(
    cas: &ContentStore,
    tree_hash: &str,
    prefix: &str,
    out: &mut Vec<(String, String)>,
) -> io::Result<()> {
    let tree = cas.read_tree(tree_hash)?;
    let mut names: Vec<&String> = tree.entries.keys().collect();
    names.sort();
    for name in names {
        let entry = &tree.entries[name];
        let path = if prefix.is_empty() {
            name.clone()
        } else {
            format!("{prefix}/{name}")
        };
        if entry.entry_type == "tree" {
            collect_tree_files(cas, &entry.hash, &path, out)?;
        } else {
            out.push((path, entry.hash.clone()));
        }
    }
    Ok(())
}

/// Read a package's default entry specifier from its `package.json`
/// text: `"main"`, else `"exports"` (a plain string, or the `"."`
/// entry's string / `default` / `import` / `require` string), else
/// `index.js`. The returned specifier is `./`-rooted; the runtime's
/// Node-style lookup supplies `.js` / `/index.js` fallbacks.
fn default_entry(manifest: Option<&str>) -> String {
    let normalise = |main: &str| {
        let trimmed = main.trim_start_matches("./");
        format!("./{trimmed}")
    };
    if let Some(text) = manifest {
        if let Ok(doc) = serde_json::from_str::<serde_json::Value>(text) {
            if let Some(main) = doc.get("main").and_then(|v| v.as_str()) {
                return normalise(main);
            }
            if let Some(exports) = doc.get("exports") {
                if let Some(s) = exports.as_str() {
                    return normalise(s);
                }
                let dot = exports.get(".").unwrap_or(exports);
                if let Some(s) = dot.as_str() {
                    return normalise(s);
                }
                for key in ["default", "import", "require"] {
                    if let Some(s) = dot.get(key).and_then(|v| v.as_str()) {
                        return normalise(s);
                    }
                }
            }
        }
    }
    "./index.js".to_string()
}

/// Load an assembled compartment map (by CAS blob hash) into a
/// [`LoadedArchive`]: sources come from each compartment's
/// `cas:sha256:` tree, `File` descriptors are synthesised per source
/// file with Node-semantics parsers, and `"."` dependency edges are
/// bound to each target package's default entry.
pub fn load_run_archive(cas: &ContentStore, map_hash: &str) -> io::Result<LoadedArchive> {
    let map_bytes = cas.fetch(map_hash)?;
    let doc: serde_json::Value =
        serde_json::from_slice(&map_bytes).map_err(|e| invalid("compartment map", e))?;
    let mut map: CompartmentMap =
        serde_json::from_slice(&map_bytes).map_err(|e| invalid("compartment map", e))?;

    let mut sources: HashMap<(String, String), String> = HashMap::new();
    let mut entries: HashMap<String, String> = HashMap::new();

    for (comp_key, comp) in map.compartments.iter_mut() {
        let location = doc
            .get("compartments")
            .and_then(|c| c.get(comp_key))
            .and_then(|c| c.get("location"))
            .and_then(|l| l.as_str())
            .ok_or_else(|| invalid(comp_key, "compartment has no location"))?;
        let tree_hash = location
            .strip_prefix("cas:sha256:")
            .ok_or_else(|| invalid(comp_key, format!("non-CAS location {location}")))?;

        let mut files = Vec::new();
        collect_tree_files(cas, tree_hash, "", &mut files)?;

        let manifest = files
            .iter()
            .find(|(path, _)| path == "package.json")
            .map(|(_, hash)| cas.fetch(hash))
            .transpose()?
            .map(|bytes| String::from_utf8_lossy(&bytes).into_owned());
        let type_module = manifest
            .as_deref()
            .and_then(|text| serde_json::from_str::<serde_json::Value>(text).ok())
            .and_then(|doc| doc.get("type").and_then(|t| t.as_str().map(String::from)))
            .is_some_and(|t| t == "module");
        entries.insert(comp_key.clone(), default_entry(manifest.as_deref()));

        for (path, hash) in files {
            let Some(parser) = parser_for(&path, type_module) else {
                continue;
            };
            let bytes = cas.fetch(&hash)?;
            let specifier = format!("./{path}");
            // Dependency edges are bare names; source specifiers are
            // './'-rooted — the two key spaces cannot collide.
            comp.modules.insert(
                specifier.clone(),
                ModuleDescriptor::File {
                    parser: parser.to_string(),
                    location: Some(path),
                    sha512: None,
                },
            );
            sources.insert(
                (comp_key.clone(), specifier),
                String::from_utf8_lossy(&bytes).into_owned(),
            );
        }
    }

    // Bind "." dependency edges to each target's default entry.
    for comp in map.compartments.values_mut() {
        for descriptor in comp.modules.values_mut() {
            if let ModuleDescriptor::Link {
                compartment,
                module,
            } = descriptor
            {
                if module == "." {
                    if let Some(entry) = entries.get(compartment) {
                        *module = entry.clone();
                    }
                }
            }
        }
    }

    Ok(LoadedArchive { map, sources })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cas::{TreeEntry, TreeManifest};

    fn fresh_cas() -> (tempfile::TempDir, ContentStore) {
        let tmp = tempfile::tempdir().unwrap();
        let cas = ContentStore::open(tmp.path()).unwrap();
        (tmp, cas)
    }

    fn store_blob(cas: &ContentStore, data: &str) -> TreeEntry {
        let hash = cas.store(data.as_bytes(), "blob").unwrap();
        TreeEntry {
            entry_type: "blob".to_string(),
            hash,
            size: Some(data.len() as u64),
        }
    }

    fn store_tree(cas: &ContentStore, entries: Vec<(&str, TreeEntry)>) -> String {
        let manifest = TreeManifest {
            entries: entries
                .into_iter()
                .map(|(name, entry)| (name.to_string(), entry))
                .collect(),
        };
        cas.store_tree(&serde_json::to_vec(&manifest).unwrap())
            .unwrap()
    }

    fn tree_entry(hash: String) -> TreeEntry {
        TreeEntry {
            entry_type: "tree".to_string(),
            hash,
            size: None,
        }
    }

    #[test]
    fn default_entry_variants() {
        assert_eq!(default_entry(None), "./index.js");
        assert_eq!(default_entry(Some("{}")), "./index.js");
        assert_eq!(
            default_entry(Some(r#"{"main": "lib/main.js"}"#)),
            "./lib/main.js"
        );
        assert_eq!(default_entry(Some(r#"{"main": "./cli.js"}"#)), "./cli.js");
        assert_eq!(
            default_entry(Some(r#"{"exports": "./index.mjs"}"#)),
            "./index.mjs"
        );
        assert_eq!(
            default_entry(Some(r#"{"exports": {".": "./entry.js"}}"#)),
            "./entry.js"
        );
        assert_eq!(
            default_entry(Some(
                r#"{"exports": {".": {"import": "./esm.js", "require": "./cjs.js"}}}"#
            )),
            "./esm.js"
        );
        assert_eq!(default_entry(Some("not json")), "./index.js");
    }

    #[test]
    fn parser_classification_follows_node_semantics() {
        assert_eq!(parser_for("index.mjs", false), Some("mjs"));
        assert_eq!(parser_for("index.cjs", true), Some("cjs"));
        assert_eq!(parser_for("index.js", false), Some("cjs"));
        assert_eq!(parser_for("index.js", true), Some("mjs"));
        assert_eq!(parser_for("package.json", false), Some("json"));
        assert_eq!(parser_for("README.md", false), None);
    }

    /// Build the shape `assemble_entry` leaves behind — an entry
    /// tree (type module, nested source dir), a cjs dependency tree,
    /// and a compartment map with a `"."` dependency edge — and
    /// check the materialised archive: sources registered with the
    /// right parsers, the `"."` edge bound to the dependency's
    /// `main`, non-source files left behind.
    #[test]
    fn materialise_assembled_map() {
        let (_tmp, cas) = fresh_cas();

        let dep_index = store_blob(&cas, "module.exports = function (n) { return n * 2; };\n");
        let dep_manifest = store_blob(&cas, r#"{"name": "doubler", "main": "lib/double.js"}"#);
        let dep_readme = store_blob(&cas, "# doubler\n");
        let dep_lib = store_tree(&cas, vec![("double.js", dep_index)]);
        let dep_tree = store_tree(
            &cas,
            vec![
                ("lib", tree_entry(dep_lib)),
                ("package.json", dep_manifest),
                ("README.md", dep_readme),
            ],
        );

        let entry_main = store_blob(
            &cas,
            "import double from 'doubler'; export const result = double(21);\n",
        );
        let entry_manifest = store_blob(
            &cas,
            r#"{"name": "app", "type": "module", "dependencies": {"doubler": "^1.0.0"}}"#,
        );
        let entry_src = store_tree(&cas, vec![("main.js", entry_main)]);
        let entry_tree = store_tree(
            &cas,
            vec![
                ("src", tree_entry(entry_src)),
                ("package.json", entry_manifest),
            ],
        );

        let map = serde_json::json!({
            "tags": [],
            "entry": { "compartment": "<entry>", "module": "./src/main.js" },
            "compartments": {
                "<entry>": {
                    "name": "app",
                    "location": format!("cas:sha256:{entry_tree}"),
                    "modules": {
                        "doubler": { "compartment": "doubler-v1.0.0", "module": "." },
                    },
                },
                "doubler-v1.0.0": {
                    "name": "doubler",
                    "version": "1.0.0",
                    "location": format!("cas:sha256:{dep_tree}"),
                    "modules": {},
                },
            },
        });
        let map_hash = cas
            .store(&serde_json::to_vec(&map).unwrap(), "compartment-map")
            .unwrap();

        let archive = load_run_archive(&cas, &map_hash).unwrap();

        assert_eq!(archive.map.entry.module, "./src/main.js");

        // The entry package is type module: its .js sources are mjs.
        let entry_comp = &archive.map.compartments["<entry>"];
        match &entry_comp.modules["./src/main.js"] {
            ModuleDescriptor::File { parser, .. } => assert_eq!(parser, "mjs"),
            other => panic!("expected File, got {other:?}"),
        }
        // The dependency has no "type": its .js sources are cjs.
        let dep_comp = &archive.map.compartments["doubler-v1.0.0"];
        match &dep_comp.modules["./lib/double.js"] {
            ModuleDescriptor::File { parser, .. } => assert_eq!(parser, "cjs"),
            other => panic!("expected File, got {other:?}"),
        }
        // package.json is registered as json in both compartments.
        match &dep_comp.modules["./package.json"] {
            ModuleDescriptor::File { parser, .. } => assert_eq!(parser, "json"),
            other => panic!("expected File, got {other:?}"),
        }
        // The "." dependency edge is bound to the target's main.
        match &entry_comp.modules["doubler"] {
            ModuleDescriptor::Link {
                compartment,
                module,
            } => {
                assert_eq!(compartment, "doubler-v1.0.0");
                assert_eq!(module, "./lib/double.js");
            }
            other => panic!("expected Link, got {other:?}"),
        }
        // Sources carry the file text; inert files stay behind.
        assert!(
            archive.sources[&("<entry>".to_string(), "./src/main.js".to_string())]
                .contains("double(21)")
        );
        assert!(!archive
            .sources
            .contains_key(&("doubler-v1.0.0".to_string(), "./README.md".to_string())));
    }

    /// The materialised archive really executes: the entry module
    /// imports its cjs dependency through the rewritten link and the
    /// result is observable from the machine.
    #[test]
    fn materialised_archive_executes_over_xs() {
        let (_tmp, cas) = fresh_cas();

        let dep_index = store_blob(&cas, "module.exports = function (n) { return n + 1; };\n");
        let dep_manifest = store_blob(&cas, r#"{"name": "inc", "main": "index.js"}"#);
        let dep_tree = store_tree(
            &cas,
            vec![("index.js", dep_index), ("package.json", dep_manifest)],
        );

        let entry_main = store_blob(
            &cas,
            "import inc from 'inc'; export const result = inc(41);\n",
        );
        let entry_manifest = store_blob(&cas, r#"{"name": "app", "type": "module"}"#);
        let entry_tree = store_tree(
            &cas,
            vec![("main.js", entry_main), ("package.json", entry_manifest)],
        );

        let map = serde_json::json!({
            "tags": [],
            "entry": { "compartment": "<entry>", "module": "./main.js" },
            "compartments": {
                "<entry>": {
                    "name": "app",
                    "location": format!("cas:sha256:{entry_tree}"),
                    "modules": {
                        "inc": { "compartment": "inc-v1.0.0", "module": "." },
                    },
                },
                "inc-v1.0.0": {
                    "name": "inc",
                    "version": "1.0.0",
                    "location": format!("cas:sha256:{dep_tree}"),
                    "modules": {},
                },
            },
        });
        let map_hash = cas
            .store(&serde_json::to_vec(&map).unwrap(), "compartment-map")
            .unwrap();

        let archive = load_run_archive(&cas, &map_hash).unwrap();
        xsnap::run_xs_archive_loaded(&archive).unwrap();
    }

    fn single_module_map(cas: &ContentStore, source: &str) -> String {
        let entry_main = store_blob(cas, source);
        let entry_manifest = store_blob(cas, r#"{"name": "app", "type": "module"}"#);
        let entry_tree = store_tree(
            cas,
            vec![("main.js", entry_main), ("package.json", entry_manifest)],
        );
        let map = serde_json::json!({
            "tags": [],
            "entry": { "compartment": "<entry>", "module": "./main.js" },
            "compartments": {
                "<entry>": {
                    "name": "app",
                    "location": format!("cas:sha256:{entry_tree}"),
                    "modules": {},
                },
            },
        });
        cas.store(&serde_json::to_vec(&map).unwrap(), "compartment-map")
            .unwrap()
    }

    /// Real npm entry code calls console.log; the standalone runner
    /// must endow it rather than let the reference throw.
    #[test]
    fn console_log_is_endowed_in_the_run_machine() {
        let (_tmp, cas) = fresh_cas();
        let map_hash = single_module_map(
            &cas,
            "console.log('hello', 42, { a: 1 });\nconsole.error('to stderr');\nexport const done = true;\n",
        );
        let archive = load_run_archive(&cas, &map_hash).unwrap();
        xsnap::run_xs_archive_loaded(&archive).unwrap();
    }

    /// A throw in the program being run (here a ReferenceError) must
    /// come back as Err from the runner, not SIGSEGV the process.
    #[test]
    fn entry_throw_surfaces_as_error_not_crash() {
        let (_tmp, cas) = fresh_cas();
        let map_hash =
            single_module_map(&cas, "noSuchGlobal(1);\nexport const unreachable = 1;\n");
        let archive = load_run_archive(&cas, &map_hash).unwrap();
        assert!(xsnap::run_xs_archive_loaded(&archive).is_err());
    }
}
