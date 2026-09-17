//! The scoper's totality, audited rather than asserted (architecture finding
//! F063).
//!
//! F063's residue after `e8a03e9f6` was the scoper: 29 `expect`/`unwrap`
//! sites, six of them in the file's own `#[cfg(test)]` modules, the other 23
//! in nine shapes. Their mere presence is not proof that source text reaches
//! them — most are invariants over the parser's own output — but the coder
//! half of this finding twice turned "the grammar keeps this unreached" into
//! a crash, so the shapes are probed here rather than argued.
//!
//! The one shape whose safety is NOT scope lifetime is
//! `self.body_scope.unwrap()` (scoper.rs:1600, 1621, 1689). `hoist_function`
//! and `hoist_function_no_self` CLEAR `body_scope` to `None` on entry
//! (scoper.rs:1439, 1748) and only `hoist_body` re-establishes it
//! (scoper.rs:1422), which runs after the parameters. So there is a real
//! window — inside a parameter list, outside any nested function body — in
//! which `body_scope` is `None` while a scope is open, and the three readers
//! survive it only because they sit in the non-`Token::Arg` arms of the
//! dispatch at scoper.rs:1580: a `Const`/`Let`/`Using`/`Var` declarator is
//! not a parameter.
//!
//! That argument is about the GRAMMAR of a parameter list, which is exactly
//! the kind of argument `code_catch` disproved. The roster below is the
//! attempt to break it: every construct that can nest a declaration inside a
//! parameter default without opening a function body.
//!
//! **What these probes do and do not establish.** Most of the static-block
//! roster ends as `Unsupported`, at the CODER's deferred-static-block fold
//! (coder.rs:3498). That fold runs after the scoper, so the scoper walks
//! every one of these sources to completion and the audit is not vacuous —
//! but the reach is asserted below rather than assumed, because a roster that
//! is refused before the pass under audit is the way this kind of test passes
//! while testing nothing. `a_static_block_is_still_deferred_by_the_coder`
//! pins that premise: when static blocks are implemented, it fails, and the
//! window audit has to be re-run against sources that reach the back end.
//!
//! This file is not a closure of the finding. It pins the shapes that are
//! known; the gate that does not depend on someone thinking of a shape is
//! `corpus_compiler_totality.rs` over test262.

use ironhorse_compile::{Goal, ParseErrorKind};

/// Compile under a firewall, reporting the outcome by its KIND.
///
/// A panic is the only failure. Any `Err` is a legitimate answer: several
/// probes below are spec early errors, and which ones is not this file's
/// subject — a total compiler is one that ANSWERS.
fn outcome(source: &str, goal: Goal, strict: bool) -> Result<&'static str, String> {
    let owned = source.to_string();
    match std::panic::catch_unwind(move || {
        ironhorse_compile::compile_atoms_goal(&owned, goal, strict)
    }) {
        Ok(Ok(_)) => Ok("compiled"),
        Ok(Err(error)) => Ok(match error.kind {
            ParseErrorKind::Unsupported => "unsupported",
            ParseErrorKind::Syntax => "syntax",
            ParseErrorKind::MeterLimit => "meter-limit",
            ParseErrorKind::Lex(_) => "lex",
        }),
        Err(_) => Err(format!(
            "PANICKED on {source:?} ({goal:?}, strict={strict})"
        )),
    }
}

/// The five goal/strictness modes a source can reach the scoper through.
///
/// The parameter-list early error this finding already moved to the parser
/// (`d56ebbc83`) was one-goal-wide when it was written coder-side, so a
/// single-goal roster is how that class of defect hides.
const MODES: &[(Goal, bool)] = &[
    (Goal::Script, false),
    (Goal::Script, true),
    (Goal::Module, false),
    (Goal::Eval, false),
    (Goal::Eval, true),
];

fn audit(roster: &[&str]) {
    let mut panics = Vec::new();
    for source in roster {
        for &(goal, strict) in MODES {
            if let Err(report) = outcome(source, goal, strict) {
                panics.push(report);
            }
        }
    }
    assert!(panics.is_empty(), "{}", panics.join("\n"));
}

