//! Dependency walk for `endor run <entry.js>` (Phase 5 of
//! `designs/endor-run-expanded.md`).
//!
//! When the entry-point form encounters a statically discoverable ES module
//! or CommonJS edge, this module walks the dependency graph from
//! the entry file. Each discovered file becomes a module within
//! its enclosing compartment; each bare specifier (`"lodash"`,
//! `"@scope/pkg"`, `"@scope/pkg/sub"`) resolves to a package in
//! a `node_modules` directory upward from the importing file,
//! becoming its own compartment in the synthesised
//! compartment-map.
//!
//! Phase 4 (`crate::cas_archive::ingest_entry_point`) handles the
//! no-dependency case as a synthesised one-compartment archive.
//! Phase 5 supersedes Phase 4 *when imports are present*; Phase 4
//! remains the fast path for the import-free case (and the
//! verified contract `cas_is_unchanged_after_rejected_ingest`,
//! `ingest_entry_point_run_path_matches_zip_run_path`, etc.,
//! still hold). The CLI dispatch picks between the two: an entry
//! whose import/require scans return no specifiers and no opaque dynamic
//! import is routed to [`crate::cas_archive::ingest_entry_point`]; an entry
//! with one or more importable specifiers, or an expression-valued
//! `import()`, is routed to [`ingest_entry_point_with_deps`].
//!
//! ### Scope deviations from the design's Option B
//!
//! The design (`designs/endor-run-expanded.md` § Compartment
//! mapper implementation) names an *XS-hosted compartment mapper*
//! bundle as the chosen near-term approach (Option B). That
//! approach requires (a) bundling `@endo/compartment-mapper` for
//! XS execution, (b) wiring filesystem host powers into a fresh
//! mapper machine, (c) running a two-machine handshake to capture
//! the mapper's CompartmentMap output before the execution
//! machine boots. The infrastructure for (a)-(c) is shared with
//! the daemon-side XS bundles and is not yet present in this
//! crate.
//!
//! This module ships the design's Option A (a *Rust-native
//! mapper*) for the Phase 5 acceptance test ("`endor run app.js`
//! where `app.js` imports from a local `node_modules` package").
//! Option A and Option B converge on the same CompartmentMap
//! shape for the cases this module handles (static and literal-dynamic ES
//! module imports, CommonJS `require()` / literal `require.resolve()` edges,
//! `node_modules`-resolved bare specifiers, plain
//! `package.json` `main`/`exports.default`/`./index.js`
//! resolution); the design's deviation pattern from Phase 4 is
//! re-applied here. The XS-hosted mapper bundle remains
//! warranted whenever the dependency graph requires features that the
//! Rust-native walk does not implement (including the registry-table path
//! from `designs/endor-npm-registry-proxy.md` Phase 4). For an
//! expression-valued dynamic import, this mapper retains every enabled
//! declared dependency even though it cannot enumerate the runtime-selected
//! module statically.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::ffi::OsStr;
use std::fmt;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use sha2::{Digest, Sha256};

use crate::cas::{ContentStore, TreeEntry, TreeManifest};
use crate::cas_archive::{
    ingest_entry_point, load_archive_from_cas, parser_for_extension, IngestedArchive,
    SYNTHETIC_COMPARTMENT_ID,
};

// Public API

/// Static-import scan result for a single source file.
///
/// Static edges and statically analyzable dynamic `import()` edges are
/// reported separately. A dynamic edge is analyzable when its first
/// argument is a string literal; expression-valued specifiers are marked so
/// callers can retain the package's declared dependency graph for runtime.
///
/// The deduplication discipline: callers receive each unique
/// specifier once in source-occurrence order, so a downstream
/// emitter that depends on a stable specifier order (the
/// per-compartment `modules` map below, for instance) gets
/// reproducible output for a given source byte sequence.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct ScannedImports {
    pub specifiers: Vec<String>,
    pub dynamic_specifiers: Vec<String>,
    /// Whether the source contains an expression-valued `import()` whose
    /// target cannot be discovered statically. In that case, the package's
    /// declared dependency graph must remain available for runtime lookup.
    pub has_opaque_dynamic_import: bool,
}

/// Source text supplied by an [`ExitModuleImportHook`].
///
/// Endor's XS archive loader hosts ECMAScript source text. The parser name is
/// nevertheless explicit so callers can describe the same source-language
/// boundary as compartment-mapper. Unsupported parser names fail ingestion at
/// the hook boundary rather than surfacing later as a runtime module-not-found
/// error.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SyntheticModuleSource {
    pub source: String,
    pub parser: String,
}

impl SyntheticModuleSource {
    /// Construct an ECMAScript synthetic module.
    pub fn new(source: impl Into<String>) -> Self {
        Self {
            source: source.into(),
            parser: "mjs".to_string(),
        }
    }

    /// Construct a synthetic module with an explicit parser language.
    pub fn with_parser(source: impl Into<String>, parser: impl Into<String>) -> Self {
        Self {
            source: source.into(),
            parser: parser.into(),
        }
    }
}

/// Context supplied to an [`ExitModuleImportHook`].
#[derive(Debug, Clone, Copy)]
pub struct ExitModuleImport<'a> {
    /// The non-file specifier requested by the source module.
    pub specifier: &'a str,
    /// The source file whose import reached the hook.
    pub importer_path: &'a Path,
    /// The importing package's human-readable compartment name.
    pub compartment_name: &'a str,
}

/// Synchronous equivalent of compartment-mapper's `exitModuleImportHook`.
///
/// `Ok(Some(source))` supplies a synthetic module, `Ok(None)` declines the
/// request and preserves the walker's ordinary resolution/error behavior, and
/// `Err` stops ingestion at the hook boundary.
pub type ExitModuleImportHook = Arc<
    dyn for<'a> Fn(ExitModuleImport<'a>) -> io::Result<Option<SyntheticModuleSource>> + Send + Sync,
>;

/// Where a [`ModuleSource`] originated.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModuleSourceOrigin<'a> {
    File { path: &'a Path },
    SyntheticExit { specifier: &'a str },
}

/// A module source observed during the dependency walk.
#[derive(Debug, Clone, Copy)]
pub struct ModuleSource<'a> {
    pub compartment_name: &'a str,
    pub specifier: &'a str,
    pub parser: &'a str,
    pub bytes: &'a [u8],
    pub origin: ModuleSourceOrigin<'a>,
}

/// Synchronous, observational equivalent of compartment-mapper's
/// `moduleSourceHook`.
///
/// The hook sees both filesystem and synthetic exit sources. It cannot mutate
/// the source; an error stops ingestion before an archive can be executed.
pub type ModuleSourceHook = Arc<dyn for<'a> Fn(ModuleSource<'a>) -> io::Result<()> + Send + Sync>;

/// Walk static imports starting from `entry_path`, ingest every
/// reachable source into the CAS, and return an
/// [`IngestedArchive`] whose `compartment-map.json` describes the
/// full graph.
///
/// Acceptance shape (per the design's Phase 5 test):
///
/// - The entry compartment holds the entry file plus every
///   relative-import-reachable sibling within the same package.
/// - Each `node_modules`-resolved bare specifier becomes its own
///   compartment; its modules and any transitively imported
///   siblings are stored under the package's compartment id
///   (`<pkg-name>-v<version>`, with the version pulled from the
///   package's `package.json` `version` field, falling back to
///   `0.0.0` when absent).
/// - Cross-compartment references are encoded as
///   [`xsnap::archive::ModuleDescriptor::Link`] entries in the
///   importing compartment, so the import hook installed by
///   [`xsnap::archive::install_archive`] routes them via
///   `importNow` on the target compartment.
///
/// Out of scope (returns an `Err` with a descriptive message):
///
/// - A bare specifier that resolves to no `node_modules` tree
///   upward from the importing file.
/// - A package whose `exports`/`main`/`index.js` resolution
///   yields no readable source file.
/// - A subpath import (`"@scope/pkg/lib/foo.js"`) that escapes
///   the resolved package's tree.
///
/// All other failure modes propagate the underlying `io::Error`
/// (a missing source file, a CAS write error, a `package.json`
/// JSON-parse error mapped to `InvalidData`).
pub fn ingest_entry_point_with_deps(
    cas: &ContentStore,
    entry_path: &Path,
) -> io::Result<IngestedArchive> {
    ingest_entry_point_with_deps_with_options(cas, entry_path, &WalkOptions::default())
}

/// Ingest an entry point through the same fast-path dispatch used by
/// `endor run --node-modules`.
///
/// Import-free entries retain the original one-compartment ingest path;
/// entries with a statically discoverable edge use the dependency walker.
/// Call [`ingest_entry_point_for_run_with_options`] when supplying host hooks
/// or other emulated walker options.
pub fn ingest_entry_point_for_run(
    cas: &ContentStore,
    entry_path: &Path,
) -> io::Result<IngestedArchive> {
    let has_imports = match std::fs::read_to_string(entry_path) {
        Ok(source) => {
            let scanned_imports = scan_static_imports(&source);
            !scanned_imports.specifiers.is_empty()
                || !scanned_imports.dynamic_specifiers.is_empty()
                || scanned_imports.has_opaque_dynamic_import
                || !scan_cjs_requires(&source).is_empty()
        }
        // Preserve the CLI's existing behavior: the simple ingest path owns
        // the diagnostic for unreadable or non-text entry files.
        Err(_) => false,
    };

    if has_imports {
        ingest_entry_point_with_deps(cas, entry_path)
    } else {
        ingest_entry_point(cas, entry_path)
    }
}

/// Options-aware public seam for an `endor run` entry-point ingest.
///
/// Unlike [`ingest_entry_point_for_run`], this always uses the dependency
/// walker so hooks observe an import-free entry source too. The returned
/// archive is ready for [`xsnap::run_xs_archive_loaded`].
pub fn ingest_entry_point_for_run_with_options(
    cas: &ContentStore,
    entry_path: &Path,
    options: &WalkOptions,
) -> io::Result<IngestedArchive> {
    ingest_entry_point_with_deps_with_options(cas, entry_path, options)
}

/// The set of default `exports`/`imports` build conditions the walker
/// resolves against, mirroring `@endo/compartment-mapper`'s
/// `node-modules.js` (`conditions.add('import'); .add('default');
/// .add('endo')`). The parity harness supplies additional per-fixture
/// conditions (e.g. `endo:lib`, `development`) on top of these.
pub fn default_conditions() -> BTreeSet<String> {
    ["import", "default", "endo"]
        .iter()
        .map(|s| s.to_string())
        .collect()
}

/// Options that emulate the compartment-mapper harness inputs a fixture
/// is driven with, so a parity comparison is apples-to-apples (see
/// `designs/endor-run-expanded.md` § Fixture-parity ratchet).
///
/// These inputs are *emulated*, never refactored away: the same values
/// are supplied to the node reference oracle
/// (`rust/endo/tools/gen-parity-golden.mjs`) and to this walker.
#[derive(Clone)]
pub struct WalkOptions {
    /// `exports`/`imports` conditions used to select conditional
    /// package entry points (e.g. `endo:lib` for
    /// `fixtures-conditional-host-exports`, `development` to admit the
    /// entry package's `devDependencies` for `fixtures-0`). The
    /// [`default_conditions`] are always present in addition.
    pub conditions: BTreeSet<String>,
    /// Bare specifiers declared as host/exit modules (compartment-mapper's
    /// `modules: { <name>: true }` option — e.g. `builtin` in
    /// `fixtures-0`). A reached import of one is recorded as an
    /// `{ exit }` module rather than walked from disk.
    pub exit_modules: BTreeSet<String>,
    /// Whether the entry package's `devDependencies` participate in
    /// dependency resolution. This never propagates to dependency packages:
    /// their development-only edges are excluded, matching
    /// `@endo/compartment-mapper`'s `dev` option.
    pub dev: bool,
    /// Whether the `browser` resolve field is honoured (compartment-mapper's
    /// `browser` build condition — `fixtures-resolve`). When set, a
    /// package's `browser` field remaps both relative and bare specifiers,
    /// and overrides the package main. See [`PackageMetadata::browser`].
    pub browser: bool,
    /// Common dependencies injected into every package's resolution scope
    /// (compartment-mapper's `commonDependencies` option —
    /// `fixtures-common-deps`). Maps an *alias* specifier to the name of a
    /// dependency of the entry package; a reached import of the alias
    /// resolves to that dependency's installed package, from any package in
    /// the graph, regardless of whether the importer declares it.
    pub common_dependencies: BTreeMap<String, String>,
    /// Emulated `languageForExtension` registrations (compartment-mapper's
    /// `languageForExtension` option — `fixtures-language-for-extension`).
    /// Maps a file extension to the language a matching module parses as
    /// (`xsonp` -> `jsonp`). A package-local `"parsers"` map overrides this;
    /// the built-in defaults (`text`, `bytes`, ...) apply beneath it. Supplied
    /// identically to the node reference oracle so the parity comparison is
    /// apples-to-apples (design §2, Group E — "the asset IS the fixture").
    pub language_for_extension: BTreeMap<String, String>,
    /// Equivalent of compartment-mapper's `exitModuleImportHook`, consulted
    /// for scheme specifiers, declared exits, missing packages, and imports
    /// excluded by dependency classification.
    pub exit_module_import_hook: Option<ExitModuleImportHook>,
    /// Equivalent of compartment-mapper's `moduleSourceHook`, called for each
    /// filesystem or synthetic source accepted into the walk.
    pub module_source_hook: Option<ModuleSourceHook>,
}

impl fmt::Debug for WalkOptions {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("WalkOptions")
            .field("conditions", &self.conditions)
            .field("exit_modules", &self.exit_modules)
            .field("dev", &self.dev)
            .field("browser", &self.browser)
            .field("common_dependencies", &self.common_dependencies)
            .field("language_for_extension", &self.language_for_extension)
            .field(
                "exit_module_import_hook",
                &self.exit_module_import_hook.is_some(),
            )
            .field("module_source_hook", &self.module_source_hook.is_some())
            .finish()
    }
}

impl Default for WalkOptions {
    fn default() -> Self {
        WalkOptions {
            conditions: default_conditions(),
            exit_modules: BTreeSet::new(),
            dev: false,
            browser: false,
            common_dependencies: BTreeMap::new(),
            language_for_extension: BTreeMap::new(),
            exit_module_import_hook: None,
            module_source_hook: None,
        }
    }
}

impl WalkOptions {
    /// Build options from an explicit set of *extra* conditions (added
    /// to [`default_conditions`]) and a set of host/exit module names.
    pub fn new<I, J>(extra_conditions: I, exit_modules: J) -> Self
    where
        I: IntoIterator<Item = String>,
        J: IntoIterator<Item = String>,
    {
        let mut conditions = default_conditions();
        conditions.extend(extra_conditions);
        // compartment-mapper treats the `development` condition as an
        // alias for `dev: true` on the entry package.
        let dev = conditions.contains("development");
        let browser = conditions.contains("browser");
        WalkOptions {
            conditions,
            exit_modules: exit_modules.into_iter().collect(),
            dev,
            browser,
            common_dependencies: BTreeMap::new(),
            language_for_extension: BTreeMap::new(),
            exit_module_import_hook: None,
            module_source_hook: None,
        }
    }

    /// Install an exit-module hook.
    pub fn with_exit_module_import_hook<F>(mut self, hook: F) -> Self
    where
        F: for<'a> Fn(ExitModuleImport<'a>) -> io::Result<Option<SyntheticModuleSource>>
            + Send
            + Sync
            + 'static,
    {
        self.exit_module_import_hook = Some(Arc::new(hook));
        self
    }

    /// Install a module-source observation hook.
    pub fn with_module_source_hook<F>(mut self, hook: F) -> Self
    where
        F: for<'a> Fn(ModuleSource<'a>) -> io::Result<()> + Send + Sync + 'static,
    {
        self.module_source_hook = Some(Arc::new(hook));
        self
    }
}

/// Like [`ingest_entry_point_with_deps`], but resolving conditional and
/// subpath `exports`/`imports` against the supplied [`WalkOptions`]
/// (condition set and host/exit-module set). The zero-argument wrapper
/// above passes [`WalkOptions::default`].
pub fn ingest_entry_point_with_deps_with_options(
    cas: &ContentStore,
    entry_path: &Path,
    options: &WalkOptions,
) -> io::Result<IngestedArchive> {
    if !entry_path.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            format!("not a regular file: {}", entry_path.display()),
        ));
    }

    // Validate the extension up-front (the language is refined below,
    // once the entry package's `type` is known, so a `.js` entry under
    // a `"type": "commonjs"` package is scanned for `require()` edges). A
    // built-in JS/JSON extension always qualifies; an extension named by the
    // emulated `languageForExtension` (a custom asset entry like `.xsonp`)
    // also qualifies — its precise language is resolved below against the
    // entry package's `"parsers"` and the emulated map.
    let entry_ext_supported = parser_for_extension(entry_path.extension()).is_some()
        || entry_path
            .extension()
            .and_then(OsStr::to_str)
            .map(|ext| {
                options
                    .language_for_extension
                    .contains_key(&ext.to_ascii_lowercase())
            })
            .unwrap_or(false);
    if !entry_ext_supported {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "unsupported entry-point extension: {} (expected .js, .mjs, .cjs, .json)",
                entry_path.display()
            ),
        ));
    }

    let entry_abs = entry_path.canonicalize()?;
    let entry_directory = entry_abs
        .parent()
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("entry path has no parent: {}", entry_path.display()),
            )
        })?
        .to_path_buf();

    // The entry compartment is rooted at the entry's directory.
    // For an entry with a sibling `package.json`, the package
    // metadata is read to discover the canonical compartment id
    // (`<name>-v<version>`); otherwise we synthesise one with the
    // Phase 4 placeholder id (`entry-v1.0.0`) so the entry
    // compartment is observably the same shape as Phase 4's
    // synthetic archive.
    let entry_pkg = load_package_metadata(&entry_directory).ok();
    let entry_compartment_base_id = match &entry_pkg {
        Some(pkg) => compartment_id_for(&pkg.name, &pkg.version),
        None => SYNTHETIC_COMPARTMENT_ID.to_string(),
    };
    let entry_compartment_name = entry_pkg
        .as_ref()
        .map(|p| p.name.clone())
        .unwrap_or_else(|| "entry".to_string());
    // The entry's `version`, used to compute its final `<name>-v<version>`
    // id. A synthetic entry (no sibling `package.json`) keeps the Phase 4
    // placeholder version so its id stays `entry-v1.0.0`.
    let entry_compartment_version = entry_pkg
        .as_ref()
        .map(|p| p.version.clone())
        .unwrap_or_else(|| "1.0.0".to_string());
    // A top-level `.js` entry with no `package.json` (or one that does not
    // declare `"type": "commonjs"`) is treated as an ES module — the
    // `endor run app.js` contract. An entry under `node_modules` uses the
    // stricter compartment-mapper package rule, so a type-less fixture app
    // is CommonJS just like any other dependency package.
    let entry_is_inside_node_modules = entry_abs
        .components()
        .any(|component| component.as_os_str() == OsStr::new("node_modules"));
    let entry_is_module = entry_pkg
        .as_ref()
        .map(|package| {
            if entry_is_inside_node_modules {
                package.js_is_module()
            } else {
                !package.is_commonjs
            }
        })
        .unwrap_or(true);

    let mut walker = Walker::new(cas, options.clone());
    walker.resolve_common_dependencies(&entry_directory);
    let entry_compartment_id = walker.add_compartment(
        entry_compartment_base_id,
        entry_compartment_name,
        entry_compartment_version,
        entry_directory.clone(),
        entry_is_module,
        options.dev,
    );

    // Classify the entry now that its package `type` is known: a `.js`
    // entry in a CommonJS package is scanned for `require()`, not
    // `import`; a custom-extension asset entry (`.xsonp`) is classified
    // against the entry package's `"parsers"` and the emulated
    // `languageForExtension`.
    let entry_parser = walker
        .language_for_module(&entry_abs, &entry_compartment_id)
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                format!(
                    "unsupported entry-point extension: {} (expected .js, .mjs, .cjs, .json, \
                     or an extension registered via languageForExtension / package \"parsers\")",
                    entry_path.display()
                ),
            )
        })?;

    let entry_file_name = entry_abs
        .file_name()
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("entry path has no file name: {}", entry_path.display()),
            )
        })?
        .to_string_lossy()
        .into_owned();
    let entry_specifier = format!("./{entry_file_name}");

    walker.enqueue_file(
        entry_compartment_id.clone(),
        entry_specifier.clone(),
        entry_abs.clone(),
        entry_parser.to_string(),
    );

    walker.drain()?;

    // Assign final compartment ids now the whole graph is known, so
    // duplicate name/version copies are disambiguated (`<base>-n<k>`) the
    // way `@endo/compartment-mapper` numbers them.
    let final_ids = walker.final_ids(&entry_compartment_id);
    let map_json = walker.emit_map_json(&entry_compartment_id, &entry_specifier, &final_ids);
    let root_hash = walker.write_root_tree(&map_json, &final_ids)?;
    let archive = load_archive_from_cas(cas, &root_hash)?;

    Ok(IngestedArchive { root_hash, archive })
}

/// Scan `source` for ES-module static import specifiers.
///
/// Recognised forms (per the
/// `import-statement-static-syntax` subset of the ECMAScript
/// module grammar):
///
/// - `import "x"`
/// - `import foo from "x"`
/// - `import * as foo from "x"`
/// - `import { a, b as c } from "x"`
/// - `import foo, { a } from "x"`
/// - `export * from "x"`
/// - `export { a } from "x"`
/// - `export * as foo from "x"`
///
/// Both single- and double-quoted specifiers are supported. The
/// scan is character-stream based and intentionally permissive:
/// it skips JS line and block comments and skips over template-
/// literal and regular string literals so a string `"import
/// 'x'"` inside a JS literal is not falsely matched. The
/// downstream walk's resolver rejects anything that isn't a real
/// file, so any remaining false-positive specifier is caught at
/// resolution time rather than producing a malformed compartment
/// map.
pub fn scan_static_imports(source: &str) -> ScannedImports {
    let mut out = ScannedImports::default();
    let mut seen = std::collections::HashSet::new();

    let bytes = source.as_bytes();
    let mut i = 0usize;
    let mut at_stmt_start = true;
    // Whether a `/` here opens a regex literal (true) or is division
    // (false), tracked from the previous significant token.
    let mut regex_allowed = true;
    while i < bytes.len() {
        let c = bytes[i];

        // Skip whitespace.
        if c.is_ascii_whitespace() {
            if c == b'\n' {
                at_stmt_start = true;
            }
            i += 1;
            continue;
        }

        // Skip line comment.
        if c == b'/' && i + 1 < bytes.len() && bytes[i + 1] == b'/' {
            while i < bytes.len() && bytes[i] != b'\n' {
                i += 1;
            }
            continue;
        }

        // Skip block comment.
        if c == b'/' && i + 1 < bytes.len() && bytes[i + 1] == b'*' {
            i += 2;
            while i + 1 < bytes.len() && !(bytes[i] == b'*' && bytes[i + 1] == b'/') {
                i += 1;
            }
            if i + 1 < bytes.len() {
                i += 2;
            }
            continue;
        }

        // Skip a regex literal so its body (which may contain `"`, `'`,
        // or `//`) is not misread as a string or comment — which would
        // silently swallow a following import statement.
        if c == b'/' && regex_allowed {
            i = skip_regex_literal(bytes, i);
            regex_allowed = false;
            at_stmt_start = false;
            continue;
        }

        // Skip string literal (single, double, or template).
        if c == b'"' || c == b'\'' || c == b'`' {
            let quote = c;
            i += 1;
            while i < bytes.len() && bytes[i] != quote {
                if bytes[i] == b'\\' && i + 1 < bytes.len() {
                    i += 2;
                    continue;
                }
                // For template literals, skip ${ ... } expressions
                // shallowly (don't track nested braces; templates
                // inside templates would slip through, but the
                // import-scan only needs to avoid mis-identifying
                // their contents).
                if quote == b'`' && bytes[i] == b'$' && i + 1 < bytes.len() && bytes[i + 1] == b'{'
                {
                    let mut depth = 1;
                    i += 2;
                    while i < bytes.len() && depth > 0 {
                        if bytes[i] == b'{' {
                            depth += 1;
                        } else if bytes[i] == b'}' {
                            depth -= 1;
                        }
                        i += 1;
                    }
                    continue;
                }
                i += 1;
            }
            if i < bytes.len() {
                i += 1;
            }
            // Resume at the same statement-start state we had on
            // entry; a string literal does not begin a new
            // statement on its own.
            regex_allowed = false;
            continue;
        }

        // `;` and `}` terminate the current statement; the next
        // token may start a new one.
        if c == b';' || c == b'}' {
            at_stmt_start = true;
            regex_allowed = true;
            i += 1;
            continue;
        }

        // Only look for `import` / `export` at statement starts.
        // The conservative rule is that `import` and `export`
        // can only begin a statement; an `import.meta` reference
        // appears after an identifier-context dot which we exclude
        // by the `at_stmt_start` gate plus the `import.meta` /
        // `import(` recognition below.
        let is_import = at_stmt_start && matches_keyword(bytes, i, b"import");
        let is_export = at_stmt_start && matches_keyword(bytes, i, b"export");
        if is_import || is_export {
            let keyword_len = if is_import { 6 } else { 7 };
            // Look at the next non-whitespace character to filter
            // out `import.meta` / `import(...)`.
            let mut j = i + keyword_len;
            while j < bytes.len() && (bytes[j] == b' ' || bytes[j] == b'\t') {
                j += 1;
            }
            if is_import && j < bytes.len() && (bytes[j] == b'.' || bytes[j] == b'(') {
                // Not a statement we follow.
                i = j + 1;
                at_stmt_start = false;
                regex_allowed = true;
                continue;
            }
            // Scan forward to the end of the statement (`;` or
            // `\n` outside of nested braces/strings).
            let stmt_end = find_statement_end(bytes, j);
            let body = &source[j..stmt_end];
            // For an `export` statement, only the re-export form
            // (`export ... from "..."` / `export * from "..."`)
            // carries a specifier we follow. A plain `export
            // function ...`, `export const ...`, etc., is a local
            // declaration whose body may contain string literals
            // that have nothing to do with imports.
            if is_export && !contains_from_keyword(body.as_bytes()) {
                i = stmt_end;
                at_stmt_start = false;
                regex_allowed = true;
                continue;
            }
            // Within the statement, capture the *last* quoted
            // string literal (single- or double-quoted; not
            // template). That is the specifier — but first trim any
            // import-attributes clause (`with { type: "json" }` /
            // legacy `assert { ... }`) whose attribute value would
            // otherwise be mistaken for the specifier.
            let body = strip_import_attributes(body);
            if let Some(spec) = find_last_string_literal(body) {
                if seen.insert(spec.clone()) {
                    out.specifiers.push(spec);
                }
            }
            i = stmt_end;
            at_stmt_start = false;
            regex_allowed = true;
            continue;
        }

        // Any other token: the next character is not a statement
        // start.
        at_stmt_start = false;
        regex_allowed = !ends_value_expression(c);
        i += 1;
    }

    let dynamic_imports = scan_dynamic_imports_detailed(source);
    out.dynamic_specifiers = dynamic_imports.specifiers;
    out.has_opaque_dynamic_import = dynamic_imports.has_opaque;
    out
}

