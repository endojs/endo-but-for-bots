//! Transitive npm dependency resolution over the CAS and registry
//! table.
//!
//! This is the resolver core of Phase 4 of
//! `designs/endor-npm-registry-proxy.md`: the `CasPackageResolver`
//! surface the XS-hosted compartment mapper calls via host
//! functions. It composes the three layers beneath it —
//! [`crate::registry::RegistryTable`] (Phase 1),
//! [`crate::fetch`] (Phase 2), and [`crate::semver`] MVS
//! (Phase 3) — into the resolution loop the design describes:
//!
//! 1. Collect requirements by walking `dependencies` from the entry
//!    package's declared ranges.
//! 2. For each package, group available versions by major and pick
//!    the greatest version satisfying every range that admits that
//!    major (Go-like MVS; two compartments may hold different major
//!    versions of the same package).
//! 3. Fetch every selected `(name, version)` into the CAS on
//!    demand — the registry-table fast path makes a re-resolution
//!    entirely offline once populated.
//! 4. Read each fetched package's `package.json` from its CAS tree,
//!    fold its `dependencies` into the requirement set, and repeat
//!    until the requirement set stops growing.
//!
//! The three host-function surfaces the design names are
//! [`NpmResolver::resolve_package`] (`resolvePackage(name, range) →
//! {version, hash}`), [`fetch_package_json`] (`fetchPackageJson
//! (hash) → JSON`), and [`fetch_module_source`]
//! (`fetchModuleSource(hash, path) → bytes`). Wiring them into the
//! XS machine's `moduleMapHook`/`importHook` is the remaining half
//! of Phase 4 and lives with the engine, not here.
//!
//! The requirement set only ever grows during a resolution
//! (accumulative fixpoint, as the design's step 4 prescribes), so a
//! version deselected by a later round still contributed its
//! ranges. That is deliberately conservative — the same
//! over-approximation Go's MVS makes — and guarantees termination:
//! each round either adds a `(name, range)` pair drawn from the
//! finite set of fetched `package.json` files or stops.

use std::collections::BTreeMap;
use std::collections::HashMap;
use std::io;

use crate::cas::ContentStore;
use crate::fetch::{fetch_metadata_cached, fetch_package, FetchError, HttpClient};
use crate::registry::RegistryTable;
use crate::semver::{Range, Version};

/// Safety valve for the resolution fixpoint. The loop terminates on
/// its own (the requirement set grows monotonically within a finite
/// universe), but hostile or malformed registry data should fail
/// loudly rather than spin.
const MAX_ROUNDS: usize = 128;

/// The requirer recorded for the entry package's own dependencies.
pub const ROOT_REQUIRER: &str = "<root>";

/// One package version selected by a resolution, fetched into the
/// CAS.
#[derive(Debug, Clone)]
pub struct ResolvedPackage {
    pub name: String,
    pub version: Version,
    /// Hex SHA-256 tree hash of the extracted package in the CAS.
    pub tree_hash: String,
    /// The package's own runtime `dependencies` (name → declared
    /// range), read from its `package.json` in the CAS tree.
    pub dependencies: BTreeMap<String, String>,
}

/// The stable outcome of [`NpmResolver::resolve_transitive`]: for
/// each package name, one selected version per major version.
#[derive(Debug, Default)]
pub struct Resolution {
    /// name → major → resolved package.
    packages: BTreeMap<String, BTreeMap<u64, ResolvedPackage>>,
}

impl Resolution {
    /// All resolved packages, ordered by name then major.
    pub fn packages(&self) -> impl Iterator<Item = &ResolvedPackage> {
        self.packages.values().flat_map(|majors| majors.values())
    }

    /// Number of resolved `(name, major)` slots.
    pub fn len(&self) -> usize {
        self.packages.values().map(|m| m.len()).sum()
    }

    pub fn is_empty(&self) -> bool {
        self.packages.is_empty()
    }

    /// The selected package for `(name, major)`, if that major was
    /// required.
    pub fn get(&self, name: &str, major: u64) -> Option<&ResolvedPackage> {
        self.packages.get(name)?.get(&major)
    }

    /// Bind a dependency edge: the greatest selected version of
    /// `name` satisfying `range`. This is how a dependent's declared
    /// range maps onto the compartment that will serve it.
    pub fn resolve_dependency(&self, name: &str, range: &str) -> Option<&ResolvedPackage> {
        let parsed = Range::parse(range)?;
        self.packages
            .get(name)?
            .values()
            .rev()
            .find(|p| parsed.satisfies(&p.version))
    }
}

