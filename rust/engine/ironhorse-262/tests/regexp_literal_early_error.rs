//! A RegExp *literal* whose pattern is an early SyntaxError must present as a
//! thrown `SyntaxError`, agreeing with the XS oracle — never a spurious
//! `parse-or-decode` (the runner decoding the *empty* bytecode a clean
//! `ironhorse-compile` rejection returns).
//!
//! Regression for the closure-audit seam fix (`dual_run_with`): before it, a
//! program containing an invalid RegExp literal (e.g. `/(a)\2/`, a
//! backreference to a group that does not exist) was cleanly *rejected* by
//! `ironhorse-compile` at parse time, but the harness then ran the resulting
//! empty bytecode, which halted with `Halt::Decode("pc 0 past end 0")` and was
//! misreported as `parse-or-decode`. Both engines in fact reject the source at
//! parse; the differential must see two SyntaxError rejections and cover the
//! case. The runtime `new RegExp(bad)` path (also here) already threw the bare
//! `SyntaxError`; this pins the literal path to the same behavior.

use ironhorse_262::{dual_run, Agreement};

/// Every source is a program that never runs because it contains a parse-phase
/// early error; XS represents that with a bytecode stub that throws
/// `SyntaxError`, and ironhorse must present the same bare `SyntaxError` throw.
fn shared_syntax_error_rejection(source: &str) {
    let run = dual_run(source).expect("the pinned XS oracle machine must start");
    assert_eq!(
        run.agreement,
        Agreement::BothAbort,
        "{source}: expected both engines to reject the source at parse: {run:?}"
    );
    assert_eq!(
        run.ironhorse_error, "SyntaxError",
        "{source}: ironhorse must throw a SyntaxError, not decode empty bytecode: {run:?}"
    );
    assert!(
        run.error_agrees,
        "{source}: the two SyntaxError rejections must agree (covered): {run:?}"
    );
}

#[test]
fn regexp_literal_out_of_range_backreference_is_covered_rejection() {
    for source in [
        // Backward reference to a group that never appears.
        "var r = /(a)\\2/; r",
        // Forward reference past the group count (the test262 Annex B shape
        // `\\b(\\w+) \\2\\b`, which reproduced the empty-bytecode decode).
        "var executed = /\\b(\\w+) \\2\\b/.test('do you listen the the band'); executed",
        // A bare `\\1` with no capturing group at all.
        "var r = /\\1(a)(b)(c)\\4/; r",
    ] {
        shared_syntax_error_rejection(source);
    }
}

#[test]
fn invalid_regexp_literal_does_not_decode_empty_bytecode() {
    // The defect signature: `ironhorse-compile` cleanly rejects the literal, so
    // the runner must NOT execute the empty bytecode a rejection returns (which
    // decoded past the end). A `Halt::Throw`, never a `Halt::Decode`.
    let run = dual_run("var r = /(a)\\2/; r").expect("oracle must start");
    match &run.ironhorse_halt {
        ironhorse_vm::Halt::Throw(message) => assert_eq!(message, "SyntaxError", "{run:?}"),
        other => panic!("expected a SyntaxError throw, got {other:?}: {run:?}"),
    }
}
