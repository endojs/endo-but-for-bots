//! The halt-label registry's mirror: the allowlists in
//! `ironhorse_vm::halt_labels` stay in step with the engine's construction
//! sites.
//!
//! The exemption from the oracle is granted at the differential instruments'
//! discard sites by `halt_labels::is_declined_label`, so an `Unsupported`
//! halt whose label is not registered there is a finding, however it was
//! constructed. That closes the channel. This test does the complementary
//! job: it parses the engine-side crates' sources and pins, mechanically,
//! that
//!
//! 1. every literal `Halt::Unsupported("…")` label is in
//!    `DECLINED_LABELS`, and every literal `Halt::EngineInvariant("…")`
//!    label is in `ENGINE_INVARIANT_LABELS` — so a new label fails the build
//!    until it is deliberately classified, and a stale registry entry is
//!    removed rather than left as a silent exemption;
//! 2. the two label-returning helpers the dynamic `Unsupported(…)` sites
//!    route through (`native_unsupported_name`, `array_generic_skip_reason`)
//!    return only the literals in `DECLINED_HELPER_LABELS`, and every other
//!    non-literal argument is one of the enumerated [`DECLINED_DYNAMIC_FORMS`];
//! 3. the variants are only ever spelled `Halt::Unsupported(` /
//!    `Halt::EngineInvariant(` — never imported, aliased, or taken as a
//!    function value — so the scan sees every construction;
//! 4. no `Halt::Unsupported(` site sits under a value-stack or frame-depth
//!    scrutinee (`stack.len()`, `checked_sub(`, `call_stack.len()`,
//!    `return_depth`): an underflow guard is an engine invariant, whatever
//!    label it carries, and the opcode-mnemonic form used to hide two of
//!    them;
//! 5. no declined label carries an invariant-guard signature (`underflow`,
//!    `no-frame`, `non-boundary-return`).
//!
//! The scan is lexer-aware: line and block comments are blanked, string and
//! character literals are kept whole, and parentheses inside literals do not
//! count, so a `//` inside a string or a construction after a block comment
//! cannot hide a site.

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

use ironhorse_vm::halt_labels::{DECLINED_HELPER_LABELS, DECLINED_LABELS, ENGINE_INVARIANT_LABELS};

/// The non-literal argument forms a `Halt::Unsupported(…)` construction may
/// take, whitespace-collapsed. Each names a family whose labels are pinned
/// elsewhere: opcode mnemonics (`op.name()` / `other.name()`, the
/// `XS_CODE_*` table in `opcode.rs`, accepted by `is_declined_label`), the
/// two helpers above, and the regexp crate's own compile-time
/// `CompileError::Unsupported` labels (`regexp_feature`), which that crate
/// owns and which today it never constructs. `_` is the wildcard of a `match`
/// pattern in this crate's own tests, not a construction.
const DECLINED_DYNAMIC_FORMS: &[&str] = &[
    "_",
    "Self::array_generic_skip_reason(m)",
    "native_unsupported_name(native)",
    "op.name()",
    "other.name()",
    "regexp_feature",
];

/// The non-literal forms a `Halt::EngineInvariant(…)` may take: only the
/// pattern wildcard. An invariant guard names itself, always.
const ENGINE_INVARIANT_DYNAMIC_FORMS: &[&str] = &["_"];

/// Substrings that mark an invariant guard: a label carrying one of these
/// can never be a declined surface.
const INVARIANT_SIGNATURES: &[&str] = &["underflow", "no-frame", "non-boundary-return"];

/// Scrutinee shapes under which a declined halt is really an invariant guard.
const UNDERFLOW_SCRUTINEES: &[&str] = &[
    "stack.len()",
    "checked_sub(",
    "call_stack.len()",
    "return_depth",
];

/// The engine-side crates whose sources are scanned, relative to this
/// crate's manifest directory. The harness crates (`ironhorse-262`,
/// `ironhorse-fuzz`) pin their own constructions in their own tests.
const SCANNED_CRATES: &[&str] = &[".", "../ironhorse-snapshot", "../ironhorse-compile"];