/// Errors that can arise during resolution.
#[derive(Debug)]
pub enum ResolveError {
    /// A metadata or tarball fetch failed (network, integrity,
    /// extraction).
    Fetch(FetchError),
    /// A declared dependency range did not parse.
    BadRange {
        name: String,
        range: String,
        required_by: String,
    },
    /// The registry's metadata document for a package was missing
    /// or malformed.
    BadMetadata { name: String, msg: String },
    /// A fetched package's `package.json` was missing, non-UTF-8,
    /// or malformed.
    BadPackageJson { what: String, msg: String },
    /// No available version of the package satisfies a declared
    /// range at all.
    NoMatchingVersion {
        name: String,
        requirement: String,
        required_by: String,
    },
    /// Within one major version, the declared ranges admit the
    /// major individually but no single version satisfies them all.
    /// (One version per major is the design's invariant; npm-style
    /// side-by-side duplication within a major is deliberately not
    /// supported.)
    Conflict {
        name: String,
        major: u64,
        ranges: Vec<String>,
    },
    /// The fixpoint failed to stabilise within [`MAX_ROUNDS`].
    NoConvergence { rounds: usize },
    /// CAS or registry-table I/O failed.
    Io(io::Error),
}

impl std::fmt::Display for ResolveError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ResolveError::Fetch(e) => write!(f, "fetch: {e}"),
            ResolveError::BadRange {
                name,
                range,
                required_by,
            } => write!(
                f,
                "unparseable range {range:?} for {name} (required by {required_by})"
            ),
            ResolveError::BadMetadata { name, msg } => {
                write!(f, "bad metadata for {name}: {msg}")
            }
            ResolveError::BadPackageJson { what, msg } => {
                write!(f, "bad package.json for {what}: {msg}")
            }
            ResolveError::NoMatchingVersion {
                name,
                requirement,
                required_by,
            } => write!(
                f,
                "no version of {name} satisfies {requirement:?} (required by {required_by})"
            ),
            ResolveError::Conflict {
                name,
                major,
                ranges,
            } => write!(
                f,
                "conflicting ranges for {name} within major {major}: {ranges:?}"
            ),
            ResolveError::NoConvergence { rounds } => {
                write!(f, "resolution did not stabilise after {rounds} rounds")
            }
            ResolveError::Io(e) => write!(f, "io: {e}"),
        }
    }
}

impl std::error::Error for ResolveError {}

impl From<FetchError> for ResolveError {
    fn from(e: FetchError) -> Self {
        ResolveError::Fetch(e)
    }
}

impl From<io::Error> for ResolveError {
    fn from(e: io::Error) -> Self {
        ResolveError::Io(e)
    }
}

/// Resolver over one registry endpoint, one CAS, and one registry
/// table.
pub struct NpmResolver<'a, H: HttpClient> {
    http: &'a H,
    cas: &'a ContentStore,
    registry_table: &'a RegistryTable,
    registry_url: String,
}

impl<'a, H: HttpClient> NpmResolver<'a, H> {
    pub fn new(
        http: &'a H,
        cas: &'a ContentStore,
        registry_table: &'a RegistryTable,
        registry_url: &str,
    ) -> Self {
        NpmResolver {
            http,
            cas,
            registry_table,
            registry_url: registry_url.to_string(),
        }
    }

    /// Resolve the full transitive dependency graph rooted at
    /// `root_dependencies` (name → declared range, as in the entry
    /// package's `package.json`), fetching every selected package
    /// into the CAS.
    pub fn resolve_transitive(
        &self,
        root_dependencies: &BTreeMap<String, String>,
    ) -> Result<Resolution, ResolveError> {
        // name → range string → who first required it (diagnostics).
        let mut requirements: BTreeMap<String, BTreeMap<String, String>> = BTreeMap::new();
        for (name, range) in root_dependencies {
            requirements
                .entry(name.clone())
                .or_default()
                .insert(range.clone(), ROOT_REQUIRER.to_string());
        }
        if requirements.is_empty() {
            return Ok(Resolution::default());
        }

        // (name, version) → (tree_hash, dependencies), for every
        // version fetched during this resolution.
        let mut fetched: HashMap<(String, String), (String, BTreeMap<String, String>)> =
            HashMap::new();

        for _round in 0..MAX_ROUNDS {
            // Selection pass: MVS over the current requirement set.
            let mut selection: BTreeMap<String, BTreeMap<u64, Version>> = BTreeMap::new();
            for (name, ranges) in &requirements {
                let available = self.available_versions(name)?;
                let selected = select_per_major(name, &available, ranges)?;
                selection.insert(name.clone(), selected);
            }

            // Fetch pass: pull every selected version into the CAS
            // (registry-table fast path makes repeats free) and fold
            // its dependencies into the requirement set.
            let mut grew = false;
            for (name, majors) in &selection {
                for version in majors.values() {
                    let key = (name.clone(), version.to_string());
                    if !fetched.contains_key(&key) {
                        let result = fetch_package(
                            self.http,
                            self.cas,
                            self.registry_table,
                            &self.registry_url,
                            name,
                            &version.to_string(),
                        )?;
                        let deps = read_dependencies(self.cas, &result.tree_hash, name, version)?;
                        fetched.insert(key.clone(), (result.tree_hash, deps));
                    }
                    let requirer = format!("{name}@{version}");
                    let (_, deps) = &fetched[&key];
                    for (dep_name, dep_range) in deps {
                        let entry = requirements.entry(dep_name.clone()).or_default();
                        if !entry.contains_key(dep_range) {
                            entry.insert(dep_range.clone(), requirer.clone());
                            grew = true;
                        }
                    }
                }
            }

            if !grew {
                // Stable: materialise the final selection.
                let mut packages: BTreeMap<String, BTreeMap<u64, ResolvedPackage>> =
                    BTreeMap::new();
                for (name, majors) in selection {
                    for (major, version) in majors {
                        let key = (name.clone(), version.to_string());
                        let (tree_hash, dependencies) = fetched[&key].clone();
                        packages.entry(name.clone()).or_default().insert(
                            major,
                            ResolvedPackage {
                                name: name.clone(),
                                version,
                                tree_hash,
                                dependencies,
                            },
                        );
                    }
                }
                return Ok(Resolution { packages });
            }
        }

        Err(ResolveError::NoConvergence { rounds: MAX_ROUNDS })
    }

