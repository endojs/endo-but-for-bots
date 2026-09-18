//! `[In]` is a grammar parameter, not an ambient mode (finding F063).
//!
//! `for ( var VariableDeclarationList[~In] ; … )` excludes `in` from the head's
//! declaration list so that `for (var x in y)` is not ambiguous. The parser
//! models `[~In]` with `flags::FOR`, and a flag is ambient where the parameter
//! is positional, which broke it in both directions:
//!
//! * **Over-rejection.** Every production the grammar writes `[+In]` resets the
//!   parameter, and several of them did not clear the flag, so valid code was
//!   refused: `for ((a in b);;)`, `for (f(a in b);;)`, `` for (`${a in b}`;;) ``,
//!   `for (x[a in b];;)` and every arrow body, e.g.
//!   `for (() => { return a in b; };;)`. A function-EXPRESSION body already
//!   cleared it, so the two spellings disagreed.
//! * **Under-rejection.** `[~In]` covers the WHOLE list including initializers,
//!   but the flag was cleared on the first `=` and again on each comma, so
//!   `for (var x = "a" in {};;)` — a spec early error — compiled.
//!
//! The same ambient flag is what let `for (() => { var [a]; };;)` panic the
//! coder, which is why these live beside that rule rather than in their own
//! pass: one root cause, three symptoms.
//!
//! What is NOT changed here: `for (var x = 0 in {})`, the Annex B
//! `VariableStatement`-in-`for-in` form, is still refused. That is a separate
//! pre-existing divergence, pinned below so this file's scope is explicit.

use ironhorse_compile::{compile_atoms_goal, Goal, ParseErrorKind};

/// `in` is legal in a `for` head wherever the grammar resets `[In]`.
///
/// Sloppy goals only for the `with`-free forms is not needed — none of these
/// depends on strictness — so all five modes must accept them.
#[test]
fn every_in_reset_production_accepts_in_inside_a_for_head() {
    for source in [
        // Parenthesized: `( Expression[+In] )`.
        "for ((\"a\" in {});;) ;",
        "for ((\"a\" in {}) && 0;;) ;",
        // Arguments: `( ArgumentList[+In] )`.
        "for (f(\"a\" in {});;) ;",
        "for (new f(\"a\" in {});;) ;",
        // Computed member: `[ Expression[+In] ]`.
        "for (x[\"a\" in {}];;) ;",
        "for (x?.[\"a\" in {}];;) ;",
        // Template substitution: `${ Expression[+In] }`.
        "for (`${\"a\" in {}}`;;) ;",
        "for (tag`${\"a\" in {}}`;;) ;",
        // Function bodies of every spelling. The arrow forms are the ones that
        // used to be refused while the `function` form was accepted.
        "for (() => { return \"a\" in {}; };;) ;",
        "for (() => (\"a\" in {});;) ;",
        // An arrow with an IDENTIFIER parameter, which does not go through the
        // parenthesized form. Without it the roster is satisfied by the
        // `( Expression[+In] )` reset alone and says nothing about the arrow
        // body — the reset that the `function` spelling already had and the
        // arrow spelling did not.
        "for (x => { return \"a\" in {}; };;) ;",
        "for (x => (\"a\" in {});;) ;",
        "for (async x => (\"a\" in {});;) ;",
        "for (x => y => (\"a\" in {});;) ;",
        "for (async () => (\"a\" in {});;) ;",
        "for ((function () { return \"a\" in {}; });;) ;",
        "for (0 ? 0 : () => (\"a\" in {});;) ;",
        "for (f(() => (\"a\" in {}));;) ;",
        // Already-correct resets, kept so a regression in them is visible here.
        "for ([\"a\" in {}];;) ;",
        "for ({ p: \"a\" in {} };;) ;",
        "for (0 ? \"a\" in {} : 0;;) ;",
        // `in` outside a `for` head was never in question.
        "if (\"a\" in {}) ;",
        "var q = \"a\" in {};",
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

/// `in` is illegal anywhere `[~In]` still applies — the whole declaration list,
/// initializers and later bindings included.
#[test]
fn the_head_declaration_list_still_excludes_in() {
    for source in [
        "for (var x = \"a\" in {};;) ;",
        "for (let x = \"a\" in {};;) ;",
        "for (const x = \"a\" in {};;) ;",
        "for (var x = 1, y = \"a\" in {};;) ;",
        "for (let x = \"a\" in {}, y = 1;;) ;",
        "for (var [a] = \"a\" in {};;) ;",
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
                "{goal:?}, strict={strict}: {source}: {result:?}"
            );
        }
    }
}

/// The Annex B form this pass does NOT change, pinned so the scope is explicit
/// and a later fix has to come here and say so.
#[test]
fn the_annex_b_initializer_in_a_for_in_head_is_still_refused() {
    let result = compile_atoms_goal("for (var x = 0 in {}) ;", Goal::Script, false);
    assert!(
        matches!(result, Err(ref e) if e.kind == ParseErrorKind::Syntax),
        "pre-existing divergence changed: {result:?}"
    );
}
