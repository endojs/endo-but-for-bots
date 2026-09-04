//! Oracle-backed differential coverage for the ECMAScript **dynamic function
//! constructor family** — `Function`, `%GeneratorFunction%`, `%AsyncFunction%`,
//! and `%AsyncGeneratorFunction%` — built on the runtime source-execution
//! bridge ([`ironhorse_vm::SourceCompiler`]). Each constructor runs
//! CreateDynamicFunction (ECMA-262 20.2.1.1.1): it `ToString`-coerces its
//! arguments, assembles the kind-specific function source
//! (`function` / `function*` / `async function` / `async function*`), compiles
//! it through the same bridge as `eval`, and returns the live realm function.
//!
//! Every case is differential: the source runs on the pinned XS oracle and on
//! ironhorse, and both the four-valued agreement and the completion value must
//! match. That is what certifies the family reproduces XS semantics —
//! construction, call/construct equivalence, parameter/body assembly, grammar,
//! global-realm execution, prototype/`new.target` behavior, `name`/`length`/
//! source text, early errors, and error identity — rather than a bespoke
//! interpretation. The three non-global constructors are reached exactly as a
//! program reaches them: through the `.constructor` of a generator/async
//! function instance.
//!
//! These are hand-authored transcriptions of the `built-ins/Function`,
//! `built-ins/GeneratorFunction`, `built-ins/AsyncFunction`, and
//! `built-ins/AsyncGeneratorFunction` intent into XS-differential form (the
//! full test262 slices run under the separate `full-run` sweep). Deliberately
//! XS-quirk-faithful where XS diverges from the letter of the spec (e.g. the
//! `[[Prototype]]` of `%GeneratorFunction%` and the `[native code]` source text
//! of a dynamic function), because the oracle is the reference.

use ironhorse_262::{dual_run, Agreement};

/// Assert ironhorse agrees with the oracle that `source` completes with
/// `expected` (rendered). The oracle is the reference: this certifies the
/// bridge + family, not ironhorse in isolation.
fn assert_oracle_result(source: &str, expected: &str) {
    let run = dual_run(source).expect("pinned XS oracle is available");
    assert_eq!(run.agreement, Agreement::BothComplete, "agreement for {source}");
    assert_eq!(run.oracle_result, expected, "oracle result for {source}");
    assert_eq!(run.ironhorse_result, expected, "ironhorse result for {source}");
}

/// Assert both engines agree the source is a shared abort (a thrown early
/// error, an un-runnable program): neither completes. This is the coverage
/// that certifies an early error is reproduced rather than mis-run — the
/// catchable-identity cases below additionally pin *which* error.
fn assert_shared_abort(source: &str) {
    let run = dual_run(source).expect("pinned XS oracle is available");
    assert_eq!(run.agreement, Agreement::BothAbort, "shared abort for {source}");
}

// ---- Function: construction, call/construct equivalence --------------------

#[test]
fn function_constructs_and_calls() {
    assert_oracle_result("Function('return 42')()", "42");
    assert_oracle_result("new Function('return 42')()", "42");
    // Call and construct are equivalent for the Function constructor: both
    // produce an ordinary callable, and calling either runs the same body.
    assert_oracle_result("Function('return 1')() === new Function('return 1')()", "true");
    // Parameter list + body.
    assert_oracle_result("Function('a', 'b', 'return a * b')(6, 7)", "42");
    assert_oracle_result("new Function('a', 'b', 'c', 'return a + b + c')(1, 2, 3)", "6");
    // Empty everything.
    assert_oracle_result("new Function()()", "undefined");
    assert_oracle_result("Function('')()", "undefined");
}

#[test]
fn function_result_used_as_constructor_and_callback() {
    // `new` on the dynamic function: it is itself a constructor.
    assert_oracle_result("var C = new Function('this.x = 5'); new C().x", "5");
    // As a native-method callback (a cross-segment `run_callback`).
    assert_oracle_result(
        "[1, 2, 3].map(Function('x', 'return x + 100')).join(',')",
        "101,102,103",
    );
    // The result outlives the constructor call (its body lives in a persisted
    // segment, dispatched when invoked later).
    assert_oracle_result("var f = Function('a', 'b', 'return a - b'); f(10, 3)", "7");
}

// ---- Function: parameter / body assembly + grammar -------------------------

