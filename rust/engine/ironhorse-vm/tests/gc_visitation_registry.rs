//! The independent GC ground-truth net (wave-6 prescribed test class).
//!
//! A SHARED omission — a side table that NEITHER collector's walk
//! visits — is exactly how the wave-6 visitation misses (W6-1..W6-4)
//! escaped 1093 green tests. This net derives the ground truth from
//! the STRUCT itself, independently of either collector's visitor:
//!
//! 1. It parses `Interp`'s fields and the crate's type graph FROM
//!    SOURCE and computes which fields are SLOT-BEARING (their type
//!    transitively mentions `Slot`/`SlotIndex`/`ChunkOffset`). The
//!    source it parses is the crate's whole production module set,
//!    derived from the `mod` declarations reachable from `lib.rs` —
//!    not a hand-kept list of files — so a new module joins the type
//!    graph by being declared, a module that is declared but missing
//!    fails the build, and a file under `src/` that no declaration
//!    reaches fails HERE rather than shrinking coverage silently (F053).
//! 2. Every slot-bearing field must appear in the REGISTRY below with
//!    an explicit GC classification; a new field fails here until a
//!    deliberate decision places it.
//! 3. Each classification is CHECKED, not just recorded, against the
//!    exact tokens the roster generators emit for the real visitor
//!    bodies — `gc_roots`, the full collector's
//!    `extra_edges`/`ephemeron_edges`/`external_chunk_refs`, the
//!    partial enumeration `each_side_table_ref`(`_tail`), and both
//!    sweep paths — and every check is `self.`-QUALIFIED: a body
//!    satisfies a claim about `target_func` only by naming
//!    `self.target_func`, never by pushing some frame's `f.target_func`
//!    (F089). Weak-keyed tables must have slot-FREE value types (checked
//!    mechanically) and prune in BOTH collectors' sweep paths, or a
//!    swept-then-reused owner slot would read a stale row. The boot
//!    anchors no visitor names are classified `TransitivelyRooted`,
//!    and that is checked at RUNTIME: every one of them must survive a
//!    full collection on a booted machine, and the probe list and the
//!    registry reconcile both ways.
//!
//! What textual presence cannot prove is that a walk visits every
//! SUBFIELD of a row correctly. Both collectors' walks are generated
//! from one per-row policy (`gc_slot_row!`), so a subfield omission is
//! shared by every walk and is invisible to the runtime counted-ref
//! parity net too (that net compares the standing bulk counts against a
//! fresh recount of the SAME three tables; it holds the counting
//! discipline, not row coverage — F038). The subfield class is held by
//! the behavioral twins alone: `gc_frame_state.rs`, `gc_side_tables.rs`,
//! `gc_anchor_truth.rs`. This net kills the forgot-the-table-entirely
//! class outright, for every future field.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use ironhorse_vm::source_scan::{self, Token};
use ironhorse_vm::Interp;

// ---------------------------------------------------------------------
// The module set (F053)
// ---------------------------------------------------------------------

/// The crate's `src/` directory, resolved from the manifest so the walk
/// is independent of the working directory.
fn src_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("src")
}

/// Files under `src/` that no `mod` declaration reaches and are
/// nevertheless legitimate: each is pulled in by `include!` from a
/// `#[cfg(test)]` inline module, so it is compiled only into the test
/// binary and declares no production type. A file that is neither
/// declared nor listed here is an orphan, and a listed file that any
/// production `include!` site pulls in is a violation; both fail
/// [`every_source_file_is_a_declared_module_or_a_listed_test_include`].
const TEST_ONLY_INCLUDES: &[&str] = &["meter_consistency.rs"];

