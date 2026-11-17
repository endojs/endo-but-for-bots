//! The converted corpus, run as crank **sequences** rather than as 1,712
//! independent single-crank programs.
//!
//! `dual_run_cranks` is the harness's only window onto cross-crank semantics,
//! and the wave-6 retrospective identified the single-crank oracle as the
//! structural cause of a whole family of missed defects. The response was
//! eleven hand-written scenarios in `multi_crank_oracle.rs`. Hand-written
//! scenarios are cases; the single-crank path has a generator, this corpus and
//! a libFuzzer lane, and multi-crank coverage did not scale with any of them.
//!
//! This file closes the corpus half: every converted case is run again, this
//! time as one crank of a sequence on a machine that has already run other
//! cases. The generated half is `ironhorse-fuzz`'s `differential_cranks`
//! target, which folds fuzzer bytes into a sequence.
//!
//! What it can and cannot see. Both engines run the *same* sequence, so a
//! case that throws because an earlier case in its window left the machine in
//! an awkward state throws on both, and the differential still holds — the
//! run simply stops there, which `dual_run_cranks` reports rather than hides.
//! What the sequencing adds is every observation a later crank makes of state
//! an earlier one created: interned names, global bindings, prototype
//! mutations, retained function and closure bytecode.

use std::path::PathBuf;

use ironhorse_262::test262::collect_js;
use ironhorse_262::{dual_run_cranks, Agreement};

/// The generated case tree, checked in beside the crate.
fn cases_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../packages/test262-runner/test262/test/ironhorse")
}

/// Cranks per machine. Long enough that later cranks genuinely observe
/// earlier ones, short enough that one aborting case does not silence a
/// large tail of the corpus (the run stops at the first crank either engine
/// fails to complete).
const WINDOW: usize = 8;

/// How many completing cases precede an aborting case in pass 3, so the
/// abort lands on a machine that has already run other work rather than on
/// a fresh one.
const PREFIX: usize = 3;

