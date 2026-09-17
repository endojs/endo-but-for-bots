//! The exotic-dispatch probe chain, counted (architecture finding F119).
//!
//! F119's claim is structural and its impact clause is a cost: `GET_PROPERTY`
//! tests membership in a fixed-order chain of side tables before reaching
//! `ordinary_get`, and "every new built-in makes every property read and
//! every call slower".
//!
//! The finding has been closed once and reopened. A derived classification
//! index landed, and then came out again, because
//! `architecture-review/2026-09-06/PERFORMANCE-TRADEOFFS.md` measured six of
//! eight cases SLOWER with it and named it the first thing simplification
//! should remove. That was the review working: a cost claim was tested and
//! did not hold. What stayed missing through both rounds is any gate at all
//! — `ironhorse-snapshot/tests/classification_bench.rs` prints medians,
//! pins identical raw and dispatch counts, and asserts no threshold — so the
//! chain could grow arbitrarily without anything noticing.
//!
//! **This file is that gate, and it gates the structure rather than the
//! clock.** The chain's LENGTH is what the finding measured and what a new
//! built-in changes; an elapsed-time gate on a shared runner would be noise
//! around the same fact. Counting the probes makes the claim a number, and a
//! ceiling makes growing it a deliberate act rather than a side effect of
//! adding a table.
//!
//! **The path, not a file.** The first version of this counted probes in
//! `interp/dispatch/property_read.rs` alone and called the result "the
//! ordinary property-read path". It is not: that file falls through to
//! `mop_get`, which is in `interp/property.rs` along with
//! `exotic_own_descriptor` and several hundred lines of further side-table
//! probes — a second `proxies` probe among them. A ceiling over one file of
//! a multi-file path is a change detector on that file, and adding a probe
//! one call deeper would have moved the real cost with the number standing
//! still. The roster below names the functions the path actually runs
//! through, and the count is over their bodies.
//!
//! What this does NOT do is decide the design question. Whether the chain
//! should be a chain at all is open, and reopening it means measuring
//! against the tradeoffs document above, not against this ceiling.

use std::path::{Path, PathBuf};

use ironhorse_vm::source_scan;

/// The functions an ordinary `GET_PROPERTY` runs through before a plain
/// object's own-property lookup answers, innermost last.
///
/// This is the maintained part. A probe added to any of these is counted; a
/// probe added to a function that is on the path but NOT named here is not,
/// so adding a hop means adding it here. The `fn` markers are resolved by
/// name and a rename fails loudly rather than silently counting zero.
const PROPERTY_READ_PATH: &[(&str, &str)] = &[
    (
        "interp/dispatch/property_read.rs",
        "fn dispatch_get_property",
    ),
    ("interp/property.rs", "fn mop_get"),
    ("interp/property.rs", "fn mop_get_with_proxy_metering"),
    ("interp/property.rs", "fn mop_get_with_proxy_metering_inner"),
    ("interp/property.rs", "fn exotic_own_descriptor"),
    ("interp/property/ordinary.rs", "fn ordinary_get"),
    (
        "interp/property/ordinary.rs",
        "fn ordinary_get_own_descriptor",
    ),
];

/// The most side-table membership probes that path may make.
///
/// Set EQUAL to the measured count, not above it: a ceiling with headroom
/// lets the chain grow silently up to it. The point of the number is
/// that adding a probe is a decision someone makes on purpose, with this
/// comment in front of them. Raising it is allowed; raising it silently is
/// not.
const MAX_PROPERTY_READ_PROBES: usize = 27;

/// And for the call path, which F119 names in the same breath.
///
/// **What this number is.** Every `self.<table>.contains_key(` /
/// `.get(&` against the four callee-class tables, anywhere in the dispatch
/// loop — the SURFACE those probes occupy, not the chain length one call
/// walks. The call path lives inside the opcode match rather than in a
/// function of its own, so it cannot be isolated the way the property-read
/// path can, and a number that claimed to be the per-call chain would be
/// claiming more than the scan can see.
///
/// The surface is still the right proxy for F119's second recommendation —
/// make the callee-class probes lazy so a plain user-function call pays at
/// most one lookup — because that recommendation is about all of them.
///
/// The first version summed bare `code.matches("self.functions")` and
/// friends: sixteen occurrences, of which four were the callee chain, four
/// were WRITES (`update`, `update_or_default`), two were other opcodes'
/// guards and five were unrelated paths. It called that "the size of the
/// thing that recommendation is about", and an unrelated `update` in a
/// 3,700-line file would have tripped a gate whose message is about calls.
const MAX_CALLEE_PROBES: usize = 12;