/// True when `bytes[i..i+kw.len()]` equals `kw` *and* the byte
/// before `i` (if any) is not an identifier continuation and the
/// byte at `i+kw.len()` (if any) is not an identifier continuation.
/// This lets us recognise `import` as a keyword without matching
/// the substring inside `myimport` or `importer`.
fn matches_keyword(bytes: &[u8], i: usize, kw: &[u8]) -> bool {
    if i + kw.len() > bytes.len() {
        return false;
    }
    if &bytes[i..i + kw.len()] != kw {
        return false;
    }
    if i > 0 && is_ident_continue(bytes[i - 1]) {
        return false;
    }
    if i + kw.len() < bytes.len() && is_ident_continue(bytes[i + kw.len()]) {
        return false;
    }
    true
}

fn is_ident_continue(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_' || b == b'$'
}

/// A byte that ends a *value* expression, after which a `/` is division
/// rather than the start of a regular-expression literal. The hand-rolled
/// scanners use this to disambiguate regex-vs-division so a regex body
/// (which may contain `"`, `'`, or `//`) is never misread as a string or
/// comment — a misread would silently swallow a following import/require,
/// a false negative. Heuristic per the ECMAScript lexical grammar's
/// division/regex ambiguity: `/` is division after an identifier or
/// number, `)`, or `]`; otherwise it opens a regex literal.
fn ends_value_expression(b: u8) -> bool {
    is_ident_continue(b) || b == b')' || b == b']'
}

/// Skip a regular-expression literal whose opening `/` is at `bytes[i]`,
/// returning the index just past the literal and any trailing flags. A `/`
/// inside a `[...]` character class does not terminate the literal, and
/// `\`-escapes are honoured. An unterminated literal (newline before the
/// closing `/`) stops at the newline rather than running away.
fn skip_regex_literal(bytes: &[u8], i: usize) -> usize {
    let mut j = i + 1;
    let mut in_class = false;
    while j < bytes.len() {
        let c = bytes[j];
        if c == b'\\' {
            j += 2;
            continue;
        }
        if c == b'\n' {
            return j;
        }
        if in_class {
            if c == b']' {
                in_class = false;
            }
            j += 1;
            continue;
        }
        match c {
            b'[' => in_class = true,
            b'/' => {
                j += 1;
                while j < bytes.len() && is_ident_continue(bytes[j]) {
                    j += 1;
                }
                return j;
            }
            _ => {}
        }
        j += 1;
    }
    j
}

/// True when `bytes` contains the standalone keyword `from`
/// (surrounded by non-identifier characters) outside of any
/// string literal or comment. Used to discriminate
/// `export ... from "..."` (a re-export specifier) from local
/// `export function`/`export const` declarations whose bodies
/// may contain unrelated quoted strings.
fn contains_from_keyword(bytes: &[u8]) -> bool {
    let mut i = 0usize;
    while i < bytes.len() {
        let c = bytes[i];
        if c == b'"' || c == b'\'' || c == b'`' {
            let q = c;
            i += 1;
            while i < bytes.len() && bytes[i] != q {
                if bytes[i] == b'\\' && i + 1 < bytes.len() {
                    i += 2;
                    continue;
                }
                i += 1;
            }
            if i < bytes.len() {
                i += 1;
            }
            continue;
        }
        if c == b'/' && i + 1 < bytes.len() && bytes[i + 1] == b'/' {
            while i < bytes.len() && bytes[i] != b'\n' {
                i += 1;
            }
            continue;
        }
        if c == b'/' && i + 1 < bytes.len() && bytes[i + 1] == b'*' {
            i += 2;
            while i + 1 < bytes.len() && !(bytes[i] == b'*' && bytes[i + 1] == b'/') {
                i += 1;
            }
            if i + 1 < bytes.len() {
                i += 2;
            }
            continue;
        }
        if matches_keyword(bytes, i, b"from") {
            return true;
        }
        i += 1;
    }
    false
}

/// Trim a static `import`/`export` statement body at an import-attributes
/// clause — `with { type: "json" }` (and the legacy `assert { ... }`) — so
/// the specifier extraction below cannot mistake an attribute *value*
/// (e.g. `"json"`) for the module specifier. In the grammar the attributes
/// clause always follows the specifier string, so truncating at the
/// top-level `with`/`assert` keyword leaves the specifier as the last
/// quoted literal. Strings and comments are skipped so a `with` inside a
/// literal or comment does not trigger the cut.
fn strip_import_attributes(body: &str) -> &str {
    let bytes = body.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() {
        let c = bytes[i];
        if c == b'"' || c == b'\'' || c == b'`' {
            let q = c;
            i += 1;
            while i < bytes.len() && bytes[i] != q {
                if bytes[i] == b'\\' && i + 1 < bytes.len() {
                    i += 2;
                    continue;
                }
                i += 1;
            }
            if i < bytes.len() {
                i += 1;
            }
            continue;
        }
        if c == b'/' && i + 1 < bytes.len() && bytes[i + 1] == b'/' {
            while i < bytes.len() && bytes[i] != b'\n' {
                i += 1;
            }
            continue;
        }
        if c == b'/' && i + 1 < bytes.len() && bytes[i + 1] == b'*' {
            i += 2;
            while i + 1 < bytes.len() && !(bytes[i] == b'*' && bytes[i + 1] == b'/') {
                i += 1;
            }
            if i + 1 < bytes.len() {
                i += 2;
            }
            continue;
        }
        if matches_keyword(bytes, i, b"with") || matches_keyword(bytes, i, b"assert") {
            let kw_len = if bytes[i] == b'w' { 4 } else { 6 };
            // Only treat this as an attributes clause when a `{` follows
            // (after optional whitespace); a bare `with`/`assert` elsewhere
            // is left alone.
            let mut j = i + kw_len;
            while j < bytes.len() && (bytes[j] == b' ' || bytes[j] == b'\t' || bytes[j] == b'\n') {
                j += 1;
            }
            if j < bytes.len() && bytes[j] == b'{' {
                return &body[..i];
            }
        }
        i += 1;
    }
    body
}

/// Find the byte index of the end of the current import/export
/// statement (`;` or newline at brace-depth zero, skipping
/// strings and comments).
fn find_statement_end(bytes: &[u8], mut i: usize) -> usize {
    let mut depth = 0i32;
    while i < bytes.len() {
        let c = bytes[i];
        // String literal: skip.
        if c == b'"' || c == b'\'' || c == b'`' {
            let q = c;
            i += 1;
            while i < bytes.len() && bytes[i] != q {
                if bytes[i] == b'\\' && i + 1 < bytes.len() {
                    i += 2;
                    continue;
                }
                i += 1;
            }
            if i < bytes.len() {
                i += 1;
            }
            continue;
        }
        if c == b'/' && i + 1 < bytes.len() && bytes[i + 1] == b'/' {
            while i < bytes.len() && bytes[i] != b'\n' {
                i += 1;
            }
            continue;
        }
        if c == b'/' && i + 1 < bytes.len() && bytes[i + 1] == b'*' {
            i += 2;
            while i + 1 < bytes.len() && !(bytes[i] == b'*' && bytes[i + 1] == b'/') {
                i += 1;
            }
            if i + 1 < bytes.len() {
                i += 2;
            }
            continue;
        }
        if c == b'{' {
            depth += 1;
        } else if c == b'}' {
            depth -= 1;
            if depth < 0 {
                return i;
            }
        } else if (c == b';' || c == b'\n') && depth == 0 {
            // Don't include the terminator itself.
            return i;
        }
        i += 1;
    }
    i
}

/// Return the contents of the last single- or double-quoted
/// string literal in `s` (excluding the surrounding quotes,
/// minimally unescaped). Returns None if no such literal exists.
fn find_last_string_literal(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut last: Option<(usize, usize, u8)> = None;
    let mut i = 0usize;
    while i < bytes.len() {
        let c = bytes[i];
        if c == b'/' && i + 1 < bytes.len() && bytes[i + 1] == b'/' {
            while i < bytes.len() && bytes[i] != b'\n' {
                i += 1;
            }
            continue;
        }
        if c == b'/' && i + 1 < bytes.len() && bytes[i + 1] == b'*' {
            i += 2;
            while i + 1 < bytes.len() && !(bytes[i] == b'*' && bytes[i + 1] == b'/') {
                i += 1;
            }
            if i + 1 < bytes.len() {
                i += 2;
            }
            continue;
        }
        if c == b'"' || c == b'\'' {
            let q = c;
            let start = i + 1;
            i += 1;
            while i < bytes.len() && bytes[i] != q {
                if bytes[i] == b'\\' && i + 1 < bytes.len() {
                    i += 2;
                    continue;
                }
                i += 1;
            }
            last = Some((start, i, q));
            if i < bytes.len() {
                i += 1;
            }
            continue;
        }
        i += 1;
    }
    last.map(|(start, end, _)| unescape_minimal(&s[start..end]))
}

fn unescape_minimal(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            if let Some(n) = chars.next() {
                match n {
                    'n' => out.push('\n'),
                    't' => out.push('\t'),
                    'r' => out.push('\r'),
                    '\\' => out.push('\\'),
                    '\'' => out.push('\''),
                    '"' => out.push('"'),
                    other => {
                        out.push('\\');
                        out.push(other);
                    }
                }
                continue;
            }
        }
        out.push(c);
    }
    out
}

/// Given `bytes[i]` is an opening quote (`"`, `'`, or a backtick),
/// return the index just past the matching closing quote, skipping
/// backslash escapes and — for a template literal — `${ ... }`
/// interpolations by shallow brace matching. Used by the CommonJS
/// `require` scanner to step over string and template bodies without
/// mis-reading their contents as source tokens.
fn skip_string_literal(bytes: &[u8], mut i: usize) -> usize {
    let quote = bytes[i];
    i += 1;
    while i < bytes.len() && bytes[i] != quote {
        if bytes[i] == b'\\' && i + 1 < bytes.len() {
            i += 2;
            continue;
        }
        if quote == b'`' && bytes[i] == b'$' && i + 1 < bytes.len() && bytes[i + 1] == b'{' {
            let mut depth = 1;
            i += 2;
            while i < bytes.len() && depth > 0 {
                if bytes[i] == b'{' {
                    depth += 1;
                } else if bytes[i] == b'}' {
                    depth -= 1;
                }
                i += 1;
            }
            continue;
        }
        i += 1;
    }
    if i < bytes.len() {
        i += 1;
    }
    i
}

/// Return the statically known first argument of a call whose opening
/// parenthesis is at `opening_parenthesis`. String literals and template
/// literals without substitutions are analyzable; all expression-valued
/// forms are deliberately ignored.
fn literal_call_argument(source: &str, opening_parenthesis: usize) -> Option<(String, usize)> {
    let bytes = source.as_bytes();
    let mut index = opening_parenthesis + 1;
    while index < bytes.len() && bytes[index].is_ascii_whitespace() {
        index += 1;
    }
    if index >= bytes.len() || !matches!(bytes[index], b'\'' | b'"' | b'`') {
        return None;
    }
    let quote = bytes[index];
    let start = index + 1;
    index += 1;
    while index < bytes.len() && bytes[index] != quote {
        if quote == b'`'
            && bytes[index] == b'$'
            && index + 1 < bytes.len()
            && bytes[index + 1] == b'{'
        {
            return None;
        }
        if bytes[index] == b'\\' && index + 1 < bytes.len() {
            index += 2;
        } else {
            index += 1;
        }
    }
    (index < bytes.len()).then(|| (unescape_minimal(&source[start..index]), index + 1))
}

/// Whether a literal dynamic target is a source language this walker can
/// archive. Extensionless relative paths keep the normal resolution fallbacks;
/// explicit non-JavaScript asset extensions remain runtime-only.
fn is_walkable_dynamic_target(specifier: &str) -> bool {
    let is_path = specifier.starts_with('.') || specifier.starts_with('/');
    if !is_path {
        return true;
    }
    match Path::new(specifier).extension().and_then(OsStr::to_str) {
        None => true,
        Some("js" | "mjs" | "cjs" | "json") => true,
        Some(_) => false,
    }
}

/// Identifier immediately to the left of an assignment whose right-hand side
/// begins at `expression_start` (`const target = require.resolve(...)`).
fn assigned_identifier_before(source: &str, expression_start: usize) -> Option<String> {
    let bytes = source.as_bytes();
    let mut end = expression_start;
    while end > 0 && bytes[end - 1].is_ascii_whitespace() {
        end -= 1;
    }
    if end == 0 || bytes[end - 1] != b'=' {
        return None;
    }
    end -= 1;
    while end > 0 && bytes[end - 1].is_ascii_whitespace() {
        end -= 1;
    }
    let mut start = end;
    while start > 0 && is_ident_continue(bytes[start - 1]) {
        start -= 1;
    }
    (start < end).then(|| source[start..end].to_string())
}

/// Whether `source[start..]` contains a dynamic `require(identifier)` call.
fn has_dynamic_require_of(source: &str, start: usize, identifier: &str) -> bool {
    let bytes = source.as_bytes();
    let mut index = start;
    while index < bytes.len() {
        if bytes[index] == b'/' && index + 1 < bytes.len() && bytes[index + 1] == b'/' {
            while index < bytes.len() && bytes[index] != b'\n' {
                index += 1;
            }
            continue;
        }
        if bytes[index] == b'/' && index + 1 < bytes.len() && bytes[index + 1] == b'*' {
            index += 2;
            while index + 1 < bytes.len() && !(bytes[index] == b'*' && bytes[index + 1] == b'/') {
                index += 1;
            }
            index = (index + 2).min(bytes.len());
            continue;
        }
        if matches!(bytes[index], b'\'' | b'"' | b'`') {
            index = skip_string_literal(bytes, index);
            continue;
        }
        if matches_keyword(bytes, index, b"require") {
            let mut cursor = index + "require".len();
            while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
                cursor += 1;
            }
            if cursor < bytes.len() && bytes[cursor] == b'(' {
                cursor += 1;
                while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
                    cursor += 1;
                }
                if source[cursor..].starts_with(identifier)
                    && (cursor + identifier.len() == bytes.len()
                        || !is_ident_continue(bytes[cursor + identifier.len()]))
                {
                    return true;
                }
            }
            index += "require".len();
            continue;
        }
        index += 1;
    }
    false
}

/// Find `const target = require.resolve("literal")` declarations whose target
/// is later consumed by `require(target)`. This is the statically analyzable
/// dynamic-require shape used by webpack-style loaders.
fn scan_bound_dynamic_require_targets(source: &str) -> Vec<String> {
    let bytes = source.as_bytes();
    let mut specifiers = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut index = 0usize;
    while index < bytes.len() {
        if matches!(bytes[index], b'\'' | b'"' | b'`') {
            index = skip_string_literal(bytes, index);
            continue;
        }
        if bytes[index] == b'/' && index + 1 < bytes.len() && bytes[index + 1] == b'/' {
            while index < bytes.len() && bytes[index] != b'\n' {
                index += 1;
            }
            continue;
        }
        if bytes[index] == b'/' && index + 1 < bytes.len() && bytes[index + 1] == b'*' {
            index += 2;
            while index + 1 < bytes.len() && !(bytes[index] == b'*' && bytes[index + 1] == b'/') {
                index += 1;
            }
            index = (index + 2).min(bytes.len());
            continue;
        }
        if matches_keyword(bytes, index, b"require") {
            let mut cursor = index + "require".len();
            if cursor < bytes.len() && bytes[cursor] == b'.' {
                cursor += 1;
                if matches_keyword(bytes, cursor, b"resolve") {
                    cursor += "resolve".len();
                    while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
                        cursor += 1;
                    }
                    if cursor < bytes.len() && bytes[cursor] == b'(' {
                        if let (Some(identifier), Some((specifier, _))) = (
                            assigned_identifier_before(source, index),
                            literal_call_argument(source, cursor),
                        ) {
                            if is_walkable_dynamic_target(&specifier)
                                && has_dynamic_require_of(source, cursor + 1, &identifier)
                                && seen.insert(specifier.clone())
                            {
                                specifiers.push(specifier);
                            }
                        }
                    }
                }
            }
            index += "require".len();
            continue;
        }
        index += 1;
    }
    specifiers
}

/// Scan an ES module for statically analyzable dynamic `import()` calls.
///
/// A call is followed only when its first argument is a string literal or a
/// substitution-free template literal. Expression-valued specifiers are
/// absent from the returned list; the detailed internal scan marks their
/// presence so the walker can retain declared dependencies. Comments,
/// strings, regex literals, template bodies, and property calls are skipped
/// so source text that merely resembles `import()` cannot create an edge.
#[derive(Default)]
struct DynamicImportScan {
    specifiers: Vec<String>,
    has_opaque: bool,
}

fn scan_dynamic_imports_detailed(source: &str) -> DynamicImportScan {
    let mut specifiers = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut has_opaque = false;
    let bytes = source.as_bytes();
    let mut index = 0usize;
    let mut regex_allowed = true;
    while index < bytes.len() {
        if bytes[index] == b'/' && index + 1 < bytes.len() && bytes[index + 1] == b'/' {
            while index < bytes.len() && bytes[index] != b'\n' {
                index += 1;
            }
            continue;
        }
        if bytes[index] == b'/' && index + 1 < bytes.len() && bytes[index + 1] == b'*' {
            index += 2;
            while index + 1 < bytes.len() && !(bytes[index] == b'*' && bytes[index + 1] == b'/') {
                index += 1;
            }
            index = (index + 2).min(bytes.len());
            continue;
        }
        if matches!(bytes[index], b'\'' | b'"' | b'`') {
            index = skip_string_literal(bytes, index);
            regex_allowed = false;
            continue;
        }
        if bytes[index] == b'/' && regex_allowed {
            index = skip_regex_literal(bytes, index);
            regex_allowed = false;
            continue;
        }
        if matches_keyword(bytes, index, b"import") {
            let previous_significant = source[..index]
                .bytes()
                .rev()
                .find(|byte| !byte.is_ascii_whitespace());
            if previous_significant == Some(b'.') {
                index += "import".len();
                regex_allowed = false;
                continue;
            }
            let mut opening_parenthesis = index + "import".len();
            while opening_parenthesis < bytes.len()
                && bytes[opening_parenthesis].is_ascii_whitespace()
            {
                opening_parenthesis += 1;
            }
            if opening_parenthesis < bytes.len() && bytes[opening_parenthesis] == b'(' {
                let mut statically_analyzable = false;
                if let Some((specifier, argument_end)) =
                    literal_call_argument(source, opening_parenthesis)
                {
                    let mut after_argument = argument_end;
                    while after_argument < bytes.len()
                        && bytes[after_argument].is_ascii_whitespace()
                    {
                        after_argument += 1;
                    }
                    // A literal followed by an operator is only the first term
                    // of an expression (`import('./' + name)`), not a static
                    // specifier. A comma is permitted for import attributes.
                    if after_argument < bytes.len() && matches!(bytes[after_argument], b')' | b',')
                    {
                        statically_analyzable = true;
                        if seen.insert(specifier.clone()) {
                            specifiers.push(specifier);
                        }
                    }
                }
                has_opaque |= !statically_analyzable;
            }
            index += "import".len();
            regex_allowed = false;
            continue;
        }
        if !bytes[index].is_ascii_whitespace() {
            regex_allowed = !ends_value_expression(bytes[index]);
        }
        index += 1;
    }
    DynamicImportScan {
        specifiers,
        has_opaque,
    }
}

pub fn scan_dynamic_imports(source: &str) -> Vec<String> {
    scan_dynamic_imports_detailed(source).specifiers
}

/// Scan `source` for CommonJS `require("x")` specifiers.
///
/// Recognises a `require(<string-literal>)` call anywhere in the
/// source — `require` is an ordinary expression, not a statement-start
/// keyword like `import` — and captures the first string-literal
/// argument of each call. It deliberately does **not** record:
///
/// - `require.extensions[...]`, `require.cache`, and similar property
///   accesses. A literal `require.resolve()` assigned to an identifier that
///   is later passed to `require(identifier)` is the exception: the binding
///   makes that later dynamic-require target statically analyzable;
/// - a call whose first argument is not a static string literal
///   (`require(expr)`, `require({ ... })`, ``require(`...${x}...`)``);
///
/// which matches `@endo/cjs-module-analyzer`'s `requires` extraction
/// for the cases the compartment-mapper fixtures exercise (including
/// `parser-struggles`, which stresses shadowed/odd `require` calls).
/// Like [`scan_static_imports`] it skips JS line/block comments and
/// string / template literals, so a `require("x")` written inside a
/// string or comment is not falsely matched. Both scanners also skip
/// regular-expression literals (disambiguated from division by the
/// previous significant token, [`ends_value_expression`]), so a regex
/// body containing `"`, `'`, or `//` is not misread as a string or
/// comment — a misread could swallow a following `require`, a false
/// negative. Any residual false positive resolves to a deferred error
/// rather than corrupting the compartment map.
///
/// Specifiers are returned once each, in source-occurrence order, so
/// the downstream emitter is deterministic for a given source.
pub fn scan_cjs_requires(source: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let bytes = source.as_bytes();
    let mut i = 0usize;
    // Whether a `/` here opens a regex literal (true) or is division.
    let mut regex_allowed = true;
    while i < bytes.len() {
        let c = bytes[i];

        // Line comment.
        if c == b'/' && i + 1 < bytes.len() && bytes[i + 1] == b'/' {
            while i < bytes.len() && bytes[i] != b'\n' {
                i += 1;
            }
            continue;
        }
        // Block comment.
        if c == b'/' && i + 1 < bytes.len() && bytes[i + 1] == b'*' {
            i += 2;
            while i + 1 < bytes.len() && !(bytes[i] == b'*' && bytes[i + 1] == b'/') {
                i += 1;
            }
            if i + 1 < bytes.len() {
                i += 2;
            }
            continue;
        }
        // Regex literal — skip its body so an embedded `"`, `'`, or `//`
        // is not misread as a string or comment.
        if c == b'/' && regex_allowed {
            i = skip_regex_literal(bytes, i);
            regex_allowed = false;
            continue;
        }
        // String / template literal.
        if c == b'"' || c == b'\'' || c == b'`' {
            i = skip_string_literal(bytes, i);
            regex_allowed = false;
            continue;
        }

        // `require` keyword (word-bounded).
        if matches_keyword(bytes, i, b"require") {
            let mut j = i + "require".len();
            while j < bytes.len() && bytes[j].is_ascii_whitespace() {
                j += 1;
            }
            if j < bytes.len() && bytes[j] == b'(' {
                let opening_parenthesis = j;
                if let Some((specifier, _)) = literal_call_argument(source, opening_parenthesis) {
                    if seen.insert(specifier.clone()) {
                        out.push(specifier);
                    }
                }
            }
            // Step past the keyword either way.
            i += "require".len();
            regex_allowed = false;
            continue;
        }

        // Whitespace does not end an expression, so it must not flip the
        // regex/division state (`a / b` stays division across the space).
        if !c.is_ascii_whitespace() {
            regex_allowed = !ends_value_expression(c);
        }
        i += 1;
    }
    for specifier in scan_bound_dynamic_require_targets(source) {
        if seen.insert(specifier.clone()) {
            out.push(specifier);
        }
    }
    out
}

// Resolver: bare specifiers and relative paths

/// Resolution result for a single import specifier.
#[derive(Debug, PartialEq, Eq)]
pub enum Resolved {
    /// Same-compartment relative file. The path is canonicalised
    /// and is guaranteed to live inside the importing
    /// compartment's root directory.
    Relative {
        abs_path: PathBuf,
        /// The specifier as it appears in the synthesised
        /// compartment-map: the importing compartment-relative
        /// specifier (`./sibling.js`, `./lib/util.js`, with the
        /// extension preserved when present).
        compartment_specifier: String,
        parser: &'static str,
    },
    /// Bare specifier resolved via `node_modules` lookup.
    /// `package_root` is the directory containing the resolved
    /// `package.json`; `entry_file` is the absolute path of the
    /// package's chosen entry source; `subpath` is the
    /// package-rooted specifier (`"."` for the main entry,
    /// `"./sub.js"` for a subpath import).
    Bare {
        package_name: String,
        package_version: String,
        package_root: PathBuf,
        entry_file: PathBuf,
        /// The resolved module's package-relative specifier: `./index.js`
        /// for the package main (compartment-mapper keys the main by its
        /// resolved path, not a bare `.`), or `./sub/foo.js` for a
        /// subpath import.
        compartment_specifier: String,
        parser: &'static str,
        /// The requested subpath (`None` for the package main,
        /// `Some("from-debug")` for `pkg/from-debug`). Drives the
        /// extension-less alias the walker synthesises in the target
        /// compartment for classic deep-import resolution.
        subpath: Option<String>,
        /// Whether the resolved package declares an `"exports"` field.
        /// When it does, deep imports resolve through the exports map
        /// (yielding the exact target), so no classic-path alias is
        /// synthesised. See [`PackageMetadata::has_exports`].
        package_has_exports: bool,
        /// Whether the resolved package resolves `.js` to ES modules
        /// (see [`PackageMetadata::is_module`]), used to classify the
        /// target module's language.
        package_is_module: bool,
    },
}

/// Resolve `specifier` from the perspective of `importer_abs`.
///
/// - A specifier beginning with `./` or `../` is treated as
///   relative: resolved against `importer_abs`'s parent, walking
///   the usual extension fall-back (`.js`, `.mjs`, `.cjs`,
///   `.json`, then `index.<ext>` for directories).
/// - Any other specifier is treated as bare and resolved against
///   the nearest `node_modules` directory upward from
///   `importer_abs`, honouring the `name` segment (and one
///   `@scope/` prefix for scoped packages) and optional
///   `subpath` (the trailing `/...` part of the specifier).
pub fn resolve_specifier(
    importer_abs: &Path,
    specifier: &str,
    importer_compartment_root: &Path,
    browser: bool,
) -> io::Result<Resolved> {
    let importer_directory = importer_abs
        .parent()
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("importer has no parent: {}", importer_abs.display()),
            )
        })?
        .to_path_buf();

    if specifier.starts_with("./") || specifier.starts_with("../") {
        let (abs_path, parser) = resolve_relative(&importer_directory, specifier)?;
        let canonical_root = importer_compartment_root
            .canonicalize()
            .unwrap_or_else(|_| importer_compartment_root.to_path_buf());
        if !abs_path.starts_with(&canonical_root) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!(
                    "relative import {specifier} escapes the importing compartment root {}",
                    canonical_root.display()
                ),
            ));
        }
        let rel = abs_path.strip_prefix(&canonical_root).map_err(|e| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("strip prefix failed: {e}"),
            )
        })?;
        let compartment_specifier = format!("./{}", path_to_forward_slashes(rel));
        Ok(Resolved::Relative {
            abs_path,
            compartment_specifier,
            parser,
        })
    } else {
        resolve_bare(&importer_directory, specifier, browser)
    }
}