    /// Host-function surface: `resolvePackage(name, range) →
    /// {version, hash}`.
    ///
    /// Resolves a single package against the registry (no
    /// transitive walk), fetches it into the CAS, and returns it.
    /// When the range admits several majors, the greatest selected
    /// version wins.
    pub fn resolve_package(
        &self,
        name: &str,
        range: &str,
    ) -> Result<ResolvedPackage, ResolveError> {
        let mut ranges = BTreeMap::new();
        ranges.insert(range.to_string(), ROOT_REQUIRER.to_string());
        let available = self.available_versions(name)?;
        let selected = select_per_major(name, &available, &ranges)?;
        let version = selected.values().next_back().cloned().ok_or_else(|| {
            ResolveError::NoMatchingVersion {
                name: name.to_string(),
                requirement: range.to_string(),
                required_by: ROOT_REQUIRER.to_string(),
            }
        })?;
        let result = fetch_package(
            self.http,
            self.cas,
            self.registry_table,
            &self.registry_url,
            name,
            &version.to_string(),
        )?;
        let dependencies = read_dependencies(self.cas, &result.tree_hash, name, &version)?;
        Ok(ResolvedPackage {
            name: name.to_string(),
            version,
            tree_hash: result.tree_hash,
            dependencies,
        })
    }

    /// The package's available versions per the registry metadata
    /// (cached write-once in the registry table by
    /// [`fetch_metadata_cached`]).
    ///
    /// Version keys that do not parse as semver are skipped rather
    /// than fatal: the npm registry carries the occasional
    /// irregular key, and an unparseable version can never be
    /// selected anyway.
    fn available_versions(&self, name: &str) -> Result<Vec<Version>, ResolveError> {
        let body = fetch_metadata_cached(self.http, self.registry_table, &self.registry_url, name)?;
        let doc: serde_json::Value =
            serde_json::from_slice(&body).map_err(|e| ResolveError::BadMetadata {
                name: name.to_string(),
                msg: format!("parse metadata: {e}"),
            })?;
        let versions = doc
            .get("versions")
            .and_then(|v| v.as_object())
            .ok_or_else(|| ResolveError::BadMetadata {
                name: name.to_string(),
                msg: "missing versions object".to_string(),
            })?;
        Ok(versions.keys().filter_map(|k| Version::parse(k)).collect())
    }
}

/// MVS selection with major-version coexistence.
///
/// A range *admits* a major when at least one available version of
/// that major satisfies it. For each admitted major, the selected
/// version is the greatest available version satisfying **all**
/// ranges that admit that major — the "greatest explicitly
/// mentioned minor within major" rule of the design, generalised so
/// `^1.0.0` and `^2.0.0` coexist as two selections instead of
/// annihilating each other. This matches
/// [`crate::semver::select_versions`] exactly whenever every range
/// admits every major.
fn select_per_major(
    name: &str,
    available: &[Version],
    ranges: &BTreeMap<String, String>,
) -> Result<BTreeMap<u64, Version>, ResolveError> {
    let mut by_major: BTreeMap<u64, Vec<&Version>> = BTreeMap::new();
    for v in available {
        by_major.entry(v.major).or_default().push(v);
    }
    for versions in by_major.values_mut() {
        versions.sort();
    }

    // Parse every range and find which majors each admits.
    let mut parsed: Vec<(&String, Range, Vec<u64>)> = Vec::new();
    for (range_str, required_by) in ranges {
        let range = Range::parse(range_str).ok_or_else(|| ResolveError::BadRange {
            name: name.to_string(),
            range: range_str.clone(),
            required_by: required_by.clone(),
        })?;
        let admitted: Vec<u64> = by_major
            .iter()
            .filter(|(_, versions)| versions.iter().any(|v| range.satisfies(v)))
            .map(|(major, _)| *major)
            .collect();
        if admitted.is_empty() {
            return Err(ResolveError::NoMatchingVersion {
                name: name.to_string(),
                requirement: range_str.clone(),
                required_by: required_by.clone(),
            });
        }
        parsed.push((range_str, range, admitted));
    }

    let mut selected = BTreeMap::new();
    for (major, versions) in &by_major {
        let admitting: Vec<&(&String, Range, Vec<u64>)> = parsed
            .iter()
            .filter(|(_, _, admitted)| admitted.contains(major))
            .collect();
        if admitting.is_empty() {
            continue;
        }
        match versions
            .iter()
            .rev()
            .find(|v| admitting.iter().all(|(_, r, _)| r.satisfies(v)))
        {
            Some(best) => {
                selected.insert(*major, (*best).clone());
            }
            None => {
                return Err(ResolveError::Conflict {
                    name: name.to_string(),
                    major: *major,
                    ranges: admitting.iter().map(|(s, _, _)| (*s).clone()).collect(),
                });
            }
        }
    }
    Ok(selected)
}