/// The callee-class tables F119 names, so unrelated growth in the dispatch
/// loop does not trip a gate about calls.
const CALLEE_TABLES: &[&str] = &[
    "functions",
    "bound_functions",
    "promise_functions",
    "proxies",
];

fn vm_src() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("src")
}

/// A file with comments blanked AND string literals blanked.
///
/// `source_scan::code_only` blanks comments and raw strings but keeps an
/// ordinary literal verbatim, by design — it is the input to scanners that
/// need to read literals. A probe named in an error message is not a probe,
/// so the literals go too, through the same `literal_end` rule the rest of
/// the module uses, and the number then means what it says.
fn scannable(path: &Path) -> String {
    let code = source_scan::code_only(&std::fs::read_to_string(path).expect("readable"));
    let mut out = String::with_capacity(code.len());
    let mut i = 0;
    while i < code.len() {
        if let Some(end) = source_scan::literal_end(&code, i) {
            out.extend(
                code[i..end]
                    .chars()
                    .map(|c| if c == '\n' { '\n' } else { ' ' }),
            );
            i = end;
        } else {
            let c = code[i..].chars().next().expect("in bounds");
            out.push(c);
            i += c.len_utf8();
        }
    }
    out
}

/// The side table named by every `self.<table>.contains_key(` and
/// `self.<table>.get(&` in `code` — one entry per membership probe.
///
/// Token-based rather than textual: `tokens` treats a string literal as one
/// token, so nothing inside one can match, and `self.arrays.contains_key(`
/// is found whatever the field name is. The first version searched for
/// `self.` and then required the next `.` to begin the method call, which
/// works, and an earlier version of THAT let `.` into the identifier and so
/// matched nothing at all — the gate counted zero probes and was vacuous.
fn probes(code: &str, tables: Option<&[&str]>) -> Vec<String> {
    let tokens = source_scan::tokens(code);
    let mut found = Vec::new();
    for at in 0..tokens.len().saturating_sub(5) {
        let (this, dot1, table, dot2, method, open) = (
            &tokens[at],
            &tokens[at + 1],
            &tokens[at + 2],
            &tokens[at + 3],
            &tokens[at + 4],
            &tokens[at + 5],
        );
        if this.text != "self" || dot1.text != "." || dot2.text != "." || open.text != "(" {
            continue;
        }
        let is_probe = match method.text {
            "contains_key" => true,
            // `.get(&k)` is a probe; `.get(index)` on a `Vec` is not, and the
            // `&` is what tells them apart in this codebase.
            "get" => tokens.get(at + 6).is_some_and(|next| next.text == "&"),
            _ => false,
        };
        if !is_probe {
            continue;
        }
        if tables.is_some_and(|wanted| !wanted.contains(&table.text)) {
            continue;
        }
        found.push(table.text.to_string());
    }
    found
}

/// The body of `marker` in `path`, comments and literals blanked.
fn body(path: &Path, marker: &str) -> String {
    let code = scannable(path);
    let tokens = source_scan::tokens(&code);
    let range = source_scan::token_body(&tokens, marker);
    code[tokens[range.start].start..tokens[range.end - 1].start + 1].to_string()
}

fn property_read_probes() -> Vec<(&'static str, Vec<String>)> {
    PROPERTY_READ_PATH
        .iter()
        .map(|(file, marker)| {
            let path = vm_src().join(file);
            assert!(
                path.is_file(),
                "{} moved; this gate follows the path, so bring it along",
                path.display()
            );
            (*marker, probes(&body(&path, marker), None))
        })
        .collect()
}