fn resolve_relative(
    importer_directory: &Path,
    specifier: &str,
) -> io::Result<(PathBuf, &'static str)> {
    let base = importer_directory.join(specifier);
    // 1. Exact file (with author-written extension).
    if base.is_file() {
        // The parser returned here is a JS/JSON-family *hint* only: an author
        // may relatively import a non-JS asset (`./text.text`,
        // `./uint32.uint32`), whose authoritative language depends on the
        // importing package's `"parsers"` and the emulated
        // `languageForExtension` — context this resolver lacks. The walk
        // recomputes the language at the call site (see
        // `Walker::language_for_module`), so an unknown extension here is not
        // an error; it defaults to `bytes` (an opaque asset) and is overridden.
        let parser = parser_for_extension(base.extension())
            .or_else(|| default_language_for_extension_os(base.extension()))
            .unwrap_or("bytes");
        let canonical = base.canonicalize()?;
        return Ok((canonical, parser));
    }
    // 2. Try extension fall-backs in priority order.
    for ext in ["js", "mjs", "cjs", "json"] {
        let candidate = base.with_extension(ext);
        if candidate.is_file() {
            let parser = parser_for_extension(Some(OsStr::new(ext))).unwrap();
            return Ok((candidate.canonicalize()?, parser));
        }
    }
    // 3. Directory with index.<ext>.
    if base.is_dir() {
        for ext in ["js", "mjs", "cjs", "json"] {
            let candidate = base.join(format!("index.{ext}"));
            if candidate.is_file() {
                let parser = parser_for_extension(Some(OsStr::new(ext))).unwrap();
                return Ok((candidate.canonicalize()?, parser));
            }
        }
    }
    Err(io::Error::new(
        io::ErrorKind::NotFound,
        format!(
            "relative import {} not found from {}",
            specifier,
            importer_directory.display()
        ),
    ))
}

/// Split a bare specifier into `(package_name, subpath)`.
///
/// `"lodash"` -> `("lodash", None)`.
/// `"lodash/fp"` -> `("lodash", Some("fp"))`.
/// `"@scope/pkg"` -> `("@scope/pkg", None)`.
/// `"@scope/pkg/sub/foo.js"` -> `("@scope/pkg", Some("sub/foo.js"))`.
pub fn split_bare_specifier(specifier: &str) -> Option<(String, Option<String>)> {
    if specifier.is_empty() {
        return None;
    }
    if specifier.starts_with('@') {
        // Scoped: name is `@scope/pkg`; subpath is everything
        // after the second `/`.
        let mut parts = specifier.splitn(3, '/');
        let scope = parts.next()?;
        let pkg = parts.next()?;
        if scope.len() < 2 || pkg.is_empty() {
            return None;
        }
        let name = format!("{scope}/{pkg}");
        let subpath = parts.next().map(|s| s.to_string());
        Some((name, subpath))
    } else {
        let mut parts = specifier.splitn(2, '/');
        let pkg = parts.next()?;
        if pkg.is_empty() {
            return None;
        }
        let subpath = parts.next().map(|s| s.to_string());
        Some((pkg.to_string(), subpath))
    }
}

fn resolve_bare(importer_directory: &Path, specifier: &str, browser: bool) -> io::Result<Resolved> {
    let (pkg_name, subpath) = split_bare_specifier(specifier).ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("malformed bare specifier: {specifier}"),
        )
    })?;

    let pkg_root = find_node_modules_package(importer_directory, &pkg_name).ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::NotFound,
            format!(
                "bare specifier {specifier} not found in node_modules upward from {}",
                importer_directory.display()
            ),
        )
    })?;
    // Resolve the package root to its realpath so a symlinked install
    // (`fixtures-symlink`'s `app/node_modules/symlink` -> `deps/node_modules/
    // symlink`) anchors the compartment — and its own transitive
    // dependency walk — at the real location. compartment-mapper resolves
    // packages by realpath; the canonical root is also what the compartment
    // is keyed by (see [`Walker::intern_compartment`]), so a package reached
    // via a symlink and via its real path is one compartment. The resolved
    // entry file below is likewise canonical, so it strips cleanly against
    // this root.
    let pkg_root = pkg_root.canonicalize().unwrap_or(pkg_root);

    let pkg_meta = load_package_metadata(&pkg_root)?;

    // Subpath resolution.
    let entry_file = match &subpath {
        None => resolve_package_main(&pkg_root, &pkg_meta, browser)?,
        Some(sub) => {
            let candidate = pkg_root.join(sub);
            resolve_subpath(&pkg_root, &candidate, sub)?
        }
    };

    let parser = parser_for_extension(entry_file.extension()).ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "package {} resolved to {} with unsupported extension",
                pkg_name,
                entry_file.display()
            ),
        )
    })?;

    // Compartment specifier: the resolved module's package-relative
    // path with its extension, for both the package main and a subpath
    // import. `@endo/compartment-mapper` keys the main by its resolved
    // location (`./index.js`), not a bare `.`, and the walker mirrors
    // that so the target compartment's module table matches.
    let rel = entry_file.strip_prefix(&pkg_root).map_err(|e| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("entry file outside package root: {e}"),
        )
    })?;
    let compartment_specifier = format!("./{}", path_to_forward_slashes(rel));

    Ok(Resolved::Bare {
        package_name: pkg_meta.name.clone(),
        package_version: pkg_meta.version.clone(),
        package_root: pkg_root,
        entry_file,
        compartment_specifier,
        parser,
        subpath,
        package_has_exports: pkg_meta.has_exports,
        package_is_module: pkg_meta.js_is_module(),
    })
}

fn resolve_subpath(pkg_root: &Path, candidate: &Path, raw_sub: &str) -> io::Result<PathBuf> {
    // 1. Exact file (with author-written extension).
    if candidate.is_file() {
        return canonicalize_within(pkg_root, candidate, raw_sub);
    }
    for ext in ["js", "mjs", "cjs", "json"] {
        let with_ext = candidate.with_extension(ext);
        if with_ext.is_file() {
            return canonicalize_within(pkg_root, &with_ext, raw_sub);
        }
    }
    if candidate.is_dir() {
        for ext in ["js", "mjs", "cjs", "json"] {
            let index_path = candidate.join(format!("index.{ext}"));
            if index_path.is_file() {
                return canonicalize_within(pkg_root, &index_path, raw_sub);
            }
        }
    }
    Err(io::Error::new(
        io::ErrorKind::NotFound,
        format!("subpath {raw_sub} not found under {}", pkg_root.display()),
    ))
}

/// Canonicalize a resolved package path and reject any result outside its
/// package root before a caller can inspect or read the target file.
fn canonicalize_within(root: &Path, candidate: &Path, requested: &str) -> io::Result<PathBuf> {
    let canonical_root = root.canonicalize()?;
    let canonical_candidate = candidate.canonicalize()?;
    if !canonical_candidate.starts_with(&canonical_root) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("subpath {requested} escapes package root"),
        ));
    }
    Ok(canonical_candidate)
}

/// Walk upward from `start_directory`, returning the first directory
/// `<dir>/node_modules/<pkg_name>` that exists.
fn find_node_modules_package(start_directory: &Path, pkg_name: &str) -> Option<PathBuf> {
    let mut cursor: &Path = start_directory;
    loop {
        let candidate = cursor.join("node_modules").join(pkg_name);
        if candidate.is_dir() {
            return Some(candidate);
        }
        match cursor.parent() {
            Some(p) => cursor = p,
            None => return None,
        }
    }
}

/// Pick a package's entry source file from its `package.json`.
///
/// Resolution order (matching the design's "exports default ->
/// main -> index.js" cascade):
///
/// 1. `exports.["."]` when present. Honoured as either a string
///    (`"./index.mjs"`) or an object with a `default` key. Other
///    conditional keys (`browser`, `import`, `require`,
///    `node`, etc.) are not consulted; the registry-table walk
///    in a later phase covers conditional exports more fully.
/// 2. `module` field (some packages use this for the ESM entry).
/// 3. `main` field.
/// 4. `index.js` (with the usual extension fall-back) in the
///    package root.
fn resolve_package_main(
    pkg_root: &Path,
    pkg: &PackageMetadata,
    browser: bool,
) -> io::Result<PathBuf> {
    // With the `browser` condition active, the package's `browser` field
    // may override the main (a string form, or an object entry keyed by the
    // `main` path) — `fixtures-resolve`'s `browser-main` and
    // `browser-main-obj-redirect`. This takes precedence over the ordinary
    // exports/module/main/index cascade.
    if browser {
        if let Some(rel) = pkg.browser.main_override(pkg.main.as_deref()) {
            let candidate = pkg_root.join(rel.trim_start_matches("./"));
            if candidate.is_file() {
                return canonicalize_within(pkg_root, &candidate, "browser");
            }
        }
    }
    if let Some(rel) = pkg.exports_dot_default.as_deref() {
        let candidate = pkg_root.join(rel);
        if candidate.is_file() {
            return canonicalize_within(pkg_root, &candidate, "exports[\".\"]");
        }
    }
    if let Some(rel) = pkg.module.as_deref() {
        let candidate = pkg_root.join(rel);
        if candidate.is_file() {
            return canonicalize_within(pkg_root, &candidate, "module");
        }
    }
    if let Some(rel) = pkg.main.as_deref() {
        let candidate = pkg_root.join(rel);
        if candidate.is_file() {
            return canonicalize_within(pkg_root, &candidate, "main");
        }
    }
    for ext in ["js", "mjs", "cjs", "json"] {
        let candidate = pkg_root.join(format!("index.{ext}"));
        if candidate.is_file() {
            return canonicalize_within(pkg_root, &candidate, "index");
        }
    }
    Err(io::Error::new(
        io::ErrorKind::NotFound,
        format!(
            "package {} at {} has no resolvable entry (exports.\".\".default/module/main/index.*)",
            pkg.name,
            pkg_root.display()
        ),
    ))
}

// package.json metadata

/// A package's parsed `"browser"` resolve field. Interpreted per the
/// [package-browser-field-spec] (as compartment-mapper's
/// `interpretBrowserField` does) only when the `browser` build condition
/// is active.
///
/// [package-browser-field-spec]: https://github.com/defunctzombie/package-browser-field-spec
#[derive(Debug, Default, Clone)]
enum BrowserField {
    /// No `browser` field.
    #[default]
    None,
    /// String form (`"browser": "./browser-main.js"`): overrides the
    /// package main.
    Main(String),
    /// Object form: each entry maps a key (a relative `./...` path, `.`, or a
    /// bare dependency name) to a target, or to `None` for `false` (ignore
    /// the module). Order is irrelevant — lookups are keyed.
    Map(Vec<(String, Option<String>)>),
}

impl BrowserField {
    /// The main-override implied by the field, given the package's raw
    /// `main` (`interpretBrowserField`: a string form, or an object entry
    /// whose key equals `main`). `None` leaves the ordinary main cascade.
    fn main_override(&self, main: Option<&str>) -> Option<String> {
        match self {
            BrowserField::Main(target) => Some(relativize(target)),
            BrowserField::Map(entries) => {
                let main_key = main.unwrap_or("index.js");
                entries.iter().find_map(|(key, target)| {
                    (key == main_key).then(|| target.as_deref().map(relativize))
                })?
            }
            BrowserField::None => None,
        }
    }

    /// The relative-key remaps (`./xyz.js` -> `./browser-xyz.js`), keyed by
    /// the relativized source path, excluding the main-override entry.
    /// These remap a resolved same-compartment file.
    fn relative_remap(&self, main: Option<&str>) -> BTreeMap<String, String> {
        let mut map = BTreeMap::new();
        if let BrowserField::Map(entries) = self {
            let main_key = main.unwrap_or("index.js");
            for (key, target) in entries {
                if key == main_key {
                    continue;
                }
                if (key.starts_with("./") || key == ".") && key != "." {
                    if let Some(target) = target {
                        map.insert(relativize(key), relativize(target));
                    }
                }
            }
        }
        map
    }

    /// The bare-key remaps (`abc` -> `browser-abc`, `ijk` ->
    /// `./browser-ijk.js`), keyed by the dependency package name. The
    /// target may be another bare package or a relative same-compartment
    /// file; it is kept verbatim.
    fn bare_remap(&self, main: Option<&str>) -> BTreeMap<String, String> {
        let mut map = BTreeMap::new();
        if let BrowserField::Map(entries) = self {
            let main_key = main.unwrap_or("index.js");
            for (key, target) in entries {
                if key == main_key {
                    continue;
                }
                if !(key.starts_with("./") || key == ".") {
                    if let Some(target) = target {
                        map.insert(key.clone(), target.clone());
                    }
                }
            }
        }
        map
    }
}

#[derive(Debug, Default, Clone)]
pub struct PackageMetadata {
    pub name: String,
    pub version: String,
    pub main: Option<String>,
    pub module: Option<String>,
    pub exports_dot_default: Option<String>,
    /// True when the package resolves `.js` to ECMAScript modules —
    /// `"type": "module"` or the presence of a `"module"` field — per
    /// `@endo/compartment-mapper`'s `inferParsers` rule. When false
    /// (`"type": "commonjs"` or no `type` at all), a `.js` in a
    /// *dependency* package is CommonJS. `.mjs`/`.cjs`/`.json` are
    /// unambiguous regardless.
    pub is_module: bool,
    /// True when the package *explicitly* declares `"type": "commonjs"`.
    /// The `endor run` entry point defaults a `.js` entry to ESM unless
    /// its package says CommonJS (its Phase 5 CLI contract); this flag
    /// distinguishes an explicit CommonJS entry from a `type`-less one.
    pub is_commonjs: bool,
    /// True when the `package.json` declares an `"exports"` field. A
    /// package with `exports` resolves deep imports through the
    /// exports map (yielding the exact target module), so the walker
    /// does not synthesise the extension-less alias it emits for the
    /// classic (`exports`-less) deep-import path. (Full conditional /
    /// subpath `exports` resolution is Increment 2 / Group C; this
    /// flag is only used here to suppress the classic-path alias.)
    pub has_exports: bool,
    /// The `"exports"` field, retained (with key order preserved) for
    /// full conditional/subpath resolution (Increment 2 / Group C).
    /// `None` when the package declares no `exports`.
    exports: Option<OrderedJson>,
    /// The `"imports"` field (the `#`-prefixed self-reference
    /// subpaths), retained (order-preserving) for `#imports`
    /// resolution. `None` when the package declares no `imports`.
    imports: Option<OrderedJson>,
    /// The `"browser"` resolve field (interpreted only when the `browser`
    /// build condition is active — see [`WalkOptions::browser`]). Remaps a
    /// package's own specifiers (relative and bare) and can override its
    /// main. See [`BrowserField`] and `interpretBrowserField` in
    /// `packages/compartment-mapper/src/infer-exports.js`.
    browser: BrowserField,
    /// The package-local `"parsers"` override for the `.js` extension,
    /// if declared (`{ "parsers": { "js": "mjs" } }`). This is
    /// compartment-mapper's per-package `inferParsers` override: a
    /// package may force `.js` to `mjs` (ESM) or `cjs` regardless of
    /// its `type` field. `Some("mjs")` / `Some("cjs")` when present.
    pub js_parser_override: Option<&'static str>,
    /// The full package-local `"parsers"` map (extension -> language),
    /// compartment-mapper's per-package `packageLanguageForExtension`. It
    /// overrides the built-in and emulated `languageForExtension` for every
    /// extension it names — `fixtures-assets` maps `uint32` -> `bytes`, and
    /// `fixtures-language-for-extension`'s `parsers-app` maps `xsonp` ->
    /// `jsonp`. `js` is retained here too, but the `.js` classification is
    /// driven through [`PackageMetadata::js_is_module`] (and hence the
    /// enclosing compartment's `is_module`), so language resolution consults
    /// this map only for non-`js` extensions.
    parsers: BTreeMap<String, String>,
    /// Runtime dependency names (`dependencies`, `peerDependencies`, and
    /// bundled dependencies). These are followed for every package.
    runtime_dependencies: BTreeSet<String>,
    /// Optional runtime dependency names (`optionalDependencies` and optional
    /// peers named only by `peerDependenciesMeta`). A missing package is a
    /// deferred edge rather than a walk failure.
    optional_dependencies: BTreeSet<String>,
    /// Development-only dependency names. These are followed only for the
    /// entry package when [`WalkOptions::dev`] is true.
    dev_dependencies: BTreeSet<String>,
}

impl PackageMetadata {
    /// Whether a bare `.js` file in this package is an ES module, after
    /// applying any package-local `"parsers"` override on top of the
    /// `type`/`module` inference. Drives the ES-`import` vs `require()`
    /// scan for the compartment's `.js` sources.
    pub fn js_is_module(&self) -> bool {
        match self.js_parser_override {
            Some("mjs") => true,
            Some("cjs") => false,
            _ => self.is_module,
        }
    }

    /// Classify a bare package dependency according to npm's manifest fields.
    /// Concrete runtime declarations take precedence over optional and
    /// development-only declarations when a name appears in more than one
    /// field.
    fn dependency_classification(
        &self,
        name: &str,
        include_dev_dependencies: bool,
    ) -> DependencyClassification {
        if self.runtime_dependencies.contains(name) {
            DependencyClassification::Runtime
        } else if self.optional_dependencies.contains(name) {
            DependencyClassification::Optional
        } else if include_dev_dependencies && self.dev_dependencies.contains(name) {
            DependencyClassification::Development
        } else {
            DependencyClassification::Excluded
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DependencyClassification {
    Runtime,
    Optional,
    Development,
    Excluded,
}

/// Read and parse `package.json` from `pkg_root`. Missing
/// optional fields are absent in the returned struct; `name` and
/// `version` fall back to placeholders (the directory basename
/// and `"0.0.0"`) when the JSON does not declare them.
pub fn load_package_metadata(pkg_root: &Path) -> io::Result<PackageMetadata> {
    let path = pkg_root.join("package.json");
    let bytes = std::fs::read(&path)?;
    let v: serde_json::Value = serde_json::from_slice(&bytes).map_err(|e| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("invalid package.json at {}: {e}", path.display()),
        )
    })?;

    let name = v
        .get("name")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| {
            pkg_root
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| "anonymous".to_string())
        });
    let version = v
        .get("version")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| "0.0.0".to_string());
    let main = v
        .get("main")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string());
    let module = v
        .get("module")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string());

    // `exports`: support the two shapes the design names.
    // - `"exports": "./index.mjs"` (shorthand)
    // - `"exports": { ".": "./index.mjs" }` (string subpath)
    // - `"exports": { ".": { "default": "./index.mjs" } }`
    //   (conditional)
    let exports_dot_default = v.get("exports").and_then(|exp| match exp {
        serde_json::Value::String(s) => Some(s.to_string()),
        serde_json::Value::Object(map) => match map.get(".") {
            Some(serde_json::Value::String(s)) => Some(s.to_string()),
            Some(serde_json::Value::Object(cond)) => cond
                .get("default")
                .and_then(|x| x.as_str())
                .map(|s| s.to_string()),
            _ => None,
        },
        _ => None,
    });

    let type_field = v.get("type").and_then(|x| x.as_str());
    // `@endo/compartment-mapper`'s `inferParsers` rule for a *package*:
    // `"type": "module"` or a `"module"` field resolves `.js` to an ES
    // module; anything else — `"type": "commonjs"` or an absent `type`
    // — resolves `.js` to CommonJS. Dependency packages follow this
    // verbatim (so `cjs-compat`'s `type`-less `defineprop`,
    // `parser-struggles`, ... are correctly CommonJS and scanned for
    // `require()`). The `endor run` *entry* additionally defaults a
    // `type`-less `.js` app to ESM — see `is_commonjs` and the entry
    // classification in `ingest_entry_point_with_deps`.
    let is_module = type_field == Some("module") || module.is_some();
    let is_commonjs = type_field == Some("commonjs");
    let has_exports = v.get("exports").is_some();
    // Re-parse just the `exports`/`imports` fields with key order
    // preserved (Node condition selection is insertion-order sensitive).
    let ordered: OrderedPackageFields = serde_json::from_slice(&bytes).unwrap_or_default();
    let OrderedPackageFields { exports, imports } = ordered;
    let browser = match v.get("browser") {
        Some(serde_json::Value::String(target)) => BrowserField::Main(target.clone()),
        Some(serde_json::Value::Object(map)) => BrowserField::Map(
            map.iter()
                .map(|(key, value)| {
                    let target = match value {
                        // `false` ignores the module (spec: ignore-a-module).
                        serde_json::Value::Bool(false) => None,
                        serde_json::Value::String(target) => Some(target.clone()),
                        _ => None,
                    };
                    (key.clone(), target)
                })
                .collect(),
        ),
        _ => BrowserField::None,
    };
    let js_parser_override = v
        .get("parsers")
        .and_then(|p| p.get("js"))
        .and_then(|x| x.as_str())
        .and_then(|s| match s {
            "mjs" => Some("mjs"),
            "cjs" => Some("cjs"),
            _ => None,
        });
    // The full `"parsers"` map (extension -> language), retained for
    // non-`js` language resolution (`.uint32` -> `bytes`, `.xsonp` ->
    // `jsonp`). Only string-valued entries are kept.
    let parsers = v
        .get("parsers")
        .and_then(|p| p.as_object())
        .map(|map| {
            map.iter()
                .filter_map(|(ext, lang)| {
                    lang.as_str()
                        .map(|lang| (ext.to_ascii_lowercase(), lang.to_string()))
                })
                .collect()
        })
        .unwrap_or_default();

    let dependency_names = |field: &str| -> BTreeSet<String> {
        match v.get(field) {
            Some(serde_json::Value::Object(dependencies)) => dependencies.keys().cloned().collect(),
            // npm accepts both spellings of bundled dependencies as either
            // an object or an array of package names.
            Some(serde_json::Value::Array(dependencies)) => dependencies
                .iter()
                .filter_map(|dependency| dependency.as_str().map(str::to_string))
                .collect(),
            _ => BTreeSet::new(),
        }
    };
    let mut runtime_dependencies = dependency_names("dependencies");
    runtime_dependencies.extend(dependency_names("peerDependencies"));
    runtime_dependencies.extend(dependency_names("bundleDependencies"));
    runtime_dependencies.extend(dependency_names("bundledDependencies"));

    let optional_dependencies = {
        let mut names = dependency_names("optionalDependencies");
        if let Some(metadata) = v
            .get("peerDependenciesMeta")
            .and_then(|value| value.as_object())
        {
            for (dependency_name, value) in metadata {
                if value
                    .get("optional")
                    .and_then(|optional| optional.as_bool())
                    == Some(true)
                {
                    names.insert(dependency_name.clone());
                }
            }
        }
        names
    };
    // npm gives optionalDependencies precedence over dependencies. The name
    // remains walkable, but is classified optional so a missing installation
    // becomes a deferred edge.
    for dependency_name in &optional_dependencies {
        runtime_dependencies.remove(dependency_name);
    }
    let dev_dependencies = dependency_names("devDependencies");

    Ok(PackageMetadata {
        name,
        version,
        main,
        module,
        exports_dot_default,
        is_module,
        is_commonjs,
        has_exports,
        exports,
        imports,
        browser,
        js_parser_override,
        parsers,
        runtime_dependencies,
        optional_dependencies,
        dev_dependencies,
    })
}

/// An `exports`/`imports` JSON value that preserves object **key
/// order**. Node.js `exports`/`imports` condition selection is
/// insertion-order sensitive (the first matching condition wins, and
/// authors place `default` last), but `serde_json::Value` stores
/// objects in a `BTreeMap` and would reorder `{ "endo:lib": ...,
/// "default": ... }` to `{ "default": ..., "endo:lib": ... }`, silently
/// letting `default` win. Deserialising into this type instead keeps
/// the JSON's textual key order, matching Node.
#[derive(Debug, Clone)]
enum OrderedJson {
    Null,
    String(String),
    Array(Vec<OrderedJson>),
    Object(Vec<(String, OrderedJson)>),
    /// Booleans/numbers — retained as a variant but unused by
    /// exports/imports resolution.
    Other,
}

impl<'de> serde::Deserialize<'de> for OrderedJson {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        struct V;
        impl<'de> serde::de::Visitor<'de> for V {
            type Value = OrderedJson;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("any JSON value")
            }
            fn visit_unit<E>(self) -> Result<OrderedJson, E> {
                Ok(OrderedJson::Null)
            }
            fn visit_none<E>(self) -> Result<OrderedJson, E> {
                Ok(OrderedJson::Null)
            }
            fn visit_some<D>(self, d: D) -> Result<OrderedJson, D::Error>
            where
                D: serde::Deserializer<'de>,
            {
                <OrderedJson as serde::Deserialize>::deserialize(d)
            }
            fn visit_bool<E>(self, _: bool) -> Result<OrderedJson, E> {
                Ok(OrderedJson::Other)
            }
            fn visit_i64<E>(self, _: i64) -> Result<OrderedJson, E> {
                Ok(OrderedJson::Other)
            }
            fn visit_u64<E>(self, _: u64) -> Result<OrderedJson, E> {
                Ok(OrderedJson::Other)
            }
            fn visit_f64<E>(self, _: f64) -> Result<OrderedJson, E> {
                Ok(OrderedJson::Other)
            }
            fn visit_str<E>(self, s: &str) -> Result<OrderedJson, E> {
                Ok(OrderedJson::String(s.to_string()))
            }
            fn visit_string<E>(self, s: String) -> Result<OrderedJson, E> {
                Ok(OrderedJson::String(s))
            }
            fn visit_seq<A>(self, mut seq: A) -> Result<OrderedJson, A::Error>
            where
                A: serde::de::SeqAccess<'de>,
            {
                let mut items = Vec::new();
                while let Some(v) = seq.next_element()? {
                    items.push(v);
                }
                Ok(OrderedJson::Array(items))
            }
            fn visit_map<A>(self, mut map: A) -> Result<OrderedJson, A::Error>
            where
                A: serde::de::MapAccess<'de>,
            {
                // `next_entry` yields keys in the JSON's textual order,
                // regardless of `serde_json`'s object storage type.
                let mut entries = Vec::new();
                while let Some((k, v)) = map.next_entry::<String, OrderedJson>()? {
                    entries.push((k, v));
                }
                Ok(OrderedJson::Object(entries))
            }
        }
        deserializer.deserialize_any(V)
    }
}

