//! `for ( var BindingIdentifier Initializer in Expression )` — Annex B.3.5.
//!
//! The one legacy shape that keeps an initializer on a `for-in` head binding.
//! It had been refused outright, which was a conformance divergence rather than
//! a fault, and was pinned as such while the surrounding `[In]` work landed.
//!
//! Admitting it is a deliberate divergence from the PINNED ORACLE, which is the
//! notable part: XS rejects `for (var a = 0 in {})` with `missing ;`, and the
//! committed expectation for
//! `annexB/language/statements/for-in/nonstrict-initializer.js` recorded the
//! resulting failure as an error-message difference. That test is POSITIVE — it
//! asserts the semantics below — and Node accepts it, so the divergence is in
//! the direction of the spec and of test262, as with the `for (let x, y in {})`
//! rejection already on this branch.
//!
//! The grammar is narrow and every clause is load-bearing: `var` only (not
//! `let`/`const`), `in` only (never `of`), ONE binding, a `BindingIdentifier`
//! target (never a pattern), and non-strict code only. `HeadBindings` carries
//! the first four out of `variable_statement`; `flags::STRICT` settles the
//! last, and covers module code, which is always strict.

use ironhorse_compile::{compile_atoms_goal, Goal, ParseErrorKind};

/// Accepted in exactly the two sloppy modes, refused in the three strict ones.
#[test]
fn the_initializer_is_admitted_in_sloppy_code_and_refused_in_strict() {
    for source in [
        "for (var x = 0 in {}) ;",
        "for (var x = 'init' in {a:1}) ;",
        "for (var x = (0, 1) in {}) ;",
        "for (var x = function () {} in {}) ;",
    ] {
        for (goal, strict, want_ok) in [
            (Goal::Script, false, true),
            (Goal::Eval, false, true),
            (Goal::Script, true, false),
            (Goal::Eval, true, false),
            (Goal::Module, false, false),
        ] {
            let result = compile_atoms_goal(source, goal, strict);
            assert_eq!(
                result.is_ok(),
                want_ok,
                "{source} ({goal:?}, strict={strict}): {result:?}"
            );
            if !want_ok {
                let error = result.unwrap_err();
                assert_eq!(error.kind, ParseErrorKind::Syntax, "{source}");
            }
        }
    }
}

/// Every neighbouring shape Annex B does NOT cover stays refused, in every
/// mode. Without these the rule above could be "any initializer, anywhere".
#[test]
fn no_neighbouring_shape_is_admitted_with_it() {
    for source in [
        // Not `var`.
        "for (let x = 0 in {}) ;",
        "for (const x = 0 in {}) ;",
        // Not `in`.
        "for (var x = 0 of []) ;",
        "async function f() { for await (var x = 0 of []) ; }",
        // Not a single binding.
        "for (var x = 0, y = 1 in {}) ;",
        "for (var x, y = 1 in {}) ;",
        // Not a `BindingIdentifier`.
        "for (var [a] = [] in {}) ;",
        "for (var {a} = {} in {}) ;",
        "for (var [a, b] = [] in {}) ;",
        // Not a declaration at all — an assignment target keeps its own rule.
        "for (x = 0 in {}) ;",
    ] {
        for (goal, strict) in [
            (Goal::Script, false),
            (Goal::Script, true),
            (Goal::Module, false),
            (Goal::Eval, false),
            (Goal::Eval, true),
        ] {
            let owned = source.to_string();
            let result = std::panic::catch_unwind(move || compile_atoms_goal(&owned, goal, strict));
            assert!(
                matches!(result, Ok(Err(ref e)) if e.kind == ParseErrorKind::Syntax),
                "{source} ({goal:?}, strict={strict}): {result:?}"
            );
        }
    }
}

/// The forms without an initializer are untouched.
#[test]
fn an_ordinary_for_in_head_still_compiles() {
    for source in [
        "for (var x in {}) ;",
        "for (let x in {}) ;",
        "for (const x in {}) ;",
        "for (var [a] in {}) ;",
        "for (var {a} in {}) ;",
        "for (var x of []) ;",
        "for (var x = 0;;) ;",
    ] {
        for (goal, strict) in [
            (Goal::Script, false),
            (Goal::Script, true),
            (Goal::Module, false),
            (Goal::Eval, false),
            (Goal::Eval, true),
        ] {
            compile_atoms_goal(source, goal, strict)
                .unwrap_or_else(|error| panic!("{goal:?}, strict={strict}: {source}: {error:?}"));
        }
    }
}
