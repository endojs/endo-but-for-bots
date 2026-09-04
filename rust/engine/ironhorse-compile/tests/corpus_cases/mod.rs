//! Shared corpus-case reader for the ironhorse-compile smoke tests.
//!
//! The curated `ironhorse-262/corpora/*.js` line files retired into the
//! shared test262 `test/ironhorse/` tree (PR #600 convergence 2/5); each
//! converted case preserves its original one-line corpus program verbatim in
//! an `info: Source: <program>` frontmatter line. ironhorse-compile cannot depend
//! on ironhorse-262 (ironhorse-262 depends on ironhorse-compile — circular), so this
//! mirrors ironhorse-262's `corpora_programs()` / `case_source_line` /
//! `collect_js` (`ironhorse-262/src/compile_diff.rs`, `ironhorse-262/src/test262.rs`)
//! locally to recover the *same* programs the retired corpus carried.

use std::path::{Path, PathBuf};

/// The number of corpus programs the surviving `test/ironhorse/` tree carries — the
/// same count the retired `corpora/*.js` line files held. Asserted by each
/// smoke test so a future `cases/` regression that drops or double-counts a
/// program is caught.
pub const CORPUS_PROGRAM_COUNT: usize = 1711;

/// The shared test262 `test/ironhorse` directory, resolved from this crate's manifest.
fn cases_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../packages/test262-runner/test262/test/ironhorse")
}

/// The original corpus program a converted case preserves in its
/// `info: Source: <program>` frontmatter line. Returns `None` for a case
/// without that line (e.g. a hand-written regression case). Mirrors
/// ironhorse-262's `case_source_line`.
fn case_source_line(contents: &str) -> Option<String> {
    contents
        .lines()
        .find_map(|l| l.strip_prefix("  Source: ").map(|s| s.to_string()))
}

/// Recursively collect `*.js` case files under `dir`, skipping `staging`
/// directories and `_FIXTURE.js` files. Mirrors ironhorse-262's `collect_js`.
fn collect_js_into(dir: &Path, out: &mut Vec<PathBuf>) {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if path.file_name().map(|n| n == "staging").unwrap_or(false) {
                continue;
            }
            collect_js_into(&path, out);
        } else if path.extension().map(|e| e == "js").unwrap_or(false) {
            let name = path.file_name().unwrap_or_default().to_string_lossy();
            if !name.ends_with("_FIXTURE.js") {
                out.push(path);
            }
        }
    }
}

/// The corpus programs the `test/ironhorse/` tree carries, as `(id, source)` pairs —
/// `id` is the case's path relative to `test/ironhorse/` (a stable, sorted name for
/// error messages), `source` its verbatim one-line program. Mirrors
/// ironhorse-262's `corpora_programs()`.
pub fn corpus_programs() -> Vec<(String, String)> {
    let dir = cases_dir();
    let mut files = Vec::new();
    collect_js_into(&dir, &mut files);
    files.sort();
    let mut out = Vec::new();
    for file in &files {
        let contents = match std::fs::read_to_string(file) {
            Ok(c) => c,
            Err(_) => continue,
        };
        if let Some(source) = case_source_line(&contents) {
            let id = file
                .strip_prefix(&dir)
                .unwrap_or(file)
                .to_string_lossy()
                .into_owned();
            out.push((id, source));
        }
    }
    out
}