/// Every `include!("FILE.rs")` in `code`, as the included path and whether
/// the site sits inside an inline `#[cfg(test)] mod` block.
fn include_sites(code: &[Token<'_>], file: &Path) -> Vec<(PathBuf, bool)> {
    let dir = file.parent().expect("module has a directory");
    // One flag per open brace: whether it opened a `#[cfg(test)] mod`.
    let mut frames: Vec<bool> = Vec::new();
    let mut out = Vec::new();
    let mut i = 0;
    while i < code.len() {
        match code[i].text {
            "{" => {
                let opens_test_mod = i >= 2 && code[i - 2].text == "mod" && {
                    // Back over `pub`, `pub(crate)` or `pub(in path)` to the
                    // item start the attributes precede.
                    let mut start = i - 2;
                    if start >= 1 && code[start - 1].text == ")" {
                        let mut depth = 0usize;
                        loop {
                            start -= 1;
                            match code[start].text {
                                ")" => depth += 1,
                                "(" => {
                                    depth -= 1;
                                    if depth == 0 {
                                        break;
                                    }
                                }
                                _ => {}
                            }
                        }
                    }
                    if start >= 1 && code[start - 1].text == "pub" {
                        start -= 1;
                    }
                    preceding_attributes(code, start)
                        .iter()
                        .any(|a| a == "cfg(test)")
                };
                frames.push(opens_test_mod);
            }
            "}" => {
                frames.pop();
            }
            "include"
                if code.get(i + 1).is_some_and(|t| t.text == "!")
                    && code.get(i + 2).is_some_and(|t| t.text == "(") =>
            {
                let literal = code.get(i + 3).map_or("", |t| t.text);
                let relative = literal
                    .strip_prefix('"')
                    .and_then(|s| s.strip_suffix('"'))
                    .unwrap_or_else(|| {
                        panic!("unsupported include! operand in {file:?}: {literal}")
                    });
                // Canonical, so a `..` in the operand cannot dodge the
                // listed-path comparison; a missing target fails loudly.
                let target = dir.join(relative);
                let target = std::fs::canonicalize(&target)
                    .unwrap_or_else(|e| panic!("include! target {target:?} in {file:?}: {e}"));
                out.push((target, frames.iter().any(|&test| test)));
                i += 3;
            }
            _ => {}
        }
        i += 1;
    }
    out
}

/// The crate's module tree as the `mod` declarations spell it.
struct ModuleSet {
    /// Modules compiled into the production crate, sorted by path.
    production: Vec<PathBuf>,
    /// Modules reached only through `#[cfg(test)]` declarations or
    /// carrying an inner `#![cfg(test)]`, sorted by path.
    test_only: Vec<PathBuf>,
}

/// Attributes immediately preceding the token at `at`, innermost last:
/// each `#[...]` group's tokens joined without whitespace.
fn preceding_attributes(code: &[Token<'_>], at: usize) -> Vec<String> {
    let mut attrs = Vec::new();
    let mut end = at;
    while end >= 3 && code[end - 1].text == "]" {
        // Walk back to the `[` that opens this group.
        let mut depth = 0usize;
        let mut open = end - 1;
        loop {
            match code[open].text {
                "]" => depth += 1,
                "[" => {
                    depth -= 1;
                    if depth == 0 {
                        break;
                    }
                }
                _ => {}
            }
            assert!(open > 0, "unbalanced attribute brackets");
            open -= 1;
        }
        if open == 0 || code[open - 1].text != "#" {
            break;
        }
        let text: String = code[open + 1..end - 1].iter().map(|t| t.text).collect();
        attrs.push(text);
        end = open - 1;
    }
    attrs.reverse();
    attrs
}

/// Whether a file's head carries the inner `#![cfg(test)]` attribute,
/// anywhere among its leading inner attributes (`#![allow(..)]` and a
/// doc `#![doc = ".."]` may precede it).
fn has_inner_cfg_test(code: &[Token<'_>]) -> bool {
    let mut at = 0;
    while code.get(at).is_some_and(|t| t.text == "#")
        && code.get(at + 1).is_some_and(|t| t.text == "!")
        && code.get(at + 2).is_some_and(|t| t.text == "[")
    {
        let close = source_scan::matching_delimiter(code, at + 2);
        let text: String = code[at + 3..close].iter().map(|t| t.text).collect();
        if text == "cfg(test)" {
            return true;
        }
        at = close + 1;
    }
    false
}

/// Resolve every `mod NAME;` declaration in `file`, returning
/// `(path, test_only)` pairs, and fail loudly on a declaration whose file
/// cannot be found or is ambiguous.
fn declared_modules(file: &Path, test_only: bool) -> Vec<(PathBuf, bool)> {
    let text = std::fs::read_to_string(file).expect("read module");
    let code = source_scan::code_only(&text);
    let tokens = source_scan::tokens(&code);
    let file_is_test_only = test_only || has_inner_cfg_test(&tokens);
    let dir = file.parent().expect("module has a directory");
    let stem = file.file_stem().and_then(|s| s.to_str()).expect("stem");
    // `lib.rs` and `mod.rs` own their directory; any other file owns the
    // directory named after it.
    let child_base = if stem == "lib" || stem == "mod" {
        dir.to_path_buf()
    } else {
        dir.join(stem)
    };
    let mut out = Vec::new();
    for i in 0..tokens.len().saturating_sub(2) {
        if tokens[i].text != "mod" || tokens[i + 2].text != ";" {
            continue;
        }
        let name = tokens[i + 1].text;
        assert!(
            name.chars().all(|c| c.is_alphanumeric() || c == '_'),
            "module name: {name}"
        );
        // `pub`, `pub(crate)`, `pub(in some::path)` … precede the keyword;
        // attributes precede the visibility.
        let mut vis_start = i;
        if i > 0 && tokens[i - 1].text == ")" {
            let mut depth = 0usize;
            let mut open = i - 1;
            loop {
                match tokens[open].text {
                    ")" => depth += 1,
                    "(" => {
                        depth -= 1;
                        if depth == 0 {
                            break;
                        }
                    }
                    _ => {}
                }
                assert!(open > 0, "unbalanced visibility parentheses");
                open -= 1;
            }
            if open > 0 && tokens[open - 1].text == "pub" {
                vis_start = open - 1;
            }
        } else if i > 0 && tokens[i - 1].text == "pub" {
            vis_start = i - 1;
        }
        let attrs = preceding_attributes(&tokens, vis_start);
        let cfg_test = attrs.iter().any(|a| a == "cfg(test)");
        let explicit = attrs.iter().find_map(|a| {
            a.strip_prefix("path=\"")
                .and_then(|rest| rest.strip_suffix('"'))
                .map(str::to_owned)
        });
        let path = match explicit {
            // A `#[path]` on an out-of-line module in any file is relative
            // to the declaring file's directory.
            Some(p) => dir.join(p),
            None => {
                let flat = child_base.join(format!("{name}.rs"));
                let nested = child_base.join(name).join("mod.rs");
                match (flat.is_file(), nested.is_file()) {
                    (true, false) => flat,
                    (false, true) => nested,
                    (true, true) => panic!("ambiguous module file for {name} in {file:?}"),
                    (false, false) => {
                        panic!("declared module {name} in {file:?} has no file")
                    }
                }
            }
        };
        assert!(path.is_file(), "module file missing: {path:?}");
        // A child that opens with `#![cfg(test)]` is test-only however it
        // is declared (`interp/tests.rs` carries its cfg inside).
        let child_text = std::fs::read_to_string(&path).expect("read child module");
        let child_code = source_scan::code_only(&child_text);
        let inner_cfg_test = has_inner_cfg_test(&source_scan::tokens(&child_code));
        out.push((path, file_is_test_only || cfg_test || inner_cfg_test));
    }
    out
}

/// Walk the module tree from `lib.rs`.
fn module_set() -> ModuleSet {
    let root = src_dir().join("lib.rs");
    let mut production = BTreeSet::new();
    let mut test_only = BTreeSet::new();
    let mut queue = vec![(root, false)];
    while let Some((file, is_test)) = queue.pop() {
        let set = if is_test {
            &mut test_only
        } else {
            &mut production
        };
        if !set.insert(file.clone()) {
            continue;
        }
        for (child, child_is_test) in declared_modules(&file, is_test) {
            queue.push((child, child_is_test));
        }
    }
    ModuleSet {
        production: production.into_iter().collect(),
        test_only: test_only.into_iter().collect(),
    }
}

/// The production module set as one code-only text (comments and raw
/// strings blanked, literals kept), files in path order, each followed
/// by a newline so no declaration straddles two files.
static SRC: LazyLock<String> = LazyLock::new(|| {
    let set = module_set();
    let mut out = String::new();
    for file in &set.production {
        let text = std::fs::read_to_string(file).expect("read production module");
        out.push_str(&source_scan::code_only(&text));
        out.push('\n');
    }
    out
});

fn src() -> &'static str {
    &SRC
}

#[test]
fn every_source_file_is_a_declared_module_or_a_listed_test_include() {
    let set = module_set();
    let all: BTreeSet<PathBuf> = source_scan::rs_files(&src_dir()).into_iter().collect();
    let declared: BTreeSet<PathBuf> = set
        .production
        .iter()
        .chain(&set.test_only)
        .cloned()
        .collect();
    let listed: BTreeSet<PathBuf> = TEST_ONLY_INCLUDES
        .iter()
        .map(|p| src_dir().join(p))
        .collect();
    for p in &listed {
        assert!(
            all.contains(p),
            "TEST_ONLY_INCLUDES names a file that no longer exists: {p:?}"
        );
        assert!(
            !declared.contains(p),
            "TEST_ONLY_INCLUDES names a file a `mod` declaration already reaches: {p:?}"
        );
    }
    let orphans: Vec<&PathBuf> = all
        .iter()
        .filter(|p| !declared.contains(*p) && !listed.contains(*p))
        .collect();
    assert!(
        orphans.is_empty(),
        "source files under src/ that no `mod` declaration reaches — declare each with \
         `mod` (a production module joins the type graph automatically) or, for a file an \
         `include!` in a #[cfg(test)] module pulls in, list it in TEST_ONLY_INCLUDES: {orphans:?}"
    );
    // A listed file is test-only only while every `include!` that pulls it
    // in sits in a `#[cfg(test)]` module or a test-only file: a production
    // `include!` would compile it into the type graph unseen.
    let mut pulled_in: BTreeSet<PathBuf> = BTreeSet::new();
    let listed_canonical: BTreeSet<PathBuf> = listed
        .iter()
        .map(|p| std::fs::canonicalize(p).expect("listed include exists"))
        .collect();
    for file in set.production.iter().chain(&set.test_only) {
        let file_is_test_only = set.test_only.contains(file);
        let text = std::fs::read_to_string(file).expect("read module");
        let code = source_scan::code_only(&text);
        let tokens = source_scan::tokens(&code);
        for (target, in_test_module) in include_sites(&tokens, file) {
            if !listed_canonical.contains(&target) {
                continue;
            }
            assert!(
                file_is_test_only || in_test_module,
                "{target:?} is listed in TEST_ONLY_INCLUDES but {file:?} pulls it in outside a \
                 #[cfg(test)] module"
            );
            pulled_in.insert(target);
        }
    }
    for p in &listed_canonical {
        assert!(
            pulled_in.contains(p),
            "TEST_ONLY_INCLUDES names a file no #[cfg(test)] `include!` pulls in: {p:?}"
        );
    }
    // Sanity floors: the walk found the crate, not an empty directory.
    let names = |paths: &[PathBuf]| -> Vec<String> {
        paths
            .iter()
            .map(|p| p.strip_prefix(src_dir()).unwrap().display().to_string())
            .collect()
    };
    let production = names(&set.production);
    for expected in [
        "lib.rs",
        "bulk.rs",
        "value.rs",
        "interp.rs",
        "interp/state.rs",
        "interp/gc_tables.rs",
        "interp/roots.rs",
        "interp/boundary.rs",
        "interp/natives/mod.rs",
        "interp/property/proxy.rs",
        "module_snapshot.rs",
    ] {
        assert!(
            production.contains(&expected.to_string()),
            "missing {expected}"
        );
    }
    assert!(
        production.len() > 60,
        "found {} production modules",
        production.len()
    );
    let test_only = names(&set.test_only);
    for expected in [
        "interp/tests.rs",
        "interp/tests/gc_chunk_roster.rs",
        "interp/boot/tests.rs",
        "interp/natives/string/slice_tests.rs",
        "interp/reused_boot_native_tests.rs",
    ] {
        assert!(
            test_only.contains(&expected.to_string()),
            "missing {expected}"
        );
    }
    for p in &production {
        assert!(
            !test_only.contains(p),
            "{p} is both production and test-only"
        );
    }
}

#[test]
fn the_module_walk_rejects_a_declared_module_without_a_file() {
    // A copy of the crate's `lib.rs` declaring one module that does not
    // exist: the walk must fail loudly rather than skip it.
    let dir = std::env::temp_dir().join(format!(
        "ironhorse-registry-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("lib.rs");
    std::fs::write(&file, "mod present;\n#[cfg(test)]\nmod absent;\n").unwrap();
    std::fs::write(dir.join("present.rs"), "pub struct P;\n").unwrap();
    let outcome = std::panic::catch_unwind(|| declared_modules(&file, false));
    std::fs::remove_dir_all(&dir).ok();
    assert!(
        outcome.is_err(),
        "a declared module without a file was accepted"
    );
}

#[test]
fn the_module_walk_reads_attributes_and_path_overrides() {
    let dir = std::env::temp_dir().join(format!(
        "ironhorse-registry-attrs-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(dir.join("owner").join("nested")).unwrap();
    let file = dir.join("owner.rs");
    std::fs::write(
        &file,
        "// mod commented_out;\n\
         pub(crate) mod plain;\n\
         #[cfg(test)]\n#[allow(dead_code)]\npub mod gated;\n\
         #[path = \"elsewhere.rs\"]\nmod renamed;\n\
         mod nested;\n\
         #[cfg(test)]\npub(in crate::owner) mod scoped;\n\
         #[path = \"aside.rs\"]\npub(in crate::owner) mod pathed;\n\
         mod stacked;\n\
         mod inline { }\n\
         const S: &str = \"mod in_string;\";\n",
    )
    .unwrap();
    std::fs::write(dir.join("owner").join("plain.rs"), "").unwrap();
    std::fs::write(dir.join("owner").join("gated.rs"), "").unwrap();
    std::fs::write(dir.join("elsewhere.rs"), "").unwrap();
    std::fs::write(
        dir.join("owner").join("nested").join("mod.rs"),
        "#![cfg(test)]\n",
    )
    .unwrap();
    std::fs::write(dir.join("owner").join("scoped.rs"), "").unwrap();
    std::fs::write(dir.join("aside.rs"), "").unwrap();
    // A decoy at the default location must lose to the `#[path]` override.
    std::fs::write(
        dir.join("owner").join("pathed.rs"),
        "pub struct Decoy { s: Slot }\n",
    )
    .unwrap();
    std::fs::write(
        dir.join("owner").join("stacked.rs"),
        "#![allow(dead_code)]\n#![cfg(test)]\n",
    )
    .unwrap();
    let found = declared_modules(&file, false);
    std::fs::remove_dir_all(&dir).ok();
    let rel: Vec<(String, bool)> = found
        .iter()
        .map(|(p, t)| (p.strip_prefix(&dir).unwrap().display().to_string(), *t))
        .collect();
    assert_eq!(
        rel,
        [
            ("owner/plain.rs".to_string(), false),
            ("owner/gated.rs".to_string(), true),
            ("elsewhere.rs".to_string(), false),
            // The inner attribute marks the child test-only however it is declared.
            ("owner/nested/mod.rs".to_string(), true),
            // Attributes are found behind a `pub(in path)` visibility too.
            ("owner/scoped.rs".to_string(), true),
            ("aside.rs".to_string(), false),
            // A `#![cfg(test)]` behind another inner attribute still counts.
            ("owner/stacked.rs".to_string(), true),
        ]
    );
    let nested_tokens = source_scan::tokens("#![cfg(test)]\nuse x;");
    assert!(has_inner_cfg_test(&nested_tokens));
    assert!(has_inner_cfg_test(&source_scan::tokens(
        "#![allow(dead_code)]\n#![doc = \"x\"]\n#![cfg(test)]\nuse x;"
    )));
    assert!(!has_inner_cfg_test(&source_scan::tokens(
        "#[cfg(test)]\nmod t;"
    )));
    assert!(!has_inner_cfg_test(&source_scan::tokens(
        "#![allow(dead_code)]\nuse x;\n#![cfg(test)]"
    )));
}

// ---------------------------------------------------------------------
// Source lookups
// ---------------------------------------------------------------------

/// The token stream of a code-only text, built once per lookup batch.
struct Lexed<'a> {
    code: &'a str,
    tokens: Vec<Token<'a>>,
}

impl<'a> Lexed<'a> {
    fn new(code: &'a str) -> Self {
        Lexed {
            code,
            tokens: source_scan::tokens(code),
        }
    }

    /// The brace body (including braces) of the UNIQUE declaration whose
    /// tokens start with `marker` and continue to a `{` before any `;` —
    /// so a trait method's declaration (`fn swept(&mut self, idx: SlotIndex);`)
    /// never impersonates its implementation, and two implementations of
    /// one spelling fail loudly rather than the first winning.
    fn body(&self, marker: &str) -> &'a str {
        let pattern = source_scan::tokens(marker);
        assert!(
            pattern.last().is_some_and(|t| t.text != "{"),
            "marker must stop before the brace: {marker}"
        );
        let opens: Vec<usize> = source_scan::token_positions(&self.tokens, marker)
            .into_iter()
            .filter_map(|at| {
                let start = at + pattern.len();
                self.tokens[start..]
                    .iter()
                    .position(|t| t.text == "{" || t.text == ";")
                    .map(|n| start + n)
                    .filter(|open| self.tokens[*open].text == "{")
            })
            .collect();
        assert_eq!(
            opens.len(),
            1,
            "declaration must be unique in the production module set: {marker} ({} bodies)",
            opens.len()
        );
        let open = opens[0];
        let close = source_scan::matching_delimiter(&self.tokens, open);
        &self.code[self.tokens[open].start..self.tokens[close].start + 1]
    }

    /// [`Self::body`] with every whitespace character removed.
    fn compact_body(&self, marker: &str) -> String {
        compact(self.body(marker))
    }

    /// A lexer over the unique body that `marker` opens, so a lookup inside
    /// it cannot be satisfied by a same-named declaration elsewhere — a
    /// trait's default method body, a test double's implementation.
    fn scoped(&self, marker: &str) -> Lexed<'a> {
        Lexed::new(self.body(marker))
    }
}

/// The collector's hook implementation on the roster-borrowed `Hooks`
/// struct: every callback the registry traces is looked up inside it.
const HOOKS_IMPL: &str = "impl crate::gc::GcHooks for Hooks";

fn compact(text: &str) -> String {
    text.chars().filter(|c| !c.is_whitespace()).collect()
}

/// The body of the unique declaration `marker` in the production set.
fn fn_body(marker: &str) -> &'static str {
    Lexed::new(src()).body(marker)
}

/// Whether `body` names the interpreter field `field` through `self` —
/// the tokens `self . field` in sequence, whitespace-insensitive. A
/// frame's `f.target_func`, a local named like the field, or the bare
/// word in a string cannot satisfy it (F089).
fn names_field(body: &str, field: &str) -> bool {
    let tokens = source_scan::tokens(body);
    !source_scan::token_positions(&tokens, &format!("self.{field}")).is_empty()
}

/// Word-bounded mention of `word` in `hay`: the type-graph relation,
/// where a type name inside another type's body is the edge.
fn mentions(hay: &str, word: &str) -> bool {
    let bytes = hay.as_bytes();
    let mut start = 0;
    while let Some(p) = hay[start..].find(word) {
        let at = start + p;
        let before_ok = at == 0 || !bytes[at - 1].is_ascii_alphanumeric() && bytes[at - 1] != b'_';
        let after = at + word.len();
        let after_ok =
            after >= hay.len() || !bytes[after].is_ascii_alphanumeric() && bytes[after] != b'_';
        if before_ok && after_ok {
            return true;
        }
        start = at + word.len();
    }
    false
}

/// Parse every `struct`/`enum` body, tuple-struct field list and `type`
/// alias right-hand side in the (code-only) source. Two definitions
/// sharing a name — the crate has several `Hooks`, `Row` and
/// `tests`-local shapes — are MERGED, so a type is slot-bearing if ANY
/// definition of that name is: the conservative direction, which can
/// demand a classification but never exempt a field. A unit struct
/// (`struct Marker;`) has no body and names no slot.
fn type_defs(src: &str) -> BTreeMap<&str, String> {
    let mut out: BTreeMap<&str, String> = BTreeMap::new();
    let mut i = 0;
    while i < src.len() {
        let rest = &src[i..];
        let hit = ["struct ", "enum ", "type "]
            .iter()
            .filter_map(|k| rest.find(k).map(|p| (p, *k)))
            .min();
        let Some((p, kw)) = hit else { break };
        let at = i + p;
        // Only definitions: the line starts with an optional visibility
        // (`pub`, `pub(crate)`, `pub(in some::path)`) and the keyword.
        let line_start = src[..at].rfind('\n').map(|n| n + 1).unwrap_or(0);
        let prefix = src[line_start..at].trim();
        let is_def = prefix.is_empty() || prefix.starts_with("pub");
        i = at + kw.len();
        if !is_def {
            continue;
        }
        let name_end = src[i..]
            .find(|c: char| !c.is_ascii_alphanumeric() && c != '_')
            .map(|n| i + n)
            .unwrap_or(i);
        let name = &src[i..name_end];
        if name.is_empty() {
            continue;
        }
        let body = if kw == "type " {
            // `type Name<..> = Rhs;` — the alias's whole right-hand side.
            let Some(eq) = src[name_end..].find('=') else {
                continue;
            };
            let Some(end) = src[name_end + eq..].find(';') else {
                continue;
            };
            &src[name_end + eq..name_end + eq + end]
        } else {
            let Some(open_rel) = src[name_end..].find(['{', ';', '(']) else {
                continue;
            };
            let open = name_end + open_rel;
            match src.as_bytes()[open] {
                b'{' => delimited_body_at(src, open, b'{', b'}'),
                // A tuple struct's field list.
                b'(' => delimited_body_at(src, open, b'(', b')'),
                _ => continue,
            }
        };
        out.entry(name).or_default().push_str(body);
        out.get_mut(name).unwrap().push('\n');
    }
    out
}

/// The balanced body starting at the `open` delimiter at byte `open`.
fn delimited_body_at(src: &str, open: usize, opener: u8, closer: u8) -> &str {
    let bytes = src.as_bytes();
    let mut depth = 0usize;
    let mut k = open;
    loop {
        let b = bytes[k];
        if b == opener {
            depth += 1;
        } else if b == closer {
            depth -= 1;
            if depth == 0 {
                return &src[open..=k];
            }
        }
        k += 1;
    }
}

/// The brace-balanced body starting at the `{` at byte `open`.
fn brace_body_at(src: &str, open: usize) -> &str {
    delimited_body_at(src, open, b'{', b'}')
}

/// Whether a weak-keyed table's VALUE half is slot-free. For a map type
/// the generic arguments are split at their top-level comma and the
/// value half checked on its own, so `HashMap<K, SlotIndex>` fails even
/// though its key half names a slot; a set or vector of keys has no
/// value half, and only what follows the key's own `SlotIndex` is asked.
fn value_half_is_slot_free(ty: &str, is_bearing: &dyn Fn(&str) -> bool) -> bool {
    let map_args = ["HashMap<", "BTreeMap<"]
        .iter()
        .filter_map(|marker| ty.find(marker).map(|at| at + marker.len()))
        .min();
    if let Some(start) = map_args {
        let mut depth = 0usize;
        let mut split = None;
        for (offset, c) in ty[start..].char_indices() {
            match c {
                '<' | '(' | '[' => depth += 1,
                '>' | ')' | ']' => {
                    if depth == 0 {
                        break;
                    }
                    depth -= 1;
                }
                ',' if depth == 0 => {
                    split = Some(start + offset);
                    break;
                }
                _ => {}
            }
        }
        let Some(comma) = split else {
            return false;
        };
        let mut depth = 0usize;
        let mut end = ty.len();
        for (offset, c) in ty[comma + 1..].char_indices() {
            match c {
                '<' | '(' | '[' => depth += 1,
                '>' | ')' | ']' => {
                    if depth == 0 {
                        end = comma + 1 + offset;
                        break;
                    }
                    depth -= 1;
                }
                _ => {}
            }
        }
        return !is_bearing(&ty[comma + 1..end]);
    }
    let after_key = match ty.find("SlotIndex") {
        Some(p) => &ty[p + "SlotIndex".len()..],
        None => ty,
    };
    !is_bearing(after_key)
}

/// The transitive slot-bearing type set: a type is slot-bearing when
/// its body mentions `Slot`/`SlotIndex`/`ChunkOffset` (`SlotIndex`
/// contains `Slot`, so one primitive check covers both) or another
/// slot-bearing type.
fn slot_bearing_types<'s>(defs: &BTreeMap<&'s str, String>) -> Vec<&'s str> {
    let mut bearing: Vec<&'s str> = Vec::new();
    loop {
        let mut changed = false;
        for (name, body) in defs {
            if bearing.contains(name) {
                continue;
            }
            let hit = mentions(body, "Slot")
                || mentions(body, "SlotIndex")
                || mentions(body, "ChunkOffset")
                || bearing.iter().any(|t| mentions(body, t));
            if hit {
                bearing.push(name);
                changed = true;
            }
        }
        if !changed {
            return bearing;
        }
    }
}