/// Read a fetched package's runtime `dependencies` from its
/// `package.json` in the CAS tree.
fn read_dependencies(
    cas: &ContentStore,
    tree_hash: &str,
    name: &str,
    version: &Version,
) -> Result<BTreeMap<String, String>, ResolveError> {
    let what = format!("{name}@{version}");
    let text = fetch_package_json(cas, tree_hash).map_err(|e| match e {
        ResolveError::BadPackageJson { msg, .. } => ResolveError::BadPackageJson {
            what: what.clone(),
            msg,
        },
        ResolveError::Io(io_err) => ResolveError::BadPackageJson {
            what: what.clone(),
            msg: format!("read package.json: {io_err}"),
        },
        other => other,
    })?;
    let doc: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| ResolveError::BadPackageJson {
            what: what.clone(),
            msg: format!("parse: {e}"),
        })?;
    let mut dependencies = BTreeMap::new();
    match doc.get("dependencies") {
        None | Some(serde_json::Value::Null) => {}
        Some(serde_json::Value::Object(map)) => {
            for (dep_name, dep_range) in map {
                let range = dep_range
                    .as_str()
                    .ok_or_else(|| ResolveError::BadPackageJson {
                        what: what.clone(),
                        msg: format!("dependency {dep_name} range is not a string"),
                    })?;
                dependencies.insert(dep_name.clone(), range.to_string());
            }
        }
        Some(_) => {
            return Err(ResolveError::BadPackageJson {
                what,
                msg: "dependencies is not an object".to_string(),
            });
        }
    }
    Ok(dependencies)
}

/// Host-function surface: `fetchPackageJson(hash) → JSON string`.
///
/// Reads `package.json` from the package's CAS tree so the
/// compartment mapper can learn the package's entry point and
/// dependencies without any filesystem.
pub fn fetch_package_json(cas: &ContentStore, tree_hash: &str) -> Result<String, ResolveError> {
    let bytes = cas.fetch_from_tree(tree_hash, "package.json")?;
    String::from_utf8(bytes).map_err(|e| ResolveError::BadPackageJson {
        what: format!("tree {tree_hash}"),
        msg: format!("non-utf8 package.json: {e}"),
    })
}

