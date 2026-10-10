//! The [`Goal`] contract: what each of the three goals compiles to, and that
//! the goal-explicit entry agrees with the named wrapper for every one of them.
//!
//! `Goal` became three-valued so the Module goal states itself instead of being
//! encoded as "not Script" (it used to ride the scoper's `script_goal: bool` as
//! `false`, i.e. labelled as the *eval* goal — inert only because a module body
//! scope is `Token::Module` and never consults the hoist decision). Making it
//! expressible also made it mis-usable, so these pin both halves: the goals
//! agree with their wrappers, and a Module goal reaches the module pipeline
//! rather than being scoped as a program.

use ironhorse_compile::{
    compile_atoms, compile_atoms_goal, compile_atoms_with, compile_module_atoms, Goal,
};

/// Each goal's explicit form is exactly its named wrapper.
#[test]
fn the_goal_entry_agrees_with_every_named_wrapper() {
    for source in [
        "var x = 1; x",
        "'use strict'; var x = 1; x",
        "let a = 1; const b = 2; a + b",
        "function f() { return 1 } f()",
        "'use strict'; function f() { return 1 } f()",
        "1 + 2",
    ] {
        assert_eq!(
            compile_atoms_goal(source, Goal::Script, false).unwrap(),
            compile_atoms(source).unwrap(),
            "Script goal vs compile_atoms: {source:?}",
        );
        for strict in [false, true] {
            assert_eq!(
                compile_atoms_goal(source, Goal::Eval, strict).unwrap(),
                compile_atoms_with(source, strict).unwrap(),
                "eval goal vs compile_atoms_with(strict={strict}): {source:?}",
            );
        }
    }
}

/// `Goal::Module` reaches the module pipeline. Before this was wired, the goal
/// entry parsed with the *program* grammar and then scoped the result as a
/// module: real module source was rejected outright, and source that happens to
/// parse both ways silently produced different bytes from the module goal.
#[test]
fn the_module_goal_reaches_the_module_pipeline() {
    for source in [
        "export const a = 1;",
        "import { x } from 'm'; x",
        "export default function () { return 1 }",
        // Sources that also parse as a program: the dangerous case, because
        // scoping a program-parsed tree as a module fails silently, not loudly.
        "var x = 1; x",
        "let a = 1; a",
        "function f() { return 1 } f()",
    ] {
        assert_eq!(
            compile_atoms_goal(source, Goal::Module, false).unwrap(),
            compile_module_atoms(source).unwrap(),
            "Module goal vs compile_module_atoms: {source:?}",
        );
        // A Module is always strict, so the caller strictness is not consulted.
        assert_eq!(
            compile_atoms_goal(source, Goal::Module, true).unwrap(),
            compile_atoms_goal(source, Goal::Module, false).unwrap(),
            "the module goal ignores caller strictness: {source:?}",
        );
    }
}

/// The Script/eval split is confined to a **strict** program that declares a
/// top-level `var`/function; every other program compiles identically under
/// both goals. This is the invariant the byte-identity harness leans on to tell
/// the one sanctioned divergence from a real finding.
#[test]
fn the_script_and_eval_goals_differ_only_where_declared() {
    let differs = [
        "'use strict'; var g = 1; g",
        "'use strict'; function f() {} f",
        "'use strict'; var g = 1; let h = 2; g + h",
    ];
    let agrees = [
        // Sloppy: identical under both goals whatever it declares.
        "var g = 1; g",
        "function f() {} f",
        // Strict but declaring no top-level var/function.
        "'use strict'; let a = 1; a",
        "'use strict'; const b = 2; b",
        "'use strict'; 1 + 2",
        "'use strict'; (function () { var inner = 1; return inner })()",
    ];
    for source in differs {
        assert!(
            ironhorse_compile::script_goal_deviates(source),
            "the compiler should class {source:?} as deviating",
        );
        assert_ne!(
            compile_atoms_goal(source, Goal::Script, false).unwrap().0,
            compile_atoms_goal(source, Goal::Eval, false).unwrap().0,
            "the two goals must differ for {source:?}",
        );
    }
    for source in agrees {
        assert!(
            !ironhorse_compile::script_goal_deviates(source),
            "the compiler should not class {source:?} as deviating",
        );
        assert_eq!(
            compile_atoms_goal(source, Goal::Script, false).unwrap(),
            compile_atoms_goal(source, Goal::Eval, false).unwrap(),
            "the two goals must agree for {source:?}",
        );
    }
}
