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

/// `scope_of`'s cross-pass invariant: the hoist pass inserted a `node_scope`
/// entry for every node the bind pass looks one up for (scoper.rs:2329).
///
/// The two passes agree by dispatch: each of the ten `scope_of` callers
/// (`bind_program`, `bind_module`, `bind_block`, `bind_function`,
/// `bind_catch`, `bind_for`, `bind_for_in_of`, `bind_switch`, `bind_with`,
/// `bind_class`) is routed the same tokens as a `hoist_*` that inserts. That
/// much is checkable by reading the two match arms, and it holds.
///
/// What reading them does not settle is asymmetric child traversal: a
/// subtree `bind_X` descends into that `hoist_X` skips would reach
/// `scope_of` with nothing inserted, and no dispatch table shows it. This is
/// the `code_catch` shape exactly — two passes that must agree on a node
/// roster — so the positions where a scope-bearing node can hide are probed.
/// Every fixture must compile in every mode, ensuring an earlier rejection
/// cannot silently remove a traversal from this audit. Sloppy-only `with`
/// statements and module-only exports have their own tests below.
#[test]
fn scope_bearing_children_are_hoisted_before_they_are_bound() {
    for source in [
        // Computed keys: evaluated in the enclosing scope, but attached to a
        // class or object member the two passes walk differently.
        "class C { [(() => { { let x; } return 0; })()]() {} }",
        "class C { static [(() => { switch (0) { case 0: let x; } return 0; })()]() {} }",
        "class C { [(() => { try {} catch (e) { let x; } return 0; })()]; }",
        "class C { get [(() => { { let x; } return 'g'; })()]() {} }",
        "({ [(() => { { let x; } return 0; })()]: 1 });",
        // Heritage: an expression evaluated before the class scope exists.
        "class C extends (() => { { let x; } return Object; })() {}",
        "class C extends (function () { for (let i of []) ; return Object; })() {}",
        // Field initializers, which hoist into a synthetic field-init scope.
        "class C { p = (() => { { let x; } })(); }",
        "class C { p = (() => { try {} catch (e) { let y; } })(); }",
        "class C { #p = (() => { switch (0) { default: let w; } })(); }",
        "class C { static p = (() => { for (let i = 0; i < 1; i++) { let x; } })(); }",
        "class C { static #p = (() => { for (let i in {}) { let x; } })(); }",
        // Private methods and accessors bind in the class scope rather than
        // the synthetic field-init scope used by private data fields.
        "class C { #m() { { let x; } } get #p() { try {} catch (e) { let x; } } set #p(v) { for (let x of []) ; } }",
        "class C { static #m(a = (() => { { let x; } })()) { { let y; } } static get #p() { { let z; } } static set #p(v) { { let w; } } }",
        "class C extends Object { constructor(a = (() => { { let x; } })()) { super(); } }",
        // Blocks, loops, catches and switches nested in parameter defaults.
        "function f(a = (() => { { let x; } })()) {}",
        "function f(a = (() => { for (const q of []) ; })()) {}",
        "function f(a = (() => { try {} catch ({ b }) {} })()) {}",
        "function f(a = (() => { switch (0) { case 0: let s; } })()) {}",
        // Binding patterns walk their keys and defaults through different
        // bind visitors from object/array expression literals.
        "let { [(() => { { let x; } return 'k'; })()]: value = (() => { { let y; } })() } = {};",
        "function f([a = (() => { for (let x of []) ; })()], { [(() => { { let y; } return 'k'; })()]: b } = {}) {}",
        "try {} catch ({ [(() => { { let x; } return 'k'; })()]: e = (() => { { let y; } })() }) {}",
        // Template substitutions, spreads and optional chains: expression
        // positions whose children are easy to miss in one pass.
        "`${(() => { { let x; } return 1; })()}`;",
        "tag`${(() => { { let x; } return 1; })()}`;",
        "[...(() => { { let x; } return []; })()];",
        "({ ...(() => { { let x; } return {}; })() });",
        "a?.[(() => { { let x; } return 0; })()];",
        // Generator and async bodies, and a labelled try with all three arms
        // carrying their own block scope.
        "(async () => { for await (const x of []) { let y; } })();",
        "(function* () { switch (0) { case 0: let x; } })();",
        "(async function* () { for await (const x of []) { let y; } })();",
        "l: try { { let x; } } catch (e) { { let y; } } finally { { let z; } }",
    ] {
        for &(goal, strict) in MODES {
            assert_eq!(
                outcome(source, goal, strict),
                Ok("compiled"),
                "{source} ({goal:?}, strict={strict})"
            );
        }
    }
}

/// `with` is rejected before scoping in strict code. Require compilation in
/// both sloppy goals to exercise `bind_with`, and pin the strict rejection
/// separately rather than counting it as successful traversal coverage.
#[test]
fn with_scope_traversal_requires_a_sloppy_program() {
    for source in [
        "function f(a = (() => { with ({}) { var v; } })()) {}",
        "tag`${(() => { with ({}) { var x; } return 1; })()}`;",
        "try { try {} finally { with ({}) { var x; } } } catch {}",
    ] {
        for &(goal, strict) in MODES {
            let expected = if strict || goal == Goal::Module {
                "syntax"
            } else {
                "compiled"
            };
            assert_eq!(
                outcome(source, goal, strict),
                Ok(expected),
                "{source} ({goal:?}, strict={strict})"
            );
        }
    }
}

/// Export visitors have declaration paths that program-grammar fixtures
/// cannot reach, including anonymous declarations synthesized for `default`.
#[test]
fn exported_scope_bearing_children_reach_both_passes() {
    for source in [
        "export default function (a = (() => { { let x; } })()) { try {} catch (e) { let y; } }",
        "export default class extends (() => { { let x; } return Object; })() { static p = (() => { { let y; } })(); }",
        "export function* f() { for (let x of []) { let y; } }",
        "export const x = class { [(() => { { let y; } return 'k'; })()]() {} };",
    ] {
        assert_eq!(
            outcome(source, Goal::Module, false),
            Ok("compiled"),
            "{source}"
        );
    }
}
