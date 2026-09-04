//! Oracle-backed differential coverage for the **Annex B / source-text portion
//! exposed by runtime `eval` and the dynamic `Function` constructor** — the
//! `annexB/built-ins/Function` and `annexB/language/eval-code` slices.
//!
//! The pinned Moddable XS oracle is the reference. XS does **not** implement the
//! Annex B block-level-function extensions these slices probe (a
//! `FunctionDeclaration` in a single-statement slot, an `if`-clause, a `do`/`for`
//! body, …): it rejects them with the early error `SyntaxError: no block (strict
//! code)`. It likewise does not treat `<!--` / `-->` as HTML comments, and it
//! throws an undefined-variable read as `ReferenceError: get <name>: undefined
//! variable`. Ironhorse reproduces each of those **exact thrown values** — the
//! same four-valued agreement AND the same `String(exception)` text — rather
//! than a bare `SyntaxError`/`ReferenceError` that would merely share a
//! constructor. That message-faithfulness is what lifts these cases from an
//! `abort-value-differs` skip to genuine differential coverage.
//!
//! Every case here runs the identical source on both engines; the assertions
//! pin which XS diagnostic each construct reproduces (a regression in the
//! bridge's error rendering fails the exact-string check, not just the shape).
//! These are the grammar/instantiation families the source bridge touches, in
//! positive (both complete) and negative (both throw the same value) form.

use ironhorse_262::{dual_run, Agreement};

/// Both engines throw and ironhorse's thrown value renders **identically** to
/// the oracle's — the differential-coverage bar for a shared early error /
/// runtime throw. Pins the exact `String(exception)` so a message regression is
/// caught, not just a constructor match.
fn assert_shared_throw(source: &str, oracle_error: &str) {
    let run = dual_run(source).expect("pinned XS oracle is available");
    assert_eq!(run.agreement, Agreement::BothAbort, "both abort for {source:?}");
    assert_eq!(
        run.oracle_error, oracle_error,
        "oracle error text for {source:?}"
    );
    assert!(
        run.error_agrees,
        "ironhorse must throw the same value as the oracle for {source:?}: oracle={:?} ironhorse={:?}",
        run.oracle_error, run.ironhorse_error
    );
}

/// Both engines complete with the same rendered value — the positive control
/// certifying the bridge still runs valid source correctly.
fn assert_shared_result(source: &str, expected: &str) {
    let run = dual_run(source).expect("pinned XS oracle is available");
    assert_eq!(
        run.agreement,
        Agreement::BothComplete,
        "both complete for {source:?}"
    );
    assert_eq!(run.oracle_result, expected, "oracle result for {source:?}");
    assert_eq!(run.ironhorse_result, expected, "ironhorse result for {source:?}");
}

// ---- Annex B block-level FunctionDeclaration: XS's `no block` early error ---
// A `FunctionDeclaration` in a position where only a `Statement` is grammatical
// (an `if`/`else` clause, a `do`/`for`/`while` body, a bare label) is an Annex
// B.3.4 extension XS declines: `fxStatement` reports `no block (strict code)`.
// The eval bridge relays that exact diagnostic into a catchable realm-local
// `SyntaxError`. Both direct and indirect eval reach the same parser.

#[test]
fn eval_if_else_function_declaration_is_no_block() {
    // if-decl-else-decl (the `*-eval-global-block-scoping` family).
    assert_shared_throw(
        "(0,eval)('if (true) function f(){} else function g(){}')",
        "SyntaxError: no block (strict code)",
    );
    // Direct eval reaches the identical front end.
    assert_shared_throw(
        "eval('if (true) function f(){} else function g(){}')",
        "SyntaxError: no block (strict code)",
    );
    // if-decl with no else.
    assert_shared_throw(
        "(0,eval)('if (true) function f(){}')",
        "SyntaxError: no block (strict code)",
    );
    // if-stmt-else-decl.
    assert_shared_throw(
        "(0,eval)('if (true) ; else function g(){}')",
        "SyntaxError: no block (strict code)",
    );
}