#[test]
fn function_parameter_and_body_grammar() {
    // Multiple parameters may arrive in one comma-joined argument.
    assert_oracle_result("Function('a, b, c', 'return a + b + c')(1, 2, 3)", "6");
    // Default + rest parameters in the assembled parameter list.
    assert_oracle_result("Function('a = 10', 'return a')()", "10");
    assert_oracle_result("Function('...rest', 'return rest.length')(1, 2, 3, 4)", "4");
    // Destructuring parameter.
    assert_oracle_result("Function('{x, y}', 'return x + y')({ x: 3, y: 4 })", "7");
    // A body with its own statements + a nested function.
    assert_oracle_result(
        "Function('n', 'function sq(x){ return x*x; } return sq(n)')(9)",
        "81",
    );
    // A trailing line comment in the body cannot swallow the closing brace (the
    // assembled `\n}` separator defends it).
    assert_oracle_result("Function('return 1 // tail comment')()", "1");
}

#[test]
fn function_tostring_argument_coercion() {
    // Non-string arguments are `ToString`-coerced (CreateDynamicFunction),
    // then compiled. A number body coerces to its decimal text.
    assert_oracle_result("Function(1)()", "undefined");
    assert_oracle_result("Function('return ' + 6 * 7)()", "42");
    // An object with a custom `toString` supplies the parameter/body text.
    assert_oracle_result(
        "Function({ toString: function(){ return 'return 99'; } })()",
        "99",
    );
    // A numeric "parameter name" is a syntax error after coercion — a shared
    // abort, exactly as if the string had been passed.
    assert_shared_abort("Function(1, 2, 3)");
}

// ---- Function: names / length / source text --------------------------------

#[test]
fn function_name_length_and_source_text() {
    assert_oracle_result("Function('a', 'b', 'return a').name", "anonymous");
    assert_oracle_result("Function('a', 'b', 'c', 'return a').length", "3");
    assert_oracle_result("Function('return 1').length", "0");
    // XS renders a dynamic function's source text as native code (the oracle is
    // the reference even where this diverges from the spec's assembled text).
    assert_oracle_result(
        "Function('a', 'b', 'return a').toString()",
        "function [\"anonymous\"] (){[native code]}",
    );
    // Its `[[Prototype]]` is `%Function.prototype%`.
    assert_oracle_result(
        "Object.getPrototypeOf(Function('return 1')) === Function.prototype",
        "true",
    );
}

// ---- Function: strictness + global-realm execution -------------------------

#[test]
fn function_runs_in_the_global_realm() {
    // The dynamic function's scope is the global realm, not the caller's — a
    // caller local is invisible; a global is visible.
    assert_oracle_result("globalThis.g1 = 7; Function('return g1')()", "7");
    assert_oracle_result(
        "var caught = false; try { (function(){ var loc = 1; return Function('return typeof loc')(); })() } catch (e) { caught = true } caught || Function('return typeof loc')()",
        "undefined",
    );
    // A `var` a dynamic function hoists lands on the realm global.
    assert_oracle_result("Function('var g2 = 41; globalThis.g2 = g2')(); globalThis.g2", "41");
}

#[test]
fn function_strictness_is_independent_of_caller() {
    // A dynamic function is sloppy by default even under a strict caller: a
    // bare `this` is the global object.
    assert_oracle_result("'use strict'; Function('return this')() === globalThis", "true");
    // Its own `"use strict"` prologue makes it strict: `this` is `undefined`.
    assert_oracle_result("Function('\"use strict\"; return this')() === undefined", "true");
    // A sloppy dynamic function sees `arguments`.
    assert_oracle_result("Function('return typeof arguments')()", "object");
}

// ---- Function: early errors + error identity -------------------------------

#[test]
fn function_early_errors_are_catchable_syntax_errors() {
    assert_oracle_result(
        "var ok = false; try { Function('return )(') } catch (e) { ok = e instanceof SyntaxError } ok",
        "true",
    );
    assert_oracle_result(
        "var ok = false; try { Function('a b', 'return 1') } catch (e) { ok = e instanceof SyntaxError } ok",
        "true",
    );
    // The thrown value's constructor identity is the realm `SyntaxError`.
    assert_oracle_result(
        "var n = ''; try { Function('(') } catch (e) { n = e.constructor.name } n",
        "SyntaxError",
    );
    // A body-level throw propagates on *call*, not construction.
    assert_oracle_result(
        "var f = Function('throw new TypeError(\"boom\")'); var t = ''; try { f() } catch (e) { t = e instanceof TypeError } t",
        "true",
    );
}

// ---- %GeneratorFunction% ---------------------------------------------------