/// Parse `Interp`'s fields as `(name, type-text)`, joining multi-line
/// types until the field's own top-level comma.
fn interp_fields() -> Vec<(String, String)> {
    let body = fn_body("pub struct Interp");
    let mut out = Vec::new();
    let mut lines = body.lines().peekable();
    while let Some(line) = lines.next() {
        let l = line.strip_prefix("    ").unwrap_or("");
        let l = l.strip_prefix("pub(crate) ").unwrap_or(l);
        let l = l.strip_prefix("pub ").unwrap_or(l);
        let Some(colon) = l.find(':') else { continue };
        let name = &l[..colon];
        if name.is_empty()
            || name.contains(' ')
            || !name
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
        {
            continue;
        }
        let mut ty = l[colon + 1..].to_string();
        // Accumulate until the angle/paren depth closes and a trailing
        // comma ends the field. `->` (a fn-trait return arrow) is not a
        // closing angle, so strip it before counting.
        loop {
            let depth: i64 = ty
                .replace("->", "")
                .chars()
                .map(|c| match c {
                    '<' | '(' | '[' => 1,
                    '>' | ')' | ']' => -1,
                    _ => 0,
                })
                .sum();
            if depth == 0 && ty.trim_end().ends_with(',') {
                break;
            }
            match lines.next() {
                Some(next) => ty.push_str(next.trim()),
                None => break,
            }
        }
        out.push((
            name.to_string(),
            ty.trim().trim_end_matches(',').to_string(),
        ));
    }
    out
}

/// `Interp`'s fields with their attribute groups, each `#[...]` kept as
/// one string (a multi-line group is joined), in declaration order. Read
/// from the comment-blanked source, so no remark can pose as an attribute.
fn interp_field_attributes() -> Vec<(String, Vec<String>)> {
    let body = fn_body("pub struct Interp");
    let mut out = Vec::new();
    let mut attrs: Vec<String> = Vec::new();
    // An attribute group still open across lines, with its paren depth.
    let mut open: Option<(String, i64)> = None;
    let paren_delta = |l: &str| -> i64 {
        l.chars()
            .map(|c| match c {
                '(' => 1,
                ')' => -1,
                _ => 0,
            })
            .sum()
    };
    for line in body.lines() {
        let l = line.trim();
        if let Some((mut text, depth)) = open.take() {
            text.push_str(l);
            let depth = depth + paren_delta(l);
            if depth > 0 {
                open = Some((text, depth));
            } else {
                attrs.push(text);
            }
            continue;
        }
        if l.starts_with("#[") {
            let depth = paren_delta(l);
            if depth > 0 {
                open = Some((l.to_string(), depth));
            } else {
                attrs.push(l.to_string());
            }
            continue;
        }
        let decl = l
            .strip_prefix("pub(crate) ")
            .or_else(|| l.strip_prefix("pub(super) "))
            .or_else(|| l.strip_prefix("pub "))
            .unwrap_or(l);
        let Some(colon) = decl.find(':') else {
            continue;
        };
        let name = &decl[..colon];
        if !name.is_empty()
            && name
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
            && !decl[colon + 1..].starts_with(':')
        {
            out.push((name.to_string(), std::mem::take(&mut attrs)));
        }
    }
    out
}

/// `Serialized` tables whose rows hold slots and whose native-reference
/// policy is `persist_refs(none)` on purpose: each names why the slots it
/// carries can never reference a function restore cannot rebuild, or why
/// a walked holder already refuses the same reference. A table missing
/// here fails [`every_serialized_slot_bearing_table_is_walked_or_names_its_reason`]
/// until it gains a holder arm in `persistence.rs` or a reason.
const PERSIST_REFS_NONE_BY_DESIGN: &[(&str, &str)] = &[
    ("functions", "global_env and closures are environment records the engine allocates, never a guest callable"),
    ("collator_compare_functions", "the value is the collator's engine-made bound compare function, carried by intl_bound_functions"),
    ("ctor_prototype", "mirrors the constructor's `.prototype` heap property, which the heap walk refuses"),
    ("array_buffers", "a ChunkOffset of byte storage, not an object reference"),
    ("typed_arrays", "buffer is an ArrayBuffer object, checked at construction"),
    ("data_views", "buffer is an ArrayBuffer object, checked at construction"),
    ("symbol_registry", "values are the registered symbols' descriptor objects"),
    ("symbol_key_ids", "keys and values are symbol descriptor objects and their ids"),
    ("promise_functions", "promise is the resolving pair's own promise object"),
];

/// Every `Serialized` table whose row type can hold a slot is a persisted
/// holder: the native-reference gate walks it through a `persist_refs`
/// policy, or the table names here why `none` is sound. The async
/// generator, promise job, and iterator tables each shipped with `none`
/// and let a doomed native restore as a plain object; this net makes the
/// next such table a failing test rather than a review finding.
#[test]
fn every_serialized_slot_bearing_table_is_walked_or_names_its_reason() {
    let defs = type_defs(src());
    let bearing = slot_bearing_types(&defs);
    let is_bearing = |ty: &str| {
        mentions(ty, "Slot")
            || mentions(ty, "SlotIndex")
            || mentions(ty, "ChunkOffset")
            || bearing.iter().any(|t| mentions(ty, t))
    };
    // A table keyed by its owner's slot holds no reference through the
    // key; the row type after the map's first top-level comma is what a
    // row can point at. A non-map type is its own row type.
    let row_type = |ty: &str| -> String {
        let Some(map) = ty.find("HashMap<") else {
            return ty.to_string();
        };
        let generics = &ty[map + "HashMap<".len()..];
        let mut depth = 0i64;
        for (i, c) in generics.char_indices() {
            match c {
                '<' | '(' => depth += 1,
                '>' | ')' => depth -= 1,
                ',' if depth == 0 => return generics[i + 1..].to_string(),
                _ => {}
            }
        }
        panic!("map without a value type: {ty}");
    };
    let types: BTreeMap<String, String> = interp_fields().into_iter().collect();
    let attributes = interp_field_attributes();
    assert_eq!(attributes.len(), types.len(), "field parsers disagree");
    let mut unwalked = BTreeSet::new();
    for (name, attrs) in &attributes {
        let serialized = attrs
            .iter()
            .any(|a| a.starts_with("#[snapshot_table(") && a.contains("Serialized"));
        let none = attrs.iter().any(|a| a == "#[persist_refs(none)]");
        if serialized && none && is_bearing(&row_type(&types[name])) {
            unwalked.insert(name.clone());
        }
    }
    // The row-type cut keeps a row that points at other objects and drops
    // an owner-keyed scalar.
    assert!(is_bearing(&row_type(&types["iterators"])));
    assert!(!is_bearing(&row_type(&types["dates"])));
    let documented: BTreeSet<String> = PERSIST_REFS_NONE_BY_DESIGN
        .iter()
        .map(|(name, _)| name.to_string())
        .collect();
    for (name, reason) in PERSIST_REFS_NONE_BY_DESIGN {
        assert!(reason.len() >= 20, "explain the reason for {name}");
        assert!(
            unwalked.contains(*name),
            "stale reason: {name} is walked, not serialized, or holds no slot"
        );
    }
    let missing: Vec<&String> = unwalked.difference(&documented).collect();
    assert!(
        missing.is_empty(),
        "serialized slot-bearing tables the native-reference gate never walks — give each a \
         persist_refs policy in persistence.rs or a documented reason: {missing:?}"
    );
    // The walked tables this net exists for stay walked.
    for walked in ["async_generators", "promise_jobs", "iterators"] {
        let (_, attrs) = attributes
            .iter()
            .find(|(name, _)| name == walked)
            .expect(walked);
        assert!(
            !attrs.iter().any(|a| a == "#[persist_refs(none)]"),
            "{walked} lost its persist_refs policy"
        );
    }
}