#[test]
fn eval_iteration_body_function_declaration_is_no_block() {
    assert_shared_throw(
        "eval('do function f(){} while(false)')",
        "SyntaxError: no block (strict code)",
    );
    assert_shared_throw(
        "eval('for (;;) function f(){}')",
        "SyntaxError: no block (strict code)",
    );
    assert_shared_throw(
        "eval('while (false) function f(){}')",
        "SyntaxError: no block (strict code)",
    );
}

// ---- undefined-variable ReferenceError: XS's `get <name>: undefined variable`
// Reading a name bound in no reachable environment is a catchable
// ReferenceError whose message names the variable. Because XS declines the
// Annex B.3.3 var-hoist of an eval block-level function, the name a
// `{ function f(){} }` eval defines is *not* reachable afterward — reading it
// throws exactly this, on both engines.

#[test]
fn undefined_variable_reference_error_names_the_variable() {
    assert_shared_throw(
        "undefinedVarXYZ",
        "ReferenceError: get undefinedVarXYZ: undefined variable",
    );
    // The block-level function an eval defines does not leak to the enclosing
    // scope on XS (no Annex B.3.3 hoist), so the later read is unresolvable.
    assert_shared_throw(
        "eval('{ function f(){} }'); f()",
        "ReferenceError: get f: undefined variable",
    );
    // A `with`-object environment miss falls through to the same diagnostic.
    assert_shared_throw(
        "with ({}) { unresolvableName }",
        "ReferenceError: get unresolvableName: undefined variable",
    );
}

// ---- dynamic Function: HTML comment markers + line-terminator restriction ---
// `CreateDynamicFunction` assembles `function anonymous(<P>\n) {\n<body>\n}` and
// parses it as Script-goal source. XS treats neither `<!--` nor `-->` as an HTML
// comment; the assembled text is a parse error, and the constructor throws the
// exact `SyntaxError` XS reports at the point the markers derail the grammar.
// The line-terminator restriction is observable through *where* the marker sits
// (in the params on the open line vs. the body on a fresh line).

#[test]
fn dynamic_function_html_close_comment_body() {
    // `\n-->` and `-->` as the body: both reach `missing expression`.
    assert_shared_throw("Function('\\n-->')", "SyntaxError: missing expression");
    assert_shared_throw("Function('-->')", "SyntaxError: missing expression");
}

#[test]
fn dynamic_function_html_comment_params() {
    // `<!--` and `\n-->` as the parameter list, and `-->` as the parameter list
    // (the no-line-terminator negative): all derail the formal-parameter parse
    // at `missing )`.
    assert_shared_throw("Function('<!--', '')", "SyntaxError: missing )");
    assert_shared_throw("Function('\\n-->', '')", "SyntaxError: missing )");
    assert_shared_throw("Function('-->', '')", "SyntaxError: missing )");
}

// NOTE: `Function('<!--')` (an HTML *open* comment as the body) is the one slice
// case whose message still diverges — XS reports `missing identifier` where
// ironhorse's parser reaches `missing expression` for the leading `<`. It is a
// bare-token-position parser-message difference, not an Annex B or bridge
// concern, and is left as a known gap rather than papered over.

// ---- positive controls: the bridge still runs valid source correctly --------

#[test]
fn eval_and_dynamic_function_positive_controls() {
    assert_shared_result("eval('1 + 2')", "3");
    assert_shared_result("eval('var y = 5; y')", "5");
    // A block-level function IS grammatical inside a real block; the eval
    // completes (its completion value is the last statement's, undefined here).
    assert_shared_result("eval('{ function f(){} }'); typeof f", "undefined");
    assert_shared_result("Function('a','b','return a+b')(2,3)", "5");
    // A valid `if` with a block body — the Annex B extension is unnecessary and
    // no early error fires.
    assert_shared_result("eval('if (true) { function f(){ return 9 } } typeof f')", "undefined");
}
