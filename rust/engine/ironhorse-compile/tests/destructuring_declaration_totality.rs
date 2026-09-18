//! A destructuring declaration requires an initializer (finding F063).
//!
//! `VariableDeclaration : BindingPattern Initializer` and `LexicalBinding :
//! BindingPattern Initializer` both REQUIRE the initializer, so `var [a];` is
//! nine bytes of spec early error. `variable_statement` ported
//! `fxVariableStatement`, which does not check it, so the bare `ArrayBinding`
//! reached `code_node_inner`'s unsupported-node panic at coder.rs:1588 — one of
//! the AST-shape sites the coder audit left for follow-up, and reachable by a
//! guest through `eval("var [a];")`.
//!
//! Neither existing gate could see it. The test262 sweep compiles each file's
//! own source, and the corpus's two occurrences of this shape
//! (`staging/sm/lexical-environment/for-loop.js`'s `Function("for (const [z]; ;
//! ) ;")` and `staging/sm/regress/regress-699682.js`'s `"var {''};"`) sit
//! INSIDE string literals, so the files compile cleanly and the sweep is
//! honestly green; the 262 harness, which would run them, excludes `staging/`.
//! The one test262 wrote for this defect class is titled "Don't assert trying
//! to parse any of these", and it was never reached.
//!
//! The `const`-requires-an-initializer rule for a plain `BindingIdentifier` was
//! already enforced — `const x;` is rejected — which is why only the pattern
//! form survived.
//!
//! The rule does NOT hold in a `for-in`/`for-of` head: `ForBinding` takes no
//! initializer, so `for (var [a] of [])` is legal and is a control below.

use ironhorse_compile::{compile_atoms_goal, Goal, ParseErrorKind};

const MODES: &[(Goal, bool)] = &[
    (Goal::Script, false),
    (Goal::Script, true),
    (Goal::Module, false),
    (Goal::Eval, false),
    (Goal::Eval, true),
];

/// Every declaration form that can carry a pattern, in every mode.
#[test]
fn a_pattern_declaration_without_an_initializer_is_a_syntax_error() {
    let mut failures = Vec::new();
    for source in [
        // The three declaration tokens, both pattern kinds.
        "var [a];",
        "var {x};",
        "let [a];",
        "let {x};",
        "const [a];",
        "const {x};",
        // Empty and elided patterns, which carry no binding at all and so are
        // the likeliest to be waved through as harmless.
        "var [];",
        "var {};",
        "var [,];",
        "var [,,];",
        "let [];",
        "const {};",
        // A rest element, whose own node kind differs from the elements'.
        "var [...a];",
        "var {...a};",
        // Nested patterns: the panic is raised by the OUTER node, so the
        // nesting must not excuse it.
        "var [[a]];",
        "var {a:{b}};",
        "var [{a}];",
        "var {a:[b]};",
        // In a binding list, in either position, and with initialized
        // neighbours that must not excuse the bare one.
        "var [a], b;",
        "var b, [a];",
        "var [a] = [], [b];",
        "var [a], [b] = [];",
        "let {x}, y;",
        "const [a] = [], [b];",
        // A three-part `for` head is an ordinary declaration, not a
        // `ForBinding`, so the rule applies there too.
        "for (var [a];;);",
        "for (let [a];;);",
        "for (const {x};;);",
        "for (var [a], b;;);",
        "for (var [a] = [], [b];;);",
        // Reached through every body that opens its own scope.
        "function f() { var [a]; }",
        "function* g() { var [a]; }",
        "async function h() { var [a]; }",
        "() => { var [a]; };",
        "try {} catch (e) { var [a]; }",
        "{ let [a]; }",
        "switch (0) { case 0: let [a]; }",
        "while (0) { var [a]; }",
        "l: { let [a]; }",
        "(class { m() { var [a]; } });",
        // Exported, which is a separate declaration path.
        "export var [a];",
        "export let [a];",
        "export const {x};",
    ] {
        for &(goal, strict) in MODES {
            let owned = source.to_string();
            let result = std::panic::catch_unwind(move || compile_atoms_goal(&owned, goal, strict));
            if !matches!(result, Ok(Err(ref error)) if error.kind == ParseErrorKind::Syntax) {
                failures.push(format!(
                    "{source:?} ({goal:?}, strict={strict}): {result:?}"
                ));
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

/// The controls, without which the rule above could be "reject every pattern".
///
/// The `for-in`/`for-of` heads are the load-bearing ones: `ForBinding` takes no
/// initializer, so the check must NOT fire there.
#[test]
fn an_initialized_pattern_and_every_for_binding_still_compile() {
    for source in [
        // The same declarations, initialized.
        "var [a] = [];",
        "var {x} = {};",
        "let [a] = [];",
        "let {x} = {};",
        "const [a] = [];",
        "const {x} = {};",
        "var [] = [];",
        "var [,] = [];",
        "var [...a] = [];",
        "var {...a} = {};",
        "var [[a]] = [[]];",
        "var {a:{b}} = {a:{}};",
        "var [a] = [], [b] = [];",
        "var a, [b] = [];",
        "for (var [a] = [];;);",
        "for (let {x} = {};;);",
        // `ForBinding`: no initializer, and legal.
        "for (var [a] in {});",
        "for (var [a] of []);",
        "for (let [a] of []);",
        "for (const {x} of []);",
        "for (const [a] in {});",
        "for (var {x} in {});",
        "for (var [...a] of []);",
        "for (var [[a]] of []);",
        "async function f() { for await (const [a] of []) ; }",
        // Plain identifiers, whose initializer stays optional for `var`/`let`.
        "var a;",
        "let a;",
        "var a, b;",
        "for (var a;;);",
        "for (let a;;);",
        // Patterns outside a declaration entirely: assignment destructuring
        // never required an initializer and must be untouched.
        "[a] = [];",
        "({x} = {});",
        "for ([a] of []);",
        "function f([a]) {}",
        "try {} catch ([a]) {}",
        "(([a]) => 0);",
    ] {
        for &(goal, strict) in MODES {
            compile_atoms_goal(source, goal, strict)
                .unwrap_or_else(|error| panic!("{goal:?}, strict={strict}: {source}: {error:?}"));
        }
    }
}
