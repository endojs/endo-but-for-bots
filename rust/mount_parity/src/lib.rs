//! Rust-side runner for the cross-language `EndoMount` glob/grep parity case
//! tables.
//!
//! `packages/daemon/test/` carries a declarative, language-neutral data
//! contract for the mount search surface:
//!
//! - `mount-fixture-manifest.json` — the canonical fixture tree (files, empty
//!   directories, denied credential names, a base64 binary probe, an optional
//!   escaping symlink).
//! - `mount-glob-cases.json` — the glob variant coverage matrix, where each
//!   case pins the exact `EndoMount.glob(pattern)` result over that fixture,
//!   sorted by UTF-16 code unit.
//! - `mount-grep-cases.json` — the grep matrix (landed by PR C), consumed by
//!   the same runner once present.
//!
//! The Node runner (`mount-glob.test.js`) iterates the same tables against the
//! real `mount.js` under V8. This crate is the design's **Rust-side** runner
//! (designs/mount-extensions-reconstruction.md § "Test strategy": *"a Rust-side
//! or XS-supervisor-side runner consumes the same three JSON files to assert
//! identical results"*). It materializes the manifest exactly as the Node
//! materializer does and reproduces `glob`'s normatively-specified semantics in
//! Rust, so a discrepancy is either a case-table regression or a drift between
//! the normative glob spec and this mirror.
//!
//! The glob semantics mirrored here are the ones `packages/daemon/src/mount.js`
//! implements: single `*` matches within a segment (never `/`) and includes
//! leading-dot names; `**` matches zero or more whole segments; every other
//! character (`?`, `[`, `]`, `+`, …) is a literal; denied credential segments
//! are never enumerated; entries that escape the confinement root through a
//! symlink are excluded; results are mount-face-relative `/`-joined paths,
//! deduplicated, sorted by UTF-16 code unit as a final step, then capped.

use std::cmp::Ordering;
use std::collections::BTreeSet;
use std::collections::HashSet;
use std::path::{Path, PathBuf};

use base64::Engine as _;
use serde::Deserialize;

/// The maximum number of paths `glob()` returns, mirroring
/// `mount.js`'s `GLOB_MAX_RESULTS`. Entries past the cap are dropped after the
/// final UTF-16 sort, so the surviving slice is deterministic.
pub const GLOB_MAX_RESULTS: usize = 10_000;

/// The default denied-segment set, mirroring `defaultDeniedSegments` in
/// `packages/daemon/src/mount.js`. Matching is case-insensitive, so the
/// entries are stored lowercased and the candidate is lowercased before the
/// probe. A mount created with an empty set disables denial entirely.
pub const DEFAULT_DENIED_SEGMENTS: &[&str] = &[
    ".ssh",
    ".aws",
    ".azure",
    ".gcloud",
    ".config",
    ".gnupg",
    ".password-store",
    ".docker",
    ".npmrc",
    ".env",
    ".env.local",
    ".env.production",
    ".kube",
    ".terraform",
];

/// The default denied-segment set as a lowercased [`HashSet`].
pub fn default_denied_segments() -> HashSet<String> {
    DEFAULT_DENIED_SEGMENTS
        .iter()
        .map(|name| name.to_lowercase())
        .collect()
}

/// The directory holding the shared cross-language contract files
/// (`packages/daemon/test/`), resolved relative to this crate.
pub fn contract_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/daemon/test")
        .canonicalize()
        .expect("contract directory packages/daemon/test must exist")
}

// Fixture manifest.

/// One record in `mount-fixture-manifest.json`.
#[derive(Debug, Clone, Deserialize)]
pub struct FixtureRecord {
    pub path: String,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub content: Option<String>,
    #[serde(default)]
    pub encoding: Option<String>,
    #[serde(default)]
    pub target: Option<String>,
    #[serde(default)]
    pub optional: bool,
}

#[derive(Debug, Clone, Deserialize)]
struct FixtureManifest {
    entries: Vec<FixtureRecord>,
}

/// The materialized fixture: the mount root plus the sets of optional records
/// that were created or skipped, mirroring `_mount-fixture.js`'s return shape.
#[derive(Debug)]
pub struct MaterializedFixture {
    /// The mount root — a `root/` subdirectory of a private parent directory,
    /// so the manifest's escaping symlink resolves to a sibling *outside* the
    /// mount root and confinement is exercised.
    pub root: PathBuf,
    /// Optional records that were created (for example the escaping symlink on
    /// a platform that permits it).
    pub created: HashSet<String>,
    /// Optional records the platform could not create; the case tables mark the
    /// expectations that depend on them.
    pub skipped: HashSet<String>,
}

/// Load the shared fixture manifest from `packages/daemon/test/`.
pub fn load_fixture_manifest() -> Vec<FixtureRecord> {
    let path = contract_dir().join("mount-fixture-manifest.json");
    let text =
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    let manifest: FixtureManifest =
        serde_json::from_str(&text).unwrap_or_else(|e| panic!("parse {}: {e}", path.display()));
    manifest.entries
}