fn source_files() -> Vec<PathBuf> {
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
    for krate in SCANNED_CRATES {
        let src = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join(krate)
            .join("src");
        assert!(
            src.is_dir(),
            "scanned crate source dir missing: {}",
            src.display()
        );
        walk(&src, &mut out);
    }
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

/// A lexer-aware pass over Rust source: line comments and (nested) block
/// comments are replaced by spaces (newlines kept, so line arithmetic
/// survives), string and character literals are kept verbatim, and raw
/// strings (`r"…"`, `r#"…"#`) are handled. Escapes inside literals are
/// honoured so a `\"` cannot end a string early.
fn code_only(src: &str) -> String {
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
        } else if rest.starts_with('"') || rest.starts_with("b\"") {
            let open = if rest.starts_with('b') { 2 } else { 1 };
            let mut j = open;
            loop {
                match rest.as_bytes().get(j) {
                    Some(b'\\') => j += 2,
                    Some(b'"') => {
                        j += 1;
                        break;
                    }
                    Some(_) => j += 1,
                    None => break,
                }
            }
            out.push_str(&rest[..j]);
            i += j;
        } else if let Some(end) = raw_string_len(src, i) {
            out.push_str(&rest[..end]);
            i += end;
        } else if rest.starts_with('\'') {
            // A char literal (`'a'`, `'\n'`, `'\u{1F600}'`) or a lifetime /
            // label (`'a`, `'static`): only the former has a closing quote
            // within a few bytes.
            let close = rest[1..].find('\'').map(|n| n + 1);
            match close {
                Some(c)
                    if c <= 12
                        && !rest[1..c].contains(|ch: char| {
                            ch.is_whitespace() || ch == ';' || ch == ',' || ch == '>'
                        }) =>
                {
                    out.push_str(&rest[..=c]);
                    i += c + 1;
                }
                _ => {
                    out.push('\'');
                    i += 1;
                }
            }
        } else {
            let c = rest.chars().next().unwrap();
            out.push(c);
            i += c.len_utf8();
        }
    }
    out
}

/// Every `"…"` string literal inside `span` (already code-only text; escapes
/// honoured, unescaped verbatim since labels contain none).
fn string_literals(span: &str) -> Vec<String> {
    let mut out = Vec::new();
    let bytes = span.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'\'' {
            // Skip a char literal so `'"'` is not a string opener.
            if let Some(c) = span[i + 1..].find('\'') {
                if c <= 12 {
                    i += c + 2;
                    continue;
                }
            }
            i += 1;
            continue;
        }
        if bytes[i] == b'"' {
            let start = i + 1;
            let mut j = start;
            loop {
                match bytes.get(j) {
                    Some(b'\\') => j += 2,
                    Some(b'"') => break,
                    Some(_) => j += 1,
                    None => panic!("unterminated string literal in span: {span}"),
                }
            }
            out.push(span[start..j].to_string());
            i = j + 1;
            continue;
        }
        i += 1;
    }
    out
}

/// Byte offsets of every occurrence of `marker` in code-only text that lies
/// outside a string or character literal.
fn marker_positions(code: &str, marker: &str) -> Vec<usize> {
    let bytes = code.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'"' => {
                i += 1;
                loop {
                    match bytes.get(i) {
                        Some(b'\\') => i += 2,
                        Some(b'"') => {
                            i += 1;
                            break;
                        }
                        Some(_) => i += 1,
                        None => break,
                    }
                }
            }
            b'\'' => match code[i + 1..].find('\'') {
                Some(c) if c <= 12 => i += c + 2,
                _ => i += 1,
            },
            _ if code.is_char_boundary(i) && code[i..].starts_with(marker) => {
                out.push(i);
                i += marker.len();
            }
            _ => i += 1,
        }
    }
    out
}

/// The text between the `(` that ends `marker` (which must end with `(`) and
/// its balanced `)`, skipping parentheses inside string and char literals.
fn balanced_args<'a>(src: &'a str, at: usize, marker: &str) -> &'a str {
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
        match bytes[k] {
            b'"' => {
                k += 1;
                loop {
                    match bytes[k] {
                        b'\\' => k += 2,
                        b'"' => break,
                        _ => k += 1,
                    }
                }
            }
            b'\'' => {
                if let Some(c) = src[k + 1..].find('\'') {
                    if c <= 12 {
                        k += c + 1;
                    }
                }
            }
            b'(' => depth += 1,
            b')' => depth -= 1,
            _ => {}
        }
        k += 1;
    }
    &src[open..k - 1]
}

struct Site {
    file: PathBuf,
    line: usize,
    /// The literal labels in the argument, or empty when dynamic.
    literals: Vec<String>,
    /// The whitespace-collapsed argument text when no literal is present.
    dynamic: Option<String>,
    /// The code-only text of the six lines preceding the site.
    preceding: String,
}

