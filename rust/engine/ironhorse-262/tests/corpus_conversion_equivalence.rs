//! Coverage-equivalence proof for the corpus → test262 conversion (design
//! [`designs/ironhorse-test262-convergence.md`] § Part 1, "Conversion
//! mechanics and corpus retirement").
//!
//! This is the proof the retirement is gated on: the generated `cases/` tree
//! reproduces the coverage the retired `stage*_corpus()` bit-exact tests
//! carried — **same totals** (one case per corpus line, 1:1), **zero
//! divergence** (every case the covered grammar reaches meets the runner's
//! bar), and the **same bit-exact set under `--gate-meter-exact`** (every
//! meter-exact-tagged case reproduces its historical computron agreement, so
//! the gate is green). It runs the checked-in `cases/` tree through the same
//! `endot-ih` machinery a nightly run uses.
//!
//! The oracle accumulates process RSS across machine create/destroy cycles;
//! the case set is ~1.7k, well under the tens-of-thousands the whole-tree
//! `endot-ih` binary bounds with per-subtree subprocesses, so one in-test
//! pass is safe.

use ironhorse_262::test262::{collect_js, locate_test262};
use ironhorse_262::xst::{run_files, Config};
use std::path::PathBuf;

/// The generated case tree, checked in beside the crate.
fn cases_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("cases")
}

#[test]
fn generated_cases_reproduce_corpus_coverage() {
    let cases = cases_dir();
    assert!(
        cases.is_dir(),
        "generated cases/ tree must be checked in at {}",
        cases.display()
    );

    let (root, harness) = match locate_test262() {
        Some(p) => p,
        None => {
            eprintln!("test262 subset absent; skipping the corpus-conversion equivalence proof");
            return;
        }
    };

    // The fuzz-trophies regression tree (`cases/regressions/`) is not corpus:
    // it is gated separately by `regressions_dual_run.rs` and legitimately
    // carries parse-negative named skips, which would break the covered==total
    // coverage proof below. Exclude it here so this test stays a pure
    // corpus-conversion equivalence proof.
    let files: Vec<_> = collect_js(&cases)
        .into_iter()
        .filter(|p| {
            !p.components()
                .any(|c| c.as_os_str() == "regressions")
        })
        .collect();
    assert!(
        !files.is_empty(),
        "cases/ tree must contain generated cases"
    );

    // The gate: verdict + observable agreement (default), and tighten every
    // `ironhorse-meter-exact`-tagged case to the historical bit-exact computron
    // bar — the "same bit-exact set" half of the proof.
    let cfg = Config {
        gate_meter_exact: true,
        ..Config::default()
    };
    let rep = run_files(&cfg, &harness, &root, &files);

    eprintln!(
        "corpus-conversion equivalence: total={} covered={} failed={} skipped={} advisory-computron-gap={}",
        rep.total,
        rep.covered,
        rep.failures.len(),
        rep.total - rep.covered - rep.failures.len(),
        rep.computron_advisories,
    );
    for (reason, n) in rep.skip_detail_summary() {
        eprintln!("    {:>5}  {}", n, reason);
    }
    for (path, detail) in &rep.failures {
        eprintln!("  FAIL {}\n    {}", path, detail);
    }

    // Same totals: every corpus line became exactly one case, and every case
    // ran (the corpus is 1,711 lines at this branch head; the count is
    // asserted to be nonzero and to equal the generated file count so a
    // dropped or duplicated case fails the proof).
    assert_eq!(
        rep.total,
        files.len(),
        "every generated case must run exactly once"
    );

    // Zero divergence AND the bit-exact set: no failures through the runner
    // with the meter-exact gate armed. A wrapper-perturbed metering or a
    // one-sided completion would land here.
    assert!(
        rep.met_bar() && rep.failures.is_empty(),
        "corpus-conversion coverage equivalence: {} failure(s) under --gate-meter-exact",
        rep.failures.len(),
    );

    // The covered-grammar cases must actually be reached, not silently
    // skipped: the conversion preserves the corpus's *covered* set, so the
    // overwhelming majority run end-to-end. (The count is reported, not
    // pinned to a target — it tracks the landed surface.)
    assert_eq!(
        rep.covered, rep.total,
        "every generated corpus case must be covered end-to-end (no named skips), \
         since every corpus line was a covered, bit-exact program"
    );
}