#[test]
fn the_property_read_probe_chain_has_a_ceiling() {
    let per_function = property_read_probes();
    let total: usize = per_function.iter().map(|(_, p)| p.len()).sum();
    assert!(
        total > 0,
        "no side-table probes found on the property-read path: the scan is \
         broken, not the code"
    );
    assert!(
        total <= MAX_PROPERTY_READ_PROBES,
        "the property-read path now makes {total} side-table probes, above \
         the ceiling of {MAX_PROPERTY_READ_PROBES}. Every one of them is paid \
         by every ordinary property read, which is F119's impact clause. \
         Raising the ceiling is a decision; make it on purpose, and read \
         architecture-review/2026-09-06/PERFORMANCE-TRADEOFFS.md before \
         reaching for a classification index instead — that was tried and \
         measured slower.\n{}",
        per_function
            .iter()
            .map(|(marker, p)| format!("  {marker}: {}", p.len()))
            .collect::<Vec<_>>()
            .join("\n")
    );
}

/// Every function on the roster must still resolve, and enough of them must
/// still probe for the total to mean anything.
///
/// Resolution is the load-bearing half and `token_body` supplies it: a
/// renamed or deleted hop fails its uniqueness assertion rather than quietly
/// contributing zero, so the roster cannot drift away from the code while
/// the total stands still.
///
/// A hop may legitimately probe nothing — `mop_get` is a forwarder that
/// tests one field and delegates — so this does not demand a probe per hop.
/// It demands that the path is not ALL forwarders, which is what a
/// silently-relocated chain would look like from here.
#[test]
fn every_hop_on_the_roster_is_real() {
    let per_function = property_read_probes();
    assert_eq!(
        per_function.len(),
        PROPERTY_READ_PATH.len(),
        "a hop on the roster did not resolve"
    );
    let probing = per_function.iter().filter(|(_, p)| !p.is_empty()).count();
    assert!(
        probing >= 3,
        "only {probing} of {} hops on the property-read roster probe a side \
         table at all. Either the chain moved somewhere the roster does not \
         name, or the scan is broken.\n{}",
        per_function.len(),
        per_function
            .iter()
            .map(|(marker, p)| format!("  {marker}: {}", p.len()))
            .collect::<Vec<_>>()
            .join("\n")
    );
}

#[test]
fn the_callee_probe_chain_has_a_ceiling() {
    // The call path lives in the dispatch loop's opcode match rather than
    // its own function, so this is the file, restricted to the four tables.
    let path = vm_src().join("interp/dispatch.rs");
    assert!(path.is_file(), "{} moved", path.display());
    let found = probes(&scannable(&path), Some(CALLEE_TABLES));
    assert!(
        !found.is_empty(),
        "no callee-class probes found: the scan is broken, not the code"
    );
    assert!(
        found.len() <= MAX_CALLEE_PROBES,
        "the dispatch loop now makes {} callee-class probes ({found:?}), \
         above the ceiling of {MAX_CALLEE_PROBES}. F119's second \
         recommendation is to make these lazy so a plain user-function call \
         pays at most one lookup; growing them instead is the opposite.",
        found.len()
    );
}

/// Both ceilings must be tight enough to bind. A ceiling set above the real
/// count is a number that can never fire, which is the failure mode this
/// whole review keeps finding — and the previous version of this file
/// checked only the property-read one, leaving the callee ceiling a `<=`
/// with unmeasured headroom under a doc comment that said "the ceilings".
#[test]
fn the_ceilings_are_equal_to_the_real_counts() {
    let reads: usize = property_read_probes().iter().map(|(_, p)| p.len()).sum();
    assert_eq!(
        reads, MAX_PROPERTY_READ_PROBES,
        "the property-read ceiling is {MAX_PROPERTY_READ_PROBES} and the real \
         count is {reads}. These are meant to be equal: a ceiling with \
         headroom lets the chain grow silently up to it, which is the \
         behaviour the gate exists to stop. If the count went DOWN, bring the \
         ceiling down with it and keep the win."
    );
    let callees = probes(
        &scannable(&vm_src().join("interp/dispatch.rs")),
        Some(CALLEE_TABLES),
    );
    assert_eq!(
        callees.len(),
        MAX_CALLEE_PROBES,
        "the callee ceiling is {MAX_CALLEE_PROBES} and the real count is {} \
         ({callees:?}); same rule as above.",
        callees.len()
    );
    eprintln!(
        "F119 probe chain: property-read={reads} callee={}",
        callees.len()
    );
}
