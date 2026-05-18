//! Classification of `endor run <path>` inputs.
//!
//! The `endor run` subcommand accepts a positional path that may
//! be one of three forms (per `designs/endor-run-expanded.md`):
//!
//! - Form 1: a compartment-map ZIP archive (Phase 2).
//! - Form 2: a directory laid out as a compartment-map tree
//!   (Phase 3; lives on PR #278 and not on this branch).
//! - Form 3: a single entry-point source file (Phase 4).
//!
//! The CLI inspects the path once with [`classify_run_input`] and
//! routes to the matching execution path. Keeping the classifier in
//! a library module (rather than inline in `src/bin/endor.rs`) lets
//! `cargo test --lib` exercise the discrimination directly without
//! shelling out to the built binary.

use std::path::Path;

/// Discrimination result for `endor run <path>`.
///
/// The dispatch follows the design's "input form detection by file
/// type, not flags" rule: the path is inspected once and the
/// matching run path is chosen. Directory input (Form 2 / Phase 3)
/// ships separately on PR #278 and is not present on this branch;
/// when Phase 3 lands a `RunInput::Directory` variant will join
/// this enum.
#[derive(Debug, PartialEq, Eq)]
pub enum RunInput {
    /// A ZIP archive: a regular file with a `.zip` extension or a
    /// `PK\x03\x04` magic prefix.
    ZipArchive,
    /// A single entry-point source file (Phase 4): a regular file
    /// whose extension is one of `.js`, `.mjs`, `.cjs`, `.json`
    /// and which does not match the ZIP shape above.
    EntryPoint,
    /// The path does not exist (or is not a regular file we can
    /// classify). The CLI surfaces a `NotFound`-shaped error so
    /// the user is not silently routed into one form or the
    /// other.
    Missing,
}

/// Classify a `endor run` positional argument by examining the
/// path on disk.
///
/// The classification is conservative: only confirmed ZIP files
/// route to the ZIP path, only known source extensions route to
/// the entry-point path. Anything ambiguous falls through to
/// `Missing` so the user gets a clear error rather than a
/// surprising behaviour change later.
pub fn classify_run_input(p: &Path) -> RunInput {
    if !p.is_file() {
        return RunInput::Missing;
    }

    // Extension-based fast path. `.zip` is unambiguous.
    if let Some(ext) = p.extension().and_then(|s| s.to_str()) {
        let ext_lower = ext.to_ascii_lowercase();
        match ext_lower.as_str() {
            "zip" => return RunInput::ZipArchive,
            "js" | "mjs" | "cjs" | "json" => return RunInput::EntryPoint,
            _ => {}
        }
    }

    // Magic-byte fallback for extension-less or oddly-named ZIPs.
    // The design names this as the second discrimination rule and
    // it lets `endor run foo` work when `foo` is actually a ZIP
    // saved without an extension. Read only the four magic bytes
    // so a multi-gigabyte file is not pulled into memory by the
    // classifier.
    if let Ok(mut f) = std::fs::File::open(p) {
        use std::io::Read;
        let mut magic = [0u8; 4];
        if f.read_exact(&mut magic).is_ok() && &magic == b"PK\x03\x04" {
            return RunInput::ZipArchive;
        }
    }

    // The file exists but is not a recognised form. Treat as
    // missing so the CLI surfaces a clear error.
    RunInput::Missing
}
