//! Checks every recorded `ironhorse-vm/tests/fixtures/finding-<id>.*` artifact
//! as a durable regression lock.
//!
//! The VM regression tests replay these artifacts without the XS oracle or
//! the fuzz generators, so nothing on their side can notice a fixture that no
//! longer matches its `finding-<id>.input.bin`. Generator changes legitimately
//! re-fold those bytes, so the recorded program or regexp case is the lock:
//!
//! - `finding-<id>.program.txt`: the recorded `differential_source` program.
//! - `finding-<id>.regexp-case.txt`: the recorded `differential_regexp` case,
//!   in the layout [`format_regexp_case`] writes and
//!   `ironhorse-vm/tests/common` reads.
//! - `finding-<id>.bytecode.bin` and `finding-<id>.symbols.bin`: the XS
//!   compiler's output for the recorded `finding-<id>.regexp-program.txt`
//!   (target `differential_regexp_surface`). Older bytecode fixtures without a
//!   recorded program are skipped.

use std::path::{Path, PathBuf};

fn fixtures_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../ironhorse-vm/tests/fixtures")
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

/// Compare `actual` with the fixture at `path`.
/// Returns a description of the mismatch, if any.
fn check(path: &Path, actual: &[u8]) -> Option<String> {
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

fn parse_regexp_case(text: &str) -> ironhorse_fuzz::RegExpCase {
    let (header, pattern) = text
        .split_once("\npattern:\n")
        .expect("regexp case pattern");
    let mut lines = header.lines();
    let flags = lines
        .next()
        .and_then(|line| line.strip_prefix("flags: "))
        .expect("regexp case flags")
        .to_string();
    let start = lines
        .next()
        .and_then(|line| line.strip_prefix("start: "))
        .expect("regexp case start")
        .parse()
        .expect("numeric regexp case start");
    let escaped_subject = lines
        .next()
        .and_then(|line| line.strip_prefix("subject: "))
        .expect("regexp case subject");
    assert!(lines.next().is_none(), "unexpected regexp case header line");
    let mut subject = String::new();
    let mut chars = escaped_subject.chars();
    while let Some(ch) = chars.next() {
        if ch != '\\' {
            subject.push(ch);
            continue;
        }
        match chars.next().expect("regexp case escape") {
            '\\' => subject.push('\\'),
            'n' => subject.push('\n'),
            escape => panic!("unexpected regexp case escape: \\{escape}"),
        }
    }
    (pattern.to_string(), flags, subject, start)
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
fn recorded_program_fixtures_are_runnable() {
    let fixtures = fixtures_with_suffix(".program.txt");
    let mismatches = fixtures
        .iter()
        .filter_map(|(id, path)| {
            let program = std::fs::read_to_string(path).expect("program fixture");
            xs_oracle::run(&program)
                .is_none()
                .then(|| format!("finding {id}: XS could not run {}", path.display()))
        })
        .collect();
    assert_no_mismatches("program", fixtures.len(), mismatches);
}

#[test]
fn recorded_regexp_case_fixtures_are_canonical_and_compile() {
    let fixtures = fixtures_with_suffix(".regexp-case.txt");
    let mismatches = fixtures
        .iter()
        .filter_map(|(id, path)| {
            let text = std::fs::read_to_string(path).expect("regexp case fixture");
            let case = parse_regexp_case(&text);
            if format_regexp_case(&case) != text {
                return Some(format!("finding {id}: non-canonical regexp case"));
            }
            ironhorse_regexp::compile(&case.0, &case.1)
                .err()
                .map(|error| format!("finding {id}: recorded regexp does not compile: {error:?}"))
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
                .join(format!("finding-{id}.regexp-program.txt"))
                .exists()
        })
        .collect();
    let mut mismatches = Vec::new();
    for (id, bytecode_path) in &fixtures {
        let program_path = fixtures_dir().join(format!("finding-{id}.regexp-program.txt"));
        let program = std::fs::read_to_string(&program_path)
            .unwrap_or_else(|error| panic!("{}: {error}", program_path.display()));
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
