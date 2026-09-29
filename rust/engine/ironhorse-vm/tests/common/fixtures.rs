//! Readers for the checked-in fuzz-finding fixtures in `tests/fixtures/`.
//!
//! `ironhorse-fuzz/tests/vm_finding_fixtures.rs` regenerates every derived
//! fixture from its `finding-<id>.input.bin` and requires byte identity, so
//! these tests can replay a finding without the fuzz generators or the XS
//! oracle.

// Each test binary that declares `mod common;` uses only some of these.
#![allow(dead_code)]

/// Assert that a finding's input is the one its regression cites.
pub fn assert_input_sha256(input: &[u8], cited: &str) {
    assert_eq!(
        ironhorse_vm::cost_table::sha256::hex_sha256(input),
        cited,
        "the fixture input must be the one the finding cites"
    );
}

/// Parse a `finding-<id>.regexp-case.txt` fixture into
/// `(pattern, flags, subject, start)`, the shape of
/// `ironhorse_fuzz::RegExpCase`. The layout is three header lines, then a
/// `pattern:` line; the pattern runs verbatim to the end of the file, and
/// the subject escapes `\` and newline.
pub fn regexp_case(text: &str) -> (String, String, String, i32) {
    let (flags, rest) = header(text, "flags: ");
    let (start, rest) = header(rest, "start: ");
    let (subject, rest) = header(rest, "subject: ");
    let pattern = rest
        .strip_prefix("pattern:\n")
        .expect("regexp case fixture: pattern line");
    (
        pattern.to_string(),
        flags.to_string(),
        unescape_subject(subject),
        start.parse().expect("regexp case fixture: start offset"),
    )
}

fn header<'a>(text: &'a str, name: &str) -> (&'a str, &'a str) {
    let (line, rest) = text
        .split_once('\n')
        .unwrap_or_else(|| panic!("regexp case fixture: missing {name:?} line"));
    let value = line
        .strip_prefix(name)
        .unwrap_or_else(|| panic!("regexp case fixture: expected {name:?}, got {line:?}"));
    (value, rest)
}

fn unescape_subject(escaped: &str) -> String {
    let mut subject = String::with_capacity(escaped.len());
    let mut chars = escaped.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            subject.push(c);
            continue;
        }
        match chars.next() {
            Some('n') => subject.push('\n'),
            Some('\\') => subject.push('\\'),
            other => panic!("regexp case fixture: bad subject escape {other:?}"),
        }
    }
    subject
}
