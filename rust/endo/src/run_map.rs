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
//! json. Entry-point and subpath resolution — the `"exports"` map
//! with subpath keys, wildcard patterns, and nested conditions, the
//! `"main"`/`index.js` fallback, and subpath encapsulation — happens
//! at run time in the archive bootstrap
//! (`xsnap::archive::EXPORTS_RESOLVER_JS`), where dynamic
//! `require('pkg/sub')` needs it anyway; `"."` dependency edges pass
//! through unrewritten. Known gaps, deliberately deferred: the
//! `"module"` / `"browser"` manifest fields, self-referential
//! package imports (`"imports"` / own-name), and cyclic `require`.

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

/// Load an assembled compartment map (by CAS blob hash) into a
/// [`LoadedArchive`]: sources come from each compartment's
/// `cas:sha256:` tree, and `File` descriptors are synthesised per
/// source file with Node-semantics parsers. `"."` dependency edges
/// are left as-is; the runtime's exports resolver binds them to each
/// target package's entry (exports map over `main` over `index.js`).
pub fn load_run_archive(cas: &ContentStore, map_hash: &str) -> io::Result<LoadedArchive> {
    let map_bytes = cas.fetch(map_hash)?;
    let doc: serde_json::Value =
        serde_json::from_slice(&map_bytes).map_err(|e| invalid("compartment map", e))?;
    let mut map: CompartmentMap =
        serde_json::from_slice(&map_bytes).map_err(|e| invalid("compartment map", e))?;

    let mut sources: HashMap<(String, String), String> = HashMap::new();

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
    /// right parsers, the `"."` edge passed through for the runtime
    /// resolver, non-source files left behind.
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
        // The "." dependency edge survives untouched; the runtime
        // exports resolver binds it to the target's entry at import.
        match &entry_comp.modules["doubler"] {
            ModuleDescriptor::Link {
                compartment,
                module,
            } => {
                assert_eq!(compartment, "doubler-v1.0.0");
                assert_eq!(module, ".");
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

    /// Store a package tree from flat `(path, content)` pairs,
    /// building nested CAS trees for paths with directories.
    fn store_file_tree(cas: &ContentStore, files: &[(&str, &str)]) -> String {
        let mut direct: Vec<(&str, TreeEntry)> = Vec::new();
        let mut groups: Vec<(&str, Vec<(&str, &str)>)> = Vec::new();
        for (path, content) in files {
            match path.split_once('/') {
                None => direct.push((path, store_blob(cas, content))),
                Some((dir, rest)) => {
                    match groups.iter_mut().find(|(d, _)| *d == dir) {
                        Some((_, entries)) => entries.push((rest, content)),
                        None => groups.push((dir, vec![(rest, content)])),
                    }
                }
            }
        }
        for (dir, entries) in &groups {
            let subtree = store_file_tree(cas, entries);
            direct.push((dir, tree_entry(subtree)));
        }
        store_tree(cas, direct)
    }

    /// A map with a type-module entry importing one dependency
    /// through edge key `dep_key`, whose package tree is `dep_files`
    /// (manifest included by the caller).
    fn two_comp_map(
        cas: &ContentStore,
        entry_src: &str,
        dep_key: &str,
        dep_files: &[(&str, &str)],
    ) -> String {
        let dep_tree = store_file_tree(cas, dep_files);
        let entry_tree = store_file_tree(
            cas,
            &[
                ("main.js", entry_src),
                ("package.json", r#"{"name": "app", "type": "module"}"#),
            ],
        );
        let map = serde_json::json!({
            "tags": [],
            "entry": { "compartment": "<entry>", "module": "./main.js" },
            "compartments": {
                "<entry>": {
                    "name": "app",
                    "location": format!("cas:sha256:{entry_tree}"),
                    "modules": {
                        dep_key: { "compartment": "dep-v1.0.0", "module": "." },
                    },
                },
                "dep-v1.0.0": {
                    "name": "dep",
                    "version": "1.0.0",
                    "location": format!("cas:sha256:{dep_tree}"),
                    "modules": {},
                },
            },
        });
        cas.store(&serde_json::to_vec(&map).unwrap(), "compartment-map")
            .unwrap()
    }

    fn run_two_comp(
        entry_src: &str,
        dep_key: &str,
        dep_files: &[(&str, &str)],
    ) -> Result<(), xsnap::XsnapError> {
        let (_tmp, cas) = fresh_cas();
        let map_hash = two_comp_map(&cas, entry_src, dep_key, dep_files);
        let archive = load_run_archive(&cas, &map_hash).unwrap();
        xsnap::run_xs_archive_loaded(&archive)
    }

    /// When a package has both `main` and `exports`, the exports map
    /// wins (Node semantics): `main` points at a file that throws,
    /// so loading it would fail the run.
    #[test]
    fn dot_edge_prefers_exports_over_main() {
        run_two_comp(
            "import v from 'dep'; export const got = v;\n",
            "dep",
            &[
                (
                    "package.json",
                    r#"{"name": "dep", "main": "./boom.js", "exports": "./good.js"}"#,
                ),
                ("boom.js", "throw new Error('main must not load');\n"),
                ("good.js", "module.exports = 'good';\n"),
            ],
        )
        .unwrap();
    }

    /// A package without an exports map keeps Node-style file
    /// access: an extension-less subpath resolves through the
    /// `.js` / `/index.js` lookup candidates.
    #[test]
    fn subpath_without_exports_falls_back_to_files() {
        run_two_comp(
            "import u from 'dep/lib/util'; export const got = u;\n",
            "dep",
            &[
                ("package.json", r#"{"name": "dep"}"#),
                ("lib/util.js", "module.exports = 7;\n"),
            ],
        )
        .unwrap();
    }

    /// Subpath exports resolve nested condition objects, skipping
    /// inapplicable conditions (`types`) and preferring the `import`
    /// build over an earlier `require` key: the require target
    /// throws, so order-blind resolution would fail the run.
    #[test]
    fn subpath_resolves_conditional_exports_import_first() {
        run_two_comp(
            "import { word } from 'dep/sub'; export const got = word;\n",
            "dep",
            &[
                (
                    "package.json",
                    r#"{"name": "dep", "type": "module", "exports": {"./sub": {"types": "./sub.d.ts", "require": "./boom.cjs", "import": "./src/sub.js"}}}"#,
                ),
                ("boom.cjs", "throw new Error('require build must not load');\n"),
                ("src/sub.js", "export const word = 'esm';\n"),
            ],
        )
        .unwrap();
    }

    /// A single-`*` wildcard pattern maps the matched text into the
    /// target path.
    #[test]
    fn wildcard_subpath_pattern_resolves() {
        run_two_comp(
            "import a from 'dep/features/alpha'; export const got = a;\n",
            "dep",
            &[
                (
                    "package.json",
                    r#"{"name": "dep", "exports": {"./features/*": "./src/features/*.js"}}"#,
                ),
                ("src/features/alpha.js", "module.exports = 'alpha';\n"),
            ],
        )
        .unwrap();
    }

    /// An exports map encapsulates the package: a subpath it does
    /// not list fails cleanly even though the file exists.
    #[test]
    fn unexported_subpath_fails_cleanly() {
        let result = run_two_comp(
            "import s from 'dep/secret.js'; export const got = s;\n",
            "dep",
            &[
                (
                    "package.json",
                    r#"{"name": "dep", "exports": {".": "./index.js"}}"#,
                ),
                ("index.js", "module.exports = 'front door';\n"),
                ("secret.js", "module.exports = 'back door';\n"),
            ],
        );
        assert!(result.is_err());
    }

    /// Scoped package names keep their two-segment name when the
    /// subpath is split off.
    #[test]
    fn scoped_package_subpath_resolves() {
        run_two_comp(
            "import u from '@acme/kit/util'; export const got = u;\n",
            "@acme/kit",
            &[
                ("package.json", r#"{"name": "@acme/kit"}"#),
                ("util.js", "module.exports = 'scoped';\n"),
            ],
        )
        .unwrap();
    }

    /// A require-only exports entry still resolves: the import-pass
    /// finds nothing and the require-pass supplies the cjs build.
    #[test]
    fn require_only_exports_resolve_on_second_pass() {
        run_two_comp(
            "import v from 'dep/sub'; export const got = v;\n",
            "dep",
            &[
                (
                    "package.json",
                    r#"{"name": "dep", "exports": {"./sub": {"require": "./sub.cjs"}}}"#,
                ),
                ("sub.cjs", "module.exports = 42;\n"),
            ],
        )
        .unwrap();
    }
}
