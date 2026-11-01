//! Long greedy runs, dual-run against the pinned XS oracle.
//!
//! Regression: a greedy loop saves one backtrack state per matched position,
//! and the matcher refused the 65,537th state, so `/a*/` over 65,536 `a`s
//! halted the whole machine with `HeapExhausted` where XS (whose state stack
//! is unbounded) completes. Every generated
//! `built-ins/RegExp/property-escapes` test262 case matches `^\p{…}+$` over a
//! string of up to a million code points and was recorded as
//! `ironhorse-aborted-limit`. The matcher now compresses consecutive states
//! that differ only in their offset, so these runs fit, while the backtracking
//! they allow, and assertions that discard states, still see every position.

use ironhorse_262::{dual_run, Agreement};

fn assert_result_agrees(source: &str) {
    let dr = dual_run(source).expect("the XS oracle machine must start");
    assert_eq!(
        dr.agreement,
        Agreement::BothComplete,
        "`{source}` must complete on both engines (ironhorse halt: {:?}; oracle={:?} ironhorse={:?})",
        dr.ironhorse_halt,
        dr.oracle_result,
        dr.ironhorse_result,
    );
    assert!(
        dr.result_agrees,
        "`{source}` result divergence: oracle={:?} ironhorse={:?}",
        dr.oracle_result, dr.ironhorse_result,
    );
}

#[test]
fn a_greedy_run_past_sixty_four_ki_positions_matches() {
    assert_result_agrees(r#"/a*/.exec("a".repeat(100000))[0].length"#);
    assert_result_agrees(r#"/^a+$/.test("a".repeat(100000))"#);
    assert_result_agrees(r#""x".repeat(100000).replace(/x+$/, "").length"#);
    assert_result_agrees(r#"/^(.*)$/.exec("y".repeat(100000))[1].length"#);
}

#[test]
fn a_long_run_backtracks_through_every_position() {
    // Each needs the run to give back characters one at a time.
    assert_result_agrees(r#"/^(a*)aaa$/.exec("a".repeat(100000))[1].length"#);
    assert_result_agrees(r#"/^(a*)b/.exec("a".repeat(70000) + "b")[1].length"#);
    assert_result_agrees(r#"/^a*b/.test("a".repeat(70000))"#);
    assert_result_agrees(r#"/^(a*?)a{70000}$/.exec("a".repeat(70003))[1].length"#);
}

#[test]
fn assertions_discard_part_of_a_compressed_run() {
    // A lookahead's completion truncates the states it saved, which here sit
    // in the same compressed record as states saved before it.
    assert_result_agrees(r#"/^a*(?=a*b)ab/.exec("a".repeat(70000) + "b")[0].length"#);
    assert_result_agrees(r#"/^(?:a(?=a?))*$/.test("a".repeat(70000))"#);
    assert_result_agrees(r#"/(?!a*b)a+/.exec("a".repeat(70000) + "c")[0].length"#);
}

#[test]
fn unicode_property_runs_over_astral_strings_match() {
    assert_result_agrees(r#"/^\p{L}+$/u.test("\u{20000}\u{2A6DF}".repeat(40000))"#);
    assert_result_agrees(r#"/^\P{ASCII}+$/u.test("\u{10000}\u00e9".repeat(40000))"#);
    assert_result_agrees(r#"/^\p{L}+$/u.test("\u{20000}".repeat(70000) + "1")"#);
}