/// Declarations nested in a parameter default: the `body_scope == None`
/// window.
///
/// A class static block and a class field initializer are the two ways to get
/// a STATEMENT into an expression position without an intervening function
/// body, so they are the two ways to put a `var`/`let`/`const`/`using`
/// declarator into the window. If any of them reaches scoper.rs:1600, 1621 or
/// 1689 the `unwrap` is a crash on valid source.
#[test]
fn a_declaration_inside_a_parameter_default_does_not_reach_a_none_body_scope() {
    audit(&[
        // Static blocks in a parameter default, one per declarator token.
        "function f(a = class { static { var x; } }) {}",
        "function f(a = class { static { let x; } }) {}",
        "function f(a = class { static { const x = 1; } }) {}",
        "function f(a = class { static { using x = null; } }) {}",
        "function f(a = class { static { function g() {} } }) {}",
        "function f(a = class { static { class D {} } }) {}",
        // The same, one nesting level deeper: a block inside the static block.
        "function f(a = class { static { { var x; } } }) {}",
        "function f(a = class { static { if (0) var x; } }) {}",
        "function f(a = class { static { for (var x of []) ; } }) {}",
        "function f(a = class { static { try {} catch { var x; } } }) {}",
        // A static block reached through the heritage clause rather than a
        // default's own expression.
        "function f(a = class extends (class { static { var x; } }) {}) {}",
        // A field initializer, which is an expression but opens its own
        // synthetic field-init function scope (scoper.rs:2208, 2221).
        "function f(a = class { p = (() => { var x; return 1; })(); }) {}",
        "function f(a = class { static p = (() => { let x; return 1; })(); }) {}",
        // Every function form that clears `body_scope`, each with a static
        // block in its parameter list.
        "function* g(a = class { static { var x; } }) {}",
        "async function h(a = class { static { var x; } }) {}",
        "async function* i(a = class { static { var x; } }) {}",
        "(a = class { static { var x; } }) => {}",
        "async (a = class { static { var x; } }) => {}",
        "({ m(a = class { static { var x; } }) {} });",
        "({ get p() { return 0; }, set p(a = class { static { var x; } }) {} });",
        "(class { m(a = class { static { var x; } }) {} });",
        "(class { static m(a = class { static { var x; } }) {} });",
        "(class { #m(a = class { static { var x; } }) {} });",
        "(class { constructor(a = class { static { var x; } }) {} });",
        // A destructuring parameter, whose defaults nest arbitrarily deep.
        "function f({ a = class { static { var x; } } }) {}",
        "function f([a = class { static { var x; } }]) {}",
        "function f({ a: { b = class { static { var x; } } } }) {}",
        "function f(...[a = class { static { var x; } }]) {}",
        // A function nested in a parameter default, whose OWN parameter
        // default carries the static block: the window, re-entered.
        "function f(a = function (b = class { static { var x; } }) {}) {}",
        "function f(a = ((b = class { static { var x; } }) => 0)) {}",
        // Controls: the same declarations where `body_scope` IS set. These
        // must not panic either, and if the roster above ever stops
        // compiling for an unrelated reason these keep the file honest.
        "function f(a = function () { var x; }) {}",
        "function f(a = 1) { var x; }",
        "class C { static { var x; } }",
        "var x;",
    ]);
}

/// The catch shape, whose `statement_scope.unwrap()` (scoper.rs:2527) is
/// taken only when the catch has a parameter.
///
/// `code_catch` is where this finding's first reachable panic lived, so the
/// scoper's own catch handling gets the same roster the coder's did.
#[test]
fn every_catch_shape_answers() {
    audit(&[
        "try {} catch {}",
        "try {} catch (e) {}",
        "try {} catch ({ a }) {}",
        "try {} catch ([a]) {}",
        "try {} catch ({ a = class { static { var x; } } }) {}",
        "try {} catch (e) { var e; }",
        "try {} catch (e) { function f() {} }",
        "try {} catch { function f() {} }",
        "try {} catch (e) {} finally {}",
        "try { try {} catch (e) {} } catch (e) {}",
        "function f(a = (() => { try {} catch (e) {} })()) {}",
    ]);
}

/// The scopes a declaration can be hoisted into without a function between it
/// and the program, which is the `self.scope.unwrap()` cluster (ten sites).
#[test]
fn every_scope_bearing_statement_answers() {
    audit(&[
        "{ let x; }",
        "if (0) { let x; } else { let y; }",
        "for (let x of []) { let y; }",
        "for (let x in {}) ;",
        "for (let x = 0; x < 0; x++) ;",
        "for (const x of []) ;",
        "for (using x of []) ;",
        "for await (const x of []) ;",
        "switch (0) { case 0: let x; }",
        "switch (0) { default: function f() {} }",
        "while (0) { let x; }",
        "do { let x; } while (0);",
        "l: { let x; break l; }",
        "with ({}) { var x; }",
        "label: for (;;) { continue label; }",
        "{ class C {} }",
        "{ using x = null; }",
        "{ await using x = null; }",
    ]);
}

/// The premise the parameter-default roster rests on, pinned.
///
/// A class static block is the only way to put a STATEMENT into an expression
/// position without an intervening function body, so it is the only way to
/// put a declarator into the `body_scope == None` window. The scoper handles
/// these sources — it is the coder that refuses them, at its deferred
/// static-block fold (coder.rs:3498), after the scoper has already walked
/// them — so the audit above is a real exercise of the scoper.
///
/// It is NOT a real exercise of anything downstream. When static blocks stop
/// being deferred this test fails, which is the intent: the window audit then
/// has to be re-run against sources that reach the back end.
#[test]
fn a_static_block_is_still_deferred_by_the_coder() {
    for source in [
        "class C { static { var x; } }",
        "function f(a = class { static { var x; } }) {}",
    ] {
        assert_eq!(
            outcome(source, Goal::Script, false),
            Ok("unsupported"),
            "{source}"
        );
    }
}

/// The declarations that DO reach the back end, so the roster is not made
/// entirely of sources the coder folds away.
///
/// Without these, every probe above could be refused before it proved
/// anything and the file would still be green.
#[test]
fn the_roster_contains_sources_that_compile_end_to_end() {
    for source in [
        "function f(a = class { p = (() => { var x; return 1; })(); }) {}",
        "function f(a = function (b = 1) { var x; }) {}",
        "try {} catch ({ a = 1 }) {}",
        "for (using x of []) ;",
        "with ({}) { var x; }",
    ] {
        assert_eq!(
            outcome(source, Goal::Script, false),
            Ok("compiled"),
            "{source}"
        );
    }
}