/// Materialize the shared manifest into a fresh tree under `parent`.
///
/// `parent` must be an empty directory the caller owns (typically a
/// `tempfile::TempDir`); the mount root is its `root/` child, and an
/// `escape-target/` sibling is created to back the manifest's escaping symlink,
/// exactly as `_mount-fixture.js` does. Records flagged `optional` whose
/// creation fails (the symlink, on a platform that forbids it) are recorded in
/// `skipped` rather than aborting.
pub fn materialize_fixture(parent: &Path) -> std::io::Result<MaterializedFixture> {
    let root = parent.join("root");
    std::fs::create_dir(&root)?;

    // The manifest's escaping symlink points here, one level above the mount
    // root, so a correct glob excludes it.
    let escape_target = parent.join("escape-target");
    std::fs::create_dir(&escape_target)?;
    std::fs::write(escape_target.join("secret.txt"), b"outside the mount\n")?;

    let mut created = HashSet::new();
    let mut skipped = HashSet::new();

    for record in load_fixture_manifest() {
        let dest = root.join(&record.path);
        match record.kind.as_str() {
            "directory" => {
                std::fs::create_dir_all(&dest)?;
            }
            "file" => {
                if let Some(parent_dir) = dest.parent() {
                    std::fs::create_dir_all(parent_dir)?;
                }
                let raw = record.content.clone().unwrap_or_default();
                if record.encoding.as_deref() == Some("base64") {
                    let bytes = base64::engine::general_purpose::STANDARD
                        .decode(raw.as_bytes())
                        .unwrap_or_else(|e| panic!("decode base64 for {}: {e}", record.path));
                    std::fs::write(&dest, bytes)?;
                } else {
                    std::fs::write(&dest, raw.as_bytes())?;
                }
            }
            "symlink" => {
                if let Some(parent_dir) = dest.parent() {
                    std::fs::create_dir_all(parent_dir)?;
                }
                let target = record.target.clone().unwrap_or_default();
                match make_symlink(&target, &dest) {
                    Ok(()) => {
                        created.insert(record.path.clone());
                    }
                    Err(error) => {
                        if record.optional {
                            skipped.insert(record.path.clone());
                        } else {
                            return Err(error);
                        }
                    }
                }
            }
            other => {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    format!("Unknown fixture record type: {other}"),
                ));
            }
        }
    }

    Ok(MaterializedFixture {
        root,
        created,
        skipped,
    })
}

/// A symlink `target` (interpreted relative to the link's own directory) at
/// `link`. `optional` symlink records that cannot be created are skipped by the
/// caller, mirroring the Node materializer's platform gate.
#[cfg(unix)]
fn make_symlink(target: &str, link: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(target, link)
}

#[cfg(windows)]
fn make_symlink(target: &str, link: &Path) -> std::io::Result<()> {
    // The manifest's only symlink is optional; treat a Windows lack of
    // privilege as a skip by surfacing the error to the optional gate.
    std::os::windows::fs::symlink_dir(target, link)
}

#[cfg(not(any(unix, windows)))]
fn make_symlink(_target: &str, _link: &Path) -> std::io::Result<()> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "symlinks unsupported on this platform",
    ))
}

// Glob engine — a mirror of mount.js's glob semantics.

/// Split a glob pattern into segments, dropping empty segments so `src//x`
/// equals `src/x` and a trailing slash is ignored. A pattern with no non-empty
/// segments is an error — the empty pattern is not a match-everything wildcard.
/// Mirrors `parseGlobPattern` in mount.js.
fn parse_glob_pattern(pattern: &str) -> Result<Vec<&str>, String> {
    let segments: Vec<&str> = pattern.split('/').filter(|s| !s.is_empty()).collect();
    if segments.is_empty() {
        return Err("glob pattern must have at least one non-empty segment".to_string());
    }
    Ok(segments)
}

/// Match one glob segment against a single directory-entry `name`.
///
/// Mirrors `compileGlobSegment`: `*` matches zero or more characters within the
/// one segment (a name never contains `/`), a run of consecutive `*` collapses
/// to the same wildcard, and every other character is a literal. `*` matches
/// leading-dot names.
fn glob_segment_matches(segment: &str, name: &str) -> bool {
    let parts: Vec<&str> = segment.split('*').collect();
    // No `*`: the whole segment is one literal and must match exactly.
    if parts.len() == 1 {
        return name == parts[0];
    }
    let first = parts[0];
    let last = parts[parts.len() - 1];
    if !name.starts_with(first) || !name.ends_with(last) {
        return false;
    }
    // The prefix and suffix regions must not overlap.
    let mut pos = first.len();
    let end = name.len() - last.len();
    if pos > end {
        return false;
    }
    // Interior literals must appear in order within `name[pos..end]`. An empty
    // interior literal (from consecutive `*`) matches trivially.
    for mid in &parts[1..parts.len() - 1] {
        if mid.is_empty() {
            continue;
        }
        match name[pos..end].find(*mid) {
            Some(offset) => pos += offset + mid.len(),
            None => return false,
        }
    }
    true
}

