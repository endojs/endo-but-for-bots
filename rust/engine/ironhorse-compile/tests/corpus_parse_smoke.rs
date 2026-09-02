//! Whole-corpus parse smoke (stage-5 child 3 local bar).
//!
//! Every conformance-corpus program — the curated corpus lines, now carried
//! verbatim in the `info: Source:` frontmatter of the shared `test/ironhorse/`
//! tree (the `corpora/*.js` line files retired in PR #600 convergence 2/5) —
//! is parsed by the `ironhorse-compile` parser **as a Script** and its
//! accept/reject verdict compared against the XS oracle
//! (`xs_oracle::run`). Two things are asserted:
//!
//!   * **Zero panics.** Every program yields a `Result`, never a panic — the
//!     invariant the parser fuzz target (a later child) depends on.
//!   * **Accept/reject agreement.** Every program the oracle *parses* (did
//!     not reject with a `SyntaxError`) the ironhorse parser must parse too.
//!     Mismatches are named, not hidden.
//!
//! Byte-identity of the emitted tree is out of scope here — that is the
//! coder child's bar. This test certifies only that the parse surface is
//! complete enough to accept the whole corpus without panicking.

use ironhorse_compile::parser::Parser;

mod corpus_cases;
use corpus_cases::{corpus_programs, CORPUS_PROGRAM_COUNT};

/// Whether the ironhorse parser accepts `src` as a Script (sloppy top level;
/// a `"use strict"` prologue upgrades from within).
fn ironhorse_accepts(src: &str) -> bool {
    match Parser::new(src, false, false) {
        Ok(mut p) => p.parse_program(false).is_ok(),
        // A lexer error before the first token is a rejection, not a panic.
        Err(_) => false,
    }
}

/// Whether the XS oracle *parsed* `src` (as opposed to rejecting it with
/// a `SyntaxError`). A runtime throw still counts as "parsed".
fn oracle_parses(src: &str) -> Option<bool> {
    let outcome = xs_oracle::run(src)?;
    if outcome.completed {
        return Some(true);
    }
    // A parse rejection surfaces as an uncompleted run whose error is a
    // SyntaxError; any other error is a runtime throw of a parsed program.
    Some(!outcome.error.contains("SyntaxError"))
}

#[test]
fn corpus_parse_smoke() {
    let programs = corpus_programs();
    assert_eq!(
        programs.len(),
        CORPUS_PROGRAM_COUNT,
        "expected {CORPUS_PROGRAM_COUNT} corpus programs in test/ironhorse, found {}",
        programs.len()
    );

    let mut total = 0usize;
    let mut agree_accept = 0usize;
    let mut agree_reject = 0usize;
    let mut oracle_unavailable = 0usize;
    // The consequential disagreement: the oracle parsed it but we did not.
    let mut ironhorse_rejected_oracle_accepted: Vec<(String, String)> = Vec::new();
    // The benign direction (we accept, oracle rejects) — recorded, not fatal.
    let mut ironhorse_accepted_oracle_rejected: Vec<(String, String)> = Vec::new();

    for (id, program) in &programs {
        let line = program.as_str();
        let oracle = match oracle_parses(line) {
            Some(v) => v,
            None => {
                oracle_unavailable += 1;
                continue;
            }
        };
        total += 1;
        let mine = ironhorse_accepts(line);
        match (mine, oracle) {
            (true, true) => agree_accept += 1,
            (false, false) => agree_reject += 1,
            (false, true) => {
                ironhorse_rejected_oracle_accepted.push((id.clone(), line.to_string()))
            }
            (true, false) => {
                ironhorse_accepted_oracle_rejected.push((id.clone(), line.to_string()))
            }
        }
    }

    // The named tally.
    eprintln!(
        "corpus parse smoke: {} programs, {total} oracle-compared",
        programs.len()
    );
    eprintln!("  agree/accept : {agree_accept}");
    eprintln!("  agree/reject : {agree_reject}");
    eprintln!(
        "  ironhorse-rejected / oracle-accepted : {}",
        ironhorse_rejected_oracle_accepted.len()
    );
    eprintln!(
        "  ironhorse-accepted / oracle-rejected : {}",
        ironhorse_accepted_oracle_rejected.len()
    );
    if oracle_unavailable > 0 {
        eprintln!("  (oracle unavailable on {oracle_unavailable} programs, skipped)");
    }
    for (id, l) in &ironhorse_accepted_oracle_rejected {
        eprintln!("  ~ ironhorse-only accept [{id}]: {l}");
    }
    for (id, l) in &ironhorse_rejected_oracle_accepted {
        eprintln!("  ! ironhorse rejected an oracle-accepted program [{id}]: {l}");
    }

    assert!(
        ironhorse_rejected_oracle_accepted.is_empty(),
        "{} corpus program(s) the oracle parses were rejected by the ironhorse parser (see above)",
        ironhorse_rejected_oracle_accepted.len()
    );
    assert!(
        agree_accept > 0,
        "expected the corpus to contain accepted programs"
    );
}