/// Every construction site of `Halt::<variant>(…)` across the scanned
/// crates' sources.
fn sites(variant: &str) -> Vec<Site> {
    let marker = format!("Halt::{variant}(");
    let bare = format!("Halt::{variant}");
    let mut out = Vec::new();
    for file in source_files() {
        let src = code_only(&fs::read_to_string(&file).expect("read source"));
        // Every spelling of the variant must be a construction: no `use`,
        // no function value, no alias — so the scan below is complete.
        for at in marker_positions(&src, &bare) {
            let after = &src[at + bare.len()..];
            assert!(
                after.starts_with('('),
                "{}:{}: `{bare}` must be spelled as a construction `{marker}…)`; \
                 importing, aliasing, or taking the variant as a value would hide a \
                 site from the registry scan",
                file.display(),
                src[..at].matches('\n').count() + 1
            );
        }
        for use_line in src.lines().filter(|l| l.trim_start().starts_with("use ")) {
            assert!(
                !(use_line.contains(&bare)
                    || use_line.contains("Halt::*")
                    || use_line.contains("Halt::{")),
                "{}: `{use_line}` imports the variant, which would hide constructions \
                 from the registry scan",
                file.display()
            );
        }
        for at in marker_positions(&src, &marker) {
            let args = balanced_args(&src, at, &marker);
            let literals = string_literals(args);
            let line = src[..at].matches('\n').count() + 1;
            let preceding: String = src[..at]
                .lines()
                .rev()
                .take(6)
                .collect::<Vec<_>>()
                .join("\n");
            out.push(Site {
                file: file.clone(),
                line,
                dynamic: literals
                    .is_empty()
                    .then(|| args.split_whitespace().collect::<Vec<_>>().join(" ")),
                literals,
                preceding,
            });
        }
    }
    out
}

/// The body of the function that starts at the first occurrence of `marker`
/// in the scanned sources (code-only text).
fn fn_body(marker: &str) -> String {
    let mut found = None;
    for file in source_files() {
        let src = code_only(&fs::read_to_string(&file).expect("read source"));
        let Some(i) = src.find(marker) else { continue };
        assert!(
            found.is_none(),
            "marker {marker} occurs in more than one scanned file"
        );
        let j = i + src[i..].find('{').expect("fn body opens");
        let bytes = src.as_bytes();
        let mut depth = 0usize;
        let mut k = j;
        loop {
            match bytes[k] {
                b'{' => depth += 1,
                b'}' => {
                    depth -= 1;
                    if depth == 0 {
                        found = Some(src[j..=k].to_string());
                        break;
                    }
                }
                _ => {}
            }
            k += 1;
        }
    }
    found.unwrap_or_else(|| panic!("marker not found in any scanned file: {marker}"))
}

fn as_set(list: &[&str]) -> BTreeSet<String> {
    list.iter().map(|s| s.to_string()).collect()
}

fn diff(name: &str, found: &BTreeSet<String>, pinned: &BTreeSet<String>) {
    let unregistered: Vec<_> = found.difference(pinned).collect();
    let stale: Vec<_> = pinned.difference(found).collect();
    assert!(
        unregistered.is_empty() && stale.is_empty(),
        "{name}: labels in source but not in the registry {unregistered:?}; \
         registry entries no longer in source {stale:?}. A new label must be \
         classified in src/halt_labels.rs before it can land."
    );
}

#[test]
fn declined_labels_mirror_the_construction_sites() {
    let sites = sites("Unsupported");
    let literals: BTreeSet<String> = sites.iter().flat_map(|s| s.literals.clone()).collect();
    diff("Halt::Unsupported", &literals, &as_set(DECLINED_LABELS));
    let allowed = as_set(DECLINED_DYNAMIC_FORMS);
    let unknown: Vec<_> = sites
        .iter()
        .filter_map(|s| {
            s.dynamic
                .as_ref()
                .filter(|d| !allowed.contains(*d))
                .map(|d| format!("{}:{}: {d}", s.file.display(), s.line))
        })
        .collect();
    assert!(
        unknown.is_empty(),
        "Halt::Unsupported constructed from unregistered dynamic forms {unknown:?}; \
         a label family must be enumerated in DECLINED_DYNAMIC_FORMS and pinned"
    );
}

#[test]
fn engine_invariant_labels_mirror_the_construction_sites() {
    let sites = sites("EngineInvariant");
    let literals: BTreeSet<String> = sites.iter().flat_map(|s| s.literals.clone()).collect();
    diff(
        "Halt::EngineInvariant",
        &literals,
        &as_set(ENGINE_INVARIANT_LABELS),
    );
    let allowed = as_set(ENGINE_INVARIANT_DYNAMIC_FORMS);
    let unknown: Vec<_> = sites
        .iter()
        .filter_map(|s| {
            s.dynamic
                .as_ref()
                .filter(|d| !allowed.contains(*d))
                .map(|d| format!("{}:{}: {d}", s.file.display(), s.line))
        })
        .collect();
    assert!(
        unknown.is_empty(),
        "Halt::EngineInvariant must name its guard with a literal; found {unknown:?}"
    );
}

