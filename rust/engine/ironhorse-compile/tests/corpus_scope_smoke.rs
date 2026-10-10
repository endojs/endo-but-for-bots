//! Whole-corpus scope smoke (stage-5 child 4 robustness bar).
//!
//! The scoper runs its two passes (hoist + bind) over every
//! curated conformance-corpus program, asserting every source parses and
//! scopes successfully. The corpus currently has no expected early errors;
//! a new parser or scoper rejection must fail this gate.
//! The coder and fuzz target lean on the scoper being total over the
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
    let mut early_errors = Vec::new();
    for (id, program) in &programs {
        let line = program.as_str();
        // A panic here fails the test (the point of the smoke).
        match ironhorse_compile::scope_program(line, false) {
            Ok(_) => scoped += 1,
            Err(error) => early_errors.push(format!("{id}: {error}")),
        }
    }
    eprintln!(
        "corpus scope smoke: {} programs, {scoped} scoped, {} early errors",
        programs.len(),
        early_errors.len()
    );
    assert!(
        early_errors.is_empty(),
        "corpus over-rejections: {early_errors:#?}"
    );
    assert_eq!(scoped, CORPUS_PROGRAM_COUNT);
}
