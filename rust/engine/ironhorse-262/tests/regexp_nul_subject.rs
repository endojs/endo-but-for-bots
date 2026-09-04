//! RegExp subjects and captures containing U+0000, dual-run against the
//! pinned XS oracle.
//!
//! Regression: the matcher walks a NUL-terminated byte string exactly as XS
//! does, but the VM handed it standard UTF-8 in which an embedded U+0000 is
//! a bare NUL byte — the walk stopped there, so `/^\D$/.test("\u0000")` was
//! false and the generated `CharacterClassEscapes/*-positive-cases.js`
//! official tests fell into their million-iteration per-character diagnosis
//! loop (recorded as ironhorse-hang in the full-sweep report). XS stores an
//! embedded U+0000 as the overlong pair `C0 80` (modified UTF-8); the VM now
//! spells the subject the same way at the matcher boundary and inverts the
//! spelling on matched slices and the reported match index.

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
fn nul_is_matched_by_non_digit_classes() {
    assert_result_agrees(r#"/^\D$/.test("\u0000")"#);
    assert_result_agrees(r#"/^\D+$/.test("\u0000\u0000")"#);
    assert_result_agrees(r#"/^\S$/.test("\u0000")"#);
    assert_result_agrees(r#"/^\W$/.test("\u0000")"#);
    assert_result_agrees(r#"/^\D$/u.test("\u0000")"#);
    assert_result_agrees(r#"/^\D$/v.test("\u0000")"#);
}

#[test]
fn match_index_after_embedded_nul_counts_code_units() {
    assert_result_agrees(r#"/b/.exec("a\u0000b").index"#);
    assert_result_agrees(r#"/b/.exec("\u0000\u0000b").index"#);
    assert_result_agrees(r#""a\u0000b".search(/b/)"#);
}

#[test]
fn captured_nul_round_trips() {
    assert_result_agrees(r#"/a(.)b/.exec("a\u0000b")[1].charCodeAt(0)"#);
    assert_result_agrees(r#"/a(.)b/.exec("a\u0000b")[1].length"#);
    assert_result_agrees(r#"/(\u0000+)/.exec("x\u0000\u0000y")[1].length"#);
}

#[test]
fn nul_free_subjects_are_unchanged() {
    assert_result_agrees(r#"/b/.exec("ab").index"#);
    assert_result_agrees(r#"/^\D+$/.test("abc")"#);
    assert_result_agrees(r#"/^\D$/.test("7")"#);
}