/// The `exports`/`imports` fields of a `package.json`, parsed with key
/// order preserved (see [`OrderedJson`]).
#[derive(Debug, Default, serde::Deserialize)]
struct OrderedPackageFields {
    #[serde(default)]
    exports: Option<OrderedJson>,
    #[serde(default)]
    imports: Option<OrderedJson>,
}

// Conditional & subpath `exports` / `#imports` resolution (Group C)
//
// A faithful port of the slice of `@endo/compartment-mapper`
// (`src/infer-exports.js` + `src/pattern-replacement.js`) that the
// Increment 2 fixtures exercise: condition selection, exact-subpath
// aliases, `*`-wildcard subpath patterns (matching across `/`, Node.js
// semantics), pattern specificity (`PATTERN_KEY_COMPARE`), null-target
// exclusions, and the `#imports` self-reference field. The parity run
// supplies the *same* condition set to this resolver and to the node
// oracle, so the comparison stays apples-to-apples (design §2, Group C).

/// The outcome of resolving a bare import into a package that declares
/// an `exports` field ([`Walker::resolve_bare_exports`]).
enum BareExportsResult {
    /// The exports map resolved the subpath to a target module.
    Module {
        pkg_name: String,
        pkg_version: String,
        pkg_root: PathBuf,
        pkg_is_module: bool,
        entry_file: PathBuf,
        /// The resolved module's package-relative specifier (`./src/x.js`).
        compartment_specifier: String,
    },
    /// The subpath is excluded (null target) or matches no exports
    /// entry — recorded as a deferred error, matching compartment-mapper.
    Deferred { reason: String },
}

/// The outcome of matching a package-relative subpath key (`.` or
/// `./sub`) against a package's exports/imports map.
enum SubpathResolution {
    /// The key resolved to a package-relative target (`./src/x.js`).
    Matched(String),
    /// The key hit a `null` target — an explicit Node.js exclusion.
    Excluded,
    /// No exact alias or pattern matched the key.
    NoMatch,
}

/// `relativize` from `node-module-specifier.js`: normalise a target to
/// a `./`-rooted, `.`/``-collapsed relative specifier. A `*` is an
/// ordinary path component and is preserved.
fn relativize(spec: &str) -> String {
    let mut solution: Vec<&str> = Vec::new();
    for part in spec.split('/') {
        match part {
            "." | "" => {}
            ".." => {
                solution.pop();
            }
            other => solution.push(other),
        }
    }
    let mut out = String::from(".");
    for part in solution {
        out.push('/');
        out.push_str(part);
    }
    out
}

/// Port of `interpretExports(name, exports, conditions)`: flatten a
/// package `exports` value into `(subpath-key, Option<target>)` pairs,
/// selecting the first matching condition at each conditional object.
/// `name` is the current subpath-key context (`.` at the top level).
fn interpret_exports(
    name: &str,
    exports: &OrderedJson,
    conditions: &BTreeSet<String>,
    out: &mut Vec<(String, Option<String>)>,
) {
    match exports {
        // Null targets are exclusions (Node.js semantics).
        OrderedJson::Null => out.push((name.to_string(), None)),
        OrderedJson::String(s) => out.push((name.to_string(), Some(relativize(s)))),
        OrderedJson::Array(sections) => {
            // The first section that yields any result wins.
            for section in sections {
                let mut results = Vec::new();
                interpret_exports(name, section, conditions, &mut results);
                if !results.is_empty() {
                    out.extend(results);
                    break;
                }
            }
        }
        OrderedJson::Object(map) => {
            for (key, value) in map {
                if key == "./" {
                    // Explicitly invalid key; ignore.
                    continue;
                } else if key.starts_with("./") || key == "." {
                    interpret_exports(key, value, conditions, out);
                } else if conditions.contains(key) {
                    interpret_exports(name, value, conditions, out);
                    // Take only the first matching condition/tag.
                    break;
                }
            }
        }
        OrderedJson::Other => {}
    }
}

/// Port of `interpretImports(imports, conditions)`: flatten a package
/// `imports` value (keys must start with `#`) into `(key,
/// Option<target>)` pairs. Only relative targets are meaningful for the
/// walker (a `#` alias that points at another package is a
/// dependency edge handled elsewhere and out of scope for these
/// fixtures).
fn interpret_imports(
    imports: &OrderedJson,
    conditions: &BTreeSet<String>,
    out: &mut Vec<(String, Option<String>)>,
) {
    let OrderedJson::Object(map) = imports else {
        return;
    };
    for (key, value) in map {
        if !key.starts_with('#') {
            continue;
        }
        match value {
            OrderedJson::Null => out.push((key.clone(), None)),
            OrderedJson::String(s) => out.push((key.clone(), Some(relativize(s)))),
            OrderedJson::Object(cond) => {
                for (condition, target) in cond {
                    if conditions.contains(condition) {
                        match target {
                            OrderedJson::Null => out.push((key.clone(), None)),
                            OrderedJson::String(s) => out.push((key.clone(), Some(relativize(s)))),
                            _ => {}
                        }
                        break;
                    }
                }
            }
            _ => {}
        }
    }
}

/// Split flattened `(key, Option<target>)` entries into exact aliases
/// (no `*`) and wildcard patterns, mirroring
/// `inferExportsAliasesAndPatterns`. A concrete `null` is dropped (an
/// exclusion by omission); a wildcard `null` is retained as an
/// exclusion pattern. Later entries override earlier ones for exact
/// aliases (exports override the `main`/`module` fall-back).
fn split_aliases_and_patterns(
    entries: Vec<(String, Option<String>)>,
) -> (BTreeMap<String, String>, Vec<(String, Option<String>)>) {
    let mut exact: BTreeMap<String, String> = BTreeMap::new();
    let mut patterns: Vec<(String, Option<String>)> = Vec::new();
    for (key, target) in entries {
        let key_wild = key.contains('*');
        match target {
            None => {
                if key_wild {
                    patterns.push((key, None));
                }
                // Concrete null: excluded by omission.
            }
            Some(t) => {
                if key_wild || t.contains('*') {
                    patterns.push((key, Some(t)));
                } else {
                    exact.insert(key, t);
                }
            }
        }
    }
    (exact, patterns)
}

/// Node.js `PATTERN_KEY_COMPARE`: prefer the longest prefix before `*`,
/// then the longest full key. Returns `Ordering` such that the more
/// specific key sorts *first*.
fn pattern_key_compare(a: &str, b: &str) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    let a_base = a.find('*').map(|i| i + 1).unwrap_or(a.len() + 1);
    let b_base = b.find('*').map(|i| i + 1).unwrap_or(b.len() + 1);
    match b_base.cmp(&a_base) {
        Ordering::Equal => b.len().cmp(&a.len()),
        other => other,
    }
}

/// Resolve a package-relative subpath `key` (`.`, `./x.js`, or
/// `#internal/x.js`) against the exact aliases and wildcard patterns of
/// a package's exports/imports map. Exact entries win over all
/// patterns; patterns are tried in `PATTERN_KEY_COMPARE` specificity
/// order (port of `makeMultiSubpathReplacer`).
fn resolve_subpath_in_map(
    exact: &BTreeMap<String, String>,
    patterns: &[(String, Option<String>)],
    key: &str,
) -> SubpathResolution {
    if let Some(target) = exact.get(key) {
        return SubpathResolution::Matched(target.clone());
    }
    let mut ordered: Vec<&(String, Option<String>)> = patterns.iter().collect();
    ordered.sort_by(|a, b| pattern_key_compare(&a.0, &b.0));
    for (pattern, target) in ordered {
        let star = match pattern.find('*') {
            Some(i) => i,
            None => continue,
        };
        let prefix = &pattern[..star];
        let suffix = &pattern[star + 1..];
        if key.starts_with(prefix)
            && key.ends_with(suffix)
            && key.len() >= prefix.len() + suffix.len()
        {
            let target = match target {
                None => return SubpathResolution::Excluded,
                Some(t) => t,
            };
            let captured = &key[prefix.len()..key.len() - suffix.len()];
            let repl_star = match target.find('*') {
                Some(i) => i,
                None => continue,
            };
            let result = format!(
                "{}{}{}",
                &target[..repl_star],
                captured,
                &target[repl_star + 1..]
            );
            return SubpathResolution::Matched(result);
        }
    }
    SubpathResolution::NoMatch
}

/// Build a package's exports map: the exact-alias table and wildcard
/// patterns, from `main`/`module` (the `.` fall-back) plus the
/// `exports` field, selected against `conditions`. Mirrors
/// `inferExportsEntries` + the alias/pattern split.
fn build_export_map(
    pkg: &PackageMetadata,
    conditions: &BTreeSet<String>,
) -> (BTreeMap<String, String>, Vec<(String, Option<String>)>) {
    let mut entries: Vec<(String, Option<String>)> = Vec::new();
    // Lowest precedence: the `.` main / module fall-back.
    if pkg.module.is_some() && conditions.contains("import") {
        entries.push((
            ".".to_string(),
            Some(relativize(pkg.module.as_ref().unwrap())),
        ));
    } else if let Some(main) = &pkg.main {
        entries.push((".".to_string(), Some(relativize(main))));
    }
    if let Some(exports) = &pkg.exports {
        interpret_exports(".", exports, conditions, &mut entries);
    }
    split_aliases_and_patterns(entries)
}

/// Build a package's `#imports` map (exact internal aliases + import
/// patterns), selected against `conditions`.
fn build_import_map(
    pkg: &PackageMetadata,
    conditions: &BTreeSet<String>,
) -> (BTreeMap<String, String>, Vec<(String, Option<String>)>) {
    let mut entries: Vec<(String, Option<String>)> = Vec::new();
    if let Some(imports) = &pkg.imports {
        interpret_imports(imports, conditions, &mut entries);
    }
    split_aliases_and_patterns(entries)
}

/// Whether `spec` carries a URI scheme (`endo:lib`, `h2g2:meaning`) as
/// opposed to a bare package or relative specifier. A scheme is
/// `^[A-Za-z][A-Za-z0-9+.-]*:` with no `/` before the `:`. Scheme
/// specifiers are host/exit modules, resolved through a hook rather
/// than the filesystem walk.
fn is_scheme_specifier(spec: &str) -> bool {
    let bytes = spec.as_bytes();
    if bytes.is_empty() || !bytes[0].is_ascii_alphabetic() {
        return false;
    }
    for (i, &b) in bytes.iter().enumerate() {
        if b == b':' {
            return i > 0;
        }
        if !(b.is_ascii_alphanumeric() || b == b'+' || b == b'.' || b == b'-') {
            return false;
        }
    }
    false
}

/// The parser language for a source file, given whether its enclosing
/// package resolves `.js` to ECMAScript modules (see
/// [`PackageMetadata::is_module`]).
///
/// This mirrors `@endo/compartment-mapper`'s per-package
/// `inferParsers`: `.mjs` -> `mjs`, `.cjs` -> `cjs`, `.json` -> `json`
/// unconditionally, while a bare `.js` is `mjs` in a module package
/// and `cjs` otherwise. It supersedes the extension-only
/// [`parser_for_extension`] for the walk's language decision, which is the
/// Group A (CommonJS `require`) step of the fixture-parity ratchet:
/// a `.js` under a `"type": "commonjs"` package must be scanned for
/// `require()` edges, not ES `import`s.
fn language_for_file(path: &Path, is_module: bool) -> Option<&'static str> {
    let ext = path
        .extension()
        .and_then(OsStr::to_str)?
        .to_ascii_lowercase();
    match ext.as_str() {
        "mjs" => Some("mjs"),
        "cjs" => Some("cjs"),
        "json" => Some("json"),
        "js" => Some(if is_module { "mjs" } else { "cjs" }),
        _ => None,
    }
}

/// Intern a resolved language name into the fixed set of parser tags the
/// walker can represent and record in a compartment map. compartment-mapper
/// validates that every language a `languageForExtension` map names has a
/// registered parser (`validateLanguageForExtension`); the walker mirrors
/// that closed set — an unknown language is `None` (an unsupported-parser
/// error at the call site), never silently accepted.
fn intern_language(language: &str) -> Option<&'static str> {
    match language {
        "mjs" => Some("mjs"),
        "cjs" => Some("cjs"),
        "json" => Some("json"),
        "text" => Some("text"),
        "bytes" => Some("bytes"),
        "jsonp" => Some("jsonp"),
        _ => None,
    }
}

/// The built-in `defaultLanguageForExtension` compartment-mapper seeds every
/// package with (`node-modules.js`), minus the per-package-`type` `js`
/// classification, which the walker drives through the enclosing
/// compartment's `is_module` instead. Non-`js` extensions the default map
/// does not name are `None`.
fn default_language_for_extension(extension: &str) -> Option<&'static str> {
    match extension {
        "mjs" => Some("mjs"),
        "cjs" => Some("cjs"),
        "json" => Some("json"),
        "text" => Some("text"),
        "bytes" => Some("bytes"),
        _ => None,
    }
}

/// [`default_language_for_extension`] over a path extension (`Option<&OsStr>`,
/// matched case-insensitively).
fn default_language_for_extension_os(extension: Option<&OsStr>) -> Option<&'static str> {
    let extension = extension?.to_str()?.to_ascii_lowercase();
    default_language_for_extension(&extension)
}

/// Resolve a source file's parser language, mirroring compartment-mapper's
/// `inferParsers` precedence: a bare `.js` is classified by the enclosing
/// package's module/commonjs type (`is_module`, which already reflects a
/// package-local `parsers.js` override); every other extension is looked up
/// in the package-local `"parsers"` map first, then the emulated
/// `languageForExtension`, then the built-in defaults. An extension no layer
/// names — or one mapped to a language the walker cannot represent — is
/// `None` (an unsupported-language error at the call site).
fn resolve_module_language(
    path: &Path,
    is_module: bool,
    package_parsers: &BTreeMap<String, String>,
    language_for_extension: &BTreeMap<String, String>,
) -> Option<&'static str> {
    let ext = path
        .extension()
        .and_then(OsStr::to_str)?
        .to_ascii_lowercase();
    if ext == "js" {
        return Some(if is_module { "mjs" } else { "cjs" });
    }
    if let Some(language) = package_parsers.get(&ext) {
        return intern_language(language);
    }
    if let Some(language) = language_for_extension.get(&ext) {
        return intern_language(language);
    }
    default_language_for_extension(&ext)
}

/// Stable, compartment-local CAS location for a synthetic module. Hashing the
/// specifier keeps URI schemes and scoped bare names from becoming path
/// syntax while giving identical hook inputs an identical archive root.
fn synthetic_module_location(specifier: &str) -> String {
    let digest = Sha256::digest(specifier.as_bytes());
    // Walker compartment manifests are flat CAS trees (their keys may name
    // ordinary nested files, but synthetic sources do not need to mirror a
    // disk path). Keep this location to one path component so the CAS reader
    // can fetch it without requiring an otherwise-unnecessary child tree.
    format!("__synthetic_{}.js", hex::encode(&digest[..16]))
}

fn compartment_id_for(name: &str, version: &str) -> String {
    // The `@endo/compartment-mapper` output uses
    // `<unscoped-name>-v<version>` for scoped packages and
    // `<name>-v<version>` for unscoped. We mirror that
    // convention so the synthesised archives are recognisable
    // alongside ZIP-shaped ones.
    let unscoped = name.rsplit('/').next().unwrap_or(name);
    format!("{unscoped}-v{version}")
}

fn path_to_forward_slashes(path: &Path) -> String {
    let mut parts: Vec<String> = Vec::new();
    for comp in path.components() {
        if let std::path::Component::Normal(c) = comp {
            parts.push(c.to_string_lossy().into_owned());
        }
    }
    parts.join("/")
}

/// Lexically normalise a path, collapsing `.` and `..` components
/// without consulting the filesystem (the path may name a file that
/// does not exist — the alias key for an extension-omitting relative
/// specifier). `..` pops the previous normal component.
fn lexically_normalize(path: &Path) -> PathBuf {
    use std::path::Component;
    let mut stack: Vec<std::ffi::OsString> = Vec::new();
    let mut prefix = PathBuf::new();
    for comp in path.components() {
        match comp {
            Component::CurDir => {}
            Component::ParentDir => {
                stack.pop();
            }
            Component::Normal(c) => stack.push(c.to_os_string()),
            other => prefix.push(other.as_os_str()),
        }
    }
    let mut out = prefix;
    for c in stack {
        out.push(c);
    }
    out
}

/// The compartment-relative form of a *written* relative specifier,
/// without resolving its extension or directory `index` — e.g. a
/// `./cycle1` written in a file at the compartment root yields
/// `Some("./cycle1")`. This is the key compartment-mapper uses for the
/// alias link it records alongside the resolved file when the written
/// specifier omits the extension. Returns `None` for a non-relative
/// specifier or one that escapes the compartment root.
fn compartment_relative_written(
    importer_abs: &Path,
    spec: &str,
    comp_root: &Path,
) -> Option<String> {
    if !(spec.starts_with("./") || spec.starts_with("../")) {
        return None;
    }
    let importer_directory = importer_abs.parent()?;
    let normalized = lexically_normalize(&importer_directory.join(spec));
    let rel = normalized.strip_prefix(comp_root).ok()?;
    Some(format!("./{}", path_to_forward_slashes(rel)))
}

// Walker: graph traversal + CAS emission

struct Compartment {
    /// `<unscoped-name>-v<version>` (or `entry-v1.0.0` for the
    /// entry compartment when the entry has no `package.json`).
    id: String,
    /// Human-readable name (the `name` field from `package.json`,
    /// or `"entry"`). Surfaces as the compartment's `name`
    /// property in the synthesised `compartment-map.json`.
    name: String,
    /// The package `version` (`"0.0.0"` when the manifest omits it).
    /// Retained so the final compartment id (`<name>-v<version>`, plus a
    /// `-n<k>` disambiguator for duplicate name/version copies) can be
    /// assigned after the walk completes — see [`Walker::final_ids`].
    version: String,
    /// Filesystem root the compartment is anchored at. All file
    /// paths recorded in `modules` below are descendants.
    root: PathBuf,
    /// Whether this compartment's package resolves `.js` to ES modules
    /// (`"type": "module"` / a `"module"` field) versus CommonJS. Used
    /// to classify a `.js` source into `mjs`/`cjs` — which in turn
    /// selects the ES-`import` scan versus the `require()` scan.
    is_module: bool,
    /// Only the entry compartment may admit development-only dependencies.
    /// Dependency compartments always set this false.
    include_dev_dependencies: bool,
    /// The package-local `"parsers"` map (extension -> language) read from
    /// this compartment's `package.json`. Overrides the built-in and
    /// emulated `languageForExtension` when classifying a non-`js` module in
    /// this compartment (`fixtures-assets`'s `uint32` -> `bytes`). Empty for a
    /// synthetic entry compartment with no manifest.
    parsers: BTreeMap<String, String>,
    /// Per-specifier module record. Keys are compartment-rooted
    /// specifiers (`"./index.js"`, `"./lib/util.js"`, `"."` for
    /// a package's main entry). Values are either a `File`
    /// (in-tree source) or a `Link` (cross-compartment).
    modules: HashMap<String, ModuleRecord>,
    /// `(compartment_id, specifier)` for in-tree sources
    /// recorded in the order they were observed; used to keep
    /// the CAS tree's per-package file ordering deterministic
    /// when serialising.
    in_order_specs: Vec<String>,
}

enum ModuleRecord {
    File {
        /// Path on disk of the source file. The walker writes
        /// the file into the CAS exactly once even if the same
        /// file is reached via multiple specifiers in the same
        /// compartment.
        abs_path: PathBuf,
        /// `mjs`, `cjs`, or `json`.
        parser: &'static str,
        /// The compartment-rooted file location written to the
        /// compartment-map.json's `location` field. Stable
        /// across runs because it is derived from the path
        /// relative to `Compartment::root`.
        location: String,
    },
    /// Source text supplied by the host for a non-file module specifier.
    /// It is materialized into the CAS alongside filesystem sources so the
    /// ordinary archive runtime can execute it without ambient host powers.
    Synthetic {
        source: String,
        parser: &'static str,
        location: String,
        exit_specifier: String,
    },
    Link {
        target_compartment_id: String,
        target_specifier: String,
    },
    /// An import/require specifier that could not be resolved. Rather
    /// than failing the whole walk, the walker records a deferred
    /// error — matching `@endo/compartment-mapper`, whose linker
    /// tolerates an unresolvable edge so the archive still builds and
    /// the error surfaces only if that module is actually imported at
    /// runtime. The message is informational; the parity comparison
    /// only distinguishes the *kind* of descriptor.
    DeferredError { message: String },
}

struct WalkerQueueItem {
    compartment_id: String,
    specifier: String,
    input: WalkerModuleInput,
    parser: String,
}

enum WalkerModuleInput {
    File {
        absolute_path: PathBuf,
    },
    Synthetic {
        source: String,
        location: String,
        exit_specifier: String,
        importer_path: PathBuf,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
enum EnqueuedModule {
    File(PathBuf),
    Synthetic(String),
}

struct Walker<'a> {
    cas: &'a ContentStore,
    compartments: HashMap<String, Compartment>,
    /// Map from package_root canonical path to compartment id,
    /// so two bare imports of the same package via different
    /// importers share one compartment.
    pkg_root_to_id: HashMap<PathBuf, String>,
    /// Per-base-id occurrence counter. Two *distinct* package roots that
    /// share a `<name>-v<version>` base id (duplicate installed copies —
    /// `fixtures-stability`'s three `dep@1.0.0` copies, `fixtures-1`'s two
    /// `evan@1.0.0` copies) each become their own compartment. The first
    /// occurrence keeps the bare base id; later ones get a
    /// collision-proof provisional suffix (`<base>#<k>`). These provisional
    /// ids are internal bookkeeping only; the walk assigns the final,
    /// compartment-mapper-compatible ids (`<base>` / `<base>-n<k>`) after
    /// it completes — see [`Walker::final_ids`].
    id_counter: HashMap<String, usize>,
    queue: Vec<WalkerQueueItem>,
    /// Per-compartment set of file paths already enqueued, to
    /// stop the BFS from re-visiting the same file twice.
    enqueued_in_compartment: HashMap<String, std::collections::HashSet<EnqueuedModule>>,
    /// Emulated harness inputs (condition set + host/exit modules) the
    /// walk resolves against (see [`WalkOptions`]).
    options: WalkOptions,
    /// Resolved common-dependency injections: alias specifier -> the
    /// installed package root it resolves to (from
    /// [`WalkOptions::common_dependencies`], resolved once against the entry
    /// package's `node_modules`). A reached import of an alias links to this
    /// package from any compartment, regardless of the importer's declared
    /// dependencies.
    common_dependency_targets: HashMap<String, PathBuf>,
    /// Compartments whose declared dependencies have already been expanded
    /// because one of their modules contains an opaque dynamic import.
    opaque_dynamic_import_compartments: std::collections::HashSet<String>,
}

impl<'a> Walker<'a> {
    fn new(cas: &'a ContentStore, options: WalkOptions) -> Self {
        Self {
            cas,
            compartments: HashMap::new(),
            pkg_root_to_id: HashMap::new(),
            id_counter: HashMap::new(),
            queue: Vec::new(),
            enqueued_in_compartment: HashMap::new(),
            options,
            common_dependency_targets: HashMap::new(),
            opaque_dynamic_import_compartments: std::collections::HashSet::new(),
        }
    }

    /// Resolve the [`WalkOptions::common_dependencies`] aliases against the
    /// entry package's `node_modules` once, recording each alias -> resolved
    /// package root. compartment-mapper resolves a common dependency from
    /// the entry package's own `dependencies` and makes that single
    /// location available under the alias to every package in the graph.
    fn resolve_common_dependencies(&mut self, entry_directory: &Path) {
        for (alias, target_name) in &self.options.common_dependencies {
            if let Some(root) = find_node_modules_package(entry_directory, target_name) {
                self.common_dependency_targets.insert(alias.clone(), root);
            }
        }
    }

    /// Create a fresh compartment rooted at `root`, keyed by a
    /// collision-proof provisional id derived from `base_id`
    /// (`<name>-v<version>` or the synthetic entry id). The first
    /// compartment for a given `base_id` keeps the bare base; a duplicate
    /// installed copy (a distinct root that resolves to the same base id)
    /// gets a `<base_id>#<k>` provisional suffix so it becomes its own
    /// compartment rather than silently collapsing into the first. Returns
    /// the assigned provisional id. Callers dedup a *shared* package root
    /// via [`Walker::intern_compartment`] before reaching here; this always
    /// creates a new compartment.
    fn add_compartment(
        &mut self,
        base_id: String,
        name: String,
        version: String,
        root: PathBuf,
        is_module: bool,
        include_dev_dependencies: bool,
    ) -> String {
        let canonical_root = root.canonicalize().unwrap_or(root);
        let count = self.id_counter.entry(base_id.clone()).or_insert(0);
        let id = if *count == 0 {
            base_id.clone()
        } else {
            format!("{base_id}#{count}")
        };
        *count += 1;
        // Read this package's `"parsers"` map once, at compartment creation,
        // so a non-`js` module's language can be classified against it (plus
        // the emulated `languageForExtension` and the built-in defaults)
        // without re-reading the manifest per module.
        let parsers = load_package_metadata(&canonical_root)
            .map(|meta| meta.parsers)
            .unwrap_or_default();
        self.pkg_root_to_id
            .insert(canonical_root.clone(), id.clone());
        self.compartments.insert(
            id.clone(),
            Compartment {
                id: id.clone(),
                name,
                version,
                root: canonical_root,
                is_module,
                include_dev_dependencies,
                parsers,
                modules: HashMap::new(),
                in_order_specs: Vec::new(),
            },
        );
        id
    }

    /// Return the compartment id for the package rooted at `root`,
    /// creating one if this root has not been seen. Two bare imports of the
    /// *same* installed package (same canonical root) share one
    /// compartment; two *distinct* roots that happen to share a
    /// `<name>-v<version>` become separate compartments (see
    /// [`Walker::add_compartment`]).
    fn intern_compartment(
        &mut self,
        name: &str,
        version: &str,
        root: &Path,
        is_module: bool,
    ) -> String {
        let canonical_root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
        if let Some(id) = self.pkg_root_to_id.get(&canonical_root) {
            return id.clone();
        }
        let base_id = compartment_id_for(name, version);
        self.add_compartment(
            base_id,
            name.to_string(),
            version.to_string(),
            canonical_root,
            is_module,
            false,
        )
    }