/// Compare two strings by UTF-16 code unit, the order
/// `Array.prototype.sort`'s default comparator produces and the order the case
/// tables' `expect` lists are written in. Distinct from Rust's default `str`
/// (UTF-8 byte) ordering for astral-plane characters.
pub fn utf16_cmp(a: &str, b: &str) -> Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

/// A confinement helper: the real (symlink-resolved) form of `path` must equal
/// `root_resolved` or sit beneath it. Mirrors `isConfinedPath` in mount.js
/// (`realPath` equality or a `${root}/` prefix). A path that cannot be resolved
/// (for example a broken link) is not confined.
fn is_confined(path: &Path, root_resolved: &Path) -> bool {
    match std::fs::canonicalize(path) {
        Ok(resolved) => resolved == root_resolved || resolved.starts_with(root_resolved),
        Err(_) => false,
    }
}

/// A denied-segment predicate over a single entry name (case-insensitive).
fn is_denied(name: &str, denied: &HashSet<String>) -> bool {
    denied.contains(&name.to_lowercase())
}

/// Read the entry names of `dir` sorted by UTF-16 code unit, mirroring
/// `mount.js`'s `readDirectory(...).sort()` walk order. A read failure yields an
/// empty listing so a directory removed mid-walk drops its branch rather than
/// aborting the glob.
fn read_dir_sorted(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = match std::fs::read_dir(dir) {
        Ok(iter) => iter
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect(),
        Err(_) => return Vec::new(),
    };
    names.sort_by(|a, b| utf16_cmp(a, b));
    names
}

/// Run a glob over the fixture rooted at `root` with the given denied-segment
/// set, returning the mount-face-relative `/`-joined result paths sorted by
/// UTF-16 code unit and capped at [`GLOB_MAX_RESULTS`].
///
/// This is a faithful Rust mirror of `EndoMount.glob` restricted to the glob
/// surface (no revocation liveness, which is a daemon concern). Confinement,
/// deny filtering, `**` recursion, and the final sort/cap all follow mount.js.
pub fn glob(root: &Path, pattern: &str, denied: &HashSet<String>) -> Result<Vec<String>, String> {
    let pattern_segments = parse_glob_pattern(pattern)?;
    let root_resolved = std::fs::canonicalize(root)
        .map_err(|e| format!("cannot resolve mount root {}: {e}", root.display()))?;

    let mut results: BTreeSet<String> = BTreeSet::new();
    walk(
        &pattern_segments,
        root,
        &[],
        &root_resolved,
        denied,
        &mut results,
    );

    let mut sorted: Vec<String> = results.into_iter().collect();
    sorted.sort_by(|a, b| utf16_cmp(a, b));
    sorted.truncate(GLOB_MAX_RESULTS);
    Ok(sorted)
}

/// Match the remaining pattern segments against the tree rooted at `dir`,
/// accumulating mount-face-relative `/`-joined paths in `results`. A faithful
/// mirror of the `walk` closure in `mount.js`'s `glob`.
fn walk(
    remaining: &[&str],
    dir: &Path,
    prefix: &[String],
    root_resolved: &Path,
    denied: &HashSet<String>,
    results: &mut BTreeSet<String>,
) {
    if remaining.is_empty() {
        // The mount face's own root (empty prefix) is never itself a result.
        if !prefix.is_empty() {
            results.insert(prefix.join("/"));
        }
        return;
    }

    let names = read_dir_sorted(dir);
    let head = remaining[0];
    let rest = &remaining[1..];

    if head == "**" {
        // Zero segments consumed: continue matching `rest` at this directory
        // (so `docs/**/*.md` still matches `docs/*.md`).
        walk(rest, dir, prefix, root_resolved, denied, results);
        for name in &names {
            if is_denied(name, denied) {
                continue;
            }
            let child_path = dir.join(name);
            if !is_confined(&child_path, root_resolved) {
                continue;
            }
            let mut child_prefix = prefix.to_vec();
            child_prefix.push(name.clone());
            if child_path.is_dir() {
                // One or more segments consumed: descend with `**` still in play.
                walk(
                    remaining,
                    &child_path,
                    &child_prefix,
                    root_resolved,
                    denied,
                    results,
                );
            } else if rest.is_empty() {
                // A trailing `**` also matches file descendants directly.
                results.insert(child_prefix.join("/"));
            }
        }
        return;
    }

    for name in &names {
        if is_denied(name, denied) || !glob_segment_matches(head, name) {
            continue;
        }
        let child_path = dir.join(name);
        if !is_confined(&child_path, root_resolved) {
            continue;
        }
        let mut child_prefix = prefix.to_vec();
        child_prefix.push(name.clone());
        if rest.is_empty() {
            results.insert(child_prefix.join("/"));
            continue;
        }
        // A non-final segment must descend, so it matches directories only.
        if child_path.is_dir() {
            walk(
                rest,
                &child_path,
                &child_prefix,
                root_resolved,
                denied,
                results,
            );
        }
    }
}
