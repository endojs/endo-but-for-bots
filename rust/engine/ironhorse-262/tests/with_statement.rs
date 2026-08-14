//! Focused differential regressions for the `with (expression) statement`
//! environment-chain model (design child "with-cluster A"): the real
//! `XS_CODE_WITH`/`WITHOUT` env instances, the `EVAL_REFERENCE`/`PROGRAM_REFERENCE`
//! scopable object-environment walk (`fxIsScopableSlot` = `HasProperty` +
//! `@@unscopables`), and `GET_VARIABLE`/`GET_THIS_VARIABLE`/`SET_VARIABLE`
//! resolving against the object the reference op selected. Each asserts
//! **bit-exact** agreement with the pinned XS oracle — same completion value AND
//! same computrons — so a metering or semantics drift fails the build.

use ironhorse_262::dual_run;

/// The program runs end-to-end bit-exact with the XS oracle (value + computrons).
fn exact(source: &str) {
    let run = dual_run(source).expect("the XS oracle machine must start");
    assert!(
        run.is_bit_exact(),
        "not bit-exact: {source}\n  oracle_result={} ironhorse_result={}\n  oracle_computrons={} ironhorse_computrons={}",
        run.oracle_result,
        run.ironhorse_result,
        run.oracle_computrons,
        run.ironhorse_computrons,
    );
}

#[test]
fn with_object_read() {
    exact("var o = {a: 1}; var r = ''; with (o) { r = a; } r");
}

#[test]
fn with_object_write_targets_the_object() {
    // A `with`-bound name assigns the object property, not a global.
    exact("var o = {a: 1}; with (o) { a = 7; } o.a");
}

#[test]
fn outer_scope_fallthrough_when_object_lacks_the_name() {
    // The object does not bind `x`, so the read/write falls through to the
    // surrounding scope (here the global `x`), byte-identically to no `with`.
    exact("var x = 9; var o = {}; var r; with (o) { r = x; } r");
    exact("var x = 9; var o = {}; with (o) { x = 3; } x");
}

#[test]
fn with_object_shadows_the_outer_binding() {
    exact("var x = 9; var o = {x: 5}; var r; with (o) { r = x; } r");
}

#[test]
fn unscopables_blocks_the_binding() {
    // `@@unscopables` listing the name truthy hides it: the read falls through
    // to the outer `x`, not the object's.
    exact("var x = 0; var o = {x: 1}; o[Symbol.unscopables] = {x: true}; var r; with (o) { r = x; } r");
}

#[test]
fn unscopables_falsey_does_not_block() {
    exact("var x = 0; var o = {x: 1}; o[Symbol.unscopables] = {x: false}; var r; with (o) { r = x; } r");
}

#[test]
fn unscopables_non_object_does_not_block() {
    exact("var x = 0; var o = {x: 1}; o[Symbol.unscopables] = 42; var r; with (o) { r = x; } r");
}

#[test]
fn nested_with_outer_binds() {
    exact("var a = 1; var o = {a: 2}; var p = {b: 3}; var r; with (o) { with (p) { r = a; } } r");
}

#[test]
fn nested_with_inner_shadows() {
    exact("var o = {a: 1}; var p = {a: 9}; var r; with (o) { with (p) { r = a; } } r");
}

#[test]
fn function_defined_in_with_captures_it() {
    // A function whose free name resolves through the enclosing `with` when it
    // runs (the closure captures the `with` environment).
    exact("var o = {a: 1}; with (o) { var r = (function(){ return a; })(); } r");
}

#[test]
fn function_containing_with_reads_the_object() {
    exact("var o = {a: 1}; function f() { with (o) { return a; } } f()");
}

#[test]
fn empty_with_chain_matches_no_with() {
    // The environment-instance allocation and teardown meter exactly (empty body).
    exact("var o = {a: 1}; with (o) {} o.a");
}
