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
//!    `Halt::EngineInvariant(` — never imported, aliased (a `Halt::{…}` or
//!    `Halt::*` group anywhere), or taken as a function value — so the scan
//!    sees every construction;
//! 4. no `Halt::Unsupported(` site sits within eight lines below a value-stack
//!    or frame-depth scrutinee (`stack.len()`, `checked_sub(`,
//!    `call_stack.len()`): an underflow guard is an engine
//!    invariant, whatever label it carries, and the opcode-mnemonic form used
//!    to hide three of them, so that form is now confined to the dispatch
//!    loop's default arm. The window is a textual backstop, not a control-flow
//!    analysis: it catches the shape every underflow guard in this crate has,
//!    while the allowlist and its reviewer remain the real classification;
//! 5. no declined label carries an invariant-guard signature (`underflow`,
//!    `no-frame`, `non-boundary-return`).
//!
//! The scan is lexer-aware (`ironhorse_vm::source_scan`, shared with the
//! runner's own mirror): line and block comments and raw strings are blanked,
//! string and character literals are kept whole, and parentheses inside
//! literals do not count, so a `//` inside a string or a construction after a
//! block comment cannot hide a site.

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

use ironhorse_vm::source_scan::{
    balanced_args, code_only, marker_positions, rs_files, string_literals,
};

use ironhorse_vm::halt_labels::{DECLINED_HELPER_LABELS, DECLINED_LABELS, ENGINE_INVARIANT_LABELS};

/// The non-literal argument forms a `Halt::Unsupported(…)` construction may
/// take, whitespace-collapsed. Each names a family whose labels are pinned
/// elsewhere: opcode mnemonics (`other.name()` at the dispatch loop's default
/// arm only, the `gxCodeNames` table in `opcode.rs`, accepted by
/// `is_declined_label`), the
/// two helpers above, and the regexp crate's own compile-time
/// `CompileError::Unsupported` labels (`regexp_feature`), which that crate
/// owns and which today it never constructs. `_` is the wildcard of a `match`
/// pattern in this crate's own tests, not a construction.
const DECLINED_DYNAMIC_FORMS: &[&str] = &[
    "_",
    "Self::array_generic_skip_reason(m)",
    "native_unsupported_name(native)",
    "other.name()",
    "regexp_feature",
];

/// The one site that may decline with a bare opcode mnemonic: the dispatch
/// loop's default arm, reached only by an opcode with no handler at all.
/// Every other refusal names its condition with a literal, so an operand or
/// stack guard cannot borrow the opcode-mnemonic family to stay unclassified.
const MNEMONIC_SITES: usize = 1;

/// The non-literal forms a `Halt::EngineInvariant(…)` may take: only the
/// pattern wildcard. An invariant guard names itself, always.
const ENGINE_INVARIANT_DYNAMIC_FORMS: &[&str] = &["_"];

/// Substrings that mark an invariant guard: a label carrying one of these
/// can never be a declined surface.
const INVARIANT_SIGNATURES: &[&str] = &["underflow", "no-frame", "non-boundary-return"];

/// Scrutinee shapes under which a declined halt is really an invariant guard.
const UNDERFLOW_SCRUTINEES: &[&str] = &["stack.len()", "checked_sub(", "call_stack.len()"];

/// The engine-side crates whose sources are scanned, relative to this
/// crate's manifest directory. The harness crates (`ironhorse-262`,
/// `ironhorse-fuzz`) pin their own constructions in their own tests.
const SCANNED_CRATES: &[&str] = &[".", "../ironhorse-snapshot", "../ironhorse-compile"];

fn source_files() -> Vec<PathBuf> {
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
        out.extend(rs_files(&src));
    }
    out
}

struct Site {
    file: PathBuf,
    line: usize,
    /// The literal labels in the argument, or empty when dynamic.
    literals: Vec<String>,
    /// The whitespace-collapsed argument text when no literal is present.
    dynamic: Option<String>,
    /// The code-only text of the eight lines preceding the site.
    preceding: String,
}

