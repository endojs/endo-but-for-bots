//! Oracle-backed regressions for the runtime **source-execution bridge**:
//! `eval` of a string and the `Function` constructor compiled and run in the
//! live realm through the principled compiler/VM seam
//! ([`ironhorse_vm::SourceCompiler`]), replacing the former
//! `eval:string-source` source-text boundary.
//!
//! Every case is differential: the source runs on the pinned XS oracle and on
//! ironhorse, and both the completion value and the four-valued agreement must
//! match. That is what certifies the bridge reproduces XS semantics — string
//! compilation, completion values, syntax-error catchability, nested
//! execution, realm-local errors, and the function lifetime — rather than a
//! bespoke interpretation. Direct eval whose scope is a function frame is a
//! deliberate named gap (`eval:direct-scope`), so those shapes are not
//! asserted here.

use ironhorse_262::{dual_run, Agreement};

/// Assert ironhorse agrees with the oracle that `source` completes with
/// `expected` (rendered). Certifies the bridge, not just ironhorse in
/// isolation: the oracle is the reference.
fn assert_oracle_result(source: &str, expected: &str) {
    let run = dual_run(source).expect("pinned XS oracle is available");
    assert_eq!(run.agreement, Agreement::BothComplete, "agreement for {source}");
    assert_eq!(run.oracle_result, expected, "oracle result for {source}");
    assert_eq!(run.ironhorse_result, expected, "ironhorse result for {source}");
}

// ---- string compilation + completion values --------------------------------

#[test]
fn indirect_eval_compiles_and_returns_expression_completion() {
    // A string reaches the compiler/VM bridge (no longer the pattern-matched
    // `eval:string-source` refusal) and returns the program completion value.
    assert_oracle_result("(0, eval)('1 + 1')", "2");
    assert_oracle_result("(0, eval)('2 * 3 * 7')", "42");
    assert_oracle_result("(0, eval)('\"a\" + \"b\" + \"c\"')", "abc");
    // The empty program completes with `undefined`.
    assert_oracle_result("(0, eval)('')", "undefined");
    // A statement list's completion is its last value.
    assert_oracle_result("(0, eval)('1; 2; 3')", "3");
}

#[test]
fn eval_runs_statements_with_realm_side_effects() {
    // `var` hoists onto the realm global; a following read sees it.
    assert_oracle_result("(0, eval)('var t = 5; t * t')", "25");
    // A loop runs to completion in the shared realm.
    assert_oracle_result("(0, eval)('var s = 0; for (var i = 0; i < 5; i++) s += i; s')", "10");
    // let/const lexical bindings evaluate in the eval scope.
    assert_oracle_result("(0, eval)('let a = 1; const b = 2; a + b')", "3");
    // An eval mutating an outer global is observable after it returns.
    assert_oracle_result("var n = 0; (0, eval)('n = n + 41'); n", "41");
}

#[test]
fn top_level_direct_eval_shares_program_scope() {
    // At top level the caller scope IS the program (global) scope, so a direct
    // eval is faithful and its declarations are visible to later top-level code.
    assert_oracle_result("eval('var d = 9'); d", "9");
    assert_oracle_result("eval('7 * 6')", "42");
}

// ---- syntax errors are catchable in the realm -------------------------------

#[test]
fn eval_syntax_error_is_a_catchable_realm_error() {
    assert_oracle_result(
        "var caught = false; try { (0, eval)('(') } catch (e) { caught = e instanceof SyntaxError } caught",
        "true",
    );
    assert_oracle_result(
        "var ok = false; try { (0, eval)('for(') } catch (e) { ok = e instanceof SyntaxError } ok",
        "true",
    );
}

// ---- nested execution -------------------------------------------------------

#[test]
fn eval_nests_and_calls_functions_within_the_unit() {
    // A function defined AND called inside the eval unit.
    assert_oracle_result("(0, eval)('(function (n) { return n * n; })(6)')", "36");
    // Recursion within the unit.
    assert_oracle_result(
        "(0, eval)('function fib(n){ return n < 2 ? n : fib(n-1) + fib(n-2); } fib(10)')",
        "55",
    );
    // eval within eval (nested bridge invocation).
    assert_oracle_result("(0, eval)('(0, eval)(\"3 + 4\")')", "7");
    // A callback defined in the eval drives a native method.
    assert_oracle_result("(0, eval)('[1,2,3].map(function (x) { return x * 2; }).join(\",\")')", "2,4,6");
}

#[test]
fn eval_defined_function_outlives_the_eval_call() {
    // The completion is a function whose body lives in the eval's own buffer;
    // calling it AFTER eval returns must dispatch over that persisted buffer
    // (the lifetime seam), not the caller's.
    assert_oracle_result("var f = (0, eval)('(function (a, b) { return a + b; })'); f(4, 5)", "9");
    // An eval-defined function calling back into a top-level function.
    assert_oracle_result("function g() { return 9; } (0, eval)('g() + 1')", "10");
}

// ---- realm-local declaration-instantiation / TDZ errors ---------------------

#[test]
fn eval_global_function_redeclaration_conflict_is_a_type_error() {
    // GlobalDeclarationInstantiation: a function declaration cannot redeclare a
    // non-configurable value global (`CanDeclareGlobalFunction` is false).
    assert_oracle_result(
        "var caught = false; try { (0, eval)('function NaN() {}') } catch (e) { caught = e instanceof TypeError } caught",
        "true",
    );
    assert_oracle_result(
        "var caught = false; try { (0, eval)('function undefined() {}') } catch (e) { caught = e instanceof TypeError } caught",
        "true",
    );
}

#[test]
fn eval_tdz_access_is_a_reference_error() {
    // Reading a lexical binding before its initializer (including via `typeof`,
    // which the compiler codes as a resolvable-local read) is a ReferenceError.
    assert_oracle_result(
        "var caught = false; try { (0, eval)('typeof x; let x;') } catch (e) { caught = e instanceof ReferenceError } caught",
        "true",
    );
    assert_oracle_result(
        "var caught = false; try { (0, eval)('y; let y = 1;') } catch (e) { caught = e instanceof ReferenceError } caught",
        "true",
    );
}

// ---- the Function constructor (dynamic functions) ---------------------------

#[test]
fn function_constructor_creates_a_callable_realm_function() {
    assert_oracle_result("new Function('return 42')()", "42");
    assert_oracle_result("Function('return 42')()", "42");
    assert_oracle_result("Function('a', 'b', 'return a * b')(6, 7)", "42");
    assert_oracle_result("new Function()()", "undefined");
    // The dynamic function's `.name` is `anonymous` and its `.length` its arity.
    assert_oracle_result("Function('a', 'b', 'return a').name", "anonymous");
    assert_oracle_result("Function('a', 'b', 'c', 'return a').length", "3");
}

#[test]
fn function_constructor_result_used_as_constructor_and_callback() {
    // Used with `new`: the dynamic function is a constructor.
    assert_oracle_result("var C = new Function('this.x = 5'); new C().x", "5");
    // Used as a native-method callback (a cross-segment run_callback).
    assert_oracle_result(
        "[1, 2, 3].map(Function('x', 'return x + 100')).join(',')",
        "101,102,103",
    );
}
