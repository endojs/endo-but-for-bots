//! The source scanner behind the halt-label registry mirrors: a lexer-aware
//! pass over Rust source that blanks comments and raw strings, keeps string
//! and character literals whole, and finds construction sites outside
//! literals. Both mirrors (`tests/halt_label_registry.rs` here and the
//! runner's own label allowlist test in `ironhorse-262`) use exactly this
//! one lexer, so their notion of "a construction site" cannot drift apart.
//!
//! Hidden from the documented API: it exists for those tests, not for
//! engine consumers.

use std::fs;
use std::path::{Path, PathBuf};

/// Every `.rs` file under `dir`, recursively, sorted.
pub fn rs_files(dir: &Path) -> Vec<PathBuf> {
    fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
        for entry in fs::read_dir(dir).expect("read src dir") {
            let path = entry.expect("dir entry").path();
            if path.is_dir() {
                walk(&path, out);
            } else if path.extension().is_some_and(|e| e == "rs") {
                out.push(path);
            }
        }
    }
    let mut out = Vec::new();
    walk(dir, &mut out);
    out.sort();
    out
}

/// The length of the raw string literal (`r"…"`, `r#"…"#`, `br"…"`) that
/// starts at byte `i` of `src`, or `None` when no raw string starts there —
/// in particular not for a raw identifier (`r#type`) or an identifier that
/// merely ends in `r`.
fn raw_string_len(src: &str, i: usize) -> Option<usize> {
    let rest = &src[i..];
    let prefix = if rest.starts_with("br") {
        2
    } else if rest.starts_with('r') {
        1
    } else {
        return None;
    };
    let ident_before = i > 0 && {
        let b = src.as_bytes()[i - 1];
        b.is_ascii_alphanumeric() || b == b'_'
    };
    if ident_before {
        return None;
    }
    let hashes = rest[prefix..].bytes().take_while(|b| *b == b'#').count();
    if rest.as_bytes().get(prefix + hashes) != Some(&b'"') {
        return None;
    }
    let terminator = format!("\"{}", "#".repeat(hashes));
    let body = prefix + hashes + 1;
    Some(
        rest[body..]
            .find(&terminator)
            .map_or(rest.len(), |n| body + n + terminator.len()),
    )
}

/// A lexer-aware pass over Rust source: line comments, (nested) block
/// comments, and raw strings (`r"…"`, `r#"…"#`) are replaced by spaces
/// (newlines kept, so line arithmetic survives); string and character
/// literals are kept verbatim, delimited by [`literal_end`] itself, so every
/// pass over the result agrees with this one about where a literal begins and
/// ends. Escapes inside literals are honoured so a `\"` cannot end a string
/// early.
pub fn code_only(src: &str) -> String {
    let bytes = src.as_bytes();
    let mut out = String::with_capacity(src.len());
    let mut i = 0;
    let blank = |out: &mut String, s: &str| {
        for c in s.chars() {
            out.push(if c == '\n' { '\n' } else { ' ' });
        }
    };
    while i < bytes.len() {
        let rest = &src[i..];
        if rest.starts_with("//") {
            let end = rest.find('\n').map_or(rest.len(), |n| n);
            blank(&mut out, &rest[..end]);
            i += end;
        } else if rest.starts_with("/*") {
            let mut depth = 0usize;
            let mut j = 0;
            loop {
                let r = &rest[j..];
                if r.starts_with("/*") {
                    depth += 1;
                    j += 2;
                } else if r.starts_with("*/") {
                    depth -= 1;
                    j += 2;
                    if depth == 0 {
                        break;
                    }
                } else if r.is_empty() {
                    break;
                } else {
                    j += r.chars().next().unwrap().len_utf8();
                }
            }
            blank(&mut out, &rest[..j]);
            i += j;
        } else if let Some(end) = raw_string_len(src, i) {
            // A raw string is blanked, not kept: a label is never a raw
            // string (one used as an argument surfaces as an unregistered
            // dynamic form), and keeping its body verbatim would let an
            // unescaped quote inside it desynchronize the literal scanner
            // the later passes share.
            blank(&mut out, &rest[..end]);
            i += end;
        } else if let Some(end) = literal_end(src, i) {
            // A string or char literal, kept verbatim under the one rule the
            // later passes apply — `literal_end` is the only definition of
            // where a literal ends, so no pass can disagree with another
            // about what is inside one. A byte string's `b` prefix is copied
            // as an ordinary character before its quote opens here.
            out.push_str(&src[i..end]);
            i = end;
        } else {
            let c = rest.chars().next().unwrap();
            out.push(c);
            i += c.len_utf8();
        }
    }
    out
}