#[test]
fn declined_helpers_return_only_registered_labels() {
    let mut found = BTreeSet::new();
    for marker in [
        "fn native_unsupported_name(",
        "fn array_generic_skip_reason(",
    ] {
        found.extend(string_literals(&fn_body(marker)));
    }
    diff(
        "declined helper labels",
        &found,
        &as_set(DECLINED_HELPER_LABELS),
    );
}

#[test]
fn no_declined_site_is_an_underflow_guard() {
    let offenders: Vec<_> = sites("Unsupported")
        .iter()
        .filter(|s| {
            UNDERFLOW_SCRUTINEES
                .iter()
                .any(|needle| s.preceding.contains(needle))
        })
        .map(|s| format!("{}:{}", s.file.display(), s.line))
        .collect();
    assert!(
        offenders.is_empty(),
        "Halt::Unsupported under a stack-depth or frame-depth scrutinee at {offenders:?}: \
         an underflow guard is an engine invariant and belongs on Halt::EngineInvariant"
    );
    // And the check is not vacuous: the invariant guards it would catch exist.
    let guarded = sites("EngineInvariant")
        .iter()
        .filter(|s| {
            UNDERFLOW_SCRUTINEES
                .iter()
                .any(|needle| s.preceding.contains(needle))
        })
        .count();
    assert!(
        guarded >= 10,
        "expected the underflow guards to sit under a scrutinee; found {guarded}"
    );
}

#[test]
fn no_declined_label_carries_an_invariant_signature() {
    let offenders: Vec<_> = DECLINED_LABELS
        .iter()
        .chain(DECLINED_HELPER_LABELS)
        .filter(|l| INVARIANT_SIGNATURES.iter().any(|sig| l.contains(sig)))
        .collect();
    assert!(
        offenders.is_empty(),
        "declined labels with an invariant-guard signature {offenders:?}; \
         these belong in ENGINE_INVARIANT_LABELS"
    );
    for sig in INVARIANT_SIGNATURES {
        assert!(
            ENGINE_INVARIANT_LABELS.iter().any(|l| l.contains(sig)),
            "signature {sig:?} matches no invariant label"
        );
    }
}

#[test]
fn the_scanner_is_not_fooled_by_comments_or_literals() {
    // The evasions an adversarial review tried against the previous,
    // line-comment-only scanner, each of which must now be seen.
    let src = r###"
        let url = "http://example"; return Err(Halt::Unsupported("a:after-url"));
        return Err(/* see https://tc39.es */ Halt::Unsupported("b:after-block"));
        let q = '"'; return Err(Halt::Unsupported("c:after-char"));
        /* Halt::Unsupported("d:inside-block-comment") */
        // Halt::Unsupported("e:inside-line-comment")
        let s = "Halt::Unsupported(\"f:inside-string\")";
        return Err(Halt::Unsupported(if x { "g:branch-one" } else { "h:branch-two" }));
        let r#type = r"raw // not a comment"; return Err(Halt::Unsupported("i:after-raw-ident"));
        let raw = r##"Halt::Unsupported("j:inside-raw-string")"##; return Err(Halt::Unsupported("k:after-raw-string"));
        let bytes = b"(\""; return Err(Halt::Unsupported("l:after-byte-string"));
    "###;
    let code = code_only(src);
    let marker = "Halt::Unsupported(";
    let mut found = Vec::new();
    for at in marker_positions(&code, marker) {
        found.extend(string_literals(balanced_args(&code, at, marker)));
    }
    assert_eq!(
        found,
        [
            "a:after-url",
            "b:after-block",
            "c:after-char",
            "g:branch-one",
            "h:branch-two",
            "i:after-raw-ident",
            "k:after-raw-string",
            "l:after-byte-string",
        ]
    );
    assert!(!code.contains("d:inside-block-comment"));
    assert!(!code.contains("e:inside-line-comment"));
    // Raw and byte strings are kept whole too, so their contents are neither
    // comments nor construction sites.
    assert!(code.contains("raw // not a comment"));
    assert!(code.contains("j:inside-raw-string"));
    // The string is kept whole, and a marker inside a string literal is not
    // a construction site: `marker_positions` skips literals.
    assert!(code.contains("f:inside-string"));
}