/// Every case is `flags: [raw]`, so the file *is* the program — the
/// frontmatter is a legal JavaScript comment and rides along.
#[test]
fn the_converted_corpus_agrees_crank_by_crank() {
    let cases = cases_dir();
    assert!(
        cases.is_dir(),
        "generated test/ironhorse/ tree must be checked in at {}",
        cases.display()
    );

    // The fuzz-trophies regression tree legitimately carries parse-negative
    // cases, which stop a sequence at their crank and would mask everything
    // behind them. `regressions_dual_run.rs` gates that tree on its own.
    let mut files: Vec<PathBuf> = collect_js(&cases)
        .into_iter()
        .filter(|p| !p.components().any(|c| c.as_os_str() == "regressions"))
        .collect();
    files.sort();
    assert!(
        !files.is_empty(),
        "test/ironhorse/ tree must contain generated cases"
    );

    let sources: Vec<String> = files
        .iter()
        .map(|p| std::fs::read_to_string(p).expect("a checked-in case is readable"))
        .collect();

    let mut sequences = 0usize;
    let mut cranks_compared = 0usize;
    let mut later_cranks = 0usize;

    // Compare one sequence's runs, crediting every crank past the first as
    // cross-crank coverage. Returns how many cranks the oracle actually ran,
    // which is not always the whole window: `dual_run_cranks` stops at the
    // first crank either engine fails to complete.
    let mut check = |window: &[usize], sources: &[String]| -> usize {
        let borrowed: Vec<&str> = window.iter().map(|i| sources[*i].as_str()).collect();
        let Some(runs) = dual_run_cranks(&borrowed) else {
            // The oracle machine failed to start: a harness condition, not
            // a divergence, and not something to report as a pass.
            panic!("the XS oracle machine must start");
        };
        sequences += 1;
        for (position, run) in runs.iter().enumerate() {
            cranks_compared += 1;
            if position > 0 {
                later_cranks += 1;
            }
            let where_ = files[window[position]].display().to_string();
            match run.agreement {
                Agreement::BothComplete => assert!(
                    run.result_agrees,
                    "crank {position} ({where_}) completed on both engines \
                     with different results: oracle {:?} against ironhorse {:?}",
                    run.oracle_result, run.ironhorse_result
                ),
                Agreement::BothAbort => assert!(
                    run.error_agrees,
                    "crank {position} ({where_}) aborted on both engines with \
                     different thrown values: oracle {:?} against ironhorse \
                     {:?} ({:?})",
                    run.oracle_error, run.ironhorse_error, run.ironhorse_halt
                ),
                Agreement::IronhorseOnlyComplete => panic!(
                    "crank {position} ({where_}): ironhorse completed a crank \
                     the oracle aborted with {:?}",
                    run.oracle_error
                ),
                Agreement::OracleOnlyComplete => panic!(
                    "crank {position} ({where_}): ironhorse aborted with {:?} \
                     a crank the oracle completed as {:?}",
                    run.ironhorse_halt, run.oracle_result
                ),
            }
        }
        runs.len()
    };

    // Pass 1 — classify. `dual_run_cranks` stops a sequence at the first
    // crank either engine fails to complete, and a large part of this corpus
    // aborts BY DESIGN (a case whose subject is a `TypeError` is a case that
    // throws). Feeding the corpus in file order therefore truncated nearly
    // every window at its second or third crank: measured over the whole
    // tree, sequences averaged 1.83 cranks against a window of 8, which is
    // the single-crank oracle wearing a sequence's clothes.
    //
    // So learn which cases complete before building sequences out of them.
    // One single-crank run each, which is what the sibling
    // `corpus_conversion_equivalence` test already pays for.
    let mut completes = Vec::new();
    let mut aborts = Vec::new();
    for index in 0..files.len() {
        let borrowed = [sources[index].as_str()];
        let runs = dual_run_cranks(&borrowed).expect("the XS oracle machine must start");
        match runs.first().map(|r| r.agreement) {
            Some(Agreement::BothComplete) => completes.push(index),
            _ => aborts.push(index),
        }
    }
    assert!(
        !completes.is_empty(),
        "no case in the corpus completes on both engines"
    );

    // Pass 2 — the completing cases in full-length windows. These run to the
    // end of the window, so this is where the cross-crank observation
    // actually happens.
    for window in completes.chunks(WINDOW) {
        let ran = check(window, &sources);
        assert_eq!(
            ran,
            window.len(),
            "a window of cases that each complete alone stopped early at \
             crank {ran} ({}). Either this is a genuine cross-crank finding — \
             a case that completes alone and not after its predecessors — or \
             two cases in this window declare the same top-level `let`, \
             `const` or `class` name, which is a shared `SyntaxError` on one \
             realm and says nothing about either engine. Read the case before \
             believing the first reading.",
            files[window[ran.min(window.len() - 1)]].display()
        );
    }

    // Pass 3 — every aborting case, still compared, and still compared in a
    // LATER position: each rides behind a short prefix of completing cases,
    // so the machine it aborts on is one that has already run other work.
    // The sequence stops at the aborting case, which is the last crank, so
    // nothing is lost behind it.
    let prefix_len = PREFIX.min(completes.len());
    for (nth, index) in aborts.iter().enumerate() {
        let start = (nth * prefix_len) % completes.len();
        let mut window: Vec<usize> = (0..prefix_len)
            .map(|k| completes[(start + k) % completes.len()])
            .collect();
        window.push(*index);
        let ran = check(&window, &sources);
        assert_eq!(
            ran,
            window.len(),
            "an aborting case did not reach its own crank: the prefix stopped \
             the sequence first"
        );
    }

    eprintln!(
        "corpus multi-crank: cases={} completes={} aborts={} sequences={sequences} \
         cranks_compared={cranks_compared} later_cranks={later_cranks}",
        files.len(),
        completes.len(),
        aborts.len()
    );

    // Where the real gate is, so nobody mistakes the arithmetic below for
    // it. The load-bearing assertion is `assert_eq!(ran, window.len())` at
    // each `check` call site: the collapse worth fearing — every sequence
    // stopping at its first crank — trips THAT, with a message that names
    // the case it stopped on. The three lines here are accounting: they
    // prove each pass compared what it was handed, and they are forced by
    // the per-window equality rather than independent of it.
    assert_eq!(completes.len() + aborts.len(), files.len());
    assert_eq!(
        cranks_compared,
        completes.len() + aborts.len() * (prefix_len + 1),
        "a pass did not compare what it was given"
    );
    assert!(
        later_cranks > 0,
        "no crank ran in a later position, so this is the single-crank \
         oracle with extra steps"
    );
}
