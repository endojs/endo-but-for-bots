//! Whole-corpus scope smoke (stage-5 child 4 robustness bar).
//!
//! The scoper runs its two passes (hoist + bind) over every
//! conformance-corpus program the parser accepts, asserting it never
//! panics and returns cleanly (either a scope tree or a classified early
//! error). This mirrors the parser child's parse-smoke: the coder child
//! and the eventual fuzz target lean on the scoper being total over the
//! parser's output, so a panic here is a defect. It does **not** compare
//! scope shapes against an oracle (XS exposes no scope dump); the
//! shape/numbering contract is pinned by the unit fixtures in
//! `src/scoper/tests.rs`.
//!
//! The corpus programs are the curated corpus lines, now carried verbatim
//! in the `info: Source:` frontmatter of the shared `test/ironhorse/` tree (the
//! `corpora/*.js` line files retired in PR #600 convergence 2/5).

mod corpus_cases;
use corpus_cases::{corpus_programs, CORPUS_PROGRAM_COUNT};

/// True if the parser accepts `src` as a Script (the scoper only runs on
/// parser-accepted programs).
fn parses(src: &str) -> bool {
    match ironhorse_compile::Parser::new(src, false, false) {
        Ok(mut p) => p.parse_program(false).is_ok(),
        Err(_) => false,
    }
}

#[test]
fn corpus_scope_smoke() {
    let programs = corpus_programs();
    assert_eq!(
        programs.len(),
        CORPUS_PROGRAM_COUNT,
        "expected {CORPUS_PROGRAM_COUNT} corpus programs in test/ironhorse, found {}",
        programs.len()
    );

    let mut scoped = 0usize;
    let mut early_errors = 0usize;
    for (_id, program) in &programs {
        let line = program.as_str();
        if !parses(line) {
            continue;
        }
        // A panic here fails the test (the point of the smoke).
        match ironhorse_compile::scope_program(line, false) {
            Ok(_) => scoped += 1,
            Err(_) => early_errors += 1,
        }
    }
    eprintln!(
        "corpus scope smoke: {} programs, {scoped} scoped, {early_errors} early errors",
        programs.len()
    );
    assert!(scoped > 0, "expected to scope at least one corpus program");
}