/// If a string or character literal starts at byte `i` of `code`, the byte
/// offset just past it; otherwise `None`. The one literal rule every scanner
/// below shares: a `"` opens a string that runs to the next unescaped `"`,
/// and a `'` opens a char literal only when a closing `'` follows within
/// twelve bytes with no whitespace or separator between (a lifetime or
/// label has none).
pub fn literal_end(code: &str, i: usize) -> Option<usize> {
    let bytes = code.as_bytes();
    match bytes.get(i)? {
        b'"' => {
            let mut j = i + 1;
            loop {
                match bytes.get(j) {
                    Some(b'\\') => j += 2,
                    Some(b'"') => return Some(j + 1),
                    Some(_) => j += 1,
                    None => panic!("unterminated string literal at byte {i}"),
                }
            }
        }
        b'\'' => {
            // Escapes first: `'\''` and `b'\''` close on their *third* quote,
            // and reading the escaped one as the close would leave a dangling
            // quote that opens a bogus literal over whatever follows.
            let mut j = i + 1;
            let close = loop {
                match bytes.get(j) {
                    Some(b'\\') => j += 2,
                    Some(b'\'') => break j,
                    Some(_) => j += 1,
                    None => return None,
                }
            };
            let body = &code[i + 1..close];
            let is_char = body.len() <= 12
                && !body.contains(|c: char| c.is_whitespace() || matches!(c, ';' | ',' | '>'));
            is_char.then_some(close + 1)
        }
        _ => None,
    }
}

/// Byte offsets of every occurrence of `marker` in code-only text that lies
/// outside a string or character literal.
pub fn marker_positions(code: &str, marker: &str) -> Vec<usize> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < code.len() {
        if let Some(end) = literal_end(code, i) {
            i = end;
        } else if code.is_char_boundary(i) && code[i..].starts_with(marker) {
            out.push(i);
            i += marker.len();
        } else {
            i += 1;
        }
    }
    out
}

/// Every `"…"` string literal inside `span` (code-only text; labels contain
/// no escapes, so the raw text between the quotes is the label).
pub fn string_literals(span: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < span.len() {
        match literal_end(span, i) {
            Some(end) => {
                if span.as_bytes()[i] == b'"' {
                    out.push(span[i + 1..end - 1].to_string());
                }
                i = end;
            }
            None => i += 1,
        }
    }
    out
}

/// The text between the `(` that ends `marker` (which must end with `(`) and
/// its balanced `)`, skipping parentheses inside string and char literals.
pub fn balanced_args<'a>(src: &'a str, at: usize, marker: &str) -> &'a str {
    let open = at + marker.len();
    assert_eq!(
        &src[open - 1..open],
        "(",
        "marker must end at its open paren"
    );
    let bytes = src.as_bytes();
    let mut depth = 1usize;
    let mut k = open;
    while depth > 0 {
        if let Some(end) = literal_end(src, k) {
            k = end;
            continue;
        }
        match bytes.get(k) {
            Some(b'(') => depth += 1,
            Some(b')') => depth -= 1,
            Some(_) => {}
            None => panic!("unbalanced parentheses after byte {at}"),
        }
        k += 1;
    }
    &src[open..k - 1]
}
