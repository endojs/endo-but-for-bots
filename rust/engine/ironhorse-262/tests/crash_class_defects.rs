//! Oracle-backed regression gate for the three crash-class defects.
//!
//! Each of these aborted the host process on valid JavaScript: a Rust panic in
//! the matcher, and two real thread-stack overflows. IronHorse runs untrusted
//! guest code by construction, so a guest-triggerable host abort is a denial of
//! service rather than a correctness gap, and these tests exist to keep them
//! from returning.
//!
//! Note that a test here failing by *aborting the test binary* is the original
//! symptom; a clean assertion failure means something subtler regressed.

use ironhorse_262::{dual_run, Agreement};
use ironhorse_vm::Halt;

/// Both engines complete with the same completion value.
fn agrees(source: &str) {
    let run = dual_run(source).expect("the pinned XS oracle must start");
    assert_eq!(
        run.agreement,
        Agreement::BothComplete,
        "`{source}` must complete on both engines (ironhorse halt: {:?})",
        run.ironhorse_halt,
    );
    assert!(
        run.result_agrees,
        "`{source}` diverged: oracle={:?} ironhorse={:?}",
        run.oracle_result, run.ironhorse_result,
    );
}

/// A `\1` backreference under `iu`/`v` can match text whose encoded length
/// differs from the capture's, because case folding is not length-preserving:
/// one-unit `k` folds together with three-unit U+212A KELVIN SIGN.
///
/// The capture-reference steps derived the new offset from the capture's
/// encoded length, which landed mid-character and tripped the code-unit
/// assertion in `regexp_match_drive`, panicking the engine.
#[test]
fn folding_backreferences_do_not_panic_the_matcher() {
    for source in [
        r#"/(k)\1/iu.test("kK")"#,
        r#"/(K)\1/iu.test("Kk")"#,
        r#"/(s)\1/iu.test("sſ")"#,
        r#"/(ſ)\1/iu.test("ss")"#,
        r#"/(k)\1/v.test("kK")"#,
        r#"var m=/(k)\1/iu.exec("kK");m?m[0].length+':'+m.index:'null'"#,
        r#""kKk".replace(/(k)\1/iu,'X')"#,
    ] {
        agrees(source);
    }
}

/// Where the pinned XS is itself wrong. Its forward step leaves `offset`
/// mid-character and then compares against a replacement character, so it
/// rejects two folds the language accepts. Adopting the comparison cursor
/// fixes the panic and incidentally makes IronHorse right here, so these are
/// pinned as deliberate, named divergences rather than left to drift.
///
/// Each was verified in its own process: the oracle's answer for a program in
/// this family can depend on which programs preceded it in the same process,
/// so a divergence seen in a batch means nothing until it is re-run alone.
#[test]
fn folding_backreferences_beyond_the_pinned_oracle() {
    for (source, expected, pinned) in [
        (r#"/(ſ)\1/iu.test("ſs")"#, "true", "false"),
        (r#"/(ᲀ)\1/i.test("ᲀВ")"#, "true", "false"),
    ] {
        let run = dual_run(source).expect("the pinned XS oracle must start");
        assert_eq!(run.agreement, Agreement::BothComplete, "{source}: {run:?}");
        assert_eq!(run.ironhorse_result, expected, "{source}: {run:?}");
        assert_eq!(run.oracle_result, pinned, "{source}: {run:?}");
    }
}

/// The backward (lookbehind) capture-reference step keeps XS's byte arithmetic
/// deliberately. Stepping back one character per captured character instead
/// regresses plain `u`/`v` with no folding at all, because XS's arithmetic can
/// legitimately land on a surrogate boundary inside a pair that a code-point
/// walk skips over.
#[test]
fn lookbehind_backreferences_keep_the_pinned_byte_arithmetic() {
    for source in [
        r#"/(?<=\1(\uDC28))x/u.test("𐐨\uDC28x")"#,
        r#"/(?<=\1(\uDC28))x/v.test("𐐨\uDC28x")"#,
        r#"/(?<=\1(s))x/iu.test("ſsx")"#,
        r#"/(?<=\1(k))x/iu.test("Kkx")"#,
    ] {
        agrees(source);
    }
}

/// The lookbehind shapes the branch's own repro reaches.
#[test]
fn folding_backreferences_in_lookbehind_do_not_panic() {
    for source in [
        r#"/(?<=(k)\1)x/iu.test("kKx")"#,
        r#"/(?<=(a)\1)x/.test("aax")"#,
        r#"/(?<!(a)\1)x/.test("abx")"#,
        r#"/(?<=(k)\1)/iu.test("kK")"#,
    ] {
        agrees(source);
    }
}

/// Ordinary backreferences keep working: the fix changed the success and
/// failure conditions of both steps, so the unaffected shapes are pinned too.
#[test]
fn ordinary_backreferences_are_unaffected() {
    for source in [
        r#"/(a)\1/.test("aa")"#,
        r#"/(a)\1/.test("ab")"#,
        r#"/(ab)\1/.test("abab")"#,
        r#"/(a)(b)\2\1/.test("abba")"#,
        r#"/(a*)\1/.test("")"#,
        r#"/(?<g>a)\k<g>/.test("aa")"#,
        r#"var m="aabb".match(/(a)\1|(b)\2/g);m?m.join(','):'null'"#,
        r#"/(a)\1/.test("a")"#,
    ] {
        agrees(source);
    }
}

/// `SetterThatIgnoresPrototypeProperties` step 5 is an ordinary `Set`, so a
/// receiver carrying its own copy of the `Iterator.prototype` accessor re-enters
/// the native setter without bound. The pinned XS does not complete this
/// program either; the requirement is that IronHorse report a halt the host can
/// observe instead of overflowing the real thread stack.
#[test]
fn copied_iterator_setter_halts_instead_of_aborting_the_host() {
    let source = "var d=Object.getOwnPropertyDescriptor(Iterator.prototype,'constructor');\
var o={};Object.defineProperty(o,'constructor',d);o.constructor=1;'done'";
    let run = dual_run(source).expect("the pinned XS oracle must start");
    assert_eq!(
        run.agreement,
        Agreement::BothAbort,
        "both engines must abort: {run:?}",
    );
    assert!(
        matches!(run.ironhorse_halt, Halt::StackOverflow(_)),
        "ironhorse must report a bounded stack overflow, got {:?}",
        run.ironhorse_halt,
    );
}

/// `BoundFunctionExoticObject.[[Call]]` recursed once per wrapper, so a long
/// chain overflowed the real thread stack while the pinned XS completed the
/// same program. The chain is folded iteratively now, as construction already
/// was.
#[test]
fn long_bound_chains_complete() {
    agrees("var f=function(){return 1};for(var i=0;i<20000;i++){f=f.bind(null)}f()");
    agrees("var f=function(){return 1};for(var i=0;i<20000;i++){f=f.bind(null)}typeof f");
}

/// The fold has to preserve argument order, the bound receiver, and the shallow
/// shapes that already worked.
#[test]
fn bound_chain_folding_preserves_arguments_and_receiver() {
    for source in [
        "var f=function(a,b){return a+b};var g=f.bind(null,1);var h=g.bind(null,2);h()",
        "var f=function(){return this.x};var g=f.bind({x:7});var h=g.bind({x:9});h()",
        "var f=function(){return Array.prototype.slice.call(arguments).join(',')};\
f.bind(null,1).bind(null,2).bind(null,3)(4)",
        "var f=function(a){return a};f.bind(null)(5)",
        "var f=function(){return this===null?'null':typeof this};f.bind(null)()",
    ] {
        agrees(source);
    }
}