    /// The order in which compartment-mapper's node_modules graph builder
    /// discovers packages: a depth-first pre-order walk from the entry
    /// compartment, visiting each compartment's cross-compartment
    /// dependency edges in sorted order (by target package name, then by
    /// the importing specifier), with a global visited set so a shared
    /// package is discovered once at its first reach. This reproduces
    /// `graphPackage`'s traversal (`packages/compartment-mapper/src/
    /// node-modules.js`: children gathered in `[...allDependencies].sort()`
    /// order, `graph[location]` set on first visit), which is the tie-break
    /// `makeArchiveCompartmentMap` relies on when numbering duplicate
    /// name/version copies (`<base>-n<k>`).
    fn discovery_order(&self, entry_id: &str) -> Vec<String> {
        let mut visited: std::collections::HashSet<String> = std::collections::HashSet::new();
        let mut order: Vec<String> = Vec::new();
        let mut stack: Vec<String> = vec![entry_id.to_string()];
        while let Some(id) = stack.pop() {
            if !visited.insert(id.clone()) {
                continue;
            }
            order.push(id.clone());
            let Some(comp) = self.compartments.get(&id) else {
                continue;
            };
            let mut edges: Vec<(String, String, String)> = Vec::new();
            for (spec, rec) in &comp.modules {
                if let ModuleRecord::Link {
                    target_compartment_id,
                    ..
                } = rec
                {
                    if *target_compartment_id != id {
                        let target_name = self
                            .compartments
                            .get(target_compartment_id)
                            .map(|c| c.name.clone())
                            .unwrap_or_default();
                        edges.push((target_name, spec.clone(), target_compartment_id.clone()));
                    }
                }
            }
            edges.sort();
            // Push in reverse so the sorted-first edge is popped (and thus
            // pre-order-visited) first.
            for (_, _, target_id) in edges.into_iter().rev() {
                if !visited.contains(&target_id) {
                    stack.push(target_id);
                }
            }
        }
        // Any compartment unreachable from the entry (there should be none
        // in a well-formed walk) is appended by provisional id, so the map
        // is deterministic regardless.
        let mut rest: Vec<String> = self
            .compartments
            .keys()
            .filter(|k| !visited.contains(*k))
            .cloned()
            .collect();
        rest.sort();
        order.extend(rest);
        order
    }

    /// Assign the final compartment ids, mapping each provisional id to a
    /// compartment-mapper-compatible `<name>-v<version>` — with a `-n<k>`
    /// disambiguator for duplicate name/version copies. This mirrors
    /// `makeArchiveCompartmentMap`'s `renameCompartments`
    /// (`packages/compartment-mapper/src/archive-lite.js`): sort every
    /// compartment by its `<name>-v<version>` label (ties broken by
    /// discovery order — the [`Walker::discovery_order`] the node graph
    /// builder would produce), then walk the sorted run, numbering the
    /// second and later compartments that share a package `name`
    /// `-n1`, `-n2`, ....
    fn final_ids(&self, entry_id: &str) -> HashMap<String, String> {
        let order = self.discovery_order(entry_id);
        let discovery_index: HashMap<&String, usize> =
            order.iter().enumerate().map(|(i, id)| (id, i)).collect();
        let mut items: Vec<(String, String, String, usize)> = self
            .compartments
            .values()
            .map(|c| {
                let label = compartment_id_for(&c.name, &c.version);
                let discovery_position = *discovery_index.get(&c.id).unwrap_or(&usize::MAX);
                (label, c.name.clone(), c.id.clone(), discovery_position)
            })
            .collect();
        // Stable-sort by label; the explicit discovery-order tie-break keeps
        // duplicate-label copies in the same relative order the node graph
        // builder inserts them, so the `-n<k>` numbering matches.
        items.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.3.cmp(&b.3)));