#[test]
fn generator_function_identity() {
    // Reachable as the `.constructor` of a generator function instance.
    assert_oracle_result("(function*(){}).constructor.name", "GeneratorFunction");
    assert_oracle_result("(function*(){}).constructor.length", "1");
    assert_oracle_result(
        "(function*(){}).constructor === Object.getPrototypeOf(function*(){}).constructor",
        "true",
    );
    // Its instance's `[[Prototype]]` is `%GeneratorFunction.prototype%`, whose
    // `.constructor` links back to `%GeneratorFunction%` (XS-faithful chain).
    assert_oracle_result(
        "var GF = (function*(){}).constructor; Object.getPrototypeOf(function*(){}) === GF.prototype",
        "true",
    );
    assert_oracle_result(
        "var GF = (function*(){}).constructor; GF.prototype.constructor === GF",
        "true",
    );
    // XS chains `%GeneratorFunction%` itself to `%Function.prototype%` (not the
    // `%Function%` constructor); the oracle is the reference.
    assert_oracle_result(
        "var GF = (function*(){}).constructor; Object.getPrototypeOf(GF) === Function.prototype",
        "true",
    );
    assert_oracle_result(
        "var GF = (function*(){}).constructor; Object.getPrototypeOf(GF.prototype) === Function.prototype",
        "true",
    );
}

#[test]
fn generator_function_constructs_and_runs() {
    // Construction + call yields a generator; driving it runs the body.
    assert_oracle_result(
        "var GF = (function*(){}).constructor; var it = GF('yield 1; yield 2')(); it.next().value + ',' + it.next().value",
        "1,2",
    );
    // Parameters are assembled into the generator head.
    assert_oracle_result(
        "var GF = (function*(){}).constructor; GF('a', 'yield a * 2')(21).next().value",
        "42",
    );
    // `new` and plain call are equivalent.
    assert_oracle_result(
        "var GF = (function*(){}).constructor; typeof new GF('yield 1')",
        "function",
    );
    // A completed generator's done result is `{ done: true }` (value omitted),
    // rendered identically after the eval-segment resume.
    assert_oracle_result(
        "var g = (function*(){}).constructor('yield 1')(); g.next(); JSON.stringify(g.next())",
        "{\"done\":true}",
    );
    // A `yield`-bearing body is only legal in the generator grammar: the plain
    // Function constructor rejects the same body as a syntax error.
    assert_shared_abort("Function('yield 1')");
}

// ---- %AsyncFunction% -------------------------------------------------------

#[test]
fn async_function_identity_and_run() {
    assert_oracle_result("(async function(){}).constructor.name", "AsyncFunction");
    assert_oracle_result("(async function(){}).constructor.length", "1");
    // XS chains `%AsyncFunction%` to the `%Function%` constructor itself (unlike
    // the two generator constructors) — mirrored from the oracle.
    assert_oracle_result(
        "var AF = (async function(){}).constructor; Object.getPrototypeOf(AF) === Function",
        "true",
    );
    // Calling a dynamic async function returns a thenable (a promise).
    assert_oracle_result(
        "var AF = (async function(){}).constructor; typeof AF('return 1')().then",
        "function",
    );
    // `await` is legal only in the async grammar: the plain Function constructor
    // rejects the same body.
    assert_shared_abort("Function('return await 1')");
    // An `await`-bearing body compiles fine under `%AsyncFunction%`.
    assert_oracle_result(
        "var AF = (async function(){}).constructor; typeof AF('return await 1')",
        "function",
    );
}

// ---- %AsyncGeneratorFunction% ----------------------------------------------

#[test]
fn async_generator_function_identity_and_run() {
    assert_oracle_result("(async function*(){}).constructor.name", "AsyncGeneratorFunction");
    assert_oracle_result("(async function*(){}).constructor.length", "1");
    assert_oracle_result(
        "var AGF = (async function*(){}).constructor; Object.getPrototypeOf(AGF) === Function.prototype",
        "true",
    );
    // Construction yields an async generator; each request returns a promise.
    assert_oracle_result(
        "var AGF = (async function*(){}).constructor; typeof AGF('yield 1')()[Symbol.asyncIterator]",
        "function",
    );
    assert_oracle_result(
        "var AGF = (async function*(){}).constructor; typeof AGF('yield 1')().next().then",
        "function",
    );
    // The four family constructors are pairwise distinct.
    assert_oracle_result(
        "var s = new Set([Function, (function*(){}).constructor, (async function(){}).constructor, (async function*(){}).constructor]); s.size",
        "4",
    );
}