/// The scanned crates' sources, lexed to code-only text once per process:
/// every test below walks the same tens of thousands of lines.
fn lexed_sources() -> &'static [(PathBuf, String)] {
    use std::sync::OnceLock;
    static SOURCES: OnceLock<Vec<(PathBuf, String)>> = OnceLock::new();
    SOURCES.get_or_init(|| {
        source_files()
            .into_iter()
            .map(|file| {
                let code = code_only(&fs::read_to_string(&file).expect("read source"));
                (file, code)
            })
            .collect()
    })
}

/// Every construction site of `Halt::<variant>(…)` across the scanned
/// crates' sources.
fn sites(variant: &str) -> Vec<Site> {
    let marker = format!("Halt::{variant}(");
    let bare = format!("Halt::{variant}");
    let mut out = Vec::new();
    for (file, src) in lexed_sources() {
        let src = src.as_str();
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
        for glob in ["Halt::*", "Halt::{", "Halt as ", "= Halt;"] {
            assert!(
                marker_positions(&src, glob).is_empty(),
                "{}: `{glob}` imports, aliases, or renames `Halt` or its variants (in a \
                 `use` group spanning any number of lines, or a type alias), which \
                 would hide constructions from the registry scan",
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
                .take(8)
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
    for (_, src) in lexed_sources() {
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
    let mnemonic_sites = sites
        .iter()
        .filter(|s| s.dynamic.as_deref() == Some("other.name()"))
        .count();
    assert_eq!(
        mnemonic_sites, MNEMONIC_SITES,
        "only the dispatch loop's default arm may decline with a bare opcode mnemonic"
    );
}

#[test]
fn the_regexp_crate_constructs_no_declined_labels() {
    // `build_regexp` passes `ironhorse_regexp::CompileError::Unsupported`'s
    // label straight through as a declined halt (the `regexp_feature` form).
    // That crate constructs none today; the day it does, its labels need a
    // registry of their own (and `is_declined_label` must learn them), so
    // pin the count at zero rather than let a new family in silently.
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("../ironhorse-regexp/src");
    let mut constructions = 0;
    for file in rs_files(&src) {
        let code = code_only(&fs::read_to_string(&file).expect("read source"));
        // Every spelling that constructs the variant: the qualified form, the
        // `Self::` form inside an `impl`, and the bare form after a glob
        // import. The one bare `Unsupported(` that is not a construction is
        // the variant's declaration, `Unsupported(&'static str)`.
        constructions += marker_positions(&code, "Unsupported(")
            .into_iter()
            .filter(|&at| !code[at + "Unsupported(".len()..].starts_with('&'))
            .count();
    }
    assert_eq!(
        constructions, 0,
        "ironhorse-regexp now constructs CompileError::Unsupported; register its labels"
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
    // Raw strings are blanked (never a label, and an unescaped quote inside
    // one must not desynchronize the literal scanner); byte strings are kept
    // whole. Neither is a comment or a construction site.
    assert!(!code.contains("raw // not a comment"));
    assert!(!code.contains("j:inside-raw-string"));
    assert!(code.contains(r#"b"(\"""#));
    // A raw string with an unescaped quote inside it does not desync the
    // scan of what follows.
    let tricky = code_only(
        r####"let a = r"\"; let b = r#"a"b"#; return Err(Halt::Unsupported("m:after-tricky-raw"));"####,
    );
    let mut found = Vec::new();
    for at in marker_positions(&tricky, marker) {
        found.extend(string_literals(balanced_args(&tricky, at, marker)));
    }
    assert_eq!(found, ["m:after-tricky-raw"]);
    // The string is kept whole, and a marker inside a string literal is not
    // a construction site: `marker_positions` skips literals.
    assert!(code.contains("f:inside-string"));
}