        let mut ids = HashMap::new();
        let mut prev: Option<String> = None;
        let mut index = 1usize;
        for (label, name, provisional, _) in items {
            let final_id = if prev.as_deref() == Some(name.as_str()) {
                let id = format!("{label}-n{index}");
                index += 1;
                id
            } else {
                prev = Some(name.clone());
                index = 1;
                label.clone()
            };
            ids.insert(provisional, final_id);
        }
        ids
    }

    /// Classify a file's parser language against a compartment's package
    /// `"parsers"` map, the emulated `languageForExtension`, and the built-in
    /// defaults (see [`resolve_module_language`]). The compartment must
    /// already exist.
    fn language_for_module(&self, path: &Path, compartment_id: &str) -> Option<&'static str> {
        let comp = self.compartments.get(compartment_id)?;
        resolve_module_language(
            path,
            comp.is_module,
            &comp.parsers,
            &self.options.language_for_extension,
        )
    }

    fn enqueue_file(
        &mut self,
        compartment_id: String,
        specifier: String,
        absolute_path: PathBuf,
        parser: String,
    ) {
        let set = self
            .enqueued_in_compartment
            .entry(compartment_id.clone())
            .or_default();
        if !set.insert(EnqueuedModule::File(absolute_path.clone())) {
            // Already enqueued / visited in this compartment.
            // Still ensure the specifier-to-file mapping is
            // recorded so the compartment-map carries it.
            return;
        }
        self.queue.push(WalkerQueueItem {
            compartment_id,
            specifier,
            input: WalkerModuleInput::File { absolute_path },
            parser,
        });
    }

    fn enqueue_synthetic(
        &mut self,
        compartment_id: String,
        specifier: String,
        source: String,
        parser: String,
        importer_path: PathBuf,
    ) {
        let set = self
            .enqueued_in_compartment
            .entry(compartment_id.clone())
            .or_default();
        if !set.insert(EnqueuedModule::Synthetic(specifier.clone())) {
            return;
        }
        let location = synthetic_module_location(&specifier);
        self.queue.push(WalkerQueueItem {
            compartment_id,
            specifier: specifier.clone(),
            input: WalkerModuleInput::Synthetic {
                source,
                location,
                exit_specifier: specifier,
                importer_path,
            },
            parser,
        });
    }

    fn drain(&mut self) -> io::Result<()> {
        while let Some(item) = self.queue.pop() {
            self.visit(item)?;
        }
        Ok(())
    }

    fn visit(&mut self, item: WalkerQueueItem) -> io::Result<()> {
        let WalkerQueueItem {
            compartment_id,
            specifier,
            input,
            parser,
        } = item;

        // Record the module entry in its compartment.
        let comp_root = {
            let comp = self.compartments.get(&compartment_id).ok_or_else(|| {
                io::Error::other(format!("walker missing compartment {compartment_id}"))
            })?;
            comp.root.clone()
        };

        let static_parser: &'static str = intern_language(&parser).ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                format!("unsupported parser {parser} for module {specifier}"),
            )
        })?;

        let (source_bytes, resolution_path, source_origin) = match &input {
            WalkerModuleInput::File { absolute_path } => {
                let bytes = std::fs::read(absolute_path)?;
                (
                    bytes,
                    absolute_path.clone(),
                    ModuleSourceOrigin::File {
                        path: absolute_path,
                    },
                )
            }
            WalkerModuleInput::Synthetic {
                source,
                exit_specifier,
                importer_path,
                ..
            } => (
                source.as_bytes().to_vec(),
                importer_path.clone(),
                ModuleSourceOrigin::SyntheticExit {
                    specifier: exit_specifier,
                },
            ),
        };

        {
            let comp = self.compartments.get_mut(&compartment_id).unwrap();
            let record = match &input {
                WalkerModuleInput::File { absolute_path } => {
                    let relative_path =
                        absolute_path.strip_prefix(&comp_root).map_err(|error| {
                            io::Error::new(
                                io::ErrorKind::InvalidInput,
                                format!(
                                    "{} not under compartment root {}: {error}",
                                    absolute_path.display(),
                                    comp_root.display()
                                ),
                            )
                        })?;
                    ModuleRecord::File {
                        abs_path: absolute_path.clone(),
                        parser: static_parser,
                        location: path_to_forward_slashes(relative_path),
                    }
                }
                WalkerModuleInput::Synthetic {
                    source,
                    location,
                    exit_specifier,
                    ..
                } => ModuleRecord::Synthetic {
                    source: source.clone(),
                    parser: static_parser,
                    location: location.clone(),
                    exit_specifier: exit_specifier.clone(),
                },
            };
            comp.modules.insert(specifier.clone(), record);
            if !comp.in_order_specs.contains(&specifier) {
                comp.in_order_specs.push(specifier.clone());
            }
        }

        if let Some(module_source_hook) = &self.options.module_source_hook {
            let compartment_name = &self.compartments[&compartment_id].name;
            module_source_hook(ModuleSource {
                compartment_name,
                specifier: &specifier,
                parser: static_parser,
                bytes: &source_bytes,
                origin: source_origin,
            })
            .map_err(|error| {
                io::Error::new(
                    error.kind(),
                    format!("module source hook for {specifier}: {error}"),
                )
            })?;
        }

        // Discover this module's out-edges. A CommonJS module is
        // scanned for direct `require()` calls and literal
        // `require.resolve()` targets; an ES module for static
        // `import` / `export ... from` and literal dynamic `import()`.
        // JSON and the asset languages (`text`, `bytes`, `jsonp`) have no
        // module edges and are leaf modules, so the source is read (as
        // UTF-8) only for the scannable languages — a `bytes` asset need not
        // be valid UTF-8.
        let source_text = || {
            std::str::from_utf8(&source_bytes).map_err(|error| {
                io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("cannot read module {specifier} as utf-8: {error}"),
                )
            })
        };
        let specifiers: Vec<String> = match static_parser {
            "cjs" => scan_cjs_requires(source_text()?),
            "mjs" => {
                let scanned = scan_static_imports(source_text()?);
                if scanned.has_opaque_dynamic_import {
                    self.include_opaque_dynamic_import_dependencies(
                        &compartment_id,
                        &resolution_path,
                    )?;
                }
                let mut specifiers = scanned.specifiers;
                for dynamic_specifier in scanned.dynamic_specifiers {
                    if !specifiers.contains(&dynamic_specifier) {
                        specifiers.push(dynamic_specifier);
                    }
                }
                specifiers
            }
            _ => return Ok(()),
        };
        for spec in &specifiers {
            if matches!(input, WalkerModuleInput::Synthetic { .. })
                && (spec.starts_with("./") || spec.starts_with("../"))
            {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    format!(
                        "synthetic module {specifier} cannot resolve relative import {spec} without a file location"
                    ),
                ));
            }
            self.handle_import(&compartment_id, &resolution_path, spec)?;
        }

        Ok(())
    }

    /// Retain every declared dependency that an opaque runtime `import()`
    /// might name. Compartment-mapper builds this package graph before source
    /// analysis, so an expression-valued import can resolve any enabled
    /// runtime dependency even though the source scanner cannot name its
    /// target. Optional dependencies participate only when installed, and
    /// development dependencies remain confined to a dev-enabled entry.
    fn include_opaque_dynamic_import_dependencies(
        &mut self,
        compartment_id: &str,
        importer_path: &Path,
    ) -> io::Result<()> {
        if !self
            .opaque_dynamic_import_compartments
            .insert(compartment_id.to_string())
        {
            return Ok(());
        }

        let compartment = self
            .compartments
            .get(compartment_id)
            .ok_or_else(|| io::Error::other(format!("missing compartment {compartment_id}")))?;
        let compartment_root = compartment.root.clone();
        let include_dev_dependencies = compartment.include_dev_dependencies;
        let Ok(metadata) = load_package_metadata(&compartment_root) else {
            // A synthetic entry has no package graph to retain.
            return Ok(());
        };

        let mut dependency_names = metadata.runtime_dependencies;
        dependency_names.extend(
            metadata
                .optional_dependencies
                .into_iter()
                .filter(|name| find_node_modules_package(&compartment_root, name).is_some()),
        );
        if include_dev_dependencies {
            dependency_names.extend(metadata.dev_dependencies);
        }

        for dependency_name in dependency_names {
            self.handle_import(compartment_id, importer_path, &dependency_name)?;
        }
        Ok(())
    }

    /// Give the configured host hook an opportunity to supply a synthetic
    /// module for a non-file specifier. Returns `true` when the hook supplied
    /// a source and the module was queued.
    fn try_exit_module_import(
        &mut self,
        compartment_id: &str,
        importer_path: &Path,
        specifier: &str,
    ) -> io::Result<bool> {
        let Some(exit_module_import_hook) = self.options.exit_module_import_hook.clone() else {
            return Ok(false);
        };
        let compartment_name = self
            .compartments
            .get(compartment_id)
            .ok_or_else(|| io::Error::other(format!("missing compartment {compartment_id}")))?
            .name
            .clone();
        let source = exit_module_import_hook(ExitModuleImport {
            specifier,
            importer_path,
            compartment_name: &compartment_name,
        })
        .map_err(|error| {
            io::Error::new(
                error.kind(),
                format!("exit module import hook for {specifier}: {error}"),
            )
        })?;
        let Some(source) = source else {
            return Ok(false);
        };
        if source.parser != "mjs" {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!(
                    "exit module import hook for {specifier} returned unsupported parser {}; synthetic exit modules must use mjs",
                    source.parser
                ),
            ));
        }
        self.enqueue_synthetic(
            compartment_id.to_string(),
            specifier.to_string(),
            source.source,
            source.parser,
            importer_path.to_path_buf(),
        );
        Ok(true)
    }

    fn handle_import(
        &mut self,
        compartment_id: &str,
        importer_abs: &Path,
        spec: &str,
    ) -> io::Result<()> {
        let comp_root = {
            let comp = self
                .compartments
                .get(compartment_id)
                .ok_or_else(|| io::Error::other(format!("missing compartment {compartment_id}")))?;
            comp.root.clone()
        };

        let comp_is_module = self.compartments[compartment_id].is_module;

        // The importing package's `browser` resolve field, interpreted only
        // when the `browser` build condition is active (`fixtures-resolve`).
        // It remaps this package's own specifiers before the ordinary walk.
        let browser_meta = if self.options.browser {
            load_package_metadata(&comp_root).ok()
        } else {
            None
        };

        // --- Group C routing (conditional/subpath exports & #imports) ---

        // `#imports`: a package-internal self-reference resolved against
        // the *importing* package's `imports` field, within the same
        // compartment.
        if spec.starts_with('#') {
            return self.handle_internal_import(compartment_id, &comp_root, importer_abs, spec);
        }

        // A host/exit specifier (`endo:lib`, `builtin`) declared via the
        // emulated `modules` option is recorded as an `{ exit }` module.
        // A *scheme* specifier not so declared (no import hook in the
        // parity run) is dropped, exactly as compartment-mapper's
        // archive mapper drops it — see design §2, Group F/host hooks.
        let is_relative = spec.starts_with("./") || spec.starts_with("../");
        if !is_relative {
            // A common-dependency alias (compartment-mapper's
            // `commonDependencies`) resolves to a single injected package
            // available to every compartment, ahead of the ordinary
            // node_modules walk and its dependency-classification gate.
            if let Some((alias, subpath)) = split_bare_specifier(spec) {
                if let Some(target_root) = self.common_dependency_targets.get(&alias).cloned() {
                    return self.record_common_dependency(
                        compartment_id,
                        spec,
                        &target_root,
                        subpath,
                    );
                }
            }

            // The importing package's `browser` field may remap a bare
            // specifier by its package name — to another package
            // (`abc`->`browser-abc`, keeping any subpath) or to a
            // same-compartment file (`ijk`->`./browser-ijk.js`) — ahead of
            // the node_modules walk and its classification gate.
            if let Some(meta) = &browser_meta {
                if let Some((pkg, subpath)) = split_bare_specifier(spec) {
                    let bare_remap = meta.browser.bare_remap(meta.main.as_deref());
                    if let Some(target) = bare_remap.get(&pkg).cloned() {
                        return self.record_browser_bare_remap(
                            compartment_id,
                            &comp_root,
                            comp_is_module,
                            importer_abs,
                            spec,
                            &target,
                            subpath,
                        );
                    }
                }
            }

            // A declared host/exit module (`modules: { builtin: true }`)
            // or an un-hooked scheme specifier (`endo:lib`) is dropped
            // from the static map, exactly as compartment-mapper's
            // archive mapper drops it when no import hook is supplied to
            // the parity run (design §2, host modules). It is *not*
            // walked from disk (which would spuriously add a compartment)
            // and *not* recorded as a map entry.
            let is_exit = self.options.exit_modules.contains(spec)
                || split_bare_specifier(spec)
                    .map(|(pkg, _)| self.options.exit_modules.contains(&pkg))
                    .unwrap_or(false);
            if is_exit || is_scheme_specifier(spec) {
                if self.try_exit_module_import(compartment_id, importer_abs, spec)? {
                    return Ok(());
                }
                return Ok(());
            }

            // A package is reachable only through dependency fields declared
            // by its importing package. This is the classification boundary
            // compartment-mapper applies before it links modules: production
            // and peer dependencies always participate, optional dependencies
            // participate when installed, and devDependencies participate only
            // for an opted-in entry package (never transitively).
            if let Some((dependency_name, _)) = split_bare_specifier(spec) {
                if let Ok(metadata) = load_package_metadata(&comp_root) {
                    let include_dev_dependencies =
                        self.compartments[compartment_id].include_dev_dependencies;
                    // A package may import itself by its own bare name (with
                    // or without a subpath); self-references resolve through
                    // `exports` and are not dependency declarations.
                    if dependency_name != metadata.name
                        && metadata
                            .dependency_classification(&dependency_name, include_dev_dependencies)
                            == DependencyClassification::Excluded
                    {
                        if self.try_exit_module_import(compartment_id, importer_abs, spec)? {
                            return Ok(());
                        }
                        self.record_deferred_error(
                            compartment_id,
                            spec,
                            &format!(
                                "dependency {dependency_name} is not enabled by {}",
                                comp_root.join("package.json").display()
                            ),
                        );
                        return Ok(());
                    }
                }
            }
            // A bare import into a package that declares `exports`
            // resolves through the exports map (conditions + subpath
            // patterns), yielding the exact target — not the classic
            // default/index fall-back. Packages without `exports` fall
            // through to the classic resolver below.
            if let Some(res) = self.resolve_bare_exports(importer_abs, spec)? {
                return self.record_bare_exports(compartment_id, spec, res);
            }
        }

        let resolved = match resolve_specifier(importer_abs, spec, &comp_root, self.options.browser)
        {
            Ok(r) => r,
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                if !is_relative
                    && self.try_exit_module_import(compartment_id, importer_abs, spec)?
                {
                    return Ok(());
                }
                // An unresolvable edge is a deferred error, not a walk
                // failure: `@endo/compartment-mapper` records a
                // `deferredError` module (keyed by the specifier as
                // written) so the archive still builds and the error
                // surfaces only if the module is imported at runtime.
                self.record_deferred_error(compartment_id, spec, &e.to_string());
                return Ok(());
            }
            Err(e) => return Err(e),
        };

        match resolved {
            Resolved::Relative {
                abs_path,
                compartment_specifier,
                ..
            } => {
                // The importing package's `browser` field may remap a
                // resolved same-compartment file (`./xyz.js`->
                // `./browser-xyz.js`). The written specifier then links to
                // the remapped target and the original resolution is
                // discarded (the remapped file, not the source, is walked).
                if let Some(meta) = &browser_meta {
                    let relative_remap = meta.browser.relative_remap(meta.main.as_deref());
                    if let Some(target) = relative_remap.get(&compartment_specifier) {
                        return self.record_browser_relative_remap(
                            compartment_id,
                            &comp_root,
                            comp_is_module,
                            spec,
                            target,
                        );
                    }
                }

                // Classify the file against the *importing* compartment's
                // package type (a `.js` sibling shares its package, so a
                // CommonJS `.js` is scanned for `require()`) and its
                // `"parsers"` / the emulated `languageForExtension` (a
                // relatively-imported asset like `./text.text` /
                // `./uint32.uint32`).
                let parser = self
                    .language_for_module(&abs_path, compartment_id)
                    .ok_or_else(|| {
                        io::Error::new(
                            io::ErrorKind::InvalidData,
                            format!("unsupported extension for {}", abs_path.display()),
                        )
                    })?;

                // The resolved file, keyed by its compartment-relative
                // path (`./cycle1.js`). The `visit` re-derives the same
                // record idempotently.
                self.record_file(compartment_id, &compartment_specifier, &abs_path, parser)?;

                // When the specifier as written omits the extension (or
                // resolves through a directory `index`), the resolved
                // path differs from the written form; compartment-mapper
                // then also records the written specifier as a
                // same-compartment alias link to the resolved module.
                if let Some(alias) = compartment_relative_written(importer_abs, spec, &comp_root) {
                    if alias != compartment_specifier {
                        self.record_link(
                            compartment_id,
                            &alias,
                            compartment_id,
                            &compartment_specifier,
                        );
                    }
                }

                self.enqueue_file(
                    compartment_id.to_string(),
                    compartment_specifier,
                    abs_path,
                    parser.to_string(),
                );
            }
            Resolved::Bare {
                package_name,
                package_version,
                package_root,
                entry_file,
                compartment_specifier,
                subpath,
                package_has_exports,
                package_is_module,
                ..
            } => {
                let target_compartment_id = self.intern_compartment(
                    &package_name,
                    &package_version,
                    &package_root,
                    package_is_module,
                );

                let parser = self
                    .language_for_module(&entry_file, &target_compartment_id)
                    .ok_or_else(|| {
                        io::Error::new(
                            io::ErrorKind::InvalidData,
                            format!("unsupported extension for {}", entry_file.display()),
                        )
                    })?;

                // The importing compartment gets a Link entry under the
                // bare specifier the source author wrote, so the resolve
                // hook returns exactly that specifier string.
                self.record_link(
                    compartment_id,
                    spec,
                    &target_compartment_id,
                    &compartment_specifier,
                );

                // A classic (non-`exports`) deep import whose written
                // subpath omits the extension gets an alias link in the
                // *target* compartment (`./from-debug` -> `./from-debug.js`),
                // mirroring compartment-mapper. A package with an
                // `exports` map resolves the subpath to the exact target,
                // so no alias is synthesised.
                if let Some(sub) = &subpath {
                    if !package_has_exports {
                        let alias = format!("./{}", sub.trim_start_matches("./"));
                        if alias != compartment_specifier {
                            self.record_link(
                                &target_compartment_id,
                                &alias,
                                &target_compartment_id,
                                &compartment_specifier,
                            );
                        }
                    }
                }

                self.enqueue_file(
                    target_compartment_id,
                    compartment_specifier,
                    entry_file,
                    parser.to_string(),
                );
            }
        }
        Ok(())
    }

    /// Resolve a `#imports` self-reference (`#internal/util.js`)
    /// against the *importing* package's `imports` field, within the
    /// same compartment. Records a `Link` keyed by the `#` specifier
    /// plus the target file, matching compartment-mapper (design §1,
    /// Group C).
    fn handle_internal_import(
        &mut self,
        compartment_id: &str,
        comp_root: &Path,
        _importer_abs: &Path,
        spec: &str,
    ) -> io::Result<()> {
        let pkg_meta = match load_package_metadata(comp_root) {
            Ok(m) => m,
            Err(e) => {
                self.record_deferred_error(compartment_id, spec, &e.to_string());
                return Ok(());
            }
        };
        let (exact, patterns) = build_import_map(&pkg_meta, &self.options.conditions);
        match resolve_subpath_in_map(&exact, &patterns, spec) {
            SubpathResolution::Matched(target) => {
                let candidate = comp_root.join(target.trim_start_matches("./"));
                let abs = match canonicalize_within(comp_root, &candidate, spec) {
                    Ok(path) if path.is_file() => path,
                    _ => {
                        self.record_deferred_error(
                            compartment_id,
                            spec,
                            &format!("#imports target {target} for {spec} not found"),
                        );
                        return Ok(());
                    }
                };
                let parser = self
                    .language_for_module(&abs, compartment_id)
                    .ok_or_else(|| {
                        io::Error::new(
                            io::ErrorKind::InvalidData,
                            format!("unsupported extension for {}", abs.display()),
                        )
                    })?;
                // The `#` alias links (within the same compartment) to
                // the resolved module; the module itself is recorded as a
                // File when it is visited.
                self.record_link(compartment_id, spec, compartment_id, &target);
                self.enqueue_file(compartment_id.to_string(), target, abs, parser.to_string());
                Ok(())
            }
            SubpathResolution::Excluded => {
                self.record_deferred_error(
                    compartment_id,
                    spec,
                    &format!("#imports {spec} is excluded (null target)"),
                );
                Ok(())
            }
            SubpathResolution::NoMatch => {
                self.record_deferred_error(
                    compartment_id,
                    spec,
                    &format!("no #imports entry matches {spec}"),
                );
                Ok(())
            }
        }
    }

    /// Resolve a bare import into a dependency package that declares an
    /// `exports` field, through the conditional/subpath exports map.
    /// Returns `Ok(None)` when the package has no `exports` (or cannot
    /// be located), so the caller falls through to the classic
    /// `default`/`index` resolver; `Ok(Some(_))` otherwise (either a
    /// resolved module or an exclusion to record as a deferred error).
    fn resolve_bare_exports(
        &self,
        importer_abs: &Path,
        spec: &str,
    ) -> io::Result<Option<BareExportsResult>> {
        let importer_directory = match importer_abs.parent() {
            Some(p) => p,
            None => return Ok(None),
        };
        let (pkg_name, subpath) = match split_bare_specifier(spec) {
            Some(v) => v,
            None => return Ok(None),
        };
        let pkg_root = match find_node_modules_package(importer_directory, &pkg_name) {
            Some(r) => r,
            None => return Ok(None),
        };
        // An unreadable / missing package.json falls through to the
        // classic resolver, which records the deferred error identically
        // (a partially-installed dependency, not a walk failure).
        let pkg_meta = match load_package_metadata(&pkg_root) {
            Ok(m) => m,
            Err(_) => return Ok(None),
        };
        if pkg_meta.exports.is_none() {
            // No exports field: classic resolution path.
            return Ok(None);
        }

        let (exact, patterns) = build_export_map(&pkg_meta, &self.options.conditions);
        let key = match &subpath {
            None => ".".to_string(),
            Some(sub) => format!("./{}", sub.trim_start_matches("./")),
        };
        match resolve_subpath_in_map(&exact, &patterns, &key) {
            SubpathResolution::Matched(target) => {
                let candidate = pkg_root.join(target.trim_start_matches("./"));
                let entry_file = match canonicalize_within(&pkg_root, &candidate, spec) {
                    Ok(path) if path.is_file() => path,
                    _ => {
                        return Ok(Some(BareExportsResult::Deferred {
                            reason: format!(
                                "exports target {target} for {spec} does not resolve to a file"
                            ),
                        }));
                    }
                };
                Ok(Some(BareExportsResult::Module {
                    pkg_name: pkg_meta.name.clone(),
                    pkg_version: pkg_meta.version.clone(),
                    pkg_root,
                    pkg_is_module: pkg_meta.js_is_module(),
                    entry_file,
                    compartment_specifier: target,
                }))
            }
            SubpathResolution::Excluded => Ok(Some(BareExportsResult::Deferred {
                reason: format!("exports subpath {key} for {spec} is excluded (null target)"),
            })),
            SubpathResolution::NoMatch => Ok(Some(BareExportsResult::Deferred {
                reason: format!("no exports entry matches {key} for {spec}"),
            })),
        }
    }

    /// Record the result of an exports-map bare resolution: a
    /// cross-compartment (or reflexive self-) `Link` plus the enqueued
    /// target module, or a `DeferredError` for an exclusion / no-match.
    fn record_bare_exports(
        &mut self,
        compartment_id: &str,
        spec: &str,
        result: BareExportsResult,
    ) -> io::Result<()> {
        match result {
            BareExportsResult::Deferred { reason } => {
                self.record_deferred_error(compartment_id, spec, &reason);
                Ok(())
            }
            BareExportsResult::Module {
                pkg_name,
                pkg_version,
                pkg_root,
                pkg_is_module,
                entry_file,
                compartment_specifier,
            } => {
                let target_compartment_id =
                    self.intern_compartment(&pkg_name, &pkg_version, &pkg_root, pkg_is_module);
                let parser = language_for_file(&entry_file, pkg_is_module).ok_or_else(|| {
                    io::Error::new(
                        io::ErrorKind::InvalidData,
                        format!("unsupported extension for {}", entry_file.display()),
                    )
                })?;
                self.record_link(
                    compartment_id,
                    spec,
                    &target_compartment_id,
                    &compartment_specifier,
                );
                self.enqueue_file(
                    target_compartment_id,
                    compartment_specifier,
                    entry_file,
                    parser.to_string(),
                );
                Ok(())
            }
        }
    }

    /// Record a common-dependency alias import: a `Link` keyed by the
    /// alias specifier the author wrote (`unlisted-common-dep`) pointing at
    /// the injected target package's compartment, plus the enqueued target
    /// module. The target package resolves through its own `exports`/`main`
    /// (or an optional subpath) exactly like an ordinary bare import.
    fn record_common_dependency(
        &mut self,
        compartment_id: &str,
        spec: &str,
        target_root: &Path,
        subpath: Option<String>,
    ) -> io::Result<()> {
        let meta = load_package_metadata(target_root)?;
        let entry_file = match &subpath {
            None => resolve_package_main(target_root, &meta, self.options.browser)?,
            Some(sub) => {
                let candidate = target_root.join(sub);
                resolve_subpath(target_root, &candidate, sub)?
            }
        };
        let pkg_is_module = meta.js_is_module();
        let parser = language_for_file(&entry_file, pkg_is_module).ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                format!("unsupported extension for {}", entry_file.display()),
            )
        })?;
        let canonical_root = target_root
            .canonicalize()
            .unwrap_or_else(|_| target_root.to_path_buf());
        let rel = entry_file.strip_prefix(&canonical_root).map_err(|e| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("common-dependency entry file outside package root: {e}"),
            )
        })?;
        let compartment_specifier = format!("./{}", path_to_forward_slashes(rel));
        let target_compartment_id =
            self.intern_compartment(&meta.name, &meta.version, target_root, pkg_is_module);
        self.record_link(
            compartment_id,
            spec,
            &target_compartment_id,
            &compartment_specifier,
        );
        self.enqueue_file(
            target_compartment_id,
            compartment_specifier,
            entry_file,
            parser.to_string(),
        );
        Ok(())
    }

    /// Record a `browser`-field remap of a same-compartment file: the
    /// written specifier links to the remapped target file
    /// (`./xyz.js`->`./browser-xyz.js`, or a bare `ijk`->`./browser-ijk.js`),
    /// and the remapped file — not the original — is walked.
    fn record_browser_relative_remap(
        &mut self,
        compartment_id: &str,
        comp_root: &Path,
        comp_is_module: bool,
        written_spec: &str,
        target: &str,
    ) -> io::Result<()> {
        let target_norm = relativize(target);
        let target_abs = comp_root.join(target_norm.trim_start_matches("./"));
        let target_abs = target_abs.canonicalize().unwrap_or(target_abs);
        let parser = language_for_file(&target_abs, comp_is_module).ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                format!(
                    "unsupported extension for browser target {}",
                    target_abs.display()
                ),
            )
        })?;
        self.record_file(compartment_id, &target_norm, &target_abs, parser)?;
        if written_spec != target_norm {
            self.record_link(compartment_id, written_spec, compartment_id, &target_norm);
        }
        self.enqueue_file(
            compartment_id.to_string(),
            target_norm,
            target_abs,
            parser.to_string(),
        );
        Ok(())
    }

    /// Record a `browser`-field remap of a bare specifier by package name.
    /// A relative target maps to a same-compartment file; a bare target
    /// (`abc`->`browser-abc`, keeping any subpath) is resolved as an
    /// ordinary package import — through its `exports` or the classic
    /// cascade — but the cross-compartment `Link` is keyed by the *original*
    /// specifier the author wrote.
    fn record_browser_bare_remap(
        &mut self,
        compartment_id: &str,
        comp_root: &Path,
        comp_is_module: bool,
        importer_abs: &Path,
        written_spec: &str,
        target: &str,
        subpath: Option<String>,
    ) -> io::Result<()> {
        if target.starts_with("./") || target.starts_with("../") || target == "." {
            let joined = match &subpath {
                Some(sub) => format!("{}/{}", target.trim_end_matches('/'), sub),
                None => target.to_string(),
            };
            return self.record_browser_relative_remap(
                compartment_id,
                comp_root,
                comp_is_module,
                written_spec,
                &joined,
            );
        }

        let rewritten = match &subpath {
            Some(sub) => format!("{target}/{sub}"),
            None => target.to_string(),
        };

        // Exports-aware resolution first, then the classic cascade —
        // mirroring the ordinary bare-import path, but keyed by the
        // original written specifier.
        if let Some(res) = self.resolve_bare_exports(importer_abs, &rewritten)? {
            return self.record_bare_exports(compartment_id, written_spec, res);
        }

        match resolve_specifier(importer_abs, &rewritten, comp_root, self.options.browser) {
            Ok(Resolved::Bare {
                package_name,
                package_version,
                package_root,
                entry_file,
                compartment_specifier,
                subpath: resolved_subpath,
                package_has_exports,
                package_is_module,
                ..
            }) => {
                let target_compartment_id = self.intern_compartment(
                    &package_name,
                    &package_version,
                    &package_root,
                    package_is_module,
                );
                let parser =
                    language_for_file(&entry_file, package_is_module).ok_or_else(|| {
                        io::Error::new(
                            io::ErrorKind::InvalidData,
                            format!("unsupported extension for {}", entry_file.display()),
                        )
                    })?;
                self.record_link(
                    compartment_id,
                    written_spec,
                    &target_compartment_id,
                    &compartment_specifier,
                );
                if let Some(sub) = &resolved_subpath {
                    if !package_has_exports {
                        let alias = format!("./{}", sub.trim_start_matches("./"));
                        if alias != compartment_specifier {
                            self.record_link(
                                &target_compartment_id,
                                &alias,
                                &target_compartment_id,
                                &compartment_specifier,
                            );
                        }
                    }
                }
                self.enqueue_file(
                    target_compartment_id,
                    compartment_specifier,
                    entry_file,
                    parser.to_string(),
                );
                Ok(())
            }
            Ok(Resolved::Relative { .. }) => {
                self.record_deferred_error(
                    compartment_id,
                    written_spec,
                    "browser bare remap unexpectedly resolved to a relative path",
                );
                Ok(())
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                self.record_deferred_error(compartment_id, written_spec, &e.to_string());
                Ok(())
            }
            Err(e) => Err(e),
        }
    }

    /// Insert (idempotently) a `File` module record keyed by
    /// `specifier` into `compartment_id`, deriving the on-disk
    /// `location` from the file's path relative to the compartment
    /// root.
    fn record_file(
        &mut self,
        compartment_id: &str,
        specifier: &str,
        abs_path: &Path,
        parser: &'static str,
    ) -> io::Result<()> {
        let comp = self.compartments.get_mut(compartment_id).unwrap();
        let rel = abs_path
            .strip_prefix(&comp.root)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, format!("strip: {e}")))?;
        let location = path_to_forward_slashes(rel);
        comp.modules
            .entry(specifier.to_string())
            .or_insert(ModuleRecord::File {
                abs_path: abs_path.to_path_buf(),
                parser,
                location,
            });
        if !comp.in_order_specs.iter().any(|s| s == specifier) {
            comp.in_order_specs.push(specifier.to_string());
        }
        Ok(())
    }

    /// Insert a `Link` module record keyed by `specifier` into
    /// `compartment_id`, pointing at `target_specifier` in
    /// `target_compartment_id` (which may be the same compartment for a
    /// same-package alias).
    fn record_link(
        &mut self,
        compartment_id: &str,
        specifier: &str,
        target_compartment_id: &str,
        target_specifier: &str,
    ) {
        let comp = self.compartments.get_mut(compartment_id).unwrap();
        comp.modules.insert(
            specifier.to_string(),
            ModuleRecord::Link {
                target_compartment_id: target_compartment_id.to_string(),
                target_specifier: target_specifier.to_string(),
            },
        );
        if !comp.in_order_specs.iter().any(|s| s == specifier) {
            comp.in_order_specs.push(specifier.to_string());
        }
    }

    /// Insert a `DeferredError` module record keyed by `specifier`.
    fn record_deferred_error(&mut self, compartment_id: &str, specifier: &str, message: &str) {
        let comp = self.compartments.get_mut(compartment_id).unwrap();
        comp.modules
            .entry(specifier.to_string())
            .or_insert(ModuleRecord::DeferredError {
                message: message.to_string(),
            });
        if !comp.in_order_specs.iter().any(|s| s == specifier) {
            comp.in_order_specs.push(specifier.to_string());
        }
    }

    /// Serialise the gathered compartments to a
    /// compartment-map.json text.
    fn emit_map_json(
        &self,
        entry_compartment_id: &str,
        entry_specifier: &str,
        final_ids: &HashMap<String, String>,
    ) -> String {
        // Resolve a provisional compartment id to its final,
        // disambiguated form. Every compartment is in `final_ids`; the
        // fallback keeps the emitter total.
        let final_id = |provisional: &str| -> String {
            final_ids
                .get(provisional)
                .cloned()
                .unwrap_or_else(|| provisional.to_string())
        };

        // Sort compartments by their *final* id so the output JSON is
        // byte-deterministic for a given graph; this matches Phase 3's
        // determinism contract and is required for stable CAS root hashes
        // across runs.
        let mut comp_ids: Vec<(String, &String)> = self
            .compartments
            .keys()
            .map(|provisional| (final_id(provisional), provisional))
            .collect();
        comp_ids.sort();

        let mut buf = String::new();
        buf.push('{');

        // entry
        buf.push_str(&format!(
            r#""entry":{{"compartment":{},"module":{}}}"#,
            json_escape(&final_id(entry_compartment_id)),
            json_escape(entry_specifier),
        ));
        buf.push(',');

        // compartments
        buf.push_str(r#""compartments":{"#);
        for (i, (cid_final, provisional)) in comp_ids.iter().enumerate() {
            if i > 0 {
                buf.push(',');
            }
            let comp = &self.compartments[*provisional];
            buf.push_str(&format!(
                r#"{}:{{"name":{},"modules":{{"#,
                json_escape(cid_final),
                json_escape(&comp.name),
            ));

            let mut specs: Vec<&String> = comp.modules.keys().collect();
            specs.sort();
            for (j, spec) in specs.iter().enumerate() {
                if j > 0 {
                    buf.push(',');
                }
                let rec = &comp.modules[*spec];
                buf.push_str(&format!("{}:", json_escape(spec)));
                match rec {
                    ModuleRecord::File {
                        parser, location, ..
                    } => {
                        buf.push_str(&format!(
                            r#"{{"parser":{},"location":{}}}"#,
                            json_escape(parser),
                            json_escape(location),
                        ));
                    }
                    ModuleRecord::Synthetic {
                        parser, location, ..
                    } => {
                        buf.push_str(&format!(
                            r#"{{"parser":{},"location":{}}}"#,
                            json_escape(parser),
                            json_escape(location),
                        ));
                    }
                    ModuleRecord::Link {
                        target_compartment_id,
                        target_specifier,
                    } => {
                        buf.push_str(&format!(
                            r#"{{"compartment":{},"module":{}}}"#,
                            json_escape(&final_id(target_compartment_id)),
                            json_escape(target_specifier),
                        ));
                    }
                    ModuleRecord::DeferredError { message } => {
                        buf.push_str(&format!(r#"{{"deferredError":{}}}"#, json_escape(message),));
                    }
                }
            }
            buf.push_str("}}");
        }
        buf.push('}');

        buf.push('}');
        buf
    }

    /// Write the per-compartment file blobs, the compartment
    /// subtrees, the compartment-map.json blob, and the root
    /// tree to the CAS. Returns the root hash.
    ///
    /// Determinism contract: [`TreeManifest`] stores entries in a
    /// `BTreeMap`, so derived serialization is canonical and the same
    /// dependency graph produces a byte-identical root hash across runs.
    fn write_root_tree(
        &self,
        map_json: &str,
        final_ids: &HashMap<String, String>,
    ) -> io::Result<String> {
        let map_hash = self.cas.store(map_json.as_bytes(), "blob")?;
        let map_size = map_json.len() as u64;

        let mut root_entries = BTreeMap::new();
        root_entries.insert(
            "compartment-map.json".to_string(),
            TreeEntry {
                entry_type: "blob".to_string(),
                hash: map_hash,
                size: Some(map_size),
            },
        );

        // Name each compartment subtree by its final, disambiguated id
        // (matching the compartment-map.json), sorted for determinism.
        let mut comp_ids: Vec<(String, &String)> = self
            .compartments
            .keys()
            .map(|provisional| {
                (
                    final_ids
                        .get(provisional)
                        .cloned()
                        .unwrap_or_else(|| provisional.clone()),
                    provisional,
                )
            })
            .collect();
        comp_ids.sort();
        for (cid_final, provisional) in comp_ids {
            let comp = &self.compartments[provisional];
            let mut sub_entries = BTreeMap::new();
            // Sort module specifiers for determinism.
            let mut specs: Vec<&String> = comp.modules.keys().collect();
            specs.sort();
            // Track files already written under this compartment
            // to avoid duplicate writes when two specifiers
            // point at the same disk file (e.g., a relative
            // import that also serves as a package main).
            let mut written: std::collections::HashSet<String> = std::collections::HashSet::new();
            for spec in specs {
                let (location, bytes) = match &comp.modules[spec] {
                    ModuleRecord::File {
                        abs_path, location, ..
                    } => (location, std::fs::read(abs_path)?),
                    ModuleRecord::Synthetic {
                        source,
                        location,
                        exit_specifier,
                        ..
                    } => {
                        debug_assert_eq!(exit_specifier.as_str(), spec.as_str());
                        (location, source.as_bytes().to_vec())
                    }
                    _ => continue,
                };
                if !written.insert(location.clone()) {
                    continue;
                }
                let hash = self.cas.store(&bytes, "blob")?;
                sub_entries.insert(
                    location.clone(),
                    TreeEntry {
                        entry_type: "blob".to_string(),
                        hash,
                        size: Some(bytes.len() as u64),
                    },
                );
            }
            let sub_json = serde_json::to_vec(&TreeManifest {
                entries: sub_entries,
            })
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
            let sub_hash = self.cas.store_tree(&sub_json)?;
            root_entries.insert(
                cid_final,
                TreeEntry {
                    entry_type: "tree".to_string(),
                    hash: sub_hash,
                    size: None,
                },
            );
        }

        let root_json = serde_json::to_vec(&TreeManifest {
            entries: root_entries,
        })
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
        self.cas.store_tree(&root_json)
    }
}

fn json_escape(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"\"".to_string())
}

// Tests

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write_file(dir: &Path, name: &str, contents: &[u8]) {
        let p = dir.join(name);
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        let mut f = std::fs::File::create(&p).unwrap();
        f.write_all(contents).unwrap();
    }

    // ---- scan_static_imports ----

    #[test]
    fn scan_extracts_default_named_and_namespace_imports() {
        let src = r#"
            import foo from "a";
            import { x, y as z } from 'b';
            import * as ns from "c";
            import "d";
            import baz, { q } from "e";
        "#;
        let s = scan_static_imports(src);
        assert_eq!(s.specifiers, vec!["a", "b", "c", "d", "e"]);
    }

    #[test]
    fn scan_static_imports_not_swallowed_by_regex_literals() {
        // A regex literal whose body contains a quote or `//` must not be
        // misread as a string or comment, which would swallow a following
        // import (a false negative). Division (`a / b`) must still be
        // treated as division, not as an unterminated regex.
        let src = r#"
            const q = /["']/;
            import { foo } from "./after-quote-regex.js";
            const s = /[//]/;
            import bar from './after-slash-regex.js';
            const d = a / b / c;
            import baz from "./after-division.js";
            const cls = /[/"']+/g;
            import qux from "./after-class-regex.js";
        "#;
        let s = scan_static_imports(src);
        assert_eq!(
            s.specifiers,
            vec![
                "./after-quote-regex.js",
                "./after-slash-regex.js",
                "./after-division.js",
                "./after-class-regex.js",
            ]
        );
    }

    #[test]
    fn scan_cjs_requires_not_swallowed_by_regex_literals() {
        let src = r#"
            const q = /["']/;
            const a = require("./after-quote-regex.js");
            const s = /[//]/;
            const b = require('./after-slash-regex.js');
            const d = x / y / z;
            const c = require("./after-division.js");
        "#;
        assert_eq!(
            scan_cjs_requires(src),
            vec![
                "./after-quote-regex.js",
                "./after-slash-regex.js",
                "./after-division.js",
            ]
        );
    }

    #[test]
    fn scan_static_import_attributes_yield_the_specifier_not_the_attribute() {
        // The import-attributes clause (`with { type: "json" }`, and the
        // legacy `assert { ... }`) trails the specifier and carries its own
        // string literals; the scanner must return the specifier, not the
        // attribute value.
        let src = r#"
            import data from "./data.json" with { type: "json" };
            import cfg from './cfg.json' assert { type: 'json' };
            export { a } from "./reexport.json" with { type: "json" };
        "#;
        let s = scan_static_imports(src);
        assert_eq!(
            s.specifiers,
            vec!["./data.json", "./cfg.json", "./reexport.json"]
        );
    }

    #[test]
    fn scan_extracts_export_from() {
        let src = r#"
            export { a } from "m1";
            export * from 'm2';
            export * as k from "m3";
        "#;
        let s = scan_static_imports(src);
        assert_eq!(s.specifiers, vec!["m1", "m2", "m3"]);
    }

    #[test]
    fn scan_separates_literal_dynamic_import_and_ignores_meta() {
        let src = r#"
            const m = await import("x");
            const u = import.meta.url;
            import foo from "real";
        "#;
        let s = scan_static_imports(src);
        assert_eq!(s.specifiers, vec!["real"]);
        assert_eq!(s.dynamic_specifiers, vec!["x"]);
    }

    #[test]
    fn dynamic_import_scan_rejects_expressions_and_substituted_templates() {
        let src = r#"
            const literal = import('./literal.js');
            const template = import(`./template.js`);
            const expression = import(moduleName);
            const concatenated = import('./prefix-' + name);
            const substituted = import(`./${name}.js`);
            const attributed = import('./data.json', { with: { type: 'json' } });
            // import('./comment.js');
            const quoted = "import('./string.js')";
        "#;
        assert_eq!(
            scan_dynamic_imports(src),
            vec!["./literal.js", "./template.js", "./data.json"]
        );
        let scanned = scan_static_imports(src);
        assert!(scanned.has_opaque_dynamic_import);
        assert!(!scan_static_imports("import('./literal.js')").has_opaque_dynamic_import);
        assert!(
            !scan_static_imports("const pattern = /import(specifier)/;").has_opaque_dynamic_import
        );
        assert!(!scan_static_imports("object.import(specifier)").has_opaque_dynamic_import);
    }

    #[test]
    fn scan_deduplicates() {
        let src = r#"
            import { a } from "dup";
            import { b } from "dup";
        "#;
        let s = scan_static_imports(src);
        assert_eq!(s.specifiers, vec!["dup"]);
    }

    #[test]
    fn scan_returns_empty_for_no_imports() {
        let src = "export const x = 42;\nconsole.log('hi');";
        let s = scan_static_imports(src);
        assert!(s.specifiers.is_empty());
    }

    // ---- scan_cjs_requires ----

    #[test]
    fn cjs_scan_extracts_relative_and_bare_requires() {
        let src = r#"
            const a = require('./a');
            const b = require("bare");
            require('side-effect');
            const c = require('@scope/pkg/sub');
        "#;
        assert_eq!(
            scan_cjs_requires(src),
            vec!["./a", "bare", "side-effect", "@scope/pkg/sub"]
        );
    }

    #[test]
    fn cjs_scan_ignores_unconsumed_require_resolve_and_other_members() {
        let src = r#"
            require.resolve('.');
            require.resolve('./nested');
            require.resolve('./source.js.map');
            const e = require.extensions['.js'];
            const real = require('real');
        "#;
        assert_eq!(scan_cjs_requires(src), vec!["real"]);
    }

    #[test]
    fn cjs_scan_follows_bound_dynamic_require_target() {
        let src = r#"
            const target = require.resolve('dynamic-package');
            const unrelated = require.resolve('not-consumed');
            module.exports = require(target);
        "#;
        assert_eq!(scan_cjs_requires(src), vec!["dynamic-package"]);
    }

    #[test]
    fn cjs_scan_ignores_non_string_and_shadowed_calls() {
        // Matches `@endo/cjs-module-analyzer` on `parser-struggles`:
        // non-string arguments are skipped, extra arguments ignored,
        // and a locally shadowed `require` is still recorded (the scan
        // is syntactic, not scope-aware) — deduplicated in order.
        let src = r#"
            function nothing() {
              const require = () => {};
              require('spam', 'asifitsdoingsomething');
              // require('/commented-out');
              require('./spam');
              require(Mime);
              require({ stuff: 1 });
              require('spam');
            }
            const isOk = require('./is-ok').isOk;
            module.exports = require('./is-ok');
        "#;
        assert_eq!(scan_cjs_requires(src), vec!["spam", "./spam", "./is-ok"]);
    }

    #[test]
    fn cjs_scan_skips_requires_in_strings_and_comments() {
        let src = "// require('phantom-line');\n\
                   /* require('phantom-block'); */\n\
                   const s = \"require('phantom-string')\";\n\
                   const t = `require('phantom-template')`;\n\
                   const real = require('real');\n";
        assert_eq!(scan_cjs_requires(src), vec!["real"]);
    }

    #[test]
    fn cjs_scan_allows_whitespace_before_paren_and_arg() {
        let src = "const x = require ( './spaced' );";
        assert_eq!(scan_cjs_requires(src), vec!["./spaced"]);
    }

    // ---- split_bare_specifier ----

    #[test]
    fn split_unscoped_and_scoped() {
        assert_eq!(
            split_bare_specifier("lodash"),
            Some(("lodash".to_string(), None))
        );
        assert_eq!(
            split_bare_specifier("lodash/fp"),
            Some(("lodash".to_string(), Some("fp".to_string())))
        );
        assert_eq!(
            split_bare_specifier("@scope/pkg"),
            Some(("@scope/pkg".to_string(), None))
        );
        assert_eq!(
            split_bare_specifier("@scope/pkg/sub/a.js"),
            Some(("@scope/pkg".to_string(), Some("sub/a.js".to_string())))
        );
    }

    #[test]
    fn split_rejects_empty() {
        assert_eq!(split_bare_specifier(""), None);
        assert_eq!(split_bare_specifier("@"), None);
    }

    // ---- load_package_metadata ----

    #[test]
    fn load_package_metadata_reads_name_version_main() {
        let dir = tempfile::tempdir().unwrap();
        write_file(
            dir.path(),
            "package.json",
            br#"{"name":"foo","version":"1.2.3","main":"./lib/entry.js"}"#,
        );
        let m = load_package_metadata(dir.path()).unwrap();
        assert_eq!(m.name, "foo");
        assert_eq!(m.version, "1.2.3");
        assert_eq!(m.main.as_deref(), Some("./lib/entry.js"));
        assert!(m.exports_dot_default.is_none());
    }

    #[test]
    fn load_package_metadata_reads_exports_default() {
        let dir = tempfile::tempdir().unwrap();
        write_file(
            dir.path(),
            "package.json",
            br#"{"name":"foo","version":"2.0.0","exports":{".":{"default":"./esm.js"}}}"#,
        );
        let m = load_package_metadata(dir.path()).unwrap();
        assert_eq!(m.exports_dot_default.as_deref(), Some("./esm.js"));
    }

    #[test]
    fn load_package_metadata_classifies_dependency_fields() {
        let dir = tempfile::tempdir().unwrap();
        write_file(
            dir.path(),
            "package.json",
            br#"{
                "name": "app",
                "dependencies": { "production": "1", "overridden": "1" },
                "peerDependencies": { "peer": "1", "optional-peer": "1" },
                "peerDependenciesMeta": {
                    "optional-peer": { "optional": true },
                    "metadata-only-peer": { "optional": true }
                },
                "optionalDependencies": { "optional": "1", "overridden": "1" },
                "devDependencies": { "development": "1" }
            }"#,
        );
        let metadata = load_package_metadata(dir.path()).unwrap();

        assert_eq!(
            metadata.dependency_classification("production", false),
            DependencyClassification::Runtime
        );
        assert_eq!(
            metadata.dependency_classification("peer", false),
            DependencyClassification::Runtime
        );
        for name in [
            "optional",
            "overridden",
            "optional-peer",
            "metadata-only-peer",
        ] {
            assert_eq!(
                metadata.dependency_classification(name, false),
                DependencyClassification::Optional,
                "{name} should be optional"
            );
        }
        assert_eq!(
            metadata.dependency_classification("development", false),
            DependencyClassification::Excluded
        );
        assert_eq!(
            metadata.dependency_classification("development", true),
            DependencyClassification::Development
        );
        assert_eq!(
            metadata.dependency_classification("undeclared", true),
            DependencyClassification::Excluded
        );
    }

    // ---- Group C: exports/imports resolution helpers ----

    fn conds(extra: &[&str]) -> BTreeSet<String> {
        let mut c = default_conditions();
        c.extend(extra.iter().map(|s| s.to_string()));
        c
    }

    #[test]
    fn relativize_normalises_targets() {
        assert_eq!(relativize("./src/main.js"), "./src/main.js");
        assert_eq!(relativize("index.mjs"), "./index.mjs");
        assert_eq!(relativize("./a/./b.js"), "./a/b.js");
        // A `*` is an ordinary component, preserved.
        assert_eq!(relativize("./src/x/*.js"), "./src/x/*.js");
    }

    #[test]
    fn bare_js_language_tracks_package_module_type() {
        let path = Path::new("main.js");
        assert_eq!(language_for_file(path, true), Some("mjs"));
        assert_eq!(language_for_file(path, false), Some("cjs"));
    }

    #[test]
    fn is_scheme_specifier_detects_host_specifiers() {
        assert!(is_scheme_specifier("endo:lib"));
        assert!(is_scheme_specifier("h2g2:meaning"));
        assert!(!is_scheme_specifier("patterns-lib/features/alpha.js"));
        assert!(!is_scheme_specifier("@scope/pkg"));
        assert!(!is_scheme_specifier("lib"));
        assert!(!is_scheme_specifier("./relative"));
    }

    #[test]
    fn pattern_key_compare_prefers_longer_prefix_then_key() {
        use std::cmp::Ordering;
        // Longer prefix before `*` is more specific (sorts first).
        assert_eq!(
            pattern_key_compare("./utils/private/*.js", "./utils/*.js"),
            Ordering::Less
        );
        // Equal prefix length: the longer full key wins.
        assert_eq!(pattern_key_compare("./foo/*.js", "./foo/*"), Ordering::Less);
    }

    #[test]
    fn conditional_exports_selects_by_insertion_order_not_sorted() {
        // `{ "endo:lib": ..., "default": ... }`: with the `endo:lib`
        // condition present, endo:lib must win even though it sorts
        // *after* `default` alphabetically (the OrderedJson fix).
        let dir = tempfile::tempdir().unwrap();
        write_file(
            dir.path(),
            "package.json",
            br#"{"name":"lib","type":"module","exports":{"endo:lib":"./endo.js","default":"./index.js"}}"#,
        );
        let m = load_package_metadata(dir.path()).unwrap();

        let (exact, _patterns) = build_export_map(&m, &conds(&["endo:lib"]));
        assert_eq!(exact.get("."), Some(&"./endo.js".to_string()));

        // Without the condition, `default` is the fall-back.
        let (exact_default, _) = build_export_map(&m, &conds(&[]));
        assert_eq!(exact_default.get("."), Some(&"./index.js".to_string()));
    }

    #[test]
    fn subpath_pattern_matches_across_slash_with_specificity() {
        let dir = tempfile::tempdir().unwrap();
        write_file(
            dir.path(),
            "package.json",
            br#"{"name":"patterns-lib","type":"module","exports":{
                ".":"./src/main.js",
                "./features/*.js":"./src/features/*.js",
                "./features/beta/exact":"./src/features/beta/exact-target.js",
                "./features/secret/*.js":null,
                "./utils/*.js":"./src/broad/*.js",
                "./utils/private/*.js":"./src/private/*.js"
            }}"#,
        );
        let m = load_package_metadata(dir.path()).unwrap();
        let (exact, patterns) = build_export_map(&m, &conds(&[]));

        // Wildcard `*` spans `/` (Node semantics).
        assert!(matches!(
            resolve_subpath_in_map(&exact, &patterns, "./features/beta/gamma.js"),
            SubpathResolution::Matched(ref t) if t == "./src/features/beta/gamma.js"
        ));
        // Exact key beats the pattern that would also match.
        assert!(matches!(
            resolve_subpath_in_map(&exact, &patterns, "./features/beta/exact"),
            SubpathResolution::Matched(ref t) if t == "./src/features/beta/exact-target.js"
        ));
        // Longer-prefix pattern wins over the broader one.
        assert!(matches!(
            resolve_subpath_in_map(&exact, &patterns, "./utils/private/thing.js"),
            SubpathResolution::Matched(ref t) if t == "./src/private/thing.js"
        ));
        // A null-target wildcard is an explicit exclusion.
        assert!(matches!(
            resolve_subpath_in_map(&exact, &patterns, "./features/secret/x.js"),
            SubpathResolution::Excluded
        ));
    }

    #[test]
    fn imports_field_resolves_hash_patterns() {
        let dir = tempfile::tempdir().unwrap();
        write_file(
            dir.path(),
            "package.json",
            br##"{"name":"app","type":"module","imports":{"#internal/*.js":"./lib/*.js"}}"##,
        );
        let m = load_package_metadata(dir.path()).unwrap();
        let (exact, patterns) = build_import_map(&m, &conds(&[]));
        assert!(matches!(
            resolve_subpath_in_map(&exact, &patterns, "#internal/util.js"),
            SubpathResolution::Matched(ref t) if t == "./lib/util.js"
        ));
    }

    #[test]
    fn load_package_metadata_reads_exports_dot_string() {
        let dir = tempfile::tempdir().unwrap();
        write_file(
            dir.path(),
            "package.json",
            br#"{"name":"foo","version":"2.0.0","exports":{".":"./shorthand.js"}}"#,
        );
        let m = load_package_metadata(dir.path()).unwrap();
        assert_eq!(m.exports_dot_default.as_deref(), Some("./shorthand.js"));
    }

    #[test]
    fn load_package_metadata_fallback_for_missing_fields() {
        let dir = tempfile::tempdir().unwrap();
        write_file(dir.path(), "package.json", b"{}");
        let m = load_package_metadata(dir.path()).unwrap();
        // name falls back to the directory basename.
        let dirname = dir
            .path()
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        assert_eq!(m.name, dirname);
        assert_eq!(m.version, "0.0.0");
        assert!(m.main.is_none());
        assert!(m.exports_dot_default.is_none());
    }

    #[test]
    fn load_package_metadata_rejects_malformed_json() {
        let dir = tempfile::tempdir().unwrap();
        write_file(dir.path(), "package.json", b"{ not valid");
        let err = load_package_metadata(dir.path()).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
        assert!(err.to_string().contains("invalid package.json"));
    }

    // ---- find_node_modules_package ----

    #[test]
    fn find_walks_upward_to_node_modules() {
        let root = tempfile::tempdir().unwrap();
        write_file(
            root.path(),
            "node_modules/foo/package.json",
            br#"{"name":"foo","version":"1.0.0"}"#,
        );
        std::fs::create_dir_all(root.path().join("a/b/c")).unwrap();
        let found = find_node_modules_package(&root.path().join("a/b/c"), "foo").unwrap();
        assert_eq!(found, root.path().join("node_modules/foo"));
    }

    #[test]
    fn find_handles_scoped_package() {
        let root = tempfile::tempdir().unwrap();
        write_file(
            root.path(),
            "node_modules/@scope/pkg/package.json",
            br#"{"name":"@scope/pkg","version":"0.1.0"}"#,
        );
        let found = find_node_modules_package(root.path(), "@scope/pkg").unwrap();
        assert_eq!(found, root.path().join("node_modules/@scope/pkg"));
    }

    #[test]
    fn find_returns_none_when_absent() {
        let root = tempfile::tempdir().unwrap();
        assert!(find_node_modules_package(root.path(), "missing").is_none());
    }

    // ---- resolve_specifier ----

    #[test]
    fn resolve_relative_with_explicit_extension() {
        let root = tempfile::tempdir().unwrap();
        write_file(root.path(), "src/main.js", b"x");
        write_file(root.path(), "src/util.js", b"x");
        let importer = root.path().join("src/main.js");
        let r = resolve_specifier(&importer, "./util.js", root.path(), false).unwrap();
        match r {
            Resolved::Relative {
                abs_path,
                compartment_specifier,
                parser,
            } => {
                assert_eq!(
                    abs_path,
                    root.path().canonicalize().unwrap().join("src/util.js")
                );
                assert_eq!(compartment_specifier, "./src/util.js");
                assert_eq!(parser, "mjs");
            }
            _ => panic!("expected Relative"),
        }
    }

    #[test]
    fn resolve_relative_with_extension_fallback() {
        let root = tempfile::tempdir().unwrap();
        write_file(root.path(), "src/main.js", b"x");
        write_file(root.path(), "src/util.mjs", b"x");
        let importer = root.path().join("src/main.js");
        let r = resolve_specifier(&importer, "./util", root.path(), false).unwrap();
        if let Resolved::Relative {
            abs_path, parser, ..
        } = r
        {
            assert_eq!(abs_path.extension().unwrap(), "mjs");
            assert_eq!(parser, "mjs");
        } else {
            panic!("expected Relative");
        }
    }

    #[test]
    fn resolve_relative_directory_index() {
        let root = tempfile::tempdir().unwrap();
        write_file(root.path(), "src/main.js", b"x");
        write_file(root.path(), "src/sub/index.js", b"x");
        let importer = root.path().join("src/main.js");
        let r = resolve_specifier(&importer, "./sub", root.path(), false).unwrap();
        if let Resolved::Relative { abs_path, .. } = r {
            assert_eq!(
                abs_path,
                root.path().canonicalize().unwrap().join("src/sub/index.js")
            );
        } else {
            panic!("expected Relative");
        }
    }

    #[test]
    fn resolve_relative_rejects_escape() {
        let root = tempfile::tempdir().unwrap();
        write_file(root.path(), "outer/sibling.js", b"x");
        write_file(root.path(), "inner/main.js", b"x");
        let importer = root.path().join("inner/main.js");
        let err = resolve_specifier(
            &importer,
            "../outer/sibling.js",
            &root.path().join("inner"),
            false,
        )
        .unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
        assert!(err.to_string().contains("escapes"));
    }

    #[test]
    fn resolve_subpath_rejects_extension_and_index_escapes() {
        let temporary = tempfile::tempdir().unwrap();
        let package_root = temporary.path().join("package");
        write_file(temporary.path(), "outside.js", b"export default 1;");
        write_file(
            temporary.path(),
            "outside-directory/index.js",
            b"export default 2;",
        );
        std::fs::create_dir_all(&package_root).unwrap();

        let extension_error = resolve_subpath(
            &package_root,
            &package_root.join("../outside"),
            "../outside",
        )
        .unwrap_err();
        assert_eq!(extension_error.kind(), io::ErrorKind::InvalidInput);
        assert!(extension_error.to_string().contains("escapes"));

        let index_error = resolve_subpath(
            &package_root,
            &package_root.join("../outside-directory"),
            "../outside-directory",
        )
        .unwrap_err();
        assert_eq!(index_error.kind(), io::ErrorKind::InvalidInput);
        assert!(index_error.to_string().contains("escapes"));
    }

    #[test]
    fn wildcard_exports_cannot_escape_package_root() {
        let temporary = tempfile::tempdir().unwrap();
        let cas = ContentStore::open(&temporary.path().join("cas")).unwrap();
        write_file(temporary.path(), "src/main.js", b"export default 1;");
        write_file(temporary.path(), "secret.js", b"secret");
        write_file(
            temporary.path(),
            "node_modules/evil/package.json",
            br#"{"name":"evil","version":"1.0.0","exports":{"./*":"./*"}}"#,
        );
        let walker = Walker::new(&cas, WalkOptions::default());
        let result = walker
            .resolve_bare_exports(
                &temporary.path().join("src/main.js"),
                "evil/../../secret.js",
            )
            .unwrap()
            .expect("exports map should handle the request");
        assert!(matches!(result, BareExportsResult::Deferred { .. }));
    }

    #[test]
    fn resolve_package_main_rejects_escape() {
        // A malicious `package.json` whose `main`/`module`/`exports["."]`/
        // `browser` entry points outside the package root must be rejected by
        // `resolve_package_main`'s own containment check, mirroring the
        // boundary `resolve_subpath` enforces — not left to an incidental
        // downstream `strip_prefix` invariant.
        for field in ["main", "module"] {
            let root = tempfile::tempdir().unwrap();
            write_file(root.path(), "src/main.js", b"export default 1;");
            write_file(root.path(), "secret.js", b"secret");
            write_file(
                root.path(),
                "node_modules/evil/package.json",
                format!(r#"{{"name":"evil","version":"1.0.0","{field}":"../../secret.js"}}"#)
                    .as_bytes(),
            );
            let importer = root.path().join("src/main.js");
            let err =
                resolve_specifier(&importer, "evil", &root.path().join("src"), false).unwrap_err();
            assert_eq!(err.kind(), io::ErrorKind::InvalidInput, "field {field}");
            assert!(err.to_string().contains("escapes"), "field {field}: {err}");
        }

        // `exports["."]` string form.
        let root = tempfile::tempdir().unwrap();
        write_file(root.path(), "src/main.js", b"export default 1;");
        write_file(root.path(), "secret.js", b"secret");
        write_file(
            root.path(),
            "node_modules/evil/package.json",
            br#"{"name":"evil","version":"1.0.0","exports":{".":"../../secret.js"}}"#,
        );
        let importer = root.path().join("src/main.js");
        let err =
            resolve_specifier(&importer, "evil", &root.path().join("src"), false).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
        assert!(err.to_string().contains("escapes"), "{err}");
    }

    #[test]
    fn resolve_bare_finds_package_main() {
        let root = tempfile::tempdir().unwrap();
        write_file(root.path(), "src/main.js", b"x");
        write_file(
            root.path(),
            "node_modules/lib/package.json",
            br#"{"name":"lib","version":"0.5.0","main":"./entry.js"}"#,
        );
        write_file(root.path(), "node_modules/lib/entry.js", b"x");
        let importer = root.path().join("src/main.js");
        let r = resolve_specifier(&importer, "lib", &root.path().join("src"), false).unwrap();
        if let Resolved::Bare {
            package_name,
            package_version,
            entry_file,
            compartment_specifier,
            parser,
            ..
        } = r
        {
            assert_eq!(package_name, "lib");
            assert_eq!(package_version, "0.5.0");
            // The package main is keyed by its resolved package-relative
            // path (compartment-mapper does the same), not a bare `.`.
            assert_eq!(compartment_specifier, "./entry.js");
            assert_eq!(parser, "mjs");
            assert!(entry_file.ends_with("entry.js"));
        } else {
            panic!("expected Bare");
        }
    }

    #[test]
    fn resolve_bare_falls_back_to_index_js() {
        let root = tempfile::tempdir().unwrap();
        write_file(root.path(), "src/main.js", b"x");
        write_file(
            root.path(),
            "node_modules/lib/package.json",
            br#"{"name":"lib","version":"0.0.1"}"#,
        );
        write_file(root.path(), "node_modules/lib/index.js", b"x");
        let importer = root.path().join("src/main.js");
        let r = resolve_specifier(&importer, "lib", &root.path().join("src"), false).unwrap();
        if let Resolved::Bare { entry_file, .. } = r {
            assert!(entry_file.ends_with("index.js"));
        } else {
            panic!("expected Bare");
        }
    }

    #[test]
    fn resolve_bare_subpath() {
        let root = tempfile::tempdir().unwrap();
        write_file(root.path(), "src/main.js", b"x");
        write_file(
            root.path(),
            "node_modules/lib/package.json",
            br#"{"name":"lib","version":"0.0.1"}"#,
        );
        write_file(root.path(), "node_modules/lib/sub/foo.js", b"x");
        let importer = root.path().join("src/main.js");
        let r = resolve_specifier(&importer, "lib/sub/foo.js", &root.path().join("src"), false)
            .unwrap();
        if let Resolved::Bare {
            entry_file,
            compartment_specifier,
            ..
        } = r
        {
            assert!(entry_file.ends_with("sub/foo.js"));
            assert_eq!(compartment_specifier, "./sub/foo.js");
        } else {
            panic!("expected Bare");
        }
    }

    #[test]
    fn resolve_bare_missing_yields_not_found() {
        let root = tempfile::tempdir().unwrap();
        write_file(root.path(), "src/main.js", b"x");
        let importer = root.path().join("src/main.js");
        let err =
            resolve_specifier(&importer, "absent", &root.path().join("src"), false).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::NotFound);
        assert!(err.to_string().contains("absent"));
    }

    // ---- ingest_entry_point_with_deps end-to-end ----

    #[test]
    fn ingest_walks_relative_imports_into_one_compartment() {
        let tmp = tempfile::tempdir().unwrap();
        let cas = ContentStore::open(&tmp.path().join("cas")).unwrap();

        let proj = tempfile::tempdir().unwrap();
        write_file(
            proj.path(),
            "main.js",
            br#"import { greet } from './util.js'; greet();"#,
        );
        write_file(
            proj.path(),
            "util.js",
            br#"export function greet() { return 'hi'; }"#,
        );

        let ingested = ingest_entry_point_with_deps(&cas, &proj.path().join("main.js")).unwrap();

        // One compartment (entry-v1.0.0), two modules in it.
        assert_eq!(ingested.archive.map.compartments.len(), 1);
        let comp = ingested
            .archive
            .map
            .compartments
            .get(SYNTHETIC_COMPARTMENT_ID)
            .unwrap();
        assert_eq!(comp.modules.len(), 2);
        assert!(comp.modules.contains_key("./main.js"));
        assert!(comp.modules.contains_key("./util.js"));

        // Both source bodies are present.
        let main_src = ingested
            .archive
            .sources
            .get(&(
                SYNTHETIC_COMPARTMENT_ID.to_string(),
                "./main.js".to_string(),
            ))
            .unwrap();
        assert!(main_src.contains("greet"));
        let util_src = ingested
            .archive
            .sources
            .get(&(
                SYNTHETIC_COMPARTMENT_ID.to_string(),
                "./util.js".to_string(),
            ))
            .unwrap();
        assert!(util_src.contains("return 'hi'"));
    }

    #[test]
    fn ingest_walks_bare_import_into_separate_compartment() {
        // The Phase 5 acceptance test: `endor run app.js` where
        // `app.js` imports from a local `node_modules` package.
        let tmp = tempfile::tempdir().unwrap();
        let cas = ContentStore::open(&tmp.path().join("cas")).unwrap();

        let proj = tempfile::tempdir().unwrap();
        write_file(
            proj.path(),
            "app.js",
            br#"import { add } from 'mathlib'; add(1, 2);"#,
        );
        write_file(
            proj.path(),
            "node_modules/mathlib/package.json",
            br#"{"name":"mathlib","version":"3.4.5","main":"./entry.js"}"#,
        );
        write_file(
            proj.path(),
            "node_modules/mathlib/entry.js",
            br#"export function add(a, b) { return a + b; }"#,
        );

        let ingested = ingest_entry_point_with_deps(&cas, &proj.path().join("app.js")).unwrap();

        // Two compartments: the entry compartment and the
        // mathlib compartment.
        assert_eq!(ingested.archive.map.compartments.len(), 2);
        let entry_comp = ingested
            .archive
            .map
            .compartments
            .get(SYNTHETIC_COMPARTMENT_ID)
            .unwrap();
        let mathlib_id = "mathlib-v3.4.5";
        let mathlib_comp = ingested.archive.map.compartments.get(mathlib_id).unwrap();

        // The entry compartment has a Link entry under the bare
        // specifier `mathlib`.
        match entry_comp.modules.get("mathlib").unwrap() {
            xsnap::archive::ModuleDescriptor::Link {
                compartment,
                module,
            } => {
                assert_eq!(compartment, mathlib_id);
                // The link targets the package main by its resolved
                // package-relative path.
                assert_eq!(module, "./entry.js");
            }
            other => panic!("expected Link, got {other:?}"),
        }

        // The mathlib compartment has the package's entry source
        // under its resolved specifier `./entry.js`.
        assert!(mathlib_comp.modules.contains_key("./entry.js"));
        let src = ingested
            .archive
            .sources
            .get(&(mathlib_id.to_string(), "./entry.js".to_string()))
            .unwrap();
        assert!(src.contains("function add"));
    }

    #[test]
    fn ingest_walks_scoped_bare_import() {
        let tmp = tempfile::tempdir().unwrap();
        let cas = ContentStore::open(&tmp.path().join("cas")).unwrap();

        let proj = tempfile::tempdir().unwrap();
        write_file(proj.path(), "app.mjs", br#"import x from '@scope/pkg';"#);
        write_file(
            proj.path(),
            "node_modules/@scope/pkg/package.json",
            br#"{"name":"@scope/pkg","version":"1.0.0","exports":{".":"./esm.mjs"}}"#,
        );
        write_file(
            proj.path(),
            "node_modules/@scope/pkg/esm.mjs",
            br#"export default 1;"#,
        );

        let ingested = ingest_entry_point_with_deps(&cas, &proj.path().join("app.mjs")).unwrap();

        // The scoped compartment id is `pkg-v1.0.0` (the
        // unscoped name) per the compartment_id_for rule.
        let scoped_id = "pkg-v1.0.0";
        assert!(ingested.archive.map.compartments.contains_key(scoped_id));
        let comp = ingested.archive.map.compartments.get(scoped_id).unwrap();
        // The main is keyed by its resolved path (`exports["."]` ->
        // `./esm.mjs`), not a bare `.`.
        assert!(comp.modules.contains_key("./esm.mjs"));
    }

    #[test]
    fn ingest_walks_transitive_dependencies() {
        let tmp = tempfile::tempdir().unwrap();
        let cas = ContentStore::open(&tmp.path().join("cas")).unwrap();

        // app -> a -> b
        let proj = tempfile::tempdir().unwrap();
        write_file(proj.path(), "app.js", br#"import { f } from 'a'; f();"#);
        write_file(
            proj.path(),
            "node_modules/a/package.json",
            br#"{"name":"a","version":"1.0.0","type":"module","dependencies":{"b":"^2.0.0"}}"#,
        );
        write_file(
            proj.path(),
            "node_modules/a/index.js",
            br#"import { g } from 'b'; export function f() { return g(); }"#,
        );
        write_file(
            proj.path(),
            "node_modules/b/package.json",
            br#"{"name":"b","version":"2.0.0","type":"module"}"#,
        );
        write_file(
            proj.path(),
            "node_modules/b/index.js",
            br#"export function g() { return 42; }"#,
        );

        let ingested = ingest_entry_point_with_deps(&cas, &proj.path().join("app.js")).unwrap();

        // Three compartments: entry, a, b.
        assert_eq!(ingested.archive.map.compartments.len(), 3);
        assert!(ingested.archive.map.compartments.contains_key("a-v1.0.0"));
        assert!(ingested.archive.map.compartments.contains_key("b-v2.0.0"));

        // a's compartment has a Link to b.
        let a_comp = ingested.archive.map.compartments.get("a-v1.0.0").unwrap();
        match a_comp.modules.get("b").unwrap() {
            xsnap::archive::ModuleDescriptor::Link {
                compartment,
                module,
            } => {
                assert_eq!(compartment, "b-v2.0.0");
                assert_eq!(module, "./index.js");
            }
            other => panic!("expected Link, got {other:?}"),
        }
    }

    #[test]
    fn opaque_dynamic_import_includes_declared_runtime_dependencies() {
        let temporary = tempfile::tempdir().unwrap();
        let cas = ContentStore::open(&temporary.path().join("cas")).unwrap();
        let project = tempfile::tempdir().unwrap();
        write_file(
            project.path(),
            "node_modules/app/package.json",
            br#"{"name":"app","version":"1.0.0","type":"module","dependencies":{"dep":"1"}}"#,
        );
        write_file(
            project.path(),
            "node_modules/app/index.js",
            br#"export const load = specifier => import(specifier);"#,
        );
        write_file(
            project.path(),
            "node_modules/dep/package.json",
            br#"{"name":"dep","version":"1.0.0","type":"module"}"#,
        );
        write_file(
            project.path(),
            "node_modules/dep/index.js",
            br#"export default 'declared';"#,
        );
        write_file(
            project.path(),
            "node_modules/undeclared/package.json",
            br#"{"name":"undeclared","version":"1.0.0","type":"module"}"#,
        );
        write_file(
            project.path(),
            "node_modules/undeclared/index.js",
            br#"export default 'undeclared';"#,
        );

        // Use the run-path dispatcher to prove an opaque import selects the
        // walker even though it yields no statically known specifier.
        let ingested =
            ingest_entry_point_for_run(&cas, &project.path().join("node_modules/app/index.js"))
                .unwrap();

        let app = ingested.archive.map.compartments.get("app-v1.0.0").unwrap();
        assert!(matches!(
            app.modules.get("dep"),
            Some(xsnap::archive::ModuleDescriptor::Link { compartment, module })
                if compartment == "dep-v1.0.0" && module == "./index.js"
        ));
        let dep = ingested.archive.map.compartments.get("dep-v1.0.0").unwrap();
        assert!(dep.modules.contains_key("./index.js"));
        assert!(!ingested
            .archive
            .map
            .compartments
            .contains_key("undeclared-v1.0.0"));
    }

    #[test]
    fn ingest_handles_relative_subdir_within_compartment() {
        // Importing `./sub/util.js` from `main.js` within the
        // entry compartment: both files become module entries
        // in the same compartment, sharing the synthetic id.
        let tmp = tempfile::tempdir().unwrap();
        let cas = ContentStore::open(&tmp.path().join("cas")).unwrap();
        let proj = tempfile::tempdir().unwrap();
        write_file(
            proj.path(),
            "main.js",
            br#"import { u } from './sub/util.js'; u();"#,
        );
        write_file(
            proj.path(),
            "sub/util.js",
            br#"export function u() { return 1; }"#,
        );

        let ingested = ingest_entry_point_with_deps(&cas, &proj.path().join("main.js")).unwrap();
        let comp = ingested
            .archive
            .map
            .compartments
            .get(SYNTHETIC_COMPARTMENT_ID)
            .unwrap();
        assert!(comp.modules.contains_key("./main.js"));
        assert!(comp.modules.contains_key("./sub/util.js"));
    }

    #[test]
    fn ingest_follows_literal_dynamic_import_within_compartment() {
        let temporary = tempfile::tempdir().unwrap();
        let cas = ContentStore::open(&temporary.path().join("cas")).unwrap();
        let project = tempfile::tempdir().unwrap();
        write_file(
            project.path(),
            "main.js",
            br#"export const load = () => import('./lazy.js');"#,
        );
        write_file(project.path(), "lazy.js", br#"export const value = 42;"#);

        let ingested = ingest_entry_point_with_deps(&cas, &project.path().join("main.js")).unwrap();
        let compartment = ingested
            .archive
            .map
            .compartments
            .get(SYNTHETIC_COMPARTMENT_ID)
            .unwrap();
        assert!(compartment.modules.contains_key("./main.js"));
        assert!(compartment.modules.contains_key("./lazy.js"));
    }

    #[test]
    fn ingest_uses_package_id_when_entry_has_package_json() {
        // When the entry directory has a `package.json`, the
        // entry compartment id is derived from the package
        // metadata rather than using the synthetic placeholder.
        let tmp = tempfile::tempdir().unwrap();
        let cas = ContentStore::open(&tmp.path().join("cas")).unwrap();

        let proj = tempfile::tempdir().unwrap();
        write_file(
            proj.path(),
            "package.json",
            br#"{"name":"my-app","version":"0.7.0"}"#,
        );
        write_file(proj.path(), "main.js", b"export default 1;");

        let ingested = ingest_entry_point_with_deps(&cas, &proj.path().join("main.js")).unwrap();
        assert!(ingested
            .archive
            .map
            .compartments
            .contains_key("my-app-v0.7.0"));
        assert_eq!(ingested.archive.map.entry.compartment, "my-app-v0.7.0");
    }

    #[test]
    fn ingest_dedupes_shared_dependency() {
        // app -> a -> shared
        // app -> shared
        // The `shared` compartment must appear exactly once
        // and be reachable from both app and a via Link
        // entries pointing at the same compartment id.
        let tmp = tempfile::tempdir().unwrap();
        let cas = ContentStore::open(&tmp.path().join("cas")).unwrap();
        let proj = tempfile::tempdir().unwrap();
        write_file(proj.path(), "app.js", br#"import 'a'; import 'shared';"#);
        write_file(
            proj.path(),
            "node_modules/a/package.json",
            br#"{"name":"a","version":"1.0.0","type":"module","dependencies":{"shared":"^1.0.0"}}"#,
        );
        write_file(
            proj.path(),
            "node_modules/a/index.js",
            br#"import 'shared';"#,
        );
        write_file(
            proj.path(),
            "node_modules/shared/package.json",
            br#"{"name":"shared","version":"1.0.0"}"#,
        );
        write_file(
            proj.path(),
            "node_modules/shared/index.js",
            b"export const x = 1;",
        );

        let ingested = ingest_entry_point_with_deps(&cas, &proj.path().join("app.js")).unwrap();
        // entry, a, shared (no duplicates)
        assert_eq!(ingested.archive.map.compartments.len(), 3);
        assert!(ingested
            .archive
            .map
            .compartments
            .contains_key("shared-v1.0.0"));
        let a = &ingested.archive.map.compartments["a-v1.0.0"];
        assert!(matches!(
            a.modules.get("shared"),
            Some(xsnap::archive::ModuleDescriptor::Link { compartment, .. })
                if compartment == "shared-v1.0.0"
        ));
    }

    #[test]
    fn ingest_admits_entry_dev_but_excludes_transitive_dev() {
        let temporary = tempfile::tempdir().unwrap();
        let cas = ContentStore::open(&temporary.path().join("cas")).unwrap();
        let project = tempfile::tempdir().unwrap();

        write_file(
            project.path(),
            "package.json",
            br#"{"name":"app","type":"module","devDependencies":{"direct":"1"}}"#,
        );
        write_file(project.path(), "index.js", br#"import "direct";"#);
        write_file(
            project.path(),
            "node_modules/direct/package.json",
            br#"{"name":"direct","type":"module","devDependencies":{"indirect":"1"}}"#,
        );
        write_file(
            project.path(),
            "node_modules/direct/index.js",
            br#"import "indirect";"#,
        );
        write_file(
            project.path(),
            "node_modules/indirect/package.json",
            br#"{"name":"indirect","type":"module"}"#,
        );
        write_file(
            project.path(),
            "node_modules/indirect/index.js",
            br#"export default 1;"#,
        );

        let options = WalkOptions::new(["development".to_string()], std::iter::empty());
        let ingested = ingest_entry_point_with_deps_with_options(
            &cas,
            &project.path().join("index.js"),
            &options,
        )
        .unwrap();

        assert!(ingested
            .archive
            .map
            .compartments
            .contains_key("direct-v0.0.0"));
        assert!(!ingested
            .archive
            .map
            .compartments
            .contains_key("indirect-v0.0.0"));
        let direct = &ingested.archive.map.compartments["direct-v0.0.0"];
        assert!(matches!(
            direct.modules.get("indirect"),
            Some(xsnap::archive::ModuleDescriptor::DeferredError { .. })
        ));
    }

    #[test]
    fn ingest_defers_missing_bare_specifier() {
        // An unresolvable import is a *deferred error*, not a walk
        // failure: `@endo/compartment-mapper` records a `deferredError`
        // module so the archive still builds and the error surfaces at
        // import time. The walker matches that (Group A parity).
        let tmp = tempfile::tempdir().unwrap();
        let cas = ContentStore::open(&tmp.path().join("cas")).unwrap();
        let proj = tempfile::tempdir().unwrap();
        write_file(proj.path(), "app.js", br#"import 'totally-missing';"#);

        let ingested = ingest_entry_point_with_deps(&cas, &proj.path().join("app.js")).unwrap();
        let comp = ingested
            .archive
            .map
            .compartments
            .get(SYNTHETIC_COMPARTMENT_ID)
            .unwrap();
        match comp.modules.get("totally-missing").unwrap() {
            xsnap::archive::ModuleDescriptor::DeferredError { deferred_error } => {
                assert!(deferred_error.contains("totally-missing"));
            }
            other => panic!("expected DeferredError, got {other:?}"),
        }
    }

    #[test]
    fn ingest_reads_back_from_cas_root_hash() {
        let tmp = tempfile::tempdir().unwrap();
        let cas = ContentStore::open(&tmp.path().join("cas")).unwrap();
        let proj = tempfile::tempdir().unwrap();
        write_file(proj.path(), "app.js", br#"import { v } from 'lib';"#);
        write_file(
            proj.path(),
            "node_modules/lib/package.json",
            br#"{"name":"lib","version":"1.0.0"}"#,
        );
        write_file(
            proj.path(),
            "node_modules/lib/index.js",
            b"export const v = 1;",
        );

        let ingested = ingest_entry_point_with_deps(&cas, &proj.path().join("app.js")).unwrap();
        let root_hash = ingested.root_hash.clone();
        let reloaded = load_archive_from_cas(&cas, &root_hash).unwrap();
        assert_eq!(reloaded.map.compartments.len(), 2);
        assert!(reloaded.map.compartments.contains_key("lib-v1.0.0"));
    }

    #[test]
    fn exit_module_import_hook_supplies_executable_host_source() {
        let temporary = tempfile::tempdir().unwrap();
        let cas = ContentStore::open(&temporary.path().join("cas")).unwrap();
        let project = tempfile::tempdir().unwrap();
        write_file(
            project.path(),
            "app.js",
            br#"import { meaning } from 'h2g2:meaning';
                if (meaning !== 42) throw new Error('wrong host meaning');"#,
        );

        let requests = Arc::new(std::sync::Mutex::new(Vec::new()));
        let requests_for_hook = Arc::clone(&requests);
        let options = WalkOptions::default().with_exit_module_import_hook(move |request| {
            requests_for_hook.lock().unwrap().push((
                request.specifier.to_string(),
                request.compartment_name.to_string(),
            ));
            Ok((request.specifier == "h2g2:meaning")
                .then(|| SyntheticModuleSource::new("export const meaning = 42;")))
        });

        let ingested =
            ingest_entry_point_for_run_with_options(&cas, &project.path().join("app.js"), &options)
                .unwrap();
        assert_eq!(
            *requests.lock().unwrap(),
            vec![("h2g2:meaning".to_string(), "entry".to_string())]
        );

        // Real execution proves the source is not merely represented in the
        // map: removing the synthetic CAS write makes this fail at runtime
        // with `Module not found: entry-v1.0.0/h2g2:meaning`.
        xsnap::run_xs_archive_loaded(&ingested.archive).unwrap();
    }

    #[test]
    fn module_source_hook_observes_file_and_executable_synthetic_sources() {
        let temporary = tempfile::tempdir().unwrap();
        let cas = ContentStore::open(&temporary.path().join("cas")).unwrap();
        let project = tempfile::tempdir().unwrap();
        write_file(
            project.path(),
            "app.js",
            br#"import { value } from 'host:value';
                if (value !== 7) throw new Error('wrong host value');"#,
        );

        let observations = Arc::new(std::sync::Mutex::new(Vec::new()));
        let observations_for_hook = Arc::clone(&observations);
        let options = WalkOptions::default()
            .with_exit_module_import_hook(|request| {
                Ok((request.specifier == "host:value")
                    .then(|| SyntheticModuleSource::new("export const value = 7;")))
            })
            .with_module_source_hook(move |module_source| {
                let origin = match module_source.origin {
                    ModuleSourceOrigin::File { .. } => "file",
                    ModuleSourceOrigin::SyntheticExit { .. } => "synthetic",
                };
                observations_for_hook.lock().unwrap().push((
                    module_source.specifier.to_string(),
                    origin.to_string(),
                    String::from_utf8(module_source.bytes.to_vec()).unwrap(),
                ));
                Ok(())
            });

        let ingested =
            ingest_entry_point_for_run_with_options(&cas, &project.path().join("app.js"), &options)
                .unwrap();
        let observations = observations.lock().unwrap();
        assert!(observations
            .iter()
            .any(|(specifier, origin, _)| specifier == "./app.js" && origin == "file"));
        assert!(observations.iter().any(|(specifier, origin, source)| {
            specifier == "host:value"
                && origin == "synthetic"
                && source == "export const value = 7;"
        }));
        drop(observations);

        // Regression evidence: bypassing the source callback for synthetic
        // records drops the `host:value` observation even though execution
        // remains green; the assertion above makes that break visible.
        xsnap::run_xs_archive_loaded(&ingested.archive).unwrap();
    }

    #[test]
    fn exit_module_import_hook_error_stops_ingestion_with_context() {
        let temporary = tempfile::tempdir().unwrap();
        let cas = ContentStore::open(&temporary.path().join("cas")).unwrap();
        let project = tempfile::tempdir().unwrap();
        write_file(project.path(), "app.js", br#"import 'host:denied';"#);
        let options = WalkOptions::default().with_exit_module_import_hook(|_| {
            Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "host policy denied import",
            ))
        });

        let error = match ingest_entry_point_for_run_with_options(
            &cas,
            &project.path().join("app.js"),
            &options,
        ) {
            Ok(_) => panic!("exit hook error should stop ingestion"),
            Err(error) => error,
        };
        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
        assert_eq!(
            error.to_string(),
            "exit module import hook for host:denied: host policy denied import"
        );
    }

    #[test]
    fn module_source_hook_error_stops_synthetic_source_ingestion() {
        let temporary = tempfile::tempdir().unwrap();
        let cas = ContentStore::open(&temporary.path().join("cas")).unwrap();
        let project = tempfile::tempdir().unwrap();
        write_file(project.path(), "app.js", br#"import 'host:broken';"#);
        let options = WalkOptions::default()
            .with_exit_module_import_hook(|_| {
                Ok(Some(SyntheticModuleSource::new("export default 1;")))
            })
            .with_module_source_hook(|module_source| match module_source.origin {
                ModuleSourceOrigin::File { .. } => Ok(()),
                ModuleSourceOrigin::SyntheticExit { .. } => Err(io::Error::new(
                    io::ErrorKind::BrokenPipe,
                    "observer unavailable",
                )),
            });

        let error = match ingest_entry_point_for_run_with_options(
            &cas,
            &project.path().join("app.js"),
            &options,
        ) {
            Ok(_) => panic!("module source hook error should stop ingestion"),
            Err(error) => error,
        };
        assert_eq!(error.kind(), io::ErrorKind::BrokenPipe);
        assert_eq!(
            error.to_string(),
            "module source hook for host:broken: observer unavailable"
        );
    }

    #[test]
    fn ingest_entry_point_for_run_takes_no_deps_fast_path() {
        // An import-free entry keeps Phase 4's single synthetic
        // compartment: `ingest_entry_point_for_run` must route it to
        // `ingest_entry_point`, not the multi-compartment walker.
        let temporary = tempfile::tempdir().unwrap();
        let cas = ContentStore::open(&temporary.path().join("cas")).unwrap();
        let project = tempfile::tempdir().unwrap();
        write_file(project.path(), "app.js", br#"globalThis.ran = true;"#);

        let ingested = ingest_entry_point_for_run(&cas, &project.path().join("app.js")).unwrap();

        assert_eq!(ingested.archive.map.compartments.len(), 1);
        assert!(ingested
            .archive
            .map
            .compartments
            .contains_key(SYNTHETIC_COMPARTMENT_ID));
    }

    #[test]
    fn ingest_entry_point_for_run_walks_dependencies() {
        // An entry with a statically discoverable edge routes through
        // the dependency walker, yielding a separate compartment for the
        // imported package.
        let temporary = tempfile::tempdir().unwrap();
        let cas = ContentStore::open(&temporary.path().join("cas")).unwrap();
        let project = tempfile::tempdir().unwrap();
        write_file(
            project.path(),
            "app.js",
            br#"import { add } from 'mathlib'; add(1, 2);"#,
        );
        write_file(
            project.path(),
            "node_modules/mathlib/package.json",
            br#"{"name":"mathlib","version":"3.4.5","main":"./entry.js"}"#,
        );
        write_file(
            project.path(),
            "node_modules/mathlib/entry.js",
            br#"export function add(a, b) { return a + b; }"#,
        );

        let ingested = ingest_entry_point_for_run(&cas, &project.path().join("app.js")).unwrap();

        assert_eq!(ingested.archive.map.compartments.len(), 2);
        assert!(ingested
            .archive
            .map
            .compartments
            .contains_key("mathlib-v3.4.5"));
    }

    #[test]
    fn exit_module_import_hook_rejects_non_mjs_parser() {
        // The synthetic-exit contract only accepts ECMAScript source; a
        // hook returning any other parser fails ingestion at the hook
        // boundary rather than emitting an un-executable archive.
        let temporary = tempfile::tempdir().unwrap();
        let cas = ContentStore::open(&temporary.path().join("cas")).unwrap();
        let project = tempfile::tempdir().unwrap();
        write_file(project.path(), "app.js", br#"import 'host:thing';"#);
        let options = WalkOptions::default().with_exit_module_import_hook(|_| {
            Ok(Some(SyntheticModuleSource::with_parser(
                "module.exports = 1;",
                "cjs",
            )))
        });

        let error = match ingest_entry_point_for_run_with_options(
            &cas,
            &project.path().join("app.js"),
            &options,
        ) {
            Ok(_) => panic!("non-mjs synthetic parser should stop ingestion"),
            Err(error) => error,
        };
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        assert_eq!(
            error.to_string(),
            "exit module import hook for host:thing returned unsupported parser cjs; \
             synthetic exit modules must use mjs"
        );
    }

    #[test]
    fn synthetic_module_cannot_resolve_relative_import() {
        // A synthetic exit source has no file location, so it cannot host
        // a relative import — that must surface as an ingestion error, not
        // a silently dropped edge.
        let temporary = tempfile::tempdir().unwrap();
        let cas = ContentStore::open(&temporary.path().join("cas")).unwrap();
        let project = tempfile::tempdir().unwrap();
        write_file(project.path(), "app.js", br#"import 'host:relative';"#);
        let options = WalkOptions::default().with_exit_module_import_hook(|_| {
            Ok(Some(SyntheticModuleSource::new(
                "import './sibling.js'; export default 1;",
            )))
        });

        let error = match ingest_entry_point_for_run_with_options(
            &cas,
            &project.path().join("app.js"),
            &options,
        ) {
            Ok(_) => panic!("relative import from a synthetic module should stop ingestion"),
            Err(error) => error,
        };
        assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
        assert_eq!(
            error.to_string(),
            "synthetic module host:relative cannot resolve relative import ./sibling.js \
             without a file location"
        );
    }

    #[test]
    fn exit_module_import_hook_declining_drops_scheme_specifier() {
        // `Ok(None)` declines the request and preserves ordinary walker
        // behavior: a declined scheme specifier is dropped from the map
        // exactly as it is when no hook is installed, so ingestion still
        // succeeds with only the entry compartment.
        let temporary = tempfile::tempdir().unwrap();
        let cas = ContentStore::open(&temporary.path().join("cas")).unwrap();
        let project = tempfile::tempdir().unwrap();
        write_file(project.path(), "app.js", br#"import 'host:declined';"#);

        let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
        let seen_for_hook = Arc::clone(&seen);
        let options = WalkOptions::default().with_exit_module_import_hook(move |request| {
            seen_for_hook
                .lock()
                .unwrap()
                .push(request.specifier.to_string());
            Ok(None)
        });

        let ingested =
            ingest_entry_point_for_run_with_options(&cas, &project.path().join("app.js"), &options)
                .unwrap();

        assert_eq!(*seen.lock().unwrap(), vec!["host:declined".to_string()]);
        assert_eq!(ingested.archive.map.compartments.len(), 1);
        let entry = ingested
            .archive
            .map
            .compartments
            .get(SYNTHETIC_COMPARTMENT_ID)
            .unwrap();
        assert!(!entry.modules.contains_key("host:declined"));
    }

    #[test]
    fn exit_module_import_hook_resolves_missing_bare_package() {
        // A bare specifier with no `node_modules` package reaches the
        // hook at the resolution `NotFound` boundary; the supplied
        // synthetic source is what makes the archive executable.
        let temporary = tempfile::tempdir().unwrap();
        let cas = ContentStore::open(&temporary.path().join("cas")).unwrap();
        let project = tempfile::tempdir().unwrap();
        write_file(
            project.path(),
            "app.js",
            br#"import { meaning } from 'absent-pkg';
                if (meaning !== 42) throw new Error('wrong host meaning');"#,
        );
        let options = WalkOptions::default().with_exit_module_import_hook(|request| {
            Ok((request.specifier == "absent-pkg")
                .then(|| SyntheticModuleSource::new("export const meaning = 42;")))
        });

        let ingested =
            ingest_entry_point_for_run_with_options(&cas, &project.path().join("app.js"), &options)
                .unwrap();
        let entry = ingested
            .archive
            .map
            .compartments
            .get(SYNTHETIC_COMPARTMENT_ID)
            .unwrap();
        assert!(entry.modules.contains_key("absent-pkg"));

        // The synthetic source is materialized into the CAS, so the
        // archive runs: dropping the resolution would fail here with
        // `Module not found`.
        xsnap::run_xs_archive_loaded(&ingested.archive).unwrap();
    }

    #[test]
    fn exit_module_import_hook_resolves_dependency_excluded_by_classification() {
        // A bare specifier that a package's dependency fields do not
        // enable is `Excluded` by classification; the hook is consulted
        // before the deferred error is recorded, so it can host the
        // dependency instead.
        let temporary = tempfile::tempdir().unwrap();
        let cas = ContentStore::open(&temporary.path().join("cas")).unwrap();
        let project = tempfile::tempdir().unwrap();
        write_file(
            project.path(),
            "package.json",
            br#"{"name":"app","version":"1.0.0"}"#,
        );
        write_file(
            project.path(),
            "app.js",
            br#"import { meaning } from 'undeclared-dep';
                if (meaning !== 42) throw new Error('wrong host meaning');"#,
        );
        let options = WalkOptions::default().with_exit_module_import_hook(|request| {
            Ok((request.specifier == "undeclared-dep")
                .then(|| SyntheticModuleSource::new("export const meaning = 42;")))
        });

        let ingested =
            ingest_entry_point_for_run_with_options(&cas, &project.path().join("app.js"), &options)
                .unwrap();
        // The entry package declares its own name, so its compartment id
        // is `<name>-v<version>` rather than the synthetic placeholder.
        let entry = ingested.archive.map.compartments.get("app-v1.0.0").unwrap();
        assert!(entry.modules.contains_key("undeclared-dep"));
        xsnap::run_xs_archive_loaded(&ingested.archive).unwrap();
    }

    #[test]
    fn ingest_is_deterministic_across_runs() {
        // The CAS root hash for the same graph is byte-stable
        // across runs because `emit_map_json` sorts compartment
        // ids and module specifiers and `write_root_tree` walks
        // both in sorted order.
        let proj = tempfile::tempdir().unwrap();
        write_file(proj.path(), "app.js", br#"import 'a'; import 'b';"#);
        for pkg in ["a", "b"] {
            write_file(
                proj.path(),
                &format!("node_modules/{pkg}/package.json"),
                format!(r#"{{"name":"{pkg}","version":"1.0.0"}}"#).as_bytes(),
            );
            write_file(
                proj.path(),
                &format!("node_modules/{pkg}/index.js"),
                b"export const x = 1;",
            );
        }

        let tmp1 = tempfile::tempdir().unwrap();
        let cas1 = ContentStore::open(&tmp1.path().join("cas")).unwrap();
        let i1 = ingest_entry_point_with_deps(&cas1, &proj.path().join("app.js")).unwrap();
        let tmp2 = tempfile::tempdir().unwrap();
        let cas2 = ContentStore::open(&tmp2.path().join("cas")).unwrap();
        let i2 = ingest_entry_point_with_deps(&cas2, &proj.path().join("app.js")).unwrap();
        assert_eq!(i1.root_hash, i2.root_hash);
    }

    #[test]
    fn ingest_rejects_unsupported_extension() {
        let tmp = tempfile::tempdir().unwrap();
        let cas = ContentStore::open(&tmp.path().join("cas")).unwrap();
        let proj = tempfile::tempdir().unwrap();
        write_file(proj.path(), "main.txt", b"not js");
        let err = match ingest_entry_point_with_deps(&cas, &proj.path().join("main.txt")) {
            Ok(_) => panic!("expected error for unsupported extension"),
            Err(e) => e,
        };
        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
        assert!(err
            .to_string()
            .contains("unsupported entry-point extension"));
    }

    #[test]
    fn ingest_rejects_missing_entry() {
        let tmp = tempfile::tempdir().unwrap();
        let cas = ContentStore::open(&tmp.path().join("cas")).unwrap();
        let proj = tempfile::tempdir().unwrap();
        let err = match ingest_entry_point_with_deps(&cas, &proj.path().join("nope.js")) {
            Ok(_) => panic!("expected NotFound for missing entry"),
            Err(e) => e,
        };
        assert_eq!(err.kind(), io::ErrorKind::NotFound);
    }

    // ---- adversarial: resolution-cascade and node_modules edge cases ----

    /// Top-level string-shorthand `"exports": "./top.js"` is the
    /// terser sibling of the `"exports": { ".": "./top.js" }`
    /// shape covered by [`load_package_metadata_reads_exports_dot_string`].
    /// The Node resolution spec treats the two as equivalent and
    /// the design's "exports.default -> main -> index.js" cascade
    /// is meaningless if the top-level shorthand isn't read.
    ///
    /// Regression: if a future refactor of
    /// [`load_package_metadata`]'s `match exp` arm dropped the
    /// `Value::String(s) => Some(s.to_string())` branch (only
    /// honouring the `Value::Object(...)` shape), a package whose
    /// `package.json` reads `"exports": "./top.js"` would silently
    /// fall through to `main` / `index.<ext>`, picking the wrong
    /// entry. This test pins the shorthand path.
    #[test]
    fn load_package_metadata_reads_top_level_exports_string_shorthand() {
        let dir = tempfile::tempdir().unwrap();
        write_file(
            dir.path(),
            "package.json",
            br#"{"name":"foo","version":"1.0.0","exports":"./top.js"}"#,
        );
        let m = load_package_metadata(dir.path()).unwrap();
        assert_eq!(m.exports_dot_default.as_deref(), Some("./top.js"));
    }

    /// A `node_modules/<pkg>/` directory that exists but contains
    /// no `package.json` is a real failure mode (a partially
    /// installed dependency, a manual rmrf that left the dir
    /// behind, a corrupted yarn install). The walker must surface
    /// the missing file rather than crashing the process or
    /// returning a successful empty archive.
    ///
    /// Regression: the resolution must not crash the process or
    /// silently produce a compartment pointing at a non-existent
    /// entry. Since the increment that taught the walker to follow
    /// `require()` also aligned it with compartment-mapper's tolerance
    /// of unresolvable edges, a `node_modules/<pkg>/` that cannot be
    /// resolved (no `package.json`, no entry) is now recorded as a
    /// `deferredError` rather than aborting the walk — the same
    /// disposition compartment-mapper gives it — and the error still
    /// surfaces if that module is imported at runtime.
    #[test]
    fn ingest_defers_missing_package_json_in_node_modules() {
        let tmp = tempfile::tempdir().unwrap();
        let cas = ContentStore::open(&tmp.path().join("cas")).unwrap();
        let proj = tempfile::tempdir().unwrap();
        write_file(proj.path(), "app.js", br#"import 'broken-pkg';"#);
        // The package directory exists but has no package.json
        // and no index.js either — a partially-installed dep.
        std::fs::create_dir_all(proj.path().join("node_modules/broken-pkg")).unwrap();

        let ingested = ingest_entry_point_with_deps(&cas, &proj.path().join("app.js")).unwrap();
        let comp = ingested
            .archive
            .map
            .compartments
            .get(SYNTHETIC_COMPARTMENT_ID)
            .unwrap();
        assert!(matches!(
            comp.modules.get("broken-pkg"),
            Some(xsnap::archive::ModuleDescriptor::DeferredError { .. })
        ));
    }

    /// `scan_static_imports` must skip line and block comments,
    /// otherwise a benign `// import foo from "evil";` doc-comment
    /// would inject a phantom dependency. The scan recognises both
    /// `//` and `/* */`. This test exercises both forms in a
    /// single source; the bare-but-otherwise-real spec `"real"` in
    /// the non-commented `import` is the only one expected to
    /// surface.
    ///
    /// Regression: the block-comment skip is the load-bearing
    /// branch — the multi-line block-comment body below contains a
    /// `\n` followed by a bare `import` keyword at the start of a
    /// line (no leading `*` decoration). Without the block-comment
    /// skip, the parser's statement-start tracking would treat
    /// that `import` as a real statement start and emit
    /// `phantom-block-multiline` as a spurious specifier. The
    /// line-comment skip is defensive: the parser is also robust
    /// to a `// import ...` line because the leading `//` consumes
    /// `at_stmt_start` before the `import` keyword is reached, but
    /// we exercise it alongside the block form to pin the
    /// contract.
    #[test]
    fn scan_ignores_imports_inside_comments() {
        let src = "// import phantom from \"phantom-line\";\n\
                   /* not-a-statement-start-spec import phantom from \"phantom-block\"; */\n\
                   /*\n\
                   import phantom from \"phantom-block-multiline\";\n\
                   */\n\
                   import real from \"real\";\n";
        let s = scan_static_imports(src);
        assert_eq!(s.specifiers, vec!["real"]);
    }
}