// ---------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------

/// What the registry can require of a field. Every requirement is
/// checked against generated visitor tokens by [`names_field`], i.e. by
/// a `self.<field>` access, never a bare word.
#[derive(Copy, Clone, Debug, PartialEq)]
enum Req {
    /// Named through `self.` in the field's OWN root policy in `gc_roots`
    /// — a root the mark starts from.
    GcRoots,
    /// Rooted through ANOTHER field's root policy, which names this field
    /// through `self.` (a reaction arena reached from the queued jobs that
    /// index it). The host must itself be `GcRoots`.
    RootedVia(&'static str),
    /// Named through `self.` in the field's OWN table walk in both the
    /// full collector's `extra_edges` and the partial enumeration
    /// (`each_side_table_ref` or its tail).
    Edges,
    /// Edged through ANOTHER table's row policy, which names this field
    /// through `self.` in both the full and the partial variant (a
    /// reaction arena the promise rows index). The host's own walk must
    /// be connected.
    EdgedVia(&'static str),
    /// Named through `self.` in the field's own `ephemeron_edges` and
    /// dead-key pruning policies.
    Ephemeron,
    /// Named through `self.` in the field's own partial-enumeration walk
    /// alone (a table the full collector reaches through a different,
    /// precise mechanism).
    PartialWalk,
    /// Named through `self.` in the field's own `external_chunk_refs`
    /// policy (compaction remap).
    ChunkRemap,
    /// The mapped VALUE type carries no slot references (checked
    /// mechanically from the parsed type), so only the weak KEY names
    /// a slot.
    ValueSlotFree,
    /// Pruned in BOTH sweep paths (`collect_garbage` and
    /// `free_pages`), so a swept owner's row cannot go stale.
    PrunedBothPaths,
    /// The heap itself: the arena BOTH collectors mark and sweep, named
    /// through `self.` in `collect_garbage` and `free_pages`.
    Arena,
    /// A boot anchor that appears in no visitor and is held only
    /// transitively (through the rooted `intrinsics` values and proto
    /// rows). Checked two ways: the named `gc_anchor_truth.rs` twin
    /// constructs through the cache after churn and a collection, and
    /// `Interp::boot_anchor_liveness` must report the anchor alive after
    /// a full collection on a booted machine.
    TransitivelyRooted(&'static str),
    /// A named behavioral test in this crate's unit tests is required and
    /// must name the field itself; the note records why no visitor does
    /// (a boundary-empty transient, or a lease whose only GC effect is
    /// through another rooted table).
    BehavioralTwin(&'static str),
}

/// The classification of EVERY slot-bearing `Interp` field. Adding a
/// field to `Interp` whose type touches slots fails this net until
/// the field is classified here — and the classification is checked
/// against the real visitor bodies, so it cannot be a dead note.
const REGISTRY: &[(&str, &[Req], &str)] = &[
    // --- the heap ---
    ("slots", &[Req::Arena], "the slot heap both collectors mark and sweep"),
    // --- roots: registers, frames, boot anchors, identity tables ---
    ("stack", &[Req::GcRoots], "value-stack slots"),
    ("locals", &[Req::GcRoots], "program-frame locals"),
    ("args", &[Req::GcRoots], "active call arguments"),
    ("this_val", &[Req::GcRoots], "active receiver"),
    ("exception", &[Req::GcRoots], "in-flight thrown value"),
    ("result", &[Req::GcRoots], "completion register (host reads at boundary)"),
    ("env", &[Req::GcRoots], "with/eval environment head (W6-1)"),
    ("cur_func", &[Req::GcRoots], "active callee"),
    ("target_func", &[Req::GcRoots], "call target register"),
    ("call_stack", &[Req::GcRoots], "suspended caller activations"),
    ("jumps", &[Req::GcRoots], "catch-jump chain (env restore)"),
    ("realm", &[Req::GcRoots], "single Realm default global and primordial roots"),
    ("environment", &[Req::GcRoots], "active globals, property index and first rejection report"),
    ("inactive_environments", &[Req::GcRoots, Req::PrunedBothPaths, Req::Edges], "inactive globals, property indexes and first rejection reports"),
    ("restored_leases", &[Req::ValueSlotFree, Req::BehavioralTwin("restored_leases_keep_identity_roots_alive_across_a_collection")], "provisional exports keep identity_roots weak leases alive; the Rc<()> value names no slot"),
    ("restored_environment_leases", &[Req::ValueSlotFree, Req::BehavioralTwin("restored_leases_keep_identity_roots_alive_across_a_collection")], "provisional compartments keep environment owner weak leases alive independently; the Rc<()> value names no slot"),
    ("identity_roots", &[Req::GcRoots], "live host object identity leases"),
    ("intrinsics", &[Req::GcRoots], "every boot constructor — the anchor that transitively keeps boot structure alive"),
    ("well_known_symbols", &[Req::GcRoots], "realm well-known symbol descriptors"),
    ("symbol_registry", &[Req::GcRoots], "Symbol.for registry (strong per spec)"),
    ("symbol_registry_keys", &[Req::GcRoots, Req::PrunedBothPaths], "registry reverse map descriptors"),
    ("proto_methods", &[Req::GcRoots], "lazy proto method rows (holder+method)"),
    ("proto_data", &[Req::GcRoots], "lazy proto data rows (holder)"),
    ("proto_accessors", &[Req::GcRoots], "lazy proto accessor rows (W6-4)"),
    ("proto_value_data", &[Req::GcRoots], "boot value-data rows"),
    ("object_proto", &[Req::GcRoots], "boot anchor"),
    ("function_proto", &[Req::GcRoots], "boot anchor"),
    ("function_has_instance_method", &[Req::GcRoots], "lazy well-known boot method"),
    ("template_cache", &[Req::GcRoots], "realm tagged-template cache boot anchor"),
    ("array_proto", &[Req::GcRoots], "boot anchor"),
    ("map_proto", &[Req::GcRoots], "boot anchor"),
    ("set_proto", &[Req::GcRoots], "boot anchor"),
    ("weakmap_proto", &[Req::GcRoots], "boot anchor"),
    ("weakset_proto", &[Req::GcRoots], "boot anchor"),
    ("arraybuffer_proto", &[Req::GcRoots], "boot anchor"),
    ("dataview_proto", &[Req::GcRoots], "boot anchor"),
    ("array_iterator_proto", &[Req::GcRoots], "boot anchor"),
    ("string_proto", &[Req::GcRoots], "boot anchor"),
    ("number_proto", &[Req::GcRoots], "boot anchor"),
    ("boolean_proto", &[Req::GcRoots], "boot anchor"),
    ("symbol_proto", &[Req::GcRoots], "boot anchor"),
    ("symbol_to_primitive_method", &[Req::GcRoots], "lazy well-known boot method"),
    ("date_to_primitive_method", &[Req::GcRoots], "lazy well-known boot method"),
    ("bigint_proto", &[Req::GcRoots], "boot anchor"),
    ("promise_proto", &[Req::GcRoots], "boot anchor"),
    ("generator_proto", &[Req::GcRoots], "boot anchor"),
    ("async_function_proto", &[Req::GcRoots], "boot anchor"),
    ("regexp_proto", &[Req::GcRoots], "boot anchor"),
    ("regexp_replace_method", &[Req::GcRoots], "lazy well-known boot method"),
    ("regexp_match_method", &[Req::GcRoots], "lazy well-known boot method"),
    ("regexp_match_all_method", &[Req::GcRoots], "lazy well-known boot method"),
    ("regexp_search_method", &[Req::GcRoots], "lazy well-known boot method"),
    ("regexp_split_method", &[Req::GcRoots], "lazy well-known boot method"),
    ("iterator_proto", &[Req::GcRoots], "boot iterator ancestor retained independently of global bindings"),
    ("iterator_wrapper_proto", &[Req::GcRoots], "boot anchor (%WrapForValidIteratorPrototype%)"),
    ("map_iterator_proto", &[Req::GcRoots], "boot iterator prototype retained for future collection iterators"),
    ("set_iterator_proto", &[Req::GcRoots], "boot iterator prototype retained for future collection iterators"),
    ("regexp_string_iterator_proto", &[Req::GcRoots], "boot anchor (%RegExpStringIteratorPrototype%)"),
    ("date_proto", &[Req::GcRoots], "boot Date prototype retained independently of global bindings"),
    ("math_object", &[Req::GcRoots], "boot anchor"),
    ("gen_run_stack", &[Req::GcRoots], "mid-resume generator stack"),
    ("async_run_stack", &[Req::GcRoots], "mid-step async stack"),
    ("async_gen_run_stack", &[Req::GcRoots], "mid-step async-generator stack"),

    ("pending_rejections", &[Req::GcRoots], "settlement candidates survive collection until the job drain"),
    ("locked_down_constructors", &[Req::GcRoots], "boot-minted lockdown() stand-ins: unreferenced until step 2 wires them, so nothing else roots them in between"),
    ("promise_jobs", &[Req::GcRoots], "queued microtasks (survive halted cranks)"),
    // --- side tables with strong outgoing edges, walked by BOTH collectors ---
    ("functions", &[Req::GcRoots, Req::Edges, Req::PrunedBothPaths], "lazy intrinsic getters are roots; other functions remain weak owners of closure/super edges (W6-2)"),
    ("bound_functions", &[Req::Edges, Req::PrunedBothPaths], "bind target/this/args"),
    ("proxies", &[Req::Edges, Req::PrunedBothPaths], "proxy target + handler"),
    ("proxy_revokers", &[Req::Edges, Req::PrunedBothPaths], "revoke-fn back-links"),
    ("ctor_prototype", &[Req::Edges, Req::PrunedBothPaths], "constructor→prototype links"),
    ("private_values", &[Req::Edges, Req::PrunedBothPaths], "private field cells + values"),
    ("private_accessors", &[Req::Edges, Req::PrunedBothPaths], "private accessor cells + fns"),
    ("wrapper_data", &[Req::Edges, Req::PrunedBothPaths], "boxed primitive values"),
    ("arrays", &[Req::Edges, Req::PrunedBothPaths], "exotic array items (counted bulk)"),
    ("index_props", &[Req::Edges, Req::PrunedBothPaths], "ordinary index-property items (counted bulk)"),
    ("collections", &[Req::Edges, Req::PrunedBothPaths, Req::Ephemeron], "Map/Set entries (counted bulk; weak kinds via ephemerons)"),
    ("typed_arrays", &[Req::Edges, Req::PrunedBothPaths], "view→buffer edges"),
    ("data_views", &[Req::Edges, Req::PrunedBothPaths], "view→buffer edges"),
    ("accessors", &[Req::Edges, Req::PrunedBothPaths], "guest getter/setter slots"),
    ("iterators", &[Req::Edges, Req::PrunedBothPaths], "iterator target/result"),
    ("promises", &[Req::Edges, Req::PrunedBothPaths], "result + reactions (+ reaction-kind payloads)"),
    ("generators", &[Req::Edges, Req::PrunedBothPaths], "suspended frames"),
    ("async_instances", &[Req::Edges, Req::PrunedBothPaths], "suspended frames + result promise"),
    ("async_generators", &[Req::Edges, Req::PrunedBothPaths], "suspended frames + request queue"),
    ("promise_functions", &[Req::Edges, Req::PrunedBothPaths], "resolve/reject→promise links"),
    ("disposable_stacks", &[Req::Edges, Req::PrunedBothPaths], "held resources + dispose methods"),
    ("number_formats", &[Req::Edges, Req::PrunedBothPaths], "bound-format fn edge"),
    ("segment_iterators", &[Req::Edges, Req::PrunedBothPaths], "cursor→segments-instance edge"),
    ("collator_compare_functions", &[Req::Edges, Req::PrunedBothPaths], "compare-fn→collator owner"),
    ("number_format_bound_functions", &[Req::Edges, Req::PrunedBothPaths], "bound-fn→format owner"),
    ("combinators", &[Req::RootedVia("promise_jobs"), Req::EdgedVia("promises")], "combinator accumulators (rooted while queued, edged via reactions)"),
    ("from_async", &[Req::RootedVia("promise_jobs"), Req::EdgedVia("promises"), Req::ChunkRemap], "fromAsync state (W6-3: chunk remap too)"),
    // --- identity/precision tables ---
    ("symbol_key_ids", &[Req::Ephemeron, Req::PartialWalk, Req::PrunedBothPaths], "symbol-key descriptor identity — full GC retains precisely via the ephemeron pass; the partial walk stays page-conservative"),
    // --- chunk-reference holders (compaction remap) ---
    ("array_buffers", &[Req::ChunkRemap, Req::PrunedBothPaths], "backing-store chunk offsets"),
    ("static_str", &[Req::ChunkRemap], "boot static-string chunk offsets"),
    // --- weak-keyed data tables: slot-free values, pruned on sweep ---
    ("error_data", &[Req::ValueSlotFree, Req::PrunedBothPaths], "error render metadata"),
    ("dates", &[Req::ValueSlotFree, Req::PrunedBothPaths], "Date epoch-ms metadata; dead owners are pruned by both collectors"),
    ("locales", &[Req::ValueSlotFree, Req::PrunedBothPaths], "Intl.Locale data"),
    ("collators", &[Req::ValueSlotFree, Req::PrunedBothPaths], "Intl.Collator data"),
    ("list_formats", &[Req::ValueSlotFree, Req::PrunedBothPaths], "Intl.ListFormat data"),
    ("plural_rules", &[Req::ValueSlotFree, Req::PrunedBothPaths], "Intl.PluralRules data"),
    ("segmenters", &[Req::ValueSlotFree, Req::PrunedBothPaths], "Intl.Segmenter data"),
    ("segments", &[Req::ValueSlotFree, Req::PrunedBothPaths], "%Segments% data"),
    ("date_time_formats", &[Req::ValueSlotFree, Req::PrunedBothPaths], "Intl.DateTimeFormat data"),
    ("temporal_instants", &[Req::ValueSlotFree, Req::PrunedBothPaths], "Temporal.Instant records"),
    ("temporal_durations", &[Req::ValueSlotFree, Req::PrunedBothPaths], "Temporal.Duration records"),
    ("temporal_plains", &[Req::ValueSlotFree, Req::PrunedBothPaths], "Temporal.Plain* records"),
    ("temporal_zoneds", &[Req::ValueSlotFree, Req::PrunedBothPaths], "Temporal.ZonedDateTime records"),
    ("regexps", &[Req::ValueSlotFree, Req::PrunedBothPaths], "compiled RegExp program + lastIndex"),
    ("func_segments", &[Req::ValueSlotFree, Req::PrunedBothPaths], "function→code-segment indices"),
    ("deleted_fn_meta", &[Req::ValueSlotFree, Req::PrunedBothPaths], "deleted length/name brand pairs"),
    ("arguments_objects", &[Req::ValueSlotFree, Req::PrunedBothPaths], "arguments-exotic brand set"),
    ("detached_buffers", &[Req::ValueSlotFree, Req::PrunedBothPaths], "detached brand set"),
    ("shared_buffers", &[Req::ValueSlotFree, Req::PrunedBothPaths], "shared brand set"),
    // --- transitively rooted boot anchors (via the rooted `intrinsics`
    //     values and the rooted proto_methods/proto_data holders; the
    //     behavioral twins in gc_anchor_truth.rs construct through each
    //     cache after churn + GC, and `boot_anchor_liveness` proves each
    //     survives a collection) ---
    ("intl_object", &[Req::TransitivelyRooted("intl_proto_caches_survive_construction_after_a_collection")], "reachable via intrinsics root"),
    ("temporal_object", &[Req::TransitivelyRooted("temporal_proto_caches_survive_construction_after_a_collection")], "reachable via intrinsics root"),
    ("temporal_now_object", &[Req::TransitivelyRooted("temporal_proto_caches_survive_construction_after_a_collection")], "reachable via Temporal's arena property chain"),
    ("locale_proto", &[Req::TransitivelyRooted("intl_proto_caches_survive_construction_after_a_collection")], "reachable via rooted constructor's prototype property"),
    ("collator_proto", &[Req::TransitivelyRooted("intl_proto_caches_survive_construction_after_a_collection")], "reachable via rooted constructor's prototype property"),
    ("list_format_proto", &[Req::TransitivelyRooted("intl_proto_caches_survive_construction_after_a_collection")], "reachable via rooted constructor's prototype property"),
    ("plural_rules_proto", &[Req::TransitivelyRooted("intl_proto_caches_survive_construction_after_a_collection")], "reachable via rooted constructor's prototype property"),
    ("segmenter_proto", &[Req::TransitivelyRooted("intl_proto_caches_survive_construction_after_a_collection")], "reachable via rooted constructor's prototype property"),
    ("segments_proto", &[Req::TransitivelyRooted("intl_proto_caches_survive_construction_after_a_collection")], "reachable via rooted proto rows"),
    ("segment_iterator_proto", &[Req::TransitivelyRooted("intl_proto_caches_survive_construction_after_a_collection")], "reachable via rooted proto rows"),
    ("date_time_format_proto", &[Req::TransitivelyRooted("intl_proto_caches_survive_construction_after_a_collection")], "reachable via rooted constructor's prototype property"),
    ("number_format_proto", &[Req::TransitivelyRooted("intl_proto_caches_survive_construction_after_a_collection")], "reachable via rooted constructor's prototype property"),
    ("temporal_instant_proto", &[Req::TransitivelyRooted("temporal_proto_caches_survive_construction_after_a_collection")], "reachable via rooted constructor's prototype property"),
    ("temporal_duration_proto", &[Req::TransitivelyRooted("temporal_proto_caches_survive_construction_after_a_collection")], "reachable via rooted constructor's prototype property"),
    ("temporal_plain_protos", &[Req::TransitivelyRooted("temporal_proto_caches_survive_construction_after_a_collection")], "reachable via rooted constructors' prototype properties"),
    ("temporal_zoned_proto", &[Req::TransitivelyRooted("temporal_proto_caches_survive_construction_after_a_collection")], "reachable via rooted constructor's prototype property"),
    ("generator_function_proto", &[Req::TransitivelyRooted("generator_function_protos_survive_definition_after_a_collection")], "reachable via rooted proto rows"),
    ("async_generator_proto", &[Req::TransitivelyRooted("generator_function_protos_survive_definition_after_a_collection")], "reachable via rooted proto rows"),
    ("async_generator_function_proto", &[Req::TransitivelyRooted("generator_function_protos_survive_definition_after_a_collection")], "reachable via rooted proto rows"),
    ("string_iterator_method", &[Req::GcRoots], "lazy intrinsic identity must survive before its property is installed"),
    ("async_iterator_identity", &[Req::GcRoots], "lazy intrinsic identity must survive before its property is installed"),
    ("iterator_identity", &[Req::GcRoots], "lazy intrinsic identity must survive before its property is installed"),
    ("segments_iterator_method", &[Req::GcRoots], "lazy intrinsic identity must survive before its property is installed"),
    ("segment_iterator_identity", &[Req::GcRoots], "lazy intrinsic identity must survive before its property is installed"),
    ("error_stack_accessor", &[Req::GcRoots], "lazy intrinsic identity must survive before its property is installed"),
    ("this_captures", &[Req::BehavioralTwin("each_activation_register_independently_refuses_quiescence")], "non-owning property-slot indices; each property is owned by a closure environment reachable through its rooted arrow function"),
    // --- boundary-empty transient ---
    ("pending_new_target", &[Req::GcRoots], "armed by SUPER; rooted across non-throw halts, gated at quiescence, reset at run entry (F025)"),
    ("array_iterator_proxy_get_context", &[Req::BehavioralTwin("each_activation_register_independently_refuses_quiescence")], "installed only across one synchronous Proxy trap call, restored on success/throw, and rejected by is_quiescent if leaked"),
];

/// The body text of the `#[test] fn NAME(` function in `source`, or
/// `None` when no such test exists there.
fn test_body<'a>(source: &'a str, test: &str) -> Option<&'a str> {
    let witness = format!("#[test]\nfn {test}(");
    let at = source.find(&witness)?;
    let open = at + source[at..].find('{')?;
    Some(brace_body_at(source, open))
}

/// The unit-test sources a `BehavioralTwin` may live in: this crate's own
/// tests, where a twin can name the private field it covers.
const TWIN_SOURCES: &[&str] = &[
    include_str!("../src/interp/tests.rs"),
    include_str!("../src/interp/tests/gc_consumer_schedules.rs"),
];

/// A booted, linked machine that has just completed a full collection —
/// the state in which every transitively rooted anchor must be alive.
fn anchors_after_a_collection() -> Vec<(&'static str, bool)> {
    let (_, s) = ironhorse_compile::compile_atoms("var t = 0; t").expect("compiles");
    let mut m = Interp::new();
    m.link_intrinsics(&ironhorse_vm::parse_symbols(&s));
    m.collect_garbage()
        .expect("a fresh linked machine is quiescent");
    m.boot_anchor_liveness()
}

#[test]
fn every_slot_bearing_field_is_classified_and_the_classification_holds() {
    let src = src();
    assert_field_emission(src);
    let defs = type_defs(src);
    let bearing_types = slot_bearing_types(&defs);
    let fields = interp_fields();
    assert!(
        fields.len() > 140,
        "parse sanity: found {} fields",
        fields.len()
    );

    let declared: Vec<_> = fields
        .iter()
        .map(|(name, ty)| (name.as_str(), compact(ty)))
        .collect();
    let emitted: Vec<_> = ironhorse_vm::diagnostics::INTERP_FIELDS
        .iter()
        .map(|(name, ty)| (*name, compact(ty)))
        .collect();
    assert_eq!(
        declared, emitted,
        "field emitter and declaration must agree"
    );

    let is_bearing = |ty: &str| {
        mentions(ty, "Slot")
            || mentions(ty, "SlotIndex")
            || mentions(ty, "ChunkOffset")
            || bearing_types
                .iter()
                .any(|t| *t != "Interp" && mentions(ty, t))
    };

    let slot_fields: Vec<&(String, String)> =
        fields.iter().filter(|(_, ty)| is_bearing(ty)).collect();
    assert!(
        slot_fields.len() > 90,
        "parse sanity: found {} slot-bearing fields",
        slot_fields.len()
    );

    let registry: BTreeMap<&str, (&[Req], &str)> = REGISTRY
        .iter()
        .map(|(name, reqs, note)| (*name, (*reqs, *note)))
        .collect();
    assert_eq!(registry.len(), REGISTRY.len(), "duplicate registry entry");

    // Two-way completeness.
    let mut unclassified: Vec<&str> = Vec::new();
    for (name, _) in &slot_fields {
        if !registry.contains_key(name.as_str()) {
            unclassified.push(name);
        }
    }
    assert!(
        unclassified.is_empty(),
        "slot-bearing Interp fields with NO GC classification (add each to the registry \
         with a checked requirement or a documented reason): {unclassified:?}"
    );
    let field_names: Vec<&str> = fields.iter().map(|(n, _)| n.as_str()).collect();
    for name in registry.keys() {
        assert!(
            field_names.contains(name),
            "registry names a field Interp no longer has: {name}"
        );
        assert!(
            slot_fields.iter().any(|(n, _)| n == name),
            "registry classifies a field that is not slot-bearing (stale entry): {name}"
        );
    }

    // The checked requirements, against the real visitor bodies. Every
    // generated policy list is emitted in roster order, one entry per
    // `Interp` field, so a field's OWN policy is the entry at its index.
    root_source(src);
    edge_sources(src);
    weak_sources(src);
    chunk_source(src);
    let (full_sweep, partial_sweep) = sweep_sources(src);
    let anchors = anchors_after_a_collection();
    let lexed = Lexed::new(src);
    let full_collector = lexed.body("pub fn collect_garbage(&mut self)");
    let partial_collector = lexed.body("pub fn free_pages(&mut self, pages: &[u32])");
    let index_of = |name: &str| -> usize {
        ironhorse_vm::diagnostics::INTERP_FIELDS
            .iter()
            .position(|(field, _)| *field == name)
            .unwrap_or_else(|| panic!("{name} is not an Interp field"))
    };
    let own = |list: &'static [&'static str], name: &str| -> &'static str { list[index_of(name)] };
    let root_of = |name: &str| -> &'static str {
        let (field, body) = ironhorse_vm::diagnostics::ROOT_SOURCE[index_of(name)];
        assert_eq!(field, name, "root policy order");
        body
    };
    let row_of = |name: &str| -> (&'static str, &'static str) {
        let (field, _, full_row, partial_row) =
            ironhorse_vm::diagnostics::ROW_EDGE_SOURCE[index_of(name)];
        assert_eq!(field, name, "row policy order");
        (full_row, partial_row)
    };
    let full_table = |name: &str| own(ironhorse_vm::diagnostics::FULL_EDGE_SOURCE, name);
    let partial_table = |name: &str| own(ironhorse_vm::diagnostics::PARTIAL_EDGE_SOURCE, name);
    let classified_as = |host: &str, wanted: Req| {
        registry
            .get(host)
            .is_some_and(|(reqs, _)| reqs.contains(&wanted))
    };

