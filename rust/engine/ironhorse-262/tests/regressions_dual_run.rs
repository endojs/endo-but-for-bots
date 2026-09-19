//! The fuzz-trophies regression gate (design
//! [`designs/ironhorse-test262-convergence.md`] § Part 1, "The fuzz-grammar
//! arms").
//!
//! `test/ironhorse/regressions/` is the durable, portable home for differential-fuzz
//! trophies: each minimized, fixed source divergence is checked in as a
//! test262-style case (features `ironhorse-dual-run`, the fuzz arm named in
//! `info:`), so a finding becomes a regression test rather than a line in a
//! stage corpus. This test runs that tree through the same `endot-ih`
//! machinery a nightly run uses and holds it to the one bar a regression case
//! must always meet: **zero divergence**. A case may still be a *named* skip
//! (a parse-phase negative waits on the `ironhorse-compile` default flip, exactly
//! as the converted corpus does — see `test/ironhorse/regressions/README.md`), but it
//! must never fail the runner's verdict/observable agreement. The moment a
//! future fix regresses, its checked-in trophy fails here.
//!
//! This is intentionally separate from `corpus_conversion_equivalence`: that
//! test proves the corpus -> shared-test-tree conversion preserved coverage (and so
//! asserts every corpus case is *covered* end-to-end); regressions are not
//! corpus and legitimately carry parse-negative named skips, so they are held
//! only to the no-divergence bar here and are excluded there.

use ironhorse_262::test262::{collect_js, locate_test262};
use ironhorse_262::xst::{run_files, Config};
use std::path::PathBuf;

/// The checked-in fuzz-trophies regression tree.
fn regressions_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../packages/test262-runner/test262/test/ironhorse")
        .join("regressions")
}

#[test]
fn regression_cases_never_diverge() {
    let dir = regressions_dir();
    assert!(
        dir.is_dir(),
        "the fuzz-trophies regression tree must exist at {}",
        dir.display()
    );

    let (root, harness) = match locate_test262() {
        Some(p) => p,
        None => {
            eprintln!("test262 subset absent; skipping the fuzz-trophies regression gate");
            return;
        }
    };

    let files = collect_js(&dir);
    // The tree is SPARSE, not empty, and the difference is load-bearing.
    // Source-expressible fuzz trophies are rare — most findings fold into the
    // stage corpus, and decoder/bytecode trophies live as Rust regression
    // tests in `ironhorse-fuzz`; see the README. But this gate used to return
    // early on an empty tree while its own comment claimed it was "always
    // wired", so deleting or renaming the one checked-in case would have left
    // it reporting green having dual-run nothing.
    //
    // That is the shape of three separate incidents on this branch (a vacuous
    // carry fixture, a `#[test]` a merge nested out of collection, and a suite
    // that skipped itself on a missing build artifact), so it is asserted
    // rather than commented. Emptying the tree deliberately means changing
    // this line deliberately, which is the same discipline every other pin
    // here uses.
    assert!(
        !files.is_empty(),
        "no cases under {} — this gate cannot dual-run anything, and a silent \
         pass is exactly what it exists to prevent. If the tree is meant to be \
         empty, retire this assertion in the same commit that empties it.",
        dir.display()
    );

    // Gate meter-exact where a trophy carries the tag; a trophy is not required
    // to, but if it does its historical computron evidence is held.
    let cfg = Config {
        gate_meter_exact: true,
        ..Config::default()
    };
    let rep = run_files(&cfg, &harness, &root, &files);

    eprintln!(
        "fuzz-trophies regressions: total={} covered={} failed={} skipped={} advisory-computron-gap={}",
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

    assert_eq!(
        rep.total,
        files.len(),
        "every checked-in regression case must run exactly once"
    );

    // The one bar a regression case must always meet: no divergence. Named
    // skips (parse-negative pending the compiler flip) are permitted; a
    // verdict/observable disagreement is not.
    assert!(
        rep.met_bar() && rep.failures.is_empty(),
        "a checked-in fuzz trophy diverged from the oracle: {} failure(s)",
        rep.failures.len(),
    );
}