/// Host-function surface: `fetchModuleSource(hash, path) → bytes`.
///
/// Reads one module file from the package's CAS tree; the XS
/// machine loads modules by hash and path, never from a
/// `node_modules` directory.
pub fn fetch_module_source(
    cas: &ContentStore,
    tree_hash: &str,
    path: &str,
) -> Result<Vec<u8>, ResolveError> {
    Ok(cas.fetch_from_tree(tree_hash, path)?)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fetch::DEFAULT_REGISTRY;
    use std::cell::RefCell;
    use std::collections::HashMap;
    use std::io::Write;

    /// In-memory `HttpClient` for hermetic tests (URL → body), with
    /// a call log so cache behaviour is observable.
    struct MockHttp {
        responses: HashMap<String, Vec<u8>>,
        calls: RefCell<Vec<String>>,
    }

    impl MockHttp {
        fn new() -> Self {
            MockHttp {
                responses: HashMap::new(),
                calls: RefCell::new(Vec::new()),
            }
        }
        fn respond(mut self, url: &str, body: Vec<u8>) -> Self {
            self.responses.insert(url.to_string(), body);
            self
        }
    }

    impl HttpClient for MockHttp {
        fn get_metadata(&self, url: &str) -> Result<Vec<u8>, FetchError> {
            self.calls.borrow_mut().push(format!("META {url}"));
            self.responses
                .get(url)
                .cloned()
                .ok_or_else(|| FetchError::Http(format!("no mock for {url}")))
        }
        fn get_tarball(&self, url: &str) -> Result<Vec<u8>, FetchError> {
            self.calls.borrow_mut().push(format!("TAR {url}"));
            self.responses
                .get(url)
                .cloned()
                .ok_or_else(|| FetchError::Http(format!("no mock for {url}")))
        }
    }

    fn make_tarball(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut tar_buf = Vec::new();
        {
            let mut builder = tar::Builder::new(&mut tar_buf);
            for (path, content) in entries {
                let mut header = tar::Header::new_gnu();
                header.set_size(content.len() as u64);
                header.set_mode(0o644);
                header.set_cksum();
                builder.append_data(&mut header, path, *content).unwrap();
            }
            builder.finish().unwrap();
        }
        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        gz.write_all(&tar_buf).unwrap();
        gz.finish().unwrap()
    }

    fn tarball_url(name: &str, version: &str) -> String {
        format!("https://registry.npmjs.org/{name}/-/{name}-{version}.tgz")
    }

    /// Tarball for `name@version` whose package.json declares the
    /// given runtime dependencies.
    fn pkg_tarball(name: &str, version: &str, deps: &[(&str, &str)]) -> Vec<u8> {
        let deps_json = deps
            .iter()
            .map(|(n, r)| format!(r#""{n}":"{r}""#))
            .collect::<Vec<_>>()
            .join(",");
        let pj =
            format!(r#"{{"name":"{name}","version":"{version}","dependencies":{{{deps_json}}}}}"#);
        make_tarball(&[
            ("package/package.json", pj.as_bytes()),
            ("package/index.js", b"export default 42;\n"),
        ])
    }

    /// Registry metadata document listing the given versions (no
    /// integrity, exercising the missing-integrity branch).
    fn registry_meta(name: &str, versions: &[&str]) -> Vec<u8> {
        let versions_json = versions
            .iter()
            .map(|v| {
                format!(
                    r#""{v}":{{"dist":{{"tarball":"{}"}}}}"#,
                    tarball_url(name, v)
                )
            })
            .collect::<Vec<_>>()
            .join(",");
        format!(r#"{{"versions":{{{versions_json}}}}}"#).into_bytes()
    }

    fn fresh_cas() -> (tempfile::TempDir, ContentStore) {
        let tmp = tempfile::tempdir().unwrap();
        let cas = ContentStore::open(tmp.path()).unwrap();
        (tmp, cas)
    }

    fn root_deps(deps: &[(&str, &str)]) -> BTreeMap<String, String> {
        deps.iter()
            .map(|(n, r)| (n.to_string(), r.to_string()))
            .collect()
    }

    #[test]
    fn transitive_resolution_fetches_dependency_graph() {
        // root → a@^1.0.0; a@1.2.0 → b@^2.0.0; b@2.3.0 (leaf).
        let (_tmp, cas) = fresh_cas();
        let registry = RegistryTable::open_in_memory().unwrap();
        let http = MockHttp::new()
            .respond(
                "https://registry.npmjs.org/a",
                registry_meta("a", &["1.0.0", "1.2.0"]),
            )
            .respond(
                "https://registry.npmjs.org/b",
                registry_meta("b", &["2.0.0", "2.3.0"]),
            )
            .respond(
                &tarball_url("a", "1.2.0"),
                pkg_tarball("a", "1.2.0", &[("b", "^2.0.0")]),
            )
            .respond(&tarball_url("b", "2.3.0"), pkg_tarball("b", "2.3.0", &[]));

        let resolver = NpmResolver::new(&http, &cas, &registry, DEFAULT_REGISTRY);
        let resolution = resolver
            .resolve_transitive(&root_deps(&[("a", "^1.0.0")]))
            .unwrap();

        assert_eq!(resolution.len(), 2);
        let a = resolution.get("a", 1).expect("a resolved");
        assert_eq!(a.version.to_string(), "1.2.0");
        assert_eq!(a.dependencies.get("b").map(String::as_str), Some("^2.0.0"));
        let b = resolution.get("b", 2).expect("b resolved");
        assert_eq!(b.version.to_string(), "2.3.0");
        assert!(b.dependencies.is_empty());

        // Both packages landed in the registry table and the CAS.
        assert_eq!(
            registry.lookup("a", "1.2.0").unwrap().unwrap().hash,
            a.tree_hash
        );
        assert_eq!(
            registry.lookup("b", "2.3.0").unwrap().unwrap().hash,
            b.tree_hash
        );
        let pj = fetch_package_json(&cas, &b.tree_hash).unwrap();
        assert!(
            pj.contains(r#""name":"b""#),
            "unexpected package.json: {pj}"
        );

        // The edge binds through the resolution.
        let bound = resolution.resolve_dependency("b", "^2.0.0").unwrap();
        assert_eq!(bound.version.to_string(), "2.3.0");
    }

    #[test]
    fn mvs_narrows_selection_across_rounds() {
        // Round 1 sees only the root's `a@*` and would pick a@1.2.0;
        // round 2 folds in c@1.0.0's `a@~1.1.0`, narrowing the
        // selection to the greatest version satisfying both: 1.1.5.
        let (_tmp, cas) = fresh_cas();
        let registry = RegistryTable::open_in_memory().unwrap();
        let http = MockHttp::new()
            .respond(
                "https://registry.npmjs.org/a",
                registry_meta("a", &["1.1.0", "1.1.5", "1.2.0"]),
            )
            .respond(
                "https://registry.npmjs.org/c",
                registry_meta("c", &["1.0.0"]),
            )
            .respond(&tarball_url("a", "1.1.5"), pkg_tarball("a", "1.1.5", &[]))
            .respond(&tarball_url("a", "1.2.0"), pkg_tarball("a", "1.2.0", &[]))
            .respond(
                &tarball_url("c", "1.0.0"),
                pkg_tarball("c", "1.0.0", &[("a", "~1.1.0")]),
            );

        let resolver = NpmResolver::new(&http, &cas, &registry, DEFAULT_REGISTRY);
        let resolution = resolver
            .resolve_transitive(&root_deps(&[("a", "*"), ("c", "*")]))
            .unwrap();

        let a = resolution.get("a", 1).expect("a resolved");
        assert_eq!(
            a.version.to_string(),
            "1.1.5",
            "narrowed selection must satisfy both * and ~1.1.0"
        );
        // Exactly one selection per (name, major): the round-1
        // candidate 1.2.0 must not survive as a second slot.
        assert_eq!(resolution.len(), 2);
    }

    #[test]
    fn coexisting_majors_resolve_independently() {
        // root → d@^1.0.0 and a@^1.0.0; a@1.0.0 → d@^2.0.0. Both
        // majors of d are selected and edges bind to their own major.
        let (_tmp, cas) = fresh_cas();
        let registry = RegistryTable::open_in_memory().unwrap();
        let http = MockHttp::new()
            .respond(
                "https://registry.npmjs.org/a",
                registry_meta("a", &["1.0.0"]),
            )
            .respond(
                "https://registry.npmjs.org/d",
                registry_meta("d", &["1.4.0", "2.2.0"]),
            )
            .respond(
                &tarball_url("a", "1.0.0"),
                pkg_tarball("a", "1.0.0", &[("d", "^2.0.0")]),
            )
            .respond(&tarball_url("d", "1.4.0"), pkg_tarball("d", "1.4.0", &[]))
            .respond(&tarball_url("d", "2.2.0"), pkg_tarball("d", "2.2.0", &[]));

        let resolver = NpmResolver::new(&http, &cas, &registry, DEFAULT_REGISTRY);
        let resolution = resolver
            .resolve_transitive(&root_deps(&[("a", "^1.0.0"), ("d", "^1.0.0")]))
            .unwrap();

        assert_eq!(resolution.get("d", 1).unwrap().version.to_string(), "1.4.0");
        assert_eq!(resolution.get("d", 2).unwrap().version.to_string(), "2.2.0");
        assert_eq!(
            resolution
                .resolve_dependency("d", "^1.0.0")
                .unwrap()
                .version
                .to_string(),
            "1.4.0"
        );
        assert_eq!(
            resolution
                .resolve_dependency("d", "^2.0.0")
                .unwrap()
                .version
                .to_string(),
            "2.2.0"
        );
    }

    #[test]
    fn conflicting_ranges_within_major_error() {
        // ~1.2.0 (root) and ~1.5.0 (via c) both admit major 1 but no
        // version satisfies both: the design's one-version-per-major
        // invariant makes this a hard conflict, not a duplication.
        let (_tmp, cas) = fresh_cas();
        let registry = RegistryTable::open_in_memory().unwrap();
        let http = MockHttp::new()
            .respond(
                "https://registry.npmjs.org/a",
                registry_meta("a", &["1.2.3", "1.5.2"]),
            )
            .respond(
                "https://registry.npmjs.org/c",
                registry_meta("c", &["1.0.0"]),
            )
            .respond(&tarball_url("a", "1.2.3"), pkg_tarball("a", "1.2.3", &[]))
            .respond(
                &tarball_url("c", "1.0.0"),
                pkg_tarball("c", "1.0.0", &[("a", "~1.5.0")]),
            );

        let resolver = NpmResolver::new(&http, &cas, &registry, DEFAULT_REGISTRY);
        match resolver.resolve_transitive(&root_deps(&[("a", "~1.2.0"), ("c", "*")])) {
            Err(ResolveError::Conflict {
                name,
                major,
                ranges,
            }) => {
                assert_eq!(name, "a");
                assert_eq!(major, 1);
                assert_eq!(
                    ranges.len(),
                    2,
                    "both offending ranges reported: {ranges:?}"
                );
            }
            other => panic!("expected Conflict, got {other:?}"),
        }
    }

    #[test]
    fn unsatisfiable_range_reports_no_matching_version() {
        let (_tmp, cas) = fresh_cas();
        let registry = RegistryTable::open_in_memory().unwrap();
        let http = MockHttp::new().respond(
            "https://registry.npmjs.org/a",
            registry_meta("a", &["1.0.0", "1.2.0"]),
        );

        let resolver = NpmResolver::new(&http, &cas, &registry, DEFAULT_REGISTRY);
        match resolver.resolve_transitive(&root_deps(&[("a", "^9.0.0")])) {
            Err(ResolveError::NoMatchingVersion {
                name,
                requirement,
                required_by,
            }) => {
                assert_eq!(name, "a");
                assert_eq!(requirement, "^9.0.0");
                assert_eq!(required_by, ROOT_REQUIRER);
            }
            other => panic!("expected NoMatchingVersion, got {other:?}"),
        }
    }

    #[test]
    fn bad_range_reports_offender() {
        // Git URLs, tags, workspace protocols: not supported ranges.
        let (_tmp, cas) = fresh_cas();
        let registry = RegistryTable::open_in_memory().unwrap();
        let http = MockHttp::new().respond(
            "https://registry.npmjs.org/a",
            registry_meta("a", &["1.0.0"]),
        );

        let resolver = NpmResolver::new(&http, &cas, &registry, DEFAULT_REGISTRY);
        match resolver.resolve_transitive(&root_deps(&[("a", "git+https://example.invalid/a.git")]))
        {
            Err(ResolveError::BadRange {
                name, required_by, ..
            }) => {
                assert_eq!(name, "a");
                assert_eq!(required_by, ROOT_REQUIRER);
            }
            other => panic!("expected BadRange, got {other:?}"),
        }
    }

    #[test]
    fn dependency_cycle_terminates() {
        // a@1.0.0 ↔ b@1.0.0 require each other; the accumulative
        // fixpoint must stabilise, not spin.
        let (_tmp, cas) = fresh_cas();
        let registry = RegistryTable::open_in_memory().unwrap();
        let http = MockHttp::new()
            .respond(
                "https://registry.npmjs.org/a",
                registry_meta("a", &["1.0.0"]),
            )
            .respond(
                "https://registry.npmjs.org/b",
                registry_meta("b", &["1.0.0"]),
            )
            .respond(
                &tarball_url("a", "1.0.0"),
                pkg_tarball("a", "1.0.0", &[("b", "^1.0.0")]),
            )
            .respond(
                &tarball_url("b", "1.0.0"),
                pkg_tarball("b", "1.0.0", &[("a", "^1.0.0")]),
            );

        let resolver = NpmResolver::new(&http, &cas, &registry, DEFAULT_REGISTRY);
        let resolution = resolver
            .resolve_transitive(&root_deps(&[("a", "^1.0.0")]))
            .unwrap();
        assert_eq!(resolution.len(), 2);
        assert!(resolution.get("a", 1).is_some());
        assert!(resolution.get("b", 1).is_some());
    }

    #[test]
    fn second_resolution_is_offline_from_registry_table() {
        // The design's registry-table-as-lock-file behaviour: after
        // one online resolution, an identical resolution against the
        // same table and CAS needs zero HTTP calls — metadata comes
        // from `package_meta`, packages from the `packages` fast
        // path.
        let (_tmp, cas) = fresh_cas();
        let registry = RegistryTable::open_in_memory().unwrap();
        let http = MockHttp::new()
            .respond(
                "https://registry.npmjs.org/a",
                registry_meta("a", &["1.2.0"]),
            )
            .respond(
                "https://registry.npmjs.org/b",
                registry_meta("b", &["2.3.0"]),
            )
            .respond(
                &tarball_url("a", "1.2.0"),
                pkg_tarball("a", "1.2.0", &[("b", "^2.0.0")]),
            )
            .respond(&tarball_url("b", "2.3.0"), pkg_tarball("b", "2.3.0", &[]));

        let deps = root_deps(&[("a", "^1.0.0")]);
        let online = NpmResolver::new(&http, &cas, &registry, DEFAULT_REGISTRY);
        let first = online.resolve_transitive(&deps).unwrap();

        // A client with no responses at all: any HTTP call fails.
        let offline_http = MockHttp::new();
        let offline = NpmResolver::new(&offline_http, &cas, &registry, DEFAULT_REGISTRY);
        let second = offline.resolve_transitive(&deps).unwrap();

        assert!(
            offline_http.calls.borrow().is_empty(),
            "offline re-resolution must not touch HTTP, saw {:?}",
            offline_http.calls.borrow()
        );
        assert_eq!(first.len(), second.len());
        assert_eq!(
            first.get("a", 1).unwrap().tree_hash,
            second.get("a", 1).unwrap().tree_hash
        );
        assert_eq!(
            first.get("b", 2).unwrap().tree_hash,
            second.get("b", 2).unwrap().tree_hash
        );
    }

    #[test]
    fn resolve_package_host_fn_returns_version_and_hash() {
        let (_tmp, cas) = fresh_cas();
        let registry = RegistryTable::open_in_memory().unwrap();
        let http = MockHttp::new()
            .respond(
                "https://registry.npmjs.org/a",
                registry_meta("a", &["1.0.0", "1.2.0", "2.0.0"]),
            )
            .respond(&tarball_url("a", "1.2.0"), pkg_tarball("a", "1.2.0", &[]));

        let resolver = NpmResolver::new(&http, &cas, &registry, DEFAULT_REGISTRY);
        let resolved = resolver.resolve_package("a", "^1.0.0").unwrap();
        assert_eq!(resolved.version.to_string(), "1.2.0");

        // The other two host-function surfaces work off the returned
        // hash.
        let pj = fetch_package_json(&cas, &resolved.tree_hash).unwrap();
        assert!(pj.contains(r#""version":"1.2.0""#), "got {pj}");
        let src = fetch_module_source(&cas, &resolved.tree_hash, "index.js").unwrap();
        assert_eq!(src, b"export default 42;\n");
    }

    #[test]
    fn fetch_module_source_missing_path_errors() {
        let (_tmp, cas) = fresh_cas();
        let registry = RegistryTable::open_in_memory().unwrap();
        let http = MockHttp::new()
            .respond(
                "https://registry.npmjs.org/a",
                registry_meta("a", &["1.0.0"]),
            )
            .respond(&tarball_url("a", "1.0.0"), pkg_tarball("a", "1.0.0", &[]));
        let resolver = NpmResolver::new(&http, &cas, &registry, DEFAULT_REGISTRY);
        let resolved = resolver.resolve_package("a", "1.0.0").unwrap();
        match fetch_module_source(&cas, &resolved.tree_hash, "no/such/module.js") {
            Err(ResolveError::Io(_)) => {}
            other => panic!("expected Io error, got {other:?}"),
        }
    }

    #[test]
    fn empty_root_resolves_to_empty() {
        let (_tmp, cas) = fresh_cas();
        let registry = RegistryTable::open_in_memory().unwrap();
        let http = MockHttp::new();
        let resolver = NpmResolver::new(&http, &cas, &registry, DEFAULT_REGISTRY);
        let resolution = resolver.resolve_transitive(&BTreeMap::new()).unwrap();
        assert!(resolution.is_empty());
        assert_eq!(resolution.len(), 0);
    }

    /// Live registry probe: transitively resolve `is-odd@^3.0.0`
    /// (which depends on `is-number@^6.0.0`) from
    /// `registry.npmjs.org`, then re-resolve offline from the
    /// populated registry table.
    ///
    /// Gated behind `ENDOR_REGISTRY_LIVE_TEST=1` so the suite stays
    /// hermetic by default. Run with:
    ///
    /// ```sh
    /// ENDOR_REGISTRY_LIVE_TEST=1 \
    ///   cargo test -p endo --lib resolver::tests::live_registry -- --nocapture
    /// ```
    #[test]
    fn live_registry_transitive_resolution() {
        if std::env::var("ENDOR_REGISTRY_LIVE_TEST").ok().as_deref() != Some("1") {
            eprintln!("skipping live registry test (set ENDOR_REGISTRY_LIVE_TEST=1 to enable)");
            return;
        }
        let (_tmp, cas) = fresh_cas();
        let registry = RegistryTable::open_in_memory().unwrap();
        let http = crate::fetch::UreqClient::new();
        let resolver = NpmResolver::new(&http, &cas, &registry, DEFAULT_REGISTRY);
        let resolution = resolver
            .resolve_transitive(&root_deps(&[("is-odd", "^3.0.0")]))
            .expect("live transitive resolution of is-odd@^3.0.0");

        let is_odd = resolution.get("is-odd", 3).expect("is-odd resolved");
        let is_number = resolution
            .get("is-number", 6)
            .expect("is-number pulled in transitively");
        eprintln!(
            "resolved is-odd@{} ({}) and is-number@{} ({})",
            is_odd.version, is_odd.tree_hash, is_number.version, is_number.tree_hash
        );

        // Both packages are readable from the CAS by hash alone.
        let pj = fetch_package_json(&cas, &is_number.tree_hash).unwrap();
        assert!(pj.contains("is-number"), "got {pj}");
        let src = fetch_module_source(&cas, &is_odd.tree_hash, "index.js").unwrap();
        assert!(!src.is_empty());

        // And a second resolution is served entirely from the
        // registry table: same hashes, no fresh fetches required.
        let again = resolver
            .resolve_transitive(&root_deps(&[("is-odd", "^3.0.0")]))
            .unwrap();
        assert_eq!(again.get("is-odd", 3).unwrap().tree_hash, is_odd.tree_hash);
    }
}
