//! Ties every generated `ironhorse-vm/tests/fixtures/finding-<id>.*` artifact
//! to the fuzz input it claims to come from.
//!
//! The VM regression tests replay these artifacts without the XS oracle or
//! the fuzz generators, so nothing on their side can notice a fixture that no
//! longer matches its `finding-<id>.input.bin`. This test regenerates each
//! artifact from its input with the maintained generator, and for bytecode
//! with the XS compiler, and requires byte identity:
//!
//! - `finding-<id>.program.txt`: `gen_program(input)` (target
//!   `differential_source`).
//! - `finding-<id>.regexp-case.txt`: `gen_regexp(input)`, in the layout
//!   [`format_regexp_case`] writes and `ironhorse-vm/tests/common` reads
//!   (target `differential_regexp`).
//! - `finding-<id>.bytecode.bin` and `finding-<id>.symbols.bin`: the XS
//!   compiler's output for `gen_stage3b_regexp_program(input)` (target
//!   `differential_regexp_surface`). Older bytecode fixtures that were
//!   checked in without their fuzz input have nothing to regenerate from and
//!   are skipped.
//!
//! Run with `IRONHORSE_BLESS_VM_FIXTURES=1` to rewrite the existing artifacts
//! from their inputs instead of comparing.

use std::path::{Path, PathBuf};

fn fixtures_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../ironhorse-vm/tests/fixtures")
}

fn blessing() -> bool {
    std::env::var_os("IRONHORSE_BLESS_VM_FIXTURES").is_some()
}

/// Every `finding-<id><suffix>` fixture, as `(id, path)`, sorted by id.
fn fixtures_with_suffix(suffix: &str) -> Vec<(String, PathBuf)> {
    let mut found: Vec<(String, PathBuf)> = std::fs::read_dir(fixtures_dir())
        .expect("ironhorse-vm fixtures directory")
        .map(|entry| entry.expect("fixture entry").path())
        .filter_map(|path| {
            let name = path.file_name()?.to_str()?;
            let id = name.strip_prefix("finding-")?.strip_suffix(suffix)?;
            Some((id.to_string(), path))
        })
        .collect();
    found.sort();
    found
}

fn input_for(id: &str) -> Vec<u8> {
    let path = fixtures_dir().join(format!("finding-{id}.input.bin"));
    std::fs::read(&path).unwrap_or_else(|error| panic!("{}: {error}", path.display()))
}

/// Compare `actual` with the fixture at `path`, or rewrite it when blessing.
/// Returns a description of the mismatch, if any.
fn check(path: &Path, actual: &[u8]) -> Option<String> {
    if blessing() {
        std::fs::write(path, actual).expect("bless fixture");
        return None;
    }
    let expected = std::fs::read(path).expect("fixture");
    (expected != actual).then(|| {
        format!(
            "{} does not match its regenerated content ({} bytes on disk, {} regenerated)",
            path.display(),
            expected.len(),
            actual.len()
        )
    })
}

fn escape_subject(subject: &str) -> String {
    subject.replace('\\', "\\\\").replace('\n', "\\n")
}

/// The on-disk layout of a `.regexp-case.txt` fixture. The pattern comes last
/// and runs to the end of the file, so it needs no escaping; the subject is
/// one line with `\` and newline escaped.
fn format_regexp_case((pattern, flags, subject, start): &ironhorse_fuzz::RegExpCase) -> String {
    format!(
        "flags: {flags}\nstart: {start}\nsubject: {}\npattern:\n{pattern}",
        escape_subject(subject)
    )
}

fn assert_no_mismatches(kind: &str, checked: usize, mismatches: Vec<String>) {
    assert!(checked > 0, "no {kind} fixtures found");
    assert!(
        mismatches.is_empty(),
        "{} of {checked} {kind} fixtures drifted from their inputs:\n{}",
        mismatches.len(),
        mismatches.join("\n")
    );
}

#[test]
fn program_fixtures_match_gen_program() {
    let fixtures = fixtures_with_suffix(".program.txt");
    let mismatches = fixtures
        .iter()
        .filter_map(|(id, path)| {
            check(path, ironhorse_fuzz::gen_program(&input_for(id)).as_bytes())
        })
        .collect();
    assert_no_mismatches("program", fixtures.len(), mismatches);
}

#[test]
fn regexp_case_fixtures_match_gen_regexp() {
    let fixtures = fixtures_with_suffix(".regexp-case.txt");
    let mismatches = fixtures
        .iter()
        .filter_map(|(id, path)| {
            let case = ironhorse_fuzz::gen_regexp(&input_for(id));
            check(path, format_regexp_case(&case).as_bytes())
        })
        .collect();
    assert_no_mismatches("regexp case", fixtures.len(), mismatches);
}

#[test]
fn bytecode_fixtures_match_the_xs_compiler() {
    let fixtures: Vec<_> = fixtures_with_suffix(".bytecode.bin")
        .into_iter()
        .filter(|(id, _)| {
            fixtures_dir()
                .join(format!("finding-{id}.input.bin"))
                .exists()
        })
        .collect();
    let mut mismatches = Vec::new();
    for (id, bytecode_path) in &fixtures {
        let program = ironhorse_fuzz::gen_stage3b_regexp_program(&input_for(id));
        let outcome = xs_oracle::run(&program)
            .unwrap_or_else(|| panic!("finding {id}: the XS oracle failed to start"));
        let symbols_path = fixtures_dir().join(format!("finding-{id}.symbols.bin"));
        mismatches.extend(check(bytecode_path, &outcome.bytecode));
        mismatches.extend(check(&symbols_path, &outcome.symbols));
    }
    assert_no_mismatches("bytecode", fixtures.len(), mismatches);
}

#[test]
fn regexp_case_layout_escapes_the_subject() {
    let case = (
        "a\n\\1".to_string(),
        "i".to_string(),
        "\n\\0 ".to_string(),
        2,
    );
    assert_eq!(
        format_regexp_case(&case),
        "flags: i\nstart: 2\nsubject: \\n\\\\0 \npattern:\na\n\\1"
    );
}