    let value_type_of = |name: &str| -> &str { &fields.iter().find(|(n, _)| n == name).unwrap().1 };

    let mut violations: Vec<String> = Vec::new();
    for (name, (reqs, _)) in &registry {
        for req in *reqs {
            let ok = match req {
                Req::GcRoots => names_field(root_of(name), name),
                Req::RootedVia(host) => {
                    names_field(root_of(host), name) && classified_as(host, Req::GcRoots)
                }
                Req::Edges => {
                    names_field(full_table(name), name) && names_field(partial_table(name), name)
                }
                Req::EdgedVia(host) => {
                    let (full_row, partial_row) = row_of(host);
                    names_field(full_row, name)
                        && names_field(partial_row, name)
                        && classified_as(host, Req::Edges)
                        && !full_table(host).trim().is_empty()
                        && !partial_table(host).trim().is_empty()
                }
                Req::Ephemeron => {
                    names_field(own(ironhorse_vm::diagnostics::EPHEMERON_SOURCE, name), name)
                        && names_field(
                            own(ironhorse_vm::diagnostics::WEAK_PRUNE_SOURCE, name),
                            name,
                        )
                }
                Req::PartialWalk => names_field(partial_table(name), name),
                Req::ChunkRemap => names_field(
                    own(ironhorse_vm::diagnostics::CHUNK_WALK_SOURCE, name),
                    name,
                ),
                Req::PrunedBothPaths => {
                    names_field(&full_sweep, name) && names_field(&partial_sweep, name)
                }
                Req::Arena => {
                    names_field(full_collector, name) && names_field(partial_collector, name)
                }
                Req::ValueSlotFree => value_half_is_slot_free(value_type_of(name), &is_bearing),
                Req::TransitivelyRooted(test) => {
                    if test_body(include_str!("gc_anchor_truth.rs"), test).is_none() {
                        violations
                            .push(format!("{name}: twin {test} is not in gc_anchor_truth.rs"));
                    }
                    match anchors.iter().find(|(anchor, _)| anchor == name) {
                        None => violations.push(format!(
                            "{name}: classified TransitivelyRooted but Interp::boot_anchor_liveness does not probe it"
                        )),
                        Some((_, false)) => violations.push(format!(
                            "{name}: did not survive a full collection on a booted machine"
                        )),
                        Some((_, true)) => {}
                    }
                    // Reported above by the specific message, never twice.
                    true
                }
                // A unit test reaches the field through its own machine
                // binding (`m.this_captures`), so the word-bounded mention
                // is the right test here, not the `self.` form. Comments are
                // blanked first: a remark naming the field is no coverage.
                Req::BehavioralTwin(test) => TWIN_SOURCES.iter().any(|source| {
                    let code = source_scan::code_only(source);
                    test_body(&code, test).is_some_and(|body| mentions(body, name))
                }),
            };
            if !ok {
                violations.push(format!("{name}: requirement {req:?} not satisfied"));
            }
        }
    }
    // The anchor probe and the registry reconcile the other way too.
    for (anchor, _) in &anchors {
        let classified = registry
            .get(anchor)
            .is_some_and(|(reqs, _)| reqs.iter().any(|r| matches!(r, Req::TransitivelyRooted(_))));
        if !classified {
            violations.push(format!(
                "{anchor}: probed by Interp::boot_anchor_liveness but not classified TransitivelyRooted"
            ));
        }
    }
    assert!(
        violations.is_empty(),
        "GC classification claims that the visitor bodies do not back:\n{}",
        violations.join("\n")
    );
}

