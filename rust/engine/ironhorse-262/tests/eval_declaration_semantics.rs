//! Oracle-backed regressions for **eval declaration-instantiation semantics** —
//! the standards-faithful conflict and definability rules a string `eval`
//! (direct and indirect) observes, plus the `typeof`-of-an-unresolvable-name
//! short-circuit those rules interact with.
//!
//! Every case is differential: the source runs on the pinned XS oracle and on
//! ironhorse, and both the completion value and the four-valued agreement must
//! match. The oracle is the reference — where XS and the abstract spec differ
//! (the indirect var/global-lexical case below), ironhorse matches XS.

use ironhorse_262::{dual_run, Agreement};

/// Assert ironhorse agrees with the oracle that `source` completes with
/// `expected` (rendered).
fn assert_oracle_result(source: &str, expected: &str) {
    let run = dual_run(source).expect("pinned XS oracle is available");
    assert_eq!(run.agreement, Agreement::BothComplete, "agreement for {source}");
    assert_eq!(run.oracle_result, expected, "oracle result for {source}");
    assert_eq!(run.ironhorse_result, expected, "ironhorse result for {source}");
}

/// Assert both engines abort on `source` (e.g. an uncaught throw) and, when
/// ironhorse threw a JS-level exception, that the thrown value agrees with the
/// oracle's.
fn assert_shared_abort(source: &str) {
    let run = dual_run(source).expect("pinned XS oracle is available");
    assert_eq!(run.agreement, Agreement::BothAbort, "agreement for {source}");
}

// ---- `typeof` of an unresolvable reference is "undefined", never a throw ----

#[test]
fn typeof_unresolvable_name_is_undefined() {
    // ECMA-262 13.5.3.1: an unresolvable reference short-circuits `typeof` to
    // "undefined" rather than faulting in `GetValue`. XS encodes this by peeking
    // the opcode after `GET_VARIABLE`.
    assert_oracle_result("typeof someUnresolvableNameXYZ", "undefined");
    assert_oracle_result("typeof someUnresolvableNameXYZ === 'undefined'", "true");
    // Inside a function frame and inside an eval unit alike.
    assert_oracle_result("function f(){ return typeof someUnresolvableNameXYZ } f()", "undefined");
    assert_oracle_result("(0, eval)('typeof someUnresolvableNameXYZ')", "undefined");
    assert_oracle_result("eval('typeof someUnresolvableNameXYZ')", "undefined");
    // A resolvable binding still reports its real type through the same path.
    assert_oracle_result("var g = 5; typeof g", "number");
    assert_oracle_result("var g = 5; (0, eval)('typeof g')", "number");
}

#[test]
fn typeof_of_a_bound_but_uninitialized_binding_still_throws() {
    // A name in its temporal dead zone is *bound*, not unresolvable, so the
    // typeof short-circuit does not apply — it is a ReferenceError.
    assert_shared_abort("typeof q; let q;");
    assert_shared_abort("(0, eval)('typeof q; let q;')");
    // A plain (non-typeof) unresolvable read is always a ReferenceError.
    assert_shared_abort("someUnresolvableNameXYZ");
    assert_shared_abort("(0, eval)('someUnresolvableNameXYZ')");
}

// ---- direct-eval `var`/global-lexical collision is a catchable SyntaxError --

#[test]
fn direct_eval_var_colliding_with_global_lexical_is_a_syntax_error() {
    // A direct eval shares the caller's lexical environment; at top level that
    // is the realm's global lexical environment holding the program's top-level
    // `let`. A `var` re-declaring that name is the direct-eval "duplicate
    // variable" early error — a catchable realm `SyntaxError`.
    assert_oracle_result(
        "let x; var caught = false; try { eval('var x;') } catch (e) { caught = e instanceof SyntaxError } caught",
        "true",
    );
    // A `const` binding conflicts identically.
    assert_oracle_result(
        "const c = 1; var ok = false; try { eval('var c;') } catch (e) { ok = e instanceof SyntaxError } ok",
        "true",
    );
    // A direct eval whose `var` does NOT collide with any lexical is fine.
    assert_oracle_result("let y = 1; eval('var z = 2'); y + z", "3");
}

#[test]
fn indirect_eval_var_does_not_collide_with_global_lexical() {
    // An indirect eval runs in a fresh global variable scope that does not see
    // the caller's lexical environment, so `var x` does NOT raise even when a
    // global lexical `x` exists — matching XS (which throws only for the direct
    // form). The completion is the plain `var` (undefined).
    assert_oracle_result(
        "let x; var threw = false; try { (0, eval)('var x;') } catch (e) { threw = true } threw",
        "false",
    );
}

// ---- eval-scoped lexicals do not leak to the enclosing scope ----------------

#[test]
fn eval_lexical_declarations_are_eval_scoped() {
    // A `let`/`const`/`class` declared inside an eval lives in the eval's own
    // (discarded) declarative environment, so after the eval returns the name is
    // unresolvable — `typeof` of it is "undefined", not the eval-time value.
    assert_oracle_result("(0, eval)('let onlyInside = 3;'); typeof onlyInside", "undefined");
    assert_oracle_result("(0, eval)('const k = 9;'); typeof k", "undefined");
    // The binding is fully usable *within* the eval.
    assert_oracle_result("(0, eval)('let z = 5; z')", "5");
    assert_oracle_result("(0, eval)('let a = 1; const b = 2; a + b')", "3");
}

// ---- CanDeclareGlobalVar: a non-extensible global rejects a new binding -----

#[test]
fn eval_var_on_a_non_extensible_global_is_a_type_error() {
    // `CanDeclareGlobalVar`/`CanDeclareGlobalFunction` reduce, for an absent
    // name, to `IsExtensible(globalThis)`: once the global is sealed, an eval's
    // `var` declaring a brand-new name is a `TypeError`.
    assert_oracle_result(
        "Object.preventExtensions(this); var caught; try { (0, eval)('var unlikelyName;'); } catch (e) { caught = e.constructor.name } caught",
        "TypeError",
    );
    // Re-declaring a name that already exists on the sealed global is allowed
    // (no new binding is created).
    assert_oracle_result(
        "var present = 7; Object.preventExtensions(this); (0, eval)('var present;'); present",
        "7",
    );
}
