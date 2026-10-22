//! Classification of `endor run <path>` inputs.
//!
//! The `endor run` subcommand accepts a positional path that may
//! be one of three forms (per `designs/endor-run-expanded.md`):
//!
//! - Form 1: a compartment-map ZIP archive (Phase 2).
//! - Form 2: a directory laid out as a compartment-map tree
//!   (Phase 3).
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
/// matching run path is chosen. [`resolve_run_input`] applies the
/// explicit `--zip` / `--dir` override.
#[derive(Debug, PartialEq, Eq)]
pub enum RunInput {
    /// A ZIP archive: a regular file with a `.zip` extension or a
    /// `PK\x03\x04` magic prefix.
    ZipArchive,
    /// An unpacked compartment-map directory (Phase 3). Any
    /// directory routes here; `ingest_directory` reports a missing
    /// `compartment-map.json`.
    Directory,
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
pub fn classify_run_input(path: &Path) -> RunInput {
    if path.is_dir() {
        return RunInput::Directory;
    }
    if !path.is_file() {
        return RunInput::Missing;
    }

    // Extension-based fast path. `.zip` is unambiguous.
    if let Some(extension) = path.extension().and_then(|value| value.to_str()) {
        let lowercase_extension = extension.to_ascii_lowercase();
        match lowercase_extension.as_str() {
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
    if let Ok(mut file) = std::fs::File::open(path) {
        use std::io::Read;
        let mut magic = [0u8; 4];
        if file.read_exact(&mut magic).is_ok() && &magic == b"PK\x03\x04" {
            return RunInput::ZipArchive;
        }
    }

    // The file exists but is not a recognised form. Treat as
    // missing so the CLI surfaces a clear error.
    RunInput::Missing
}

/// An explicit form chosen with `--zip` or `--dir`.
///
/// The design keeps detection by file type as the default and makes
/// these flags available "for disambiguation but rarely needed": a
/// ZIP with bytes ahead of its first local file header (a
/// self-extracting stub, say) lacks the magic the classifier sniffs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunForm {
    /// `--zip`: read the path as a ZIP archive.
    Zip,
    /// `--dir`: read the path as an unpacked compartment-map directory.
    Directory,
}

impl RunForm {
    fn flag(self) -> &'static str {
        match self {
            RunForm::Zip => "--zip",
            RunForm::Directory => "--dir",
        }
    }
}

/// Read the form override from the `endor run` argument list.
///
/// Repeating one flag is harmless. Naming two different forms is a
/// usage error, reported as a message naming both flags.
pub fn parse_run_form(args: &[String]) -> Result<Option<RunForm>, String> {
    let mut chosen: Option<RunForm> = None;
    for argument in args {
        let form = match argument.as_str() {
            "--zip" => RunForm::Zip,
            "--dir" => RunForm::Directory,
            _ => continue,
        };
        match chosen {
            Some(previous) if previous != form => {
                return Err(format!(
                    "{} and {} name different input forms; pass at most one",
                    previous.flag(),
                    form.flag()
                ));
            }
            _ => chosen = Some(form),
        }
    }
    Ok(chosen)
}

/// Classify `path`, honoring an explicit form when one is given.
///
/// Without an override this is [`classify_run_input`]. With one, the
/// override replaces extension and magic-byte detection, but the path
/// type still has to fit: `--dir` needs a directory and `--zip` needs
/// a regular file. A path that does not exist is
/// `Missing` either way, so the CLI reports it the same way.
pub fn resolve_run_input(path: &Path, form: Option<RunForm>) -> Result<RunInput, String> {
    let Some(form) = form else {
        return Ok(classify_run_input(path));
    };
    if !path.exists() {
        return Ok(RunInput::Missing);
    }
    match form {
        RunForm::Directory if path.is_dir() => Ok(RunInput::Directory),
        RunForm::Zip if path.is_file() => Ok(RunInput::ZipArchive),
        RunForm::Directory => Err(format!("--dir expects a directory: {}", path.display())),
        RunForm::Zip => Err(format!("--zip expects a regular file: {}", path.display())),
    }
}

// Tests

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// Write `bytes` to a fresh temporary file named `name` inside
    /// a fresh temporary directory. Returns both so the caller can
    /// keep the temp dir alive for the duration of the assertion.
    fn write_temp_file(name: &str, bytes: &[u8]) -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(name);
        std::fs::write(&path, bytes).unwrap();
        (dir, path)
    }

    /// A four-byte ZIP local-file-header magic followed by enough
    /// trailing bytes that `read_exact([0u8; 4])` always succeeds.
    /// We do not need a valid ZIP body here: `classify_run_input`
    /// only inspects the first four bytes.
    fn zip_magic_prefix() -> Vec<u8> {
        let mut v = Vec::from(*b"PK\x03\x04");
        // Padding so `read_exact` cannot short-circuit on a tiny
        // file when our test happens to write only the magic.
        v.extend_from_slice(&[0u8; 8]);
        v
    }

    #[test]
    fn missing_when_path_does_not_exist() {
        // A non-existent path classifies as Missing without any
        // attempt to open the file. The CLI uses this verdict to
        // print a clear error rather than routing into either
        // form blind.
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("nope.zip");
        assert_eq!(classify_run_input(&missing), RunInput::Missing);
    }

    #[test]
    fn directory_when_path_is_a_directory() {
        // A directory routes to the Phase 3 directory form, even
        // when its name looks like a ZIP or a source file: the path
        // type is checked before any extension.
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(classify_run_input(dir.path()), RunInput::Directory);
        for name in ["archive.zip", "entry.js"] {
            let sub = dir.path().join(name);
            std::fs::create_dir(&sub).unwrap();
            assert_eq!(classify_run_input(&sub), RunInput::Directory, "{name}");
        }
    }

    #[test]
    fn zip_archive_by_dot_zip_extension() {
        // The fast path: any regular file with a `.zip` extension
        // routes to `ZipArchive` without reading the file body.
        // The bytes here are *not* a valid ZIP and the classifier
        // does not care.
        let (_tmp, path) = write_temp_file("archive.zip", b"not a real zip body");
        assert_eq!(classify_run_input(&path), RunInput::ZipArchive);
    }

    #[test]
    fn zip_archive_by_uppercase_extension() {
        // Extension matching is case-insensitive: a Windows-y
        // `ARCHIVE.ZIP` still routes through the ZIP path. The
        // lowercase normalization is the only reason this case
        // does not fall through to the magic-byte fallback.
        let (_tmp, path) = write_temp_file("ARCHIVE.ZIP", b"not a real zip body");
        assert_eq!(classify_run_input(&path), RunInput::ZipArchive);
    }

    #[test]
    fn entry_point_by_known_source_extension() {
        // Each of `.js`, `.mjs`, `.cjs`, `.json` routes to the
        // entry-point form. The body content does not matter for
        // classification; `ingest_entry_point` does the actual
        // parsing later.
        for ext in ["js", "mjs", "cjs", "json"] {
            let (_tmp, path) = write_temp_file(&format!("entry.{ext}"), b"x");
            assert_eq!(
                classify_run_input(&path),
                RunInput::EntryPoint,
                "extension .{ext} should route to EntryPoint",
            );
        }
    }

    #[test]
    fn entry_point_extensions_are_case_insensitive() {
        // The `.to_ascii_lowercase()` in the classifier means
        // `Hello.JS` is just as much an entry-point as `hello.js`.
        // Pinning this protects against a regression that drops
        // the lowercase normalization (e.g., a literal-match
        // `match ext { "js" => ... }` without the lower step).
        let (_tmp, path) = write_temp_file("Hello.JS", b"export default 1;");
        assert_eq!(classify_run_input(&path), RunInput::EntryPoint);
    }

    #[test]
    fn zip_archive_by_magic_bytes_without_zip_extension() {
        // The magic-byte fallback is the second discrimination
        // rule: a file without a `.zip` extension that *does*
        // start with `PK\x03\x04` still routes to the ZIP path so
        // `endor run foo` works when `foo` is a ZIP saved with a
        // different (or no) suffix. This is the Phase 4
        // behaviour-change the classifier introduces, so the test
        // is load-bearing for the new code path. Regression-
        // evidence: stripping the magic-byte fallback block
        // changes the verdict on this file to `Missing`.
        let mut buf = io::Cursor::new(Vec::new());
        {
            let mut zip = zip::ZipWriter::new(&mut buf);
            zip.start_file("hello.txt", zip::write::SimpleFileOptions::default())
                .unwrap();
            zip.write_all(b"hello").unwrap();
            zip.finish().unwrap();
        }
        // Write the real ZIP with a no-`.zip`-extension name.
        let (_tmp, path) = write_temp_file("bundle", buf.get_ref());
        assert_eq!(classify_run_input(&path), RunInput::ZipArchive);
    }

    #[test]
    fn zip_archive_by_magic_when_extension_is_unrecognised() {
        // A `.bin`-named file whose body happens to be a ZIP
        // still routes to the ZIP path. The extension-match
        // branch falls through (`.bin` is none of `.zip`, `.js`,
        // `.mjs`, `.cjs`, `.json`), and the magic-byte fallback
        // takes over.
        let (_tmp, path) = write_temp_file("payload.bin", &zip_magic_prefix());
        assert_eq!(classify_run_input(&path), RunInput::ZipArchive);
    }

    #[test]
    fn missing_when_file_has_no_extension_and_no_magic() {
        // A regular file with neither a recognised extension nor
        // a ZIP magic prefix is `Missing`: the user is not
        // silently routed into either form. This is the
        // conservative third clause of the classifier and the
        // last line of defence against a future regression that
        // would, for example, treat unknown extensions as
        // entry-point sources.
        let (_tmp, path) = write_temp_file("randomdata", b"not a zip and not js");
        assert_eq!(classify_run_input(&path), RunInput::Missing);
    }

    #[test]
    fn missing_when_extension_is_unknown_and_no_magic() {
        // Mirror of the above with a non-empty extension that is
        // none of the recognised ones. The classifier neither
        // routes by extension nor finds a ZIP magic, so it falls
        // through to `Missing`.
        let (_tmp, path) = write_temp_file("notes.txt", b"plain text");
        assert_eq!(classify_run_input(&path), RunInput::Missing);
    }

    #[test]
    fn missing_when_file_too_short_for_magic_check() {
        // A regular file shorter than four bytes cannot satisfy
        // the `read_exact([0u8; 4])` check, so the magic-byte
        // branch short-circuits and the verdict is `Missing`.
        // This pins the conservative behaviour on a truncated
        // input.
        let (_tmp, path) = write_temp_file("tiny", b"PK");
        assert_eq!(classify_run_input(&path), RunInput::Missing);
    }

    fn arguments(items: &[&str]) -> Vec<String> {
        items.iter().map(|item| item.to_string()).collect()
    }

    #[test]
    fn run_form_absent_by_default() {
        assert_eq!(parse_run_form(&arguments(&["app.js"])), Ok(None));
        assert_eq!(
            parse_run_form(&arguments(&["--no-cas", "--node-modules", "app.js"])),
            Ok(None)
        );
    }

    #[test]
    fn run_form_flags_parse_in_any_position() {
        assert_eq!(
            parse_run_form(&arguments(&["--zip", "bundle"])),
            Ok(Some(RunForm::Zip))
        );
        assert_eq!(
            parse_run_form(&arguments(&["--offline", "app", "--dir"])),
            Ok(Some(RunForm::Directory))
        );
        assert_eq!(
            parse_run_form(&arguments(&["--zip", "bundle", "--zip"])),
            Ok(Some(RunForm::Zip))
        );
    }

    #[test]
    fn run_form_rejects_two_different_forms() {
        let error = parse_run_form(&arguments(&["--zip", "--dir", "x"])).unwrap_err();
        assert!(
            error.contains("--zip") && error.contains("--dir"),
            "{error}"
        );
    }

    #[test]
    fn resolve_without_override_is_classification() {
        let (_temporary, path) = write_temp_file("notes.txt", b"plain text");
        assert_eq!(resolve_run_input(&path, None), Ok(RunInput::Missing));
        let (_temporary, path) = write_temp_file("entry.js", b"x");
        assert_eq!(resolve_run_input(&path, None), Ok(RunInput::EntryPoint));
    }

    #[test]
    fn zip_override_routes_a_file_without_magic() {
        let (_temporary, path) = write_temp_file("bundle.bin", b"#!stub\nPK\x03\x04");
        assert_eq!(classify_run_input(&path), RunInput::Missing);
        assert_eq!(
            resolve_run_input(&path, Some(RunForm::Zip)),
            Ok(RunInput::ZipArchive)
        );
    }

    #[test]
    fn zip_override_wins_over_entry_extension() {
        let (_temporary, path) = write_temp_file("bundle.js", b"#!stub\nPK\x03\x04");
        assert_eq!(classify_run_input(&path), RunInput::EntryPoint);
        assert_eq!(
            resolve_run_input(&path, Some(RunForm::Zip)),
            Ok(RunInput::ZipArchive)
        );
    }

    #[test]
    fn dir_override_accepts_a_directory() {
        let directory = tempfile::tempdir().unwrap();
        assert_eq!(
            resolve_run_input(directory.path(), Some(RunForm::Directory)),
            Ok(RunInput::Directory)
        );
    }

    #[test]
    fn override_rejects_a_path_of_the_wrong_type() {
        let directory = tempfile::tempdir().unwrap();
        let error = resolve_run_input(directory.path(), Some(RunForm::Zip)).unwrap_err();
        assert!(error.contains("--zip expects a regular file"), "{error}");
        let (_temporary, path) = write_temp_file("archive.zip", &zip_magic_prefix());
        let error = resolve_run_input(&path, Some(RunForm::Directory)).unwrap_err();
        assert!(error.contains("--dir expects a directory"), "{error}");
    }

    #[test]
    fn override_of_a_missing_path_is_missing() {
        let directory = tempfile::tempdir().unwrap();
        let missing = directory.path().join("nope");
        for form in [RunForm::Zip, RunForm::Directory] {
            assert_eq!(
                resolve_run_input(&missing, Some(form)),
                Ok(RunInput::Missing),
                "{form:?}"
            );
        }
    }

    // Re-import io within the tests module for the cursor used by
    // `zip_archive_by_magic_bytes_without_zip_extension`. The
    // helper imports it through `use std::io;` here instead of in
    // the parent module so the source module stays minimal.
    use std::io;
}