/// The `self.`-qualified checks close the hole the review named: a
/// caller-frame walk that pushes `f.target_func` used to satisfy the
/// `target_func` root claim by bare word. Now only `self.target_func`
/// does, and a name that appears only as a frame subfield fails.
#[test]
fn a_frame_subfield_mention_does_not_satisfy_a_self_field_claim() {
    let callers =
        "for f in &self.call_stack { roots.push(f.cur_func); roots.push(f.target_func); }";
    assert!(names_field(callers, "call_stack"));
    assert!(!names_field(callers, "target_func"));
    assert!(!names_field(callers, "cur_func"));
    assert!(names_field(
        "roots . push ( self . target_func ) ;",
        "target_func"
    ));
    assert!(!names_field(
        "let target_func = 1; roots.push(target_func);",
        "target_func"
    ));
    assert!(!names_field("\"self.target_func\"", "target_func"));
    assert!(!names_field("self.target_function", "target_func"));
    // And against the real generated roots: the frame walk names its own
    // field and no register.
    let gc_roots = root_source(src());
    let callers = ironhorse_vm::diagnostics::ROOT_SOURCE
        .iter()
        .find(|(field, _)| *field == "call_stack")
        .unwrap()
        .1;
    assert!(callers.contains("target_func"));
    assert!(!names_field(callers, "target_func"));
    assert!(names_field(&gc_roots, "target_func"));
}

/// A `TransitivelyRooted` claim is refused when the anchor is dead, when
/// it is not probed, and when the probe covers an unclassified field.
#[test]
fn transitively_rooted_claims_are_checked_at_runtime() {
    let anchors = anchors_after_a_collection();
    assert!(anchors.len() >= 19, "probe sanity: {}", anchors.len());
    assert!(
        anchors.iter().all(|(_, alive)| *alive),
        "a boot anchor did not survive collection: {anchors:?}"
    );
    let classified: BTreeSet<&str> = REGISTRY
        .iter()
        .filter(|(_, reqs, _)| reqs.iter().any(|r| matches!(r, Req::TransitivelyRooted(_))))
        .map(|(name, _, _)| *name)
        .collect();
    let probed: BTreeSet<&str> = anchors.iter().map(|(name, _)| *name).collect();
    assert_eq!(classified, probed);
    // Every named twin exists in the anchor-truth file.
    for (name, reqs, _) in REGISTRY {
        for req in *reqs {
            if let Req::TransitivelyRooted(test) = req {
                assert!(
                    test_body(include_str!("gc_anchor_truth.rs"), test).is_some(),
                    "{name}: twin {test} is not in gc_anchor_truth.rs"
                );
            }
        }
    }
    // The probe's negative side (a null or swept anchor reads back dead)
    // needs private access and lives in the crate's own unit tests:
    // `boot_anchor_liveness_reports_a_null_or_swept_anchor_dead`.
    assert!(
        TWIN_SOURCES[0].contains("fn boot_anchor_liveness_reports_a_null_or_swept_anchor_dead(")
    );
}

/// A `BehavioralTwin` must exist in this crate's unit tests AND name the
/// field it covers; a twin that merely exists is not a witness.
#[test]
fn behavioral_twins_must_name_their_fields() {
    // Comments blanked, as the registry check reads them: a remark
    // naming a field is not a witness.
    let sources: Vec<String> = TWIN_SOURCES
        .iter()
        .map(|source| source_scan::code_only(source))
        .collect();
    let body = test_body(
        &sources[0],
        "each_activation_register_independently_refuses_quiescence",
    )
    .expect("twin exists");
    assert!(mentions(body, "this_captures"));
    assert!(mentions(body, "array_iterator_proxy_get_context"));
    assert!(!mentions(body, "restored_leases"));
    assert!(test_body(&sources[0], "no_such_test_anywhere").is_none());
    for (name, reqs, _) in REGISTRY {
        for req in *reqs {
            if let Req::BehavioralTwin(test) = req {
                let bodies: Vec<&str> = sources
                    .iter()
                    .filter_map(|source| test_body(source, test))
                    .collect();
                assert!(!bodies.is_empty(), "{name}: twin {test} does not exist");
                assert!(
                    bodies.iter().any(|b| mentions(b, name)),
                    "{name}: twin {test} never names the field"
                );
            }
        }
    }
}

// ---------------------------------------------------------------------
// The visitor sources, each traced from its live entry point
// ---------------------------------------------------------------------

/// Follow the generated calls and inspect the same token templates used by the
/// executable expansion. A roster entry without an active sweep call is not
/// evidence of pruning. The registry above remains independent of the roster.
fn sweep_sources(src: &str) -> (String, String) {
    let lexed = Lexed::new(src);
    let emitter = lexed.compact_body("macro_rules! gc_run");
    assert_eq!(emitter, "{($($code:tt)*)=>{{$($code)*}};}");
    let full = lexed.compact_body("pub fn collect_garbage(&mut self)");
    let swept = lexed
        .scoped(HOOKS_IMPL)
        .compact_body("fn swept(&mut self, idx: SlotIndex)");
    let partial = lexed.compact_body("pub fn free_pages(&mut self, pages: &[u32])");
    assert!(full.contains("letmuthooks=gc_tables!(borrow_gc_tables,self);"));
    assert!(
        full.contains("crate::gc::collect_full(&mutself.slots,&mutself.chunks,&roots,&muthooks)")
    );
    assert!(swept.contains("self.prune_swept(idx);"));
    assert!(full.contains("hooks.prune_late(&dead);"));
    assert!(partial.contains("self.prune_dead_tables(&dead);"));
    let early_template = lexed.compact_body("fn prune_swept(&mut self, idx: SlotIndex)");
    let late_template = lexed.compact_body("fn prune_late(&mut self,");
    let partial_template = lexed.compact_body("fn prune_dead_tables(&mut self,");
    assert!(early_template.contains("$(gc_remove!(gc_run,self,$early,idx,$early_shape);)*"));
    assert!(late_template.contains("$(gc_retain!(gc_run,self,$late,dead,$late_shape);)*"));
    assert!(partial_template.contains("$(gc_retain!(gc_run,self,$early,dead,$early_shape);)*"));
    assert!(partial_template.contains("$(gc_retain!(gc_run,self,$late,dead,$late_shape);)*"));
    // The sweep lists are emitted early-then-late rather than in roster
    // order, so the registry reads them joined; that is sound only while
    // every entry prunes exactly ONE table (plus the counted-reference
    // side table it decrements), so no entry can vouch for another field.
    for entry in ironhorse_vm::diagnostics::FULL_SWEEP_SOURCE
        .iter()
        .chain(ironhorse_vm::diagnostics::PARTIAL_SWEEP_SOURCE)
    {
        let mut named = self_fields_named(entry);
        named.remove("side_refs");
        assert_eq!(named.len(), 1, "a sweep entry prunes one table: {entry}");
    }
    (
        ironhorse_vm::diagnostics::FULL_SWEEP_SOURCE.join("\n"),
        ironhorse_vm::diagnostics::PARTIAL_SWEEP_SOURCE.join("\n"),
    )
}

/// Every field a body names through `self.`.
fn self_fields_named(body: &str) -> BTreeSet<String> {
    let tokens = source_scan::tokens(body);
    tokens
        .windows(3)
        .filter(|w| w[0].text == "self" && w[1].text == ".")
        .filter(|w| {
            w[2].text
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
        })
        .map(|w| w[2].text.to_string())
        .collect()
}

#[test]
fn generated_sweep_checks_reject_disconnected_calls_and_missing_expansions() {
    for code in [
        "{{ $($code)* }}",
        "self.prune_swept(idx);",
        "hooks.prune_late(&dead);",
        "self.prune_dead_tables(&dead);",
        "gc_remove!(gc_run, self, $early, idx, $early_shape)",
        "gc_retain!(gc_run, self, $early, dead, $early_shape)",
        "gc_retain!(gc_run, self, $late, dead, $late_shape)",
    ] {
        assert!(src().contains(code), "mutation target missing: {code}");
        let mutation = src().replace(code, "/* removed by mutation */");
        assert!(
            std::panic::catch_unwind(|| sweep_sources(&mutation)).is_err(),
            "source lock accepted removed sweep code: {code}"
        );
    }
}

/// Keep the independently parsed declaration tied to the executable field
/// expansion: neither deleting the struct callback nor dropping a repeated field
/// from the emitter may leave a passing metadata-only test.
fn assert_field_emission(src: &str) {
    let lexed = Lexed::new(src);
    assert!(compact(src).contains("interp_state!(define_interp_state);"));
    let emitter = lexed.compact_body("macro_rules! define_interp_state");
    assert!(emitter.contains("$visstruct$name{$($(#[$attr])*$field_vis$field:$ty,)*}"));
}

#[test]
fn field_checks_reject_disconnected_or_incomplete_struct_emission() {
    for target in [
        "interp_state!(define_interp_state);",
        "$($(#[$attr])* $field_vis $field: $ty,)*",
    ] {
        assert!(src().contains(target), "missing mutation target: {target}");
        let mutation = src().replace(target, "/* field emission removed */");
        assert!(std::panic::catch_unwind(|| assert_field_emission(&mutation)).is_err());
    }
}

/// Trace the collector callback to the generated per-field policy expansion.
fn chunk_source(src: &str) -> String {
    let lexed = Lexed::new(src);
    assert_eq!(
        lexed.compact_body("macro_rules! gc_run"),
        "{($($code:tt)*)=>{{$($code)*}};}"
    );
    assert!(compact(src).contains("interp_state!(define_chunk_walk);"));
    let callback = lexed
        .scoped(HOOKS_IMPL)
        .compact_body("fn external_chunk_refs(&mut self, visit: &mut dyn FnMut(&mut ChunkOffset))");
    assert!(callback.contains("self.visit_chunks(visit);"));
    let walk = lexed.compact_body("fn visit_chunks(&mut self");
    assert!(walk.contains("$(gc_chunk!(gc_run,self,$field,visit,$chunk);)*"));
    ironhorse_vm::diagnostics::CHUNK_WALK_SOURCE.join("\n")
}

#[test]
fn chunk_checks_reject_disconnected_calls_and_missing_expansions() {
    for target in [
        "{{ $($code)* }}",
        "interp_state!(define_chunk_walk);",
        "self.visit_chunks(visit);",
        "gc_chunk!(gc_run, self, $field, visit, $chunk)",
    ] {
        assert!(src().contains(target), "missing mutation target: {target}");
        let mutation = src().replace(target, "/* chunk walk removed */");
        assert!(std::panic::catch_unwind(|| chunk_source(&mutation)).is_err());
    }
}

/// Inspect generated table walks only after checking their live entry points.
fn edge_sources(src: &str) -> (String, String) {
    let lexed = Lexed::new(src);
    assert_eq!(
        lexed.compact_body("macro_rules! gc_run"),
        "{($($code:tt)*)=>{{$($code)*}};}"
    );
    assert!(compact(src).contains("interp_state!(define_slot_walks);"));
    let callback = lexed
        .scoped(HOOKS_IMPL)
        .compact_body("fn extra_edges(&self, idx: SlotIndex, visit: &mut dyn FnMut(SlotIndex))");
    assert!(callback.contains("self.visit_owner_slots(idx,visit);"));
    for (marker, mode) in [
        ("fn visit_owner_slots(&self", "full"),
        ("fn each_side_table_ref(&self", "all"),
        ("fn each_side_table_ref_tail(&self", "tail"),
        ("fn each_side_table_ref_bulk(&self", "bulk"),
    ] {
        let walk = lexed.compact_body(marker);
        assert!(
            walk.contains(&format!(
                "$(gc_slot_table!(gc_run,{mode},self,$field,idx,visit,$shape,$row);)*"
            )),
            "{marker}"
        );
    }
    let slots = lexed.compact_body("pub fn side_table_ref_slots(&self)");
    assert!(slots.contains("self.each_side_table_ref(&mut|r|out.push(r));"));
    let pages = lexed.compact_body("pub fn side_table_ref_page_bits(&self)");
    assert!(pages.contains("self.each_side_table_ref_tail(&mut|r|"));
    assert!(pages.contains("self.side_refs.or_into_bits(&mutbits);"));
    assert!(pages.contains("ifself.side_ref_parity().is_err(){self.side_refs.poison();}"));
    let parity = lexed.compact_body("pub fn side_ref_parity(&self)");
    assert!(parity.contains("self.each_side_table_ref_bulk(&mut|r|"));
    assert!(parity.contains("self.side_refs.mismatch_against(&walked)"));
    let full = expanded_row_edges(ironhorse_vm::diagnostics::FULL_EDGE_SOURCE, true);
    let partial = expanded_row_edges(ironhorse_vm::diagnostics::PARTIAL_EDGE_SOURCE, false);
    let tail = expanded_row_edges(ironhorse_vm::diagnostics::TAIL_EDGE_SOURCE, false);
    let bulk = expanded_row_edges(ironhorse_vm::diagnostics::BULK_EDGE_SOURCE, false);
    assert_tail_coverage(&partial, &tail, &bulk);
    (full, partial)
}

#[test]
fn edge_checks_reject_disconnected_calls_and_missing_expansions() {
    for target in [
        "{{ $($code)* }}",
        "interp_state!(define_slot_walks);",
        "self.visit_owner_slots(idx, visit);",
        "gc_slot_table!(gc_run, full, self, $field, idx, visit, $shape, $row)",
        "gc_slot_table!(gc_run, all, self, $field, idx, visit, $shape, $row)",
        "gc_slot_table!(gc_run, tail, self, $field, idx, visit, $shape, $row)",
        "gc_slot_table!(gc_run, bulk, self, $field, idx, visit, $shape, $row)",
        "self.each_side_table_ref(&mut |r| out.push(r));",
        "self.each_side_table_ref_tail(&mut |r|",
        "self.side_refs.or_into_bits(&mut bits);",
        "if self.side_ref_parity().is_err() {",
        "self.each_side_table_ref_bulk(&mut |r|",
        "self.side_refs.mismatch_against(&walked)",
    ] {
        assert!(src().contains(target), "missing mutation target: {target}");
        let mutation = src().replace(target, "/* slot walk removed */");
        assert!(
            std::panic::catch_unwind(|| edge_sources(&mutation)).is_err(),
            "mutation accepted: {target}"
        );
    }
}

/// Include a row body's evidence only when the table walk actually calls that
/// policy. Promise rows reach combinator/fromAsync state through those bodies.
fn expanded_row_edges(tables: &[&str], full: bool) -> String {
    let rows = ironhorse_vm::diagnostics::ROW_EDGE_SOURCE;
    assert_eq!(tables.len(), rows.len());
    let mut source = tables.join("\n");
    for ((field, policy, full_row, partial_row), table) in rows.iter().zip(tables) {
        let row = if full { full_row } else { partial_row };
        if !row.trim().is_empty() && !table.trim().is_empty() {
            assert!(
                names_field(table, field),
                "{field}: table identity mismatch"
            );
            assert!(
                compact(table).contains(&format!(
                    "gc_slot_row!(gc_run,self,row,visit,{full},{policy});"
                )),
                "{field}: row policy is disconnected from the table walk"
            );
            source.push_str(row);
        }
    }
    source
}

/// The counted bulk tables are exactly the ones the tail omits and the
/// bulk walk enumerates; every other table the partial walk visits is in
/// the tail and not in the bulk walk.
fn assert_tail_coverage(partial: &str, tail: &str, bulk: &str) {
    for (field, _) in ironhorse_vm::diagnostics::INTERP_FIELDS {
        if ["arrays", "index_props", "collections"].contains(field) {
            assert!(
                !names_field(tail, field),
                "counted bulk table scanned in tail: {field}"
            );
            assert!(
                names_field(bulk, field),
                "counted bulk table missing from the parity walk: {field}"
            );
        } else if names_field(partial, field) {
            assert!(
                names_field(tail, field),
                "nonbulk table missing from tail: {field}"
            );
            assert!(
                !names_field(bulk, field),
                "nonbulk table scanned by the parity walk: {field}"
            );
        }
    }
}

#[test]
fn tail_checks_reject_missing_nonbulk_fields_and_added_bulk_fields() {
    let partial = expanded_row_edges(ironhorse_vm::diagnostics::PARTIAL_EDGE_SOURCE, false);
    let tail = expanded_row_edges(ironhorse_vm::diagnostics::TAIL_EDGE_SOURCE, false);
    let bulk = expanded_row_edges(ironhorse_vm::diagnostics::BULK_EDGE_SOURCE, false);
    assert_tail_coverage(&partial, &tail, &bulk);
    for field in [
        "functions",
        "promises",
        "combinators",
        "from_async",
        "symbol_key_ids",
    ] {
        assert!(names_field(&tail, field));
        let mutation = tail.replace(field, "removed_field");
        assert!(
            std::panic::catch_unwind(|| assert_tail_coverage(&partial, &mutation, &bulk)).is_err()
        );
        let mutation = format!("{bulk} self.{field};");
        assert!(
            std::panic::catch_unwind(|| assert_tail_coverage(&partial, &tail, &mutation)).is_err()
        );
    }
    for field in ["arrays", "index_props", "collections"] {
        let mutation = format!("{tail} self.{field};");
        assert!(
            std::panic::catch_unwind(|| assert_tail_coverage(&partial, &mutation, &bulk)).is_err()
        );
        assert!(names_field(&bulk, field));
        let mutation = bulk.replace(field, "removed_field");
        assert!(
            std::panic::catch_unwind(|| assert_tail_coverage(&partial, &tail, &mutation)).is_err()
        );
    }
}

#[test]
fn row_checks_reject_a_disconnected_call_even_when_another_table_uses_the_policy() {
    let mut tables: Vec<String> = ironhorse_vm::diagnostics::PARTIAL_EDGE_SOURCE
        .iter()
        .map(|source| (*source).to_owned())
        .collect();
    let table = tables
        .iter_mut()
        .find(|table| names_field(table, "ctor_prototype"))
        .unwrap();
    assert!(table.contains("gc_slot_row"));
    *table = table.replace("gc_slot_row", "removed_row_call");
    let tables: Vec<&str> = tables.iter().map(String::as_str).collect();
    assert!(std::panic::catch_unwind(|| expanded_row_edges(&tables, false)).is_err());
}

fn weak_sources(src: &str) -> (String, String) {
    let lexed = Lexed::new(src);
    assert_eq!(
        lexed.compact_body("macro_rules! gc_run"),
        "{($($code:tt)*)=>{{$($code)*}};}"
    );
    assert!(compact(src).contains("interp_state!(define_weak_walks);"));
    let hooks = lexed.scoped(HOOKS_IMPL);
    let trace = hooks.compact_body(
        "fn ephemeron_edges(&self, slots: &SlotArena, visit: &mut dyn FnMut(SlotIndex))",
    );
    assert!(trace.contains("self.visit_ephemerons(slots,visit);"));
    let prune = hooks.compact_body("fn prune_dead_keyed(&mut self, slots: &SlotArena)");
    assert!(prune.contains("self.prune_ephemerons(slots);"));
    let trace = lexed.compact_body("fn visit_ephemerons(&self");
    assert!(trace.contains("$(gc_weak!(gc_run,trace,self,$field,slots,visit,$weak);)*"));
    let prune = lexed.compact_body("fn prune_ephemerons(&mut self");
    assert!(prune.contains("$(gc_weak!(gc_run,prune,self,$field,slots,visit,$weak);)*"));
    (
        ironhorse_vm::diagnostics::EPHEMERON_SOURCE.join("\n"),
        ironhorse_vm::diagnostics::WEAK_PRUNE_SOURCE.join("\n"),
    )
}

#[test]
fn weak_checks_reject_disconnected_callbacks_and_missing_expansions() {
    for target in [
        "{{ $($code)* }}",
        "interp_state!(define_weak_walks);",
        "self.visit_ephemerons(slots, visit);",
        "self.prune_ephemerons(slots);",
        "gc_weak!(gc_run, trace, self, $field, slots, visit, $weak)",
        "gc_weak!(gc_run, prune, self, $field, slots, visit, $weak)",
    ] {
        assert!(src().contains(target), "missing mutation target: {target}");
        let mutation = src().replace(target, "/* weak walk removed */");
        assert!(std::panic::catch_unwind(|| weak_sources(&mutation)).is_err());
    }
}

fn root_source(src: &str) -> String {
    let lexed = Lexed::new(src);
    assert_eq!(
        lexed.compact_body("macro_rules! gc_run"),
        "{($($code:tt)*)=>{{$($code)*}};}"
    );
    assert_eq!(
        lexed.compact_body("macro_rules! gc_text"),
        "{($($code:tt)*)=>{stringify!($($code)*)};}"
    );
    assert_eq!(lexed.compact_body("pub fn gc_roots(&self)"),
        "{letmutroots=Vec::new();self.append_gc_roots(&mutroots);roots.sort_unstable_by_key(|r|r.0);roots.dedup();roots}");
    assert_eq!(
        lexed.compact_body("fn append_gc_roots(&self,"),
        "{$(gc_root!(gc_run,self,$field,roots,$root);)*}"
    );
    assert_eq!(
        lexed.compact_body("fn slot_roots(s: &Slot,"),
        "{s.each_ref_slot(|e|roots.push(e));}"
    );
    let source = compact(src);
    assert!(source.contains("interp_state!(define_root_walk);"));
    assert!(source.contains("pubconstROOT_SOURCE:&[(&str,&str)]=&[$((stringify!($field),gc_root!(gc_text,self,$field,roots,$root)),)*];"));
    let sources = ironhorse_vm::diagnostics::ROOT_SOURCE;
    // Weak symbol-key descriptors must not silently become strong roots.
    assert_eq!(
        sources
            .iter()
            .find(|(field, _)| *field == "symbol_key_ids")
            .unwrap()
            .1,
        ""
    );
    sources
        .iter()
        .map(|(_, body)| *body)
        .collect::<Vec<_>>()
        .join("\n")
}

#[test]
fn disconnected_root_walks_cannot_satisfy_the_registry() {
    root_source(src());
    for (before, after) in [
        ("self.append_gc_roots(&mut roots);", ""),
        ("$(gc_root!(gc_run, self, $field, roots, $root);)*", ""),
        ("gc_root!(gc_text, self, $field, roots, $root)", "\"\""),
        ("interp_state!(define_root_walk);", ""),
        ("roots.sort_unstable_by_key(|r| r.0);", ""),
        ("roots.dedup();", ""),
        ("s.each_ref_slot(|e| roots.push(e));", ""),
    ] {
        let mutated = src().replace(before, after);
        assert_ne!(mutated, src(), "mutation must match: {before}");
        assert!(
            std::panic::catch_unwind(|| root_source(&mutated)).is_err(),
            "disconnected roots accepted: {before}"
        );
    }
}

/// A body lookup fails loudly when its declaration is not unique — the
/// case a second implementation of a visitor spelling would create — and
/// a trait method's declaration never stands in for its body.
#[test]
fn body_lookups_require_a_unique_declaration_with_a_body() {
    let lexed = Lexed::new("trait T { fn swept(&mut self, idx: SlotIndex); }\nimpl T for A { fn swept(&mut self, idx: SlotIndex) { a() } }");
    assert_eq!(
        compact(lexed.body("fn swept(&mut self, idx: SlotIndex)")),
        "{a()}"
    );
    let two = Lexed::new("impl A { fn f(&self) { 1 } }\nimpl B { fn f(&self) { 2 } }");
    assert!(std::panic::catch_unwind(|| two.body("fn f(&self)")).is_err());
    let none = Lexed::new("trait T { fn f(&self); }");
    assert!(std::panic::catch_unwind(|| none.body("fn f(&self)")).is_err());
    // Comments and strings cannot impersonate a declaration.
    let code = source_scan::code_only(
        "// fn g(&self) { 0 }\nconst S: &str = \"fn g(&self) { 0 }\";\nfn g(&self) { 3 }",
    );
    let noisy = Lexed::new(&code);
    assert_eq!(compact(noisy.body("fn g(&self)")), "{3}");
    // A scoped lookup sees only its block: the trait's default body is
    // invisible inside the implementation, and vice versa.
    let scoped = Lexed::new(
        "trait T { fn h(&self) { 0 } }\nimpl T for A { fn h(&self) { 1 } }\nimpl T for B { fn h(&self) { 2 } }",
    );
    assert!(std::panic::catch_unwind(|| scoped.body("fn h(&self)")).is_err());
    assert_eq!(
        compact(scoped.scoped("impl T for A").body("fn h(&self)")),
        "{1}"
    );
    assert_eq!(compact(scoped.scoped("trait T").body("fn h(&self)")), "{0}");
    // The real hook block is unique and holds every traced callback.
    let hooks = Lexed::new(src()).scoped(HOOKS_IMPL);
    for callback in [
        "fn extra_edges(&self, idx: SlotIndex, visit: &mut dyn FnMut(SlotIndex))",
        "fn swept(&mut self, idx: SlotIndex)",
        "fn ephemeron_edges(&self, slots: &SlotArena, visit: &mut dyn FnMut(SlotIndex))",
        "fn prune_dead_keyed(&mut self, slots: &SlotArena)",
        "fn external_chunk_refs(&mut self, visit: &mut dyn FnMut(&mut ChunkOffset))",
    ] {
        hooks.body(callback);
    }
}

#[test]
fn moved_temporal_records_remain_in_the_slot_bearing_type_graph() {
    let original = type_defs(src());
    let original_bearing = slot_bearing_types(&original);
    for (record, field) in [
        ("TemporalInstantRecord", "temporal_instants"),
        ("TemporalDurationRecord", "temporal_durations"),
        ("TemporalPlainRecord", "temporal_plains"),
        ("TemporalZonedRecord", "temporal_zoneds"),
    ] {
        assert!(
            original.contains_key(record),
            "moved record is invisible: {record}"
        );
        assert!(!original_bearing.contains(&record));
        let declaration = format!("pub(super) struct {record} {{");
        let changed = src().replace(&declaration, &format!("{declaration}\n    retained: Slot,"));
        assert_ne!(changed, src());
        let definitions = type_defs(&changed);
        let bearing = slot_bearing_types(&definitions);
        assert!(
            bearing.contains(&record),
            "new Slot member must invalidate {record}'s slot-free classification"
        );
        let fields = interp_fields();
        let (_, ty) = fields.iter().find(|(name, _)| name == field).unwrap();
        assert!(bearing.iter().any(|name| mentions(ty, name)));
        assert!(REGISTRY
            .iter()
            .find(|(name, _, _)| *name == field)
            .unwrap()
            .1
            .iter()
            .any(|req| matches!(req, Req::ValueSlotFree)));
    }
}

/// The type graph covers every production module: a slot-bearing type
/// declared OUTSIDE `interp/` — `bulk.rs`'s `ArrayData`, `value.rs`'s
/// `Slot` itself — is in it, and a second definition sharing a name
/// merges conservatively rather than shadowing.
#[test]
fn the_type_graph_spans_the_whole_production_crate() {
    let defs = type_defs(src());
    let bearing = slot_bearing_types(&defs);
    for (ty, expected) in [
        ("ArrayData", true),
        ("CollectionData", true),
        ("SideRefCounts", false),
        ("SavedFrame", true),
        ("FuncInfo", true),
        ("ModuleGraph", true),
        ("Meter", false),
    ] {
        assert!(defs.contains_key(ty), "{ty} is not in the type graph");
        assert_eq!(bearing.contains(&ty), expected, "{ty}");
    }
    let mut merged = BTreeMap::new();
    merged.insert("Twice", "{ a: u32 }\n{ b: Slot }\n".to_string());
    assert!(slot_bearing_types(&merged).contains(&"Twice"));
    let doubled = format!("{}\nstruct Meter {{ hidden: Slot }}\n", src());
    assert!(slot_bearing_types(&type_defs(&doubled)).contains(&"Meter"));
    // Tuple structs, type aliases and `pub(in path)` definitions are in
    // the graph too: a field typed through any of them cannot be exempt.
    let shapes = "pub(in crate::x) struct Tuple(u32, Slot);\n\
                  pub type Alias = std::collections::HashMap<SlotIndex, u32>;\n\
                  type Plain = Vec<u8>;\n\
                  struct Unit;\n\
                  impl T for U {\n    type Assoc = Slot;\n}\n";
    let defs = type_defs(shapes);
    let bearing = slot_bearing_types(&defs);
    assert!(bearing.contains(&"Tuple"));
    assert!(bearing.contains(&"Alias"));
    assert!(!bearing.contains(&"Plain"));
    assert!(!defs.contains_key("Unit"));
    assert!(bearing.contains(&"Assoc"));
    // The real crate's aliases and tuple structs are covered.
    let real = type_defs(src());
    let real_bearing = slot_bearing_types(&real);
    for ty in ["ArraySnapshot", "CollectionSnapshot", "PoisonedPage"] {
        assert!(real_bearing.contains(&ty), "{ty}");
    }
}

/// The weak-keyed value check reads the map's VALUE half on its own.
#[test]
fn value_slot_free_reads_the_value_half_of_a_map() {
    let is_bearing = |ty: &str| mentions(ty, "Slot") || mentions(ty, "SlotIndex");
    for (ty, expected) in [
        (
            "Tracked<std::collections::HashMap<crate::value::SlotIndex, ErrorData>>",
            true,
        ),
        ("HashMap<SlotIndex, (bool, bool)>", true),
        ("HashSet<SlotIndex>", true),
        ("Vec<crate::value::SlotIndex>", true),
        ("HashMap<SlotIndex, Slot>", false),
        ("HashMap<(SlotIndex, u16), Slot>", false),
        ("BTreeMap<u32, SlotIndex>", false),
        ("HashMap<Foo, Vec<SlotIndex>>", false),
        ("HashMap<SlotIndex, Option<Box<Slot>>>", false),
        ("HashMap<SlotIndex, HashMap<u16, usize>>", true),
    ] {
        assert_eq!(value_half_is_slot_free(ty, &is_bearing), expected, "{ty}");
    }
}
